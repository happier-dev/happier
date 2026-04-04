import { describe, expect, it } from 'vitest';

import * as transferSubstrate from './index';

describe('transferSubstrate (public API)', () => {
    it('freezes the transferSubstrate index runtime exports', () => {
        expect(Object.keys(transferSubstrate).sort()).toEqual([
            'callDaemonWorkspaceStatFileRpc',
            'callDaemonWorkspaceWriteFileRpc',
            'deleteDaemonPromptAsset',
            'discoverDaemonPromptAssets',
            'downloadBulkJsonPayload',
            'downloadBulkPayloadToFile',
            'downloadDaemonPromptAsset',
            'downloadDaemonPromptRegistryItem',
            'downloadDaemonWorkspaceFileToBase64',
            'downloadDaemonWorkspaceFileToDestination',
            'installDaemonPromptRegistryItem',
            'listDaemonPromptAssetTypes',
            'listDaemonPromptRegistryAdapters',
            'listDaemonPromptRegistrySources',
            'resolveSessionFileTransferAvailability',
            'resolveTransferAvailability',
            'resolveTransferRouteDecision',
            'scanDaemonPromptRegistrySource',
            'shouldPreferScopedMachineRpcForBulkTransfer',
            'uploadBulkJsonPayload',
            'uploadBulkPayloadFromFile',
            'uploadDaemonPromptAsset',
            'uploadDaemonSessionAttachmentFromReader',
            'uploadDaemonWorkspaceFileFromReader',
        ]);
    });
});
