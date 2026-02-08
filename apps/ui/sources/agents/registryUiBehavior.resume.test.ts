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
    it('returns a blocking issue when codex resume is requested but the resume dep is not installed', () => {
        const settings = makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: false });
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

    it('returns a blocking issue when codex acp is requested but the acp dep is not installed', () => {
        const settings = makeSettings({ experiments: true, expCodexResume: false, expCodexAcp: true });
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

    it('returns empty when experiments are disabled or dep status is unknown', () => {
        const disabled = makeSettings({ experiments: false, expCodexResume: true, expCodexAcp: true });
        expect(getResumePreflightIssues({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', disabled),
            results: makeResults({
                'dep.codex-acp': okCapability({ installed: false }),
                'dep.codex-mcp-resume': okCapability({ installed: false }),
            }),
        })).toEqual([]);

        const unknown = makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: true });
        expect(getResumePreflightIssues({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', unknown),
            results: makeResults({}),
        })).toEqual([]);
    });

    it('returns empty for non-codex agents', () => {
        const settings = makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: true });
        expect(getResumePreflightIssues({
            agentId: 'claude',
            experiments: getAgentResumeExperimentsFromSettings('claude', settings),
            results: makeResults({}),
        })).toEqual([]);
    });
});

describe('buildResumeCapabilityOptionsFromUiState', () => {
    it('includes codex experimental resume and runtime resume support when detected', () => {
        const settings = makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: false });
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
        const settings = makeSettings({ experiments: false, expCodexResume: false, expCodexAcp: false });
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
    it('prefetches codex resume checklist only when codex experiments are enabled', () => {
        const disabled = makeSettings({ experiments: false, expCodexResume: true, expCodexAcp: true });
        expect(getResumePreflightPrefetchPlan({ agentId: 'codex', settings: disabled, results: undefined })).toEqual(null);

        const enabled = makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: false });
        expect(getResumePreflightPrefetchPlan({ agentId: 'codex', settings: enabled, results: undefined })).toEqual(
            expect.objectContaining({
                request: expect.objectContaining({ checklistId: expect.stringContaining('resume.codex') }),
            }),
        );
    });
});
