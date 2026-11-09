import { describe, expect, it } from 'vitest';
import { CODEX_ACP_DEP_ID, INSTALLABLE_KEYS } from '@happier-dev/protocol/installables';

import {
    getAgentResumeExperimentsFromSettings,
    getNewSessionPreflightIssues,
    getNewSessionRelevantInstallableDepKeys,
    resolveConfiguredAgentRuntimeKindFromUiBehavior,
    resolveAgentPluginSettingsPreflightIssue,
} from './registryUiBehavior';
import { makeResults, makeSettings, okCapability } from './registryUiBehavior.testHelpers';

describe('resolveConfiguredAgentRuntimeKindFromUiBehavior', () => {
    it.each([
        [true, 'unifiedTerminal'],
        [false, 'agentSdk'],
        [undefined, 'agentSdk'],
    ] as const)('resolves Claude runtime selection for %s', (enabled, expected) => {
        const account = enabled === undefined ? {} : { claudeUnifiedTerminalEnabled: enabled };
        expect(resolveConfiguredAgentRuntimeKindFromUiBehavior({
            agentId: 'claude',
            settings: makeSettings(),
            pluginSettings: { account },
        })).toBe(expected);
    });
});

describe('getNewSessionRelevantInstallableDepKeys', () => {
    it('uses the exact scoped Agent Settings snapshot over the legacy global value', () => {
        const settings = makeSettings({ codexBackendMode: 'acp' });
        const scoped = { account: { codexBackendMode: 'mcp' } };
        expect(getAgentResumeExperimentsFromSettings('codex', settings, 'machine-a', scoped)).toEqual({
            enabled: true,
            switches: { resumeAcp: false },
        });
        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'codex',
            settings,
            pluginSettings: scoped,
            experiments: getAgentResumeExperimentsFromSettings('codex', settings, 'machine-a', scoped),
            resumeSessionId: 'x1',
            machineId: 'machine-a',
        })).toEqual([]);
    });

    it('returns codex installable deps based on the scoped codex backend mode', () => {
        const settings = makeSettings();
        const acp = { account: { codexBackendMode: 'acp' } };
        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'codex',
            settings,
            pluginSettings: acp,
            experiments: getAgentResumeExperimentsFromSettings('codex', settings, 'machine-a', acp),
            resumeSessionId: '',
            machineId: 'machine-a',
        })).toEqual([INSTALLABLE_KEYS.CODEX_ACP]);

        const mcp = { account: { codexBackendMode: 'mcp' } };
        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'codex',
            settings,
            pluginSettings: mcp,
            experiments: getAgentResumeExperimentsFromSettings('codex', settings, 'machine-a', mcp),
            resumeSessionId: 'x1',
            machineId: 'machine-a',
        })).toEqual([]);
    });

    it('still honors a released flat account setting when no scoped record was loaded', () => {
        // A released Account persisted this value as a flat Settings root, and
        // availability is evaluated for Agents whose scoped record is not
        // loaded. Dropping the released carrier would silently move an upgraded
        // Account off ACP and hide the codex-acp installable.
        const released = makeSettings({ codexBackendMode: 'acp' });
        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'codex',
            settings: released,
            experiments: getAgentResumeExperimentsFromSettings('codex', released),
            resumeSessionId: '',
        })).toEqual([INSTALLABLE_KEYS.CODEX_ACP]);

        const releasedMcp = makeSettings({ codexBackendMode: 'mcp' });
        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'codex',
            settings: releasedMcp,
            experiments: getAgentResumeExperimentsFromSettings('codex', releasedMcp),
            resumeSessionId: 'x1',
        })).toEqual([]);
    });

    it('returns empty for non-codex agents', () => {
        const settings = makeSettings();
        const scoped = { account: { codexBackendMode: 'acp' } };
        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'claude',
            settings,
            pluginSettings: scoped,
            experiments: getAgentResumeExperimentsFromSettings('claude', settings, 'machine-a', scoped),
            resumeSessionId: 'x1',
            machineId: 'machine-a',
        })).toEqual([]);
    });
});

describe('getNewSessionPreflightIssues', () => {
    it('blocks a selected Agent while its exact scoped Settings record is loading', () => {
        expect(resolveAgentPluginSettingsPreflightIssue({
            ready: false,
            settled: false,
            loading: true,
            error: null,
        })).toEqual({
            id: 'agent-plugin-settings-loading',
            titleKey: 'settingsPlugins.genericSettingsTitle',
            messageKey: 'settingsPlugins.genericSettingsLoading',
            confirmTextKey: 'connect.openMachine',
            action: 'openMachine',
        });
        expect(getNewSessionPreflightIssues({
            agentId: 'codex',
            experiments: { enabled: true, switches: {} },
            resumeSessionId: '',
            results: undefined,
            pluginSettingsReadiness: {
                ready: false,
                settled: true,
                loading: false,
                error: 'failed',
            },
        })?.[0]?.messageKey).toBe('settingsPlugins.genericSettingsLoadError');
    });

    it('returns codex preflight issues based on machine results (deps missing)', () => {
        const settings = makeSettings();
        const pluginSettings = { account: { codexBackendMode: 'acp' } } as const;
        const issues = getNewSessionPreflightIssues({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', settings, null, pluginSettings),
            resumeSessionId: 'x1',
            results: makeResults({
                [CODEX_ACP_DEP_ID]: okCapability({ installed: false }),
            }),
            pluginSettings,
        });
        // Codex ACP is handled via background install + daemon fresh-session fallback, so the wizard
        // should not hard-block when the optional dependency is not installed yet.
        expect(issues).toEqual([]);
    });
});
