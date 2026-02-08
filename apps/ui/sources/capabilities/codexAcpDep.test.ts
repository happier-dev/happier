import { describe, expect, it } from 'vitest';
import type { CodexAcpDepData } from '@/sync/capabilitiesProtocol';

import {
    buildCodexAcpRegistryDetectRequest,
    CODEX_ACP_DEP_ID,
    CODEX_ACP_DIST_TAG,
    getCodexAcpDepData,
    getCodexAcpDetectResult,
    getCodexAcpLatestVersion,
    getCodexAcpRegistryError,
    isCodexAcpUpdateAvailable,
    shouldPrefetchCodexAcpRegistry,
} from './codexAcpDep';
import { runCodexDepCapabilityContract } from './codexDepCapability.testHelpers';

runCodexDepCapabilityContract<CodexAcpDepData>({
    suiteName: 'codexAcpDep',
    depId: CODEX_ACP_DEP_ID,
    distTag: CODEX_ACP_DIST_TAG,
    getDetectResult: getCodexAcpDetectResult,
    getDepData: getCodexAcpDepData,
    getLatestVersion: getCodexAcpLatestVersion,
    getRegistryError: getCodexAcpRegistryError,
    isUpdateAvailable: isCodexAcpUpdateAvailable,
    shouldPrefetchRegistry: shouldPrefetchCodexAcpRegistry,
});

describe('codexAcpDep detect request', () => {
    it('builds a registry detect request for the ACP dependency', () => {
        expect(buildCodexAcpRegistryDetectRequest()).toEqual({
            requests: [
                {
                    id: CODEX_ACP_DEP_ID,
                    params: {
                        includeRegistry: true,
                        onlyIfInstalled: true,
                        distTag: CODEX_ACP_DIST_TAG,
                    },
                },
            ],
        });
    });
});
