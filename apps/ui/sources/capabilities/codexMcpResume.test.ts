import { describe, expect, it } from 'vitest';
import type { CodexMcpResumeDepData } from '@/sync/api/capabilities/capabilitiesProtocol';

import {
    buildCodexMcpResumeRegistryDetectRequest,
    CODEX_MCP_RESUME_DEP_ID,
    CODEX_MCP_RESUME_DIST_TAG,
    getCodexMcpResumeDepData,
    getCodexMcpResumeDetectResult,
    getCodexMcpResumeLatestVersion,
    getCodexMcpResumeRegistryError,
    isCodexMcpResumeUpdateAvailable,
    shouldPrefetchCodexMcpResumeRegistry,
} from './codexMcpResume';
import { runCodexDepCapabilityContract } from './codexDepCapability.testHelpers';

runCodexDepCapabilityContract<CodexMcpResumeDepData>({
    suiteName: 'codexMcpResume',
    depId: CODEX_MCP_RESUME_DEP_ID,
    distTag: CODEX_MCP_RESUME_DIST_TAG,
    getDetectResult: getCodexMcpResumeDetectResult,
    getDepData: getCodexMcpResumeDepData,
    getLatestVersion: getCodexMcpResumeLatestVersion,
    getRegistryError: getCodexMcpResumeRegistryError,
    isUpdateAvailable: isCodexMcpResumeUpdateAvailable,
    shouldPrefetchRegistry: shouldPrefetchCodexMcpResumeRegistry,
});

describe('codexMcpResume detect request', () => {
    it('builds a registry detect request for the MCP resume dependency', () => {
        expect(buildCodexMcpResumeRegistryDetectRequest()).toEqual({
            requests: [
                {
                    id: CODEX_MCP_RESUME_DEP_ID,
                    params: {
                        includeRegistry: true,
                        onlyIfInstalled: true,
                        distTag: CODEX_MCP_RESUME_DIST_TAG,
                    },
                },
            ],
        });
    });
});
