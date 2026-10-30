import { describe, expect, it } from 'vitest';

import {
    findRunnerUnsupportedAuthoringField,
} from './runnerAuthoringCompatibility';

describe('Runner ordinary-authoring compatibility', () => {

    it('accepts only neutral defaults for conditionally unsupported selections', () => {
        expect(findRunnerUnsupportedAuthoringField({
            checkoutCreationDraft: null,
            transcriptStorage: 'persisted',
            profileId: null,
            environmentVariables: null,
            resumeSessionId: null,
            capabilitySelection: { mcp: {
                v: 1,
                managedServersEnabled: true,
                forceIncludeServerIds: [],
                forceExcludeServerIds: [],
            } },
            connectedServices: {
                v: 2,
                bindingsByServiceId: {
                    'happier.service.github/github': { source: 'native' },
                },
            },
            terminal: null,
            windowsRemoteSessionLaunchMode: null,
            windowsRemoteSessionConsole: null,
            windowsTerminalWindowName: null,
            runtimeDescriptorV1: null,
            automation: null,
        })).toBeNull();
    });

    it.each([
        ['transcriptStorage', { transcriptStorage: 'direct' }],
        ['runtimeDescriptorV1', { runtimeDescriptorV1: { v: 1 } }],
        ['automation', { automation: { enabled: true } }],
    ] as const)('returns the exact selected unsupported field %s', (field, authoring) => {
        expect(findRunnerUnsupportedAuthoringField(authoring)).toBe(field);
    });

    it('blocks Account Connected Services before activation until scoped brokering is available', () => {
        expect(findRunnerUnsupportedAuthoringField({ connectedServices: { v: 2, bindingsByServiceId: {
            'happier.service.github/github': { source: 'connected', selection: 'profile', profileId: 'work' },
        } } })).toBe('connectedServices');
    });

    it('allows explicit MCP selection for canonical portable materialization', () => {
        expect(findRunnerUnsupportedAuthoringField({
            capabilitySelection: { mcp: { v: 1, managedServersEnabled: false, forceIncludeServerIds: ['server-a'], forceExcludeServerIds: [] } },
        })).toBeNull();
    });

    it('accepts an exact profile identity and its activation-scoped environment snapshot', () => {
        expect(findRunnerUnsupportedAuthoringField({
            profileId: 'work',
            environmentVariables: {
                PATH: '/reviewed/bin',
                LANG: 'de_CH.UTF-8',
                RUNNER_PROFILE_TOKEN: 'sealed-secret',
            },
        })).toBeNull();
    });

    it.each([
        'HOME',
        'happier_home_dir',
        'XDG_CONFIG_HOME',
        'TMPDIR',
    ])('rejects the Runner-isolation environment override %s before activation', (key) => {
        expect(findRunnerUnsupportedAuthoringField({
            environmentVariables: { [key]: '/creator-selected' },
        })).toBe('environmentVariables');
    });

    it('rejects global and selected-Agent provider environment before activation', () => {
        expect(findRunnerUnsupportedAuthoringField({
            environmentVariables: { AZURE_OPENAI_API_KEY: 'direct-secret' },
        })).toBe('environmentVariables');
        expect(findRunnerUnsupportedAuthoringField({
            environmentVariables: { AZURE_OPENAI_API_VERSION: '2024-02-15-preview' },
        })).toBe('environmentVariables');
        expect(findRunnerUnsupportedAuthoringField({
            environmentVariables: { happier_codex_provider_api_key: 'direct-secret' },
        }, ['HAPPIER_CODEX_PROVIDER_API_KEY'])).toBe('environmentVariables');
    });

    it.each([
        ['windowsRemoteSessionLaunchMode', 'windows_terminal'],
        ['windowsRemoteSessionConsole', 'visible'],
        ['windowsTerminalWindowName', 'Happier'],
    ] as const)('rejects the selected unsupported Windows launch field %s before activation', (field, value) => {
        expect(findRunnerUnsupportedAuthoringField({ [field]: value })).toBe(field);
    });

    it('accepts checkout, Agent resume, and terminal selections for sealed review', () => {
        expect(findRunnerUnsupportedAuthoringField({
            checkoutCreationDraft: { kind: 'git_worktree', displayName: 'review', baseRef: 'main' },
            resumeSessionId: 'provider-session',
            terminal: { mode: 'tmux', tmux: { sessionName: 'reviewed' } },
        })).toBeNull();
    });
});
