import { describe, expect, it } from 'vitest';

import * as bulkTransferPipeline from './index';

describe('bulkTransferPipeline (public API)', () => {
    it('freezes the bulkTransferPipeline index runtime exports', () => {
        expect(Object.keys(bulkTransferPipeline).sort()).toEqual([
            'callDaemonSessionWriteFileRpc',
            'deleteDaemonPromptAsset',
            'discoverDaemonPromptAssets',
            'downloadBulkJsonPayload',
            'downloadBulkPayloadToFile',
            'downloadDaemonPromptAsset',
            'downloadDaemonPromptRegistryItem',
            'downloadDaemonSessionFileToBase64',
            'downloadDaemonSessionFileToDestination',
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
            'uploadDaemonSessionFileFromReader',
        ]);
    });
});
