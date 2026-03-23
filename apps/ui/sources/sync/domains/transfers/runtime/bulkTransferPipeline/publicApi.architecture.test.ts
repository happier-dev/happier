import { describe, expect, it } from 'vitest';

import * as bulkTransferPipeline from './index';
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
});

