import { describe, expect, it } from 'vitest';
import { CODEX_ACP_DEP_ID, INSTALLABLE_KEYS } from '@happier-dev/protocol/installables';

import {
    getAgentResumeExperimentsFromSettings,
    getNewSessionPreflightIssues,
    getNewSessionRelevantInstallableDepKeys,
    resolveAgentPluginSettingsPreflightIssue,
} from './registryUiBehavior';
import { makeResults, makeSettings, okCapability } from './registryUiBehavior.testHelpers';

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

    it('returns codex installable deps based on codex backend mode', () => {
        const acp = makeSettings({ codexBackendMode: 'acp' });
        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'codex',
            settings: acp,
            experiments: getAgentResumeExperimentsFromSettings('codex', acp),
            resumeSessionId: '',
        })).toEqual([INSTALLABLE_KEYS.CODEX_ACP]);

        const mcp = makeSettings({ codexBackendMode: 'mcp' });
        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'codex',
            settings: mcp,
            experiments: getAgentResumeExperimentsFromSettings('codex', mcp),
            resumeSessionId: 'x1',
        })).toEqual([]);
    });

    it('returns empty for non-codex agents', () => {
        const settings = makeSettings({ codexBackendMode: 'acp' });
        expect(getNewSessionRelevantInstallableDepKeys({
            agentId: 'claude',
            settings,
            experiments: getAgentResumeExperimentsFromSettings('claude', settings),
            resumeSessionId: 'x1',
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
            confirmTextKey: 'common.openMachine',
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
        const settings = makeSettings({ codexBackendMode: 'acp' });
        const issues = getNewSessionPreflightIssues({
            agentId: 'codex',
            experiments: getAgentResumeExperimentsFromSettings('codex', settings),
            resumeSessionId: 'x1',
            results: makeResults({
                [CODEX_ACP_DEP_ID]: okCapability({ installed: false }),
            }),
        });
        // Codex ACP is handled via background install + daemon fresh-session fallback, so the wizard
        // should not hard-block when the optional dependency is not installed yet.
        expect(issues).toEqual([]);
    });
});
