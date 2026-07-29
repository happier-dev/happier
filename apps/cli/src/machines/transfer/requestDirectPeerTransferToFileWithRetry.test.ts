import { describe, expect, it, vi } from 'vitest';

import { requestDirectPeerTransferToFileWithRetry } from './requestDirectPeerTransferToFileWithRetry';

describe('requestDirectPeerTransferToFileWithRetry', () => {
    it('never delegates predecessor LAN HTTP candidates to any retry attempt', async () => {
        const requestTransferToFile = vi.fn(async () => ({ destinationPath: '/tmp/result' }));

        await requestDirectPeerTransferToFileWithRetry({
            requestTransferToFile,
            transferId: 'transfer-1',
            endpointCandidates: [
                {
                    kind: 'http',
                    url: 'http://192.168.1.20:46001/machine-transfers/direct/transfer-1',
                    authorizationToken: 'remote-dev-shaped-token',
                    expiresAt: 10_000,
                },
                {
                    kind: 'https',
                    url: 'https://machine.example.test/machine-transfers/direct/transfer-1',
                    authorizationToken: 'safe-token',
                    expiresAt: 10_000,
                },
            ],
            destinationPath: '/tmp/result',
            expectedSizeBytes: 7,
            expectedManifestHash: 'sha256:published',
        });

        expect(requestTransferToFile).toHaveBeenCalledWith(expect.objectContaining({
            endpointCandidates: [{
                kind: 'https',
                url: 'https://machine.example.test/machine-transfers/direct/transfer-1',
                authorizationToken: 'safe-token',
                expiresAt: 10_000,
            }],
            expectedSizeBytes: 7,
            expectedManifestHash: 'sha256:published',
        }));
    });
});
