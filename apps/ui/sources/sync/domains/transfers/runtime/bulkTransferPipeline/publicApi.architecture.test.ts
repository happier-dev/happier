import { describe, expect, it } from 'vitest';

import * as bulkTransferPipeline from './index';

describe('bulkTransferPipeline (public API)', () => {
    it('freezes the bulkTransferPipeline index runtime exports', () => {
        expect(Object.keys(bulkTransferPipeline).sort()).toEqual([
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
