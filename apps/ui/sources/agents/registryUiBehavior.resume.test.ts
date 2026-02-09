import { describe, expect, it } from 'vitest';

import {
    buildResumeCapabilityOptionsFromUiState,
    getAgentResumeExperimentsFromSettings,
    getResumePreflightIssues,
    getResumePreflightPrefetchPlan,
    getResumeRuntimeSupportPrefetchPlan,
} from './registryUiBehavior';
import { makeResults, makeSettings, okCapability } from './registryUiBehavior.testHelpers';

describe('getResumePreflightIssues', () => {
    it('returns a blocking issue when codex backend mode is mcp_resume but the resume dep is not installed', () => {
        const settings = makeSettings({ codexBackendMode: 'mcp_resume' });
        expect(getResumePreflightIssues({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', settings),
            results: {
                'dep.codex-mcp-resume': { ok: true, checkedAt: 1, data: { installed: false } },
            },
        })).toEqual([
            expect.objectContaining({
                id: 'codex-mcp-resume-not-installed',
                action: 'openMachine',
            }),
        ]);
    });

    it('returns a blocking issue when codex backend mode is acp but the acp dep is not installed', () => {
        const settings = makeSettings({ codexBackendMode: 'acp' });
        expect(getResumePreflightIssues({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', settings),
            results: {
                'dep.codex-acp': { ok: true, checkedAt: 1, data: { installed: false } },
            },
        })).toEqual([
            expect.objectContaining({
                id: 'codex-acp-not-installed',
                action: 'openMachine',
            }),
        ]);
    });

    it('returns empty when deps are unknown', () => {
        const mcp = makeSettings({ codexBackendMode: 'mcp_resume' });
        expect(getResumePreflightIssues({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', mcp),
            results: makeResults({
                'dep.codex-acp': okCapability({ installed: false }),
                'dep.codex-mcp-resume': okCapability({ installed: false }),
            }),
        })).toEqual([
            expect.objectContaining({
                id: 'codex-mcp-resume-not-installed',
                action: 'openMachine',
            }),
        ]);

        const unknown = makeSettings({ codexBackendMode: 'acp' });
        expect(getResumePreflightIssues({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', unknown),
            results: makeResults({}),
        })).toEqual([]);
    });

    it('returns empty for non-codex agents', () => {
        const settings = makeSettings({ codexBackendMode: 'acp' });
        expect(getResumePreflightIssues({
            agentId: 'claude',
            experiments: getAgentResumeExperimentsFromSettings('claude', settings),
            results: makeResults({}),
        })).toEqual([]);
    });
});

describe('buildResumeCapabilityOptionsFromUiState', () => {
    it('includes codex experimental resume and runtime resume support when detected', () => {
        const settings = makeSettings({ codexBackendMode: 'mcp_resume' });
        expect(buildResumeCapabilityOptionsFromUiState({
            settings,
            results: makeResults({
                'cli.gemini': okCapability({ available: true, acp: { ok: true, loadSession: true } }),
            }),
        })).toEqual({
            allowExperimentalResumeByAgentId: { codex: true },
            allowRuntimeResumeByAgentId: { gemini: true },
        });
    });

    it('includes OpenCode runtime resume support when detected', () => {
        const settings = makeSettings({ codexBackendMode: 'mcp' });
        expect(buildResumeCapabilityOptionsFromUiState({
            settings,
            results: makeResults({
                'cli.opencode': okCapability({ available: true, acp: { ok: true, loadSession: true } }),
            }),
        })).toEqual({
            allowRuntimeResumeByAgentId: { opencode: true },
        });
    });
});

describe('getResumeRuntimeSupportPrefetchPlan', () => {
    it('prefetches runtime resume support when ACP data is missing', () => {
        const cases = [
            { agentId: 'gemini' as const, capabilityId: 'cli.gemini' },
            { agentId: 'opencode' as const, capabilityId: 'cli.opencode' },
        ];
        for (const testCase of cases) {
            expect(
                getResumeRuntimeSupportPrefetchPlan({
                    agentId: testCase.agentId,
                    settings: makeSettings(),
                    results: undefined,
                }),
            ).toEqual({
                request: {
                    requests: [
                        {
                            id: testCase.capabilityId,
                            params: { includeAcpCapabilities: true, includeLoginStatus: true },
                        },
                    ],
                },
                timeoutMs: 8_000,
            });
        }
    });
});

describe('getResumePreflightPrefetchPlan', () => {
    it('prefetches codex resume checklist when codex backend mode requires optional deps', () => {
        const mcp = makeSettings({ codexBackendMode: 'mcp' });
        expect(getResumePreflightPrefetchPlan({ agentId: 'codex', settings: mcp, results: undefined })).toEqual(null);

        const mcpResume = makeSettings({ codexBackendMode: 'mcp_resume' });
        expect(getResumePreflightPrefetchPlan({ agentId: 'codex', settings: mcpResume, results: undefined })).toEqual(
            expect.objectContaining({
                request: expect.objectContaining({ checklistId: expect.stringContaining('resume.codex') }),
            }),
        );

        const acp = makeSettings({ codexBackendMode: 'acp' });
        expect(getResumePreflightPrefetchPlan({ agentId: 'codex', settings: acp, results: undefined })).toEqual(
            expect.objectContaining({
                request: expect.objectContaining({ checklistId: expect.stringContaining('resume.codex') }),
            }),
        );
    });
});
