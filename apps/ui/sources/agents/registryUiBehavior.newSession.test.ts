import { describe, expect, it } from 'vitest';

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
        })).toEqual(['codex-mcp-resume']);

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
        })).toEqual(['codex-acp']);

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
                'dep.codex-mcp-resume': okCapability({ installed: false }),
                'dep.codex-acp': okCapability({ installed: false }),
            }),
        });
        expect(issues.length).toBeGreaterThan(0);
        expect(issues[0]).toEqual(expect.objectContaining({ id: 'codex-acp-not-installed' }));
        expect(issues).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'codex-mcp-resume-not-installed' })]));
    });
});
