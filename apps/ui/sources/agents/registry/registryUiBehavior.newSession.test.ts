import { describe, expect, it } from 'vitest';
import { CODEX_ACP_DEP_ID, CODEX_MCP_RESUME_DEP_ID, INSTALLABLE_KEYS } from '@happier-dev/protocol/installables';

import {
    getAgentResumeExperimentsFromSettings,
    getNewSessionPreflightIssues,
    getNewSessionRelevantInstallableDepKeys,
} from './registryUiBehavior';
import { makeResults, makeSettings, okCapability } from './registryUiBehavior.testHelpers';

describe('getNewSessionRelevantInstallableDepKeys', () => {
    it('returns codex installable deps based on codex backend mode', () => {
        const mcpResume = makeSettings({ codexBackendMode: 'mcp_resume' });
        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', mcpResume),
            resumeSessionId: 'x1',
        })).toEqual([INSTALLABLE_KEYS.CODEX_MCP_RESUME]);

        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', mcpResume),
            resumeSessionId: '',
        })).toEqual([]);

        const acp = makeSettings({ codexBackendMode: 'acp' });
        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', acp),
            resumeSessionId: '',
        })).toEqual([INSTALLABLE_KEYS.CODEX_ACP]);

        const mcp = makeSettings({ codexBackendMode: 'mcp' });
        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', mcp),
            resumeSessionId: 'x1',
        })).toEqual([]);
    });

    it('returns empty for non-codex agents', () => {
        const settings = makeSettings({ codexBackendMode: 'acp' });
        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'claude',
            experiments: getAgentResumeExperimentsFromSettings('claude', settings),
            resumeSessionId: 'x1',
        })).toEqual([]);
    });
});

describe('getNewSessionPreflightIssues', () => {
    it('returns codex preflight issues based on machine results (deps missing)', () => {
        const settings = makeSettings({ codexBackendMode: 'acp' });
        const issues = getNewSessionPreflightIssues({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', settings),
            resumeSessionId: 'x1',
            results: makeResults({
                [CODEX_MCP_RESUME_DEP_ID]: okCapability({ installed: false }),
                [CODEX_ACP_DEP_ID]: okCapability({ installed: false }),
            }),
        });
        // Codex ACP can run via npx fallback now; do not block new sessions when the optional dep isn't installed.
        expect(issues).toEqual([]);
    });
});
