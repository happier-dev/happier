import { describe, expect, it } from 'vitest';

import * as bulkTransferPipeline from './index';
import * as daemonPromptAssets from './daemonPromptAssets';
import * as daemonPromptRegistries from './daemonPromptRegistries';
import * as daemonSessionAttachments from './daemonSessionAttachments';
import * as daemonSessionFiles from './daemonSessionFiles';

describe('bulkTransferPipeline (public API)', () => {
    it('freezes the bulkTransferPipeline index runtime exports', () => {
        expect(Object.keys(bulkTransferPipeline).sort()).toEqual([
            'downloadBulkJsonPayload',
            'downloadBulkPayloadToFile',
            'resolveBulkTransferPolicyAndRoute',
            'shouldPreferScopedMachineRpcForBulkTransfer',
            'uploadBulkJsonPayload',
            'uploadBulkPayloadFromFile',
        ]);
    });

    it('freezes the daemonSessionFiles runtime exports', () => {
        expect(Object.keys(daemonSessionFiles).sort()).toEqual([
            'callDaemonSessionWriteFileRpc',
            'downloadDaemonSessionFileToBase64',
            'downloadDaemonSessionFileToDestination',
            'uploadDaemonSessionFileFromReader',
        ]);
    });

    it('freezes the daemonSessionAttachments runtime exports', () => {
        expect(Object.keys(daemonSessionAttachments).sort()).toEqual([
            'uploadDaemonSessionAttachmentFromReader',
        ]);
    });

    it('freezes the daemonPromptAssets runtime exports', () => {
        expect(Object.keys(daemonPromptAssets).sort()).toEqual([
            'deleteDaemonPromptAsset',
            'discoverDaemonPromptAssets',
            'downloadDaemonPromptAsset',
            'listDaemonPromptAssetTypes',
            'uploadDaemonPromptAsset',
        ]);
    });

    it('freezes the daemonPromptRegistries runtime exports', () => {
        expect(Object.keys(daemonPromptRegistries).sort()).toEqual([
            'downloadDaemonPromptRegistryItem',
            'installDaemonPromptRegistryItem',
            'listDaemonPromptRegistryAdapters',
            'listDaemonPromptRegistrySources',
            'scanDaemonPromptRegistrySource',
        ]);
    });
});
