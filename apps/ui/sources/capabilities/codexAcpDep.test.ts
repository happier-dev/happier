import { describe, expect, it } from 'vitest';
import type { CodexAcpDepData } from '@/sync/api/capabilities/capabilitiesProtocol';
import { CODEX_ACP_DEP_ID } from '@happier-dev/protocol/installables';

import {
    buildCodexAcpLatestVersionDetectRequest,
    getCodexAcpDepData,
    getCodexAcpDetectResult,
    getCodexAcpLatestVersion,
    getCodexAcpLatestVersionError,
    isCodexAcpUpdateAvailable,
    shouldPrefetchCodexAcpLatestVersion,
} from './codexAcpDep';
import { runCodexDepCapabilityContract } from './codexDepCapability.testHelpers';

runCodexDepCapabilityContract<CodexAcpDepData>({
    suiteName: 'codexAcpDep',
    depId: CODEX_ACP_DEP_ID,
    getDetectResult: getCodexAcpDetectResult,
    getDepData: getCodexAcpDepData,
    getLatestVersion: getCodexAcpLatestVersion,
    getRegistryError: getCodexAcpLatestVersionError,
    isUpdateAvailable: isCodexAcpUpdateAvailable,
    shouldPrefetchRegistry: shouldPrefetchCodexAcpLatestVersion,
});

describe('codexAcpDep detect request', () => {
    it('builds a latest-version detect request for the ACP dependency', () => {
        expect(buildCodexAcpLatestVersionDetectRequest()).toEqual({
            requests: [
                {
                    id: CODEX_ACP_DEP_ID,
                    params: {
                        includeLatestVersion: true,
                        onlyIfInstalled: true,
                    },
                },
            ],
        });
    });
});

describe('shouldPrefetchCodexAcpLatestVersion', () => {
    it('treats a carried-forward latestVersionCheck as stale when its own timestamp is stale', () => {
        const now = new Date('2026-02-08T00:00:00.000Z').getTime();
        const staleVersionCheckAt = now - 2 * 24 * 60 * 60 * 1000;

        const originalNow = Date.now;
        Date.now = () => now;

        try {
            expect(
                shouldPrefetchCodexAcpLatestVersion({
                    requireExistingResult: true,
                    result: {
                        ok: true,
                        checkedAt: now,
                        data: {},
                    },
                    data: {
                        installed: true,
                        latestVersionCheck: {
                            ok: true,
                            latestVersion: '1.0.1',
                            label: 'v1.0.1',
                            checkedAt: staleVersionCheckAt,
                        },
                    } as CodexAcpDepData,
                }),
            ).toBe(true);
        } finally {
            Date.now = originalNow;
        }
    });
});
