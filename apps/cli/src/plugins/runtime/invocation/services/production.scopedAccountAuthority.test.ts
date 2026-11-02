import { afterEach, describe, expect, it } from 'vitest';

import { accountSettingsParse, normalizeActionsSettingsV1, type PluginSettingsContributionV2 } from '@happier-dev/protocol';

import { createPluginAccountActionSettingsService } from '@happier-dev/cli-common/plugins/registration';
import { clearActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createAccountPluginSettingsRecordStorage } from '../../context/accountPluginSettingsRecordStorage';

import { createProductionPluginInvocationServiceOwners } from './production';

const accountSettingsDeclaration: PluginSettingsContributionV2 = {
    id: 'account-preferences',
    version: 1,
    title: 'Account preferences',
    target: { kind: 'plugin' },
    scope: 'account',
    fields: [{
        id: 'endpoint',
        title: 'Endpoint',
        schema: { type: 'string' },
    }],
    presentation: { sections: [], subagentSections: [] },
};

describe('production invocation services for a scoped principal', () => {
    afterEach(() => clearActiveAccountSettingsSnapshot());

    it('binds declared Account Settings only through the captured persistence producer', async () => {
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
            loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'unrelated-ambient-account' });
        const readCredentials = async () => ({ token: 'captured-token', encryption: null });
        let recordReads = 0;
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            accountCredentialAuthority: { readCredentials,
                actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1(undefined) } },
            settingsDeclarations: [{ pluginId: 'acme.plugin', contribution: accountSettingsDeclaration }],
            accountSettingsRecordAdapter: createAccountPluginSettingsRecordStorage({
                readCredentials, isCurrentAccount: () => true, resolveBaseUrl: () => 'https://captured.example',
                http: {
                    get: async (url, config) => {
                        expect(config.headers).toMatchObject({ Authorization: 'Bearer captured-token' });
                        if (url.endsWith('/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                        expect(url).toBe('https://captured.example/v1/account/plugin-settings/acme.plugin');
                        recordReads++;
                        return { status: 200, data: { status: 'present', revision: 4,
                            content: { t: 'plain', v: { v: 1, values: { endpoint: 'https://configured.example' } } } } };
                    },
                    post: async () => { throw new Error('Account Actions must expose only Settings reads'); },
                },
            }),
        });
        try {
            const services = owners.createServices({
                plugin: { id: 'acme.plugin', version: '1.0.0' },
                contribution: { id: 'run', qualifiedId: 'acme.plugin/actions/run' },
                occurrenceId: '1', correlationId: 'captured-settings', surface: 'cli',
                signal: new AbortController().signal, isOccurrenceCurrent: () => true,
            }, owners.createOrdinaryServiceBinding('1', 'captured-settings'));
            const reader = createPluginAccountActionSettingsService(services.settings).forScope({ kind: 'account' });
            await expect(reader.get('endpoint')).resolves.toBe('https://configured.example');
            expect(Object.keys(reader).sort()).toEqual(['describe', 'get', 'snapshot', 'watch']);
            expect(recordReads).toBe(1);
        } finally { await owners.dispose(); }
    });

    it('keeps ambient Account settings and secrets unavailable without a scoped Account-state producer', () => {
        const actionsSettingsProvider = {
            getActionsSettings: () => normalizeActionsSettingsV1({ v: 1, actions: {} }),
        };
        const owners = createProductionPluginInvocationServiceOwners({
            loggerSink: { write: () => {} },
            accountCredentialAuthority: {
                readCredentials: async () => ({ token: 'scoped-token', encryption: null }),
                actionsSettingsProvider,
            },
            settingsDeclarations: [{
                pluginId: 'acme.plugin',
                contribution: accountSettingsDeclaration,
            }],
            secretDeclarations: [{
                pluginId: 'acme.plugin',
                declaration: { id: 'account-token', custody: 'account' },
            }],
        });
        const services = owners.createServices({
            plugin: { id: 'acme.plugin', version: '1.0.0' },
            contribution: { id: 'run', qualifiedId: 'acme.plugin/actions/run' },
            occurrenceId: 'occurrenceId-1',
            correlationId: 'correlation-1',
            surface: 'cli',
            signal: new AbortController().signal,
            isOccurrenceCurrent: () => true,
        }, owners.createOrdinaryServiceBinding('occurrenceId-1', 'binding-1'));

        expect(services.availability('settings')).toEqual({
            status: 'unavailable',
            code: 'plugin_service_unavailable',
        });
        expect(services.availability('secrets')).toEqual({
            status: 'unavailable',
            code: 'plugin_service_unavailable',
        });
    });
});
