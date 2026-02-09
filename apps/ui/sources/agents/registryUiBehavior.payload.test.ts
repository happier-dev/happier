import { describe, expect, it } from 'vitest';

import {
    buildResumeSessionExtrasFromUiState,
    buildSpawnSessionExtrasFromUiState,
    buildWakeResumeExtras,
} from './registryUiBehavior';
import { makeSettings } from './registryUiBehavior.testHelpers';

describe('buildSpawnSessionExtrasFromUiState', () => {
    it('enables codex MCP resume only when backend mode is mcp_resume and resume id is present', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'mcp_resume' }),
            resumeSessionId: 'x1',
        })).toEqual({
            experimentalCodexResume: true,
            experimentalCodexAcp: false,
        });

        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'mcp_resume' }),
            resumeSessionId: '   ',
        })).toEqual({
            experimentalCodexResume: false,
            experimentalCodexAcp: false,
        });
    });

    it('enables codex ACP only when backend mode is acp', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'acp' }),
            resumeSessionId: '',
        })).toEqual({
            experimentalCodexResume: false,
            experimentalCodexAcp: true,
        });
    });

    it('disables codex resume extras when backend mode is mcp', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'mcp' }),
            resumeSessionId: 'x1',
        })).toEqual({
            experimentalCodexResume: false,
            experimentalCodexAcp: false,
        });
    });

    it('returns an empty object for non-codex agents', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'claude',
            settings: makeSettings({ codexBackendMode: 'acp' }),
            resumeSessionId: 'x1',
        })).toEqual({});
    });
});

describe('buildResumeSessionExtrasFromUiState', () => {
    it('passes codex mode through to resume extras', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'mcp_resume' }),
        })).toEqual({
            experimentalCodexResume: true,
            experimentalCodexAcp: false,
        });

        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'acp' }),
        })).toEqual({
            experimentalCodexResume: false,
            experimentalCodexAcp: true,
        });

        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'mcp' }),
        })).toEqual({
            experimentalCodexResume: false,
            experimentalCodexAcp: false,
        });
    });

    it('returns an empty object for non-codex agents', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'claude',
            settings: makeSettings({ codexBackendMode: 'acp' }),
        })).toEqual({});
    });
});

describe('buildWakeResumeExtras', () => {
    it('adds experimentalCodexResume for codex wake payloads only', () => {
        expect(buildWakeResumeExtras({
            agentId: 'claude',
            resumeCapabilityOptions: { allowExperimentalResumeByAgentId: { codex: true } },
        })).toEqual({});
        expect(buildWakeResumeExtras({
            agentId: 'codex',
            resumeCapabilityOptions: { allowExperimentalResumeByAgentId: { codex: true } },
        })).toEqual({ experimentalCodexResume: true });
        expect(buildWakeResumeExtras({
            agentId: 'codex',
            resumeCapabilityOptions: {},
        })).toEqual({});
    });
});
