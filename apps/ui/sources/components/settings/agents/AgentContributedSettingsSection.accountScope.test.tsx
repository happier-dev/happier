import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginAccountSettingsMutationRequestV1Schema, PluginAccountSettingsMutationResponseV1Schema, PluginAccountSettingsReadResponseV1Schema } from '@happier-dev/protocol/plugins/settings/accountSettingsV1';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { resolveMachineAdministrationTargetState } from '@/sync/domains/machines/administration/targetSelection';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });
const account = createProviderSettingsAccountHarness();
const { AgentContributedSettingsSection } = await import('./AgentContributedSettingsSection');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { resolveScopedPluginSettingsServerIdentity } = await import('@/sync/domains/plugins/settings/scopedPluginSettingsRuntime');

const projection: PluginProjectionEntry = {
    pluginId: 'test.agent', title: 'Test Agent', description: null, version: '1.0.0', enabled: true,
    generation: null, generationLabel: null, status: null, provenance: null,
    diagnostics: [], actions: [], resources: [],
    editableSettingsGroups: [{
        id: 'preferences', pluginId: 'test.agent', version: 1, title: 'Preferences',
        scope: { kind: 'account' }, presentation: { sections: [], subagentSections: [] },
        target: { kind: 'agent', agent: { pluginId: 'test.agent', localId: 'agent' } },
        fields: [{
            key: 'enabled', control: 'switch', valueType: 'boolean', valueSchema: { type: 'boolean' },
            title: 'Enabled', secretCustody: null, redaction: 'none', clearWhenEmpty: 'persist',
        }],
    }],
};

function selection(foreign: boolean): MachineAdministrationTargetSelectionV1 {
    const selectedTarget = foreign ? { serverIdentityId: 'srv_foreign_home', machineId: 'foreign-machine' } : null;
    return {
        candidates: [], pickerRows: [], state: resolveMachineAdministrationTargetState({ storedTarget: selectedTarget, candidates: [] }),
        selectedTarget,
        selectedTargetServerMatchesActiveAccount: false, canExecute: false,
        selectTarget: () => {}, clearTarget: () => {}, resolveExecutionTarget: () => null,
    };
}

afterEach(async () => { standardCleanup(); await account.reset(); });

describe('Agent contributed Account preferences', () => {
    it.each([false, true])('admits Account preference editing with no machine, while refusing a foreign target (%s)', async foreign => {
        await account.restore({ machines: [], serverIdentityId: 'srv_agent_settings_home' });
        expect(captureActiveServerAccountScopeLifetime()?.isCurrent()).toBe(true);
        expect(resolveScopedPluginSettingsServerIdentity(getActiveServerSnapshot().serverId)).toBe('srv_agent_settings_home');
        // The Account HTTP leaf serves an absent plugin record; the real
        // scoped settings adapter/projection performs all admission and reads.
        account.home.answer(account.serverId, '/v1/account/plugin-settings/test.agent', {
            body: PluginAccountSettingsReadResponseV1Schema.parse({ status: 'absent' }),
        });
        account.home.answer(account.serverId, 'POST /v1/account/plugin-settings/test.agent', {
            body: PluginAccountSettingsMutationResponseV1Schema.parse({ status: 'updated', revision: 1 }),
        });
        const screen = await renderScreen(<AgentContributedSettingsSection
            pluginSettingsProjection={projection}
            targetSelection={selection(foreign)}
            executionTarget={null}
            daemonOperationsAvailable={false}
        />);
        await flushHookEffects();
        const control = screen.findByTestId('settings.plugins.detail.test.agent.settings.preferences.enabled');
        if (foreign) {
            expect(control).toBeNull();
            expect(screen.findByTestId('settings.plugins.detail.test.agent.settings.unavailable')).not.toBeNull();
        } else {
            expect(control, screen.getTextContent()).not.toBeNull();
            await screen.pressByTestIdAsync('settings.plugins.detail.test.agent.settings.preferences.enabled');
            await flushHookEffects();
            await vi.waitFor(() => expect(account.home.requestsFor('/v1/account/plugin-settings/test.agent')
                .some(request => PluginAccountSettingsMutationRequestV1Schema.safeParse(request.input).success)).toBe(true));
            const mutation = account.home.requestsFor('/v1/account/plugin-settings/test.agent')
                .filter(request => PluginAccountSettingsMutationRequestV1Schema.safeParse(request.input).success).at(-1);
            expect(mutation?.serverId).toBe(account.serverId);
            expect(PluginAccountSettingsMutationRequestV1Schema.parse(mutation?.input)).toEqual({
                expectedRevision: 'absent',
                content: { t: 'plain', v: { v: 1, values: { enabled: true } } },
            });
        }
    });

    it('edits the active Home override without a machine and preserves the Account default and other Homes', async () => {
        await account.restore({ machines: [], serverIdentityId: 'srv_agent_settings_home' });
        const path = '/v1/account/plugin-settings/test.agent';
        const values = {
            serverUrl: 'https://account-default.example.test',
            serverUrlByServerId: {
                srv_agent_settings_home: 'https://home.example.test',
                srv_other_home: 'https://other.example.test',
            },
        };
        account.home.answer(account.serverId, path, {
            body: PluginAccountSettingsReadResponseV1Schema.parse({
                status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, values } },
            }),
        });
        account.home.answer(account.serverId, `POST ${path}`, {
            body: PluginAccountSettingsMutationResponseV1Schema.parse({ status: 'updated', revision: 2 }),
        });
        const scopedProjection: PluginProjectionEntry = {
            ...projection,
            editableSettingsGroups: [{
                ...projection.editableSettingsGroups[0]!,
                fields: [{
                    key: 'serverUrl', control: 'text', valueType: 'string', valueSchema: { type: 'string' },
                    title: 'Server URL', secretCustody: null, redaction: 'none', clearWhenEmpty: 'persist',
                    presentation: {
                        control: 'text', binding: {
                            kind: 'perActiveServer', fallbackSettingId: 'serverUrl', byServerIdSettingId: 'serverUrlByServerId',
                        },
                    },
                }, {
                    key: 'serverUrlByServerId', control: 'json', valueType: 'object',
                    valueSchema: { type: 'object', additionalProperties: { type: 'string' } },
                    title: 'Home overrides', secretCustody: null, redaction: 'none', clearWhenEmpty: 'persist',
                    presentation: { control: 'json', hidden: true },
                }],
            }],
        };
        const screen = await renderScreen(<AgentContributedSettingsSection
            pluginSettingsProjection={scopedProjection}
            targetSelection={selection(false)}
            executionTarget={null}
            daemonOperationsAvailable={false}
        />);
        await flushHookEffects();
        const prefix = 'settings.plugins.detail.test.agent.settings.preferences.serverUrl';
        expect(screen.findByTestId(`${prefix}.input`)?.props.value).toBe('https://home.example.test');
        await act(async () => { screen.changeTextByTestId(`${prefix}.input`, 'https://updated-home.example.test'); });
        await act(async () => { screen.pressByTestId(`${prefix}.save`); });
        await flushHookEffects();
        await vi.waitFor(() => expect(account.home.requestsFor(path)
            .some(request => PluginAccountSettingsMutationRequestV1Schema.safeParse(request.input).success)).toBe(true));
        const mutation = account.home.requestsFor(path)
            .filter(request => PluginAccountSettingsMutationRequestV1Schema.safeParse(request.input).success).at(-1);
        expect(mutation?.serverId).toBe(account.serverId);
        expect(PluginAccountSettingsMutationRequestV1Schema.parse(mutation?.input)).toEqual({
            expectedRevision: 1,
            content: { t: 'plain', v: { v: 1, values: {
                ...values,
                serverUrlByServerId: { ...values.serverUrlByServerId, srv_agent_settings_home: 'https://updated-home.example.test' },
            } } },
        });
    });
});
