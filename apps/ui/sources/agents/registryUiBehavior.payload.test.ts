import { describe, expect, it } from 'vitest';

import {
    buildResumeSessionExtrasFromUiState,
    buildSpawnSessionExtrasFromUiState,
    buildWakeResumeExtras,
} from './registryUiBehavior';
import { makeSettings } from './registryUiBehavior.testHelpers';

describe('buildSpawnSessionExtrasFromUiState', () => {
    it('enables codex resume only when spawning codex with a non-empty resume id', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: false }),
            resumeSessionId: 'x1',
        })).toEqual({
            experimentalCodexResume: true,
            experimentalCodexAcp: false,
        });

        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: false }),
            resumeSessionId: '   ',
        })).toEqual({
            experimentalCodexResume: false,
            experimentalCodexAcp: false,
        });
    });

    it('enables codex acp only when spawning codex and the flag is enabled', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ experiments: true, expCodexResume: false, expCodexAcp: true }),
            resumeSessionId: '',
        })).toEqual({
            experimentalCodexResume: false,
            experimentalCodexAcp: true,
        });
    });

    it('returns an empty object for non-codex agents', () => {
        expect(buildSpawnSessionExtrasFromUiState({
            agentId: 'claude',
            settings: makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: true }),
            resumeSessionId: 'x1',
        })).toEqual({});
    });
});

describe('buildResumeSessionExtrasFromUiState', () => {
    it('passes codex experiment flags through when experiments are enabled', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: false }),
        })).toEqual({
            experimentalCodexResume: true,
            experimentalCodexAcp: false,
        });
    });

    it('returns false flags when experiments are disabled', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'codex',
            settings: makeSettings({ experiments: false, expCodexResume: true, expCodexAcp: true }),
        })).toEqual({});
    });

    it('returns an empty object for non-codex agents', () => {
        expect(buildResumeSessionExtrasFromUiState({
            agentId: 'claude',
            settings: makeSettings({ experiments: true, expCodexResume: true, expCodexAcp: true }),
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
