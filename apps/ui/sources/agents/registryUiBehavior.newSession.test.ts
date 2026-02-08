import { describe, expect, it } from 'vitest';

import {
    getAgentResumeExperimentsFromSettings,
    getNewSessionPreflightIssues,
    getNewSessionRelevantInstallableDepKeys,
} from './registryUiBehavior';
import { makeResults, makeSettings, okCapability } from './registryUiBehavior.testHelpers';

describe('getNewSessionRelevantInstallableDepKeys', () => {
    it('returns codex deps based on current spawn extras', () => {
        const settings = makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: true });
        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', settings),
            resumeSessionId: 'x1',
        })).toEqual(['codex-mcp-resume', 'codex-acp']);

        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', settings),
            resumeSessionId: '',
        })).toEqual(['codex-acp']);
    });

    it('returns empty for non-codex agents and when experiments are disabled', () => {
        const settings = makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: true });
        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'claude',
            experiments: getAgentResumeExperimentsFromSettings('claude', settings),
            resumeSessionId: 'x1',
        })).toEqual([]);

        const disabled = makeSettings({ experiments: false, expCodexResume: true, expCodexAcp: true });
        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', disabled),
            resumeSessionId: 'x1',
        })).toEqual([]);
    });
});

describe('getNewSessionPreflightIssues', () => {
    it('returns codex preflight issues based on machine results (deps missing)', () => {
        const settings = makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: true });
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
        expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'codex-mcp-resume-not-installed' })]));
    });
});
