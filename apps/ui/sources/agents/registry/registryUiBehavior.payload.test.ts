import { describe, expect, it } from 'vitest';

import {
    buildResumeSessionExtrasFromUiState,
    buildSpawnEnvironmentVariablesFromUiState,
    buildSpawnSessionExtrasFromUiState,
    buildWakeResumeExtras,
} from './registryUiBehavior';
import { makeSettings } from './registryUiBehavior.testHelpers';

describe('buildSpawnSessionExtrasFromUiState', () => {
    it('enables codex ACP only when backend mode is acp', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'acp' }),
            resumeSessionId: '',
        })).toEqual({
            experimentalCodexAcp: true,
        });
    });

    it('disables codex ACP when backend mode is mcp', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'mcp' }),
            resumeSessionId: 'x1',
        })).toEqual({
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
            settings: makeSettings({ codexBackendMode: 'acp' }),
        })).toEqual({
            experimentalCodexAcp: true,
        });

        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ codexBackendMode: 'mcp' }),
        })).toEqual({
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
    it('adds experimentalCodexAcp for codex wake payloads only', () => {
        expect(buildWakeResumeExtras({
            agentId: 'claude',
            resumeCapabilityOptions: { accountSettings: makeSettings({ codexBackendMode: 'acp' }) },
        })).toEqual({});
        expect(buildWakeResumeExtras({
            agentId: 'codex',
            resumeCapabilityOptions: { accountSettings: makeSettings({ codexBackendMode: 'acp' }) },
        })).toEqual({ experimentalCodexAcp: true });
        expect(buildWakeResumeExtras({
            agentId: 'codex',
            resumeCapabilityOptions: { accountSettings: makeSettings({ codexBackendMode: 'mcp' }) },
        })).toEqual({});
    });
});

describe('buildSpawnEnvironmentVariablesFromUiState', () => {
    it('injects OpenCode backend mode env var while preserving existing env', () => {
        expect(buildSpawnEnvironmentVariablesFromUiState({
            agentId: 'opencode',
            settings: makeSettings({ opencodeBackendMode: 'acp' as any }),
            environmentVariables: { FOO: '1' },
            newSessionOptions: null,
        })).toEqual({
            FOO: '1',
            HAPPIER_OPENCODE_BACKEND_MODE: 'acp',
        });

        expect(buildSpawnEnvironmentVariablesFromUiState({
            agentId: 'opencode',
            settings: makeSettings({ opencodeBackendMode: 'server' as any }),
            environmentVariables: undefined,
            newSessionOptions: null,
        })).toEqual({
            HAPPIER_OPENCODE_BACKEND_MODE: 'server',
        });
    });

    it('returns the input env for non-OpenCode agents', () => {
        expect(buildSpawnEnvironmentVariablesFromUiState({
            agentId: 'claude',
            settings: makeSettings({ opencodeBackendMode: 'acp' as any }),
            environmentVariables: { FOO: '1' },
            newSessionOptions: null,
        })).toEqual({ FOO: '1' });
    });
});
