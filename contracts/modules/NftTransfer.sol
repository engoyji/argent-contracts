// Copyright (C) 2018  Argent Labs Ltd. <https://argent.xyz>

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.6.12;

import "./common/OnlyOwnerModule.sol";

/**
 * @title NftTransfer
 * @notice Module to transfer NFTs (ERC721),
 * @author Olivier VDB - <olivier@argent.xyz>
 */
contract NftTransfer is OnlyOwnerModule {

    bytes32 constant NAME = "NftTransfer";

    // Equals to `bytes4(keccak256("onERC721Received(address,address,uint256,bytes)"))`
    bytes4 private constant ERC721_RECEIVED = 0x150b7a02;

    // The address of the CryptoKitties contract
    address public ckAddress;

    // *************** Events *************************** //

    event NonFungibleTransfer(address indexed wallet, address indexed nftContract, uint256 indexed tokenId, address to, bytes data);

    // *************** Constructor ********************** //

    constructor(
        IModuleRegistry _registry,
        IGuardianStorage _guardianStorage,
        address _ckAddress
    )
        BaseModule(_registry, _guardianStorage, NAME)
        public
    {
        ckAddress = _ckAddress;
    }

    // *************** External/Public Functions ********************* //

    /**
     * @notice Inits the module for a wallet by setting up the onERC721Received
     * static call redirection from the wallet to the module.
     * @param _wallet The target wallet.
     */
    function init(address _wallet) public override onlyWallet(_wallet) {
        IWallet(_wallet).enableStaticCall(address(this), ERC721_RECEIVED);
    }

    /**
     * @notice Handle the receipt of an NFT
     * @notice An ERC721 smart contract calls this function on the recipient contract
     * after a `safeTransfer`. If the recipient is a BaseWallet, the call to onERC721Received
     * will be forwarded to the method onERC721Received of the present module.
     * @return bytes4 `bytes4(keccak256("onERC721Received(address,address,uint256,bytes)"))`
     */
    function onERC721Received(
        address /* operator */,
        address /* from */,
        uint256 /* tokenId */,
        bytes calldata /* data*/
    )
        external
        returns (bytes4)
    {
        return ERC721_RECEIVED;
    }

    /**
    * @notice Lets the owner transfer NFTs from a wallet.
    * @param _wallet The target wallet.
    * @param _nftContract The ERC721 address.
    * @param _to The recipient.
    * @param _tokenId The NFT id
    * @param _safe Whether to execute a safe transfer or not
    * @param _data The data to pass with the transfer.
    */
    function transferNFT(
        address _wallet,
        address _nftContract,
        address _to,
        uint256 _tokenId,
        bool _safe,
        bytes calldata _data
    )
        external
        onlyWalletOwnerOrModule(_wallet)
        onlyWhenUnlocked(_wallet)
    {
        bytes memory methodData;
        if (_nftContract == ckAddress) {
            methodData = abi.encodeWithSignature("transfer(address,uint256)", _to, _tokenId);
        } else {
           if (_safe) {
               methodData = abi.encodeWithSignature(
                   "safeTransferFrom(address,address,uint256,bytes)", _wallet, _to, _tokenId, _data);
           } else {
               require(isERC721(_nftContract, _tokenId), "NT: Non-compliant NFT contract");
               methodData = abi.encodeWithSignature(
                   "transferFrom(address,address,uint256)", _wallet, _to, _tokenId);
           }
        }
        invokeWallet(_wallet, _nftContract, 0, methodData);
        emit NonFungibleTransfer(_wallet, _nftContract, _tokenId, _to, _data);
    }

    // *************** Internal Functions ********************* //

    /**
    * @notice Check whether a given contract complies with ERC721.
    * @param _nftContract The contract to check.
    * @param _tokenId The tokenId to use for the check.
    * @return `true` if the contract is an ERC721, `false` otherwise.
    */
    function isERC721(address _nftContract, uint256 _tokenId) internal returns (bool) {
        (bool success, bytes memory result) = _nftContract.call(abi.encodeWithSignature("supportsInterface(bytes4)", 0x80ac58cd));
        if (success && result[0] != 0x0)
            return true;

        (success, result) = _nftContract.call(abi.encodeWithSignature("supportsInterface(bytes4)", 0x6466353c));
        if (success && result[0] != 0x0)
            return true;

        (success,) = _nftContract.call(abi.encodeWithSignature("ownerOf(uint256)", _tokenId));
        return success;
    }

}