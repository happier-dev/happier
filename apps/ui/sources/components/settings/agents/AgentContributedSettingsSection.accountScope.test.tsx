import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginAccountSettingsMutationRequestV1Schema, PluginAccountSettingsMutationResponseV1Schema, PluginAccountSettingsReadResponseV1Schema } from '@happier-dev/protocol/plugins/settings/accountSettingsV1';
import { PluginAccountAvailabilityIntentReadResponseV1Schema } from '@happier-dev/protocol/plugins/availability';
import { PluginSettingsContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/settings';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import type { MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { flushHookEffects, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
await vi.hoisted(async () => {
    const { installSettingsViewCommonModuleMocks } = await import('../settingsViewTestHelpers');
    installSettingsViewCommonModuleMocks({ storage: 'real', modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ confirmResult: true }).module;
    } });
});
vi.doUnmock('@/sync/domains/state/storage');
const { createProviderSettingsAccountHarness } = await import('@/dev/testkit/harness/providerSettingsHarness');
const account = createProviderSettingsAccountHarness();
const { resolveMachineAdministrationTargetState } = await import('@/sync/domains/machines/administration/targetSelection');
const { AgentContributedSettingsSection } = await import('./AgentContributedSettingsSection');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { resolveScopedPluginSettingsServerIdentity } = await import('@/sync/domains/plugins/settings/scopedPluginSettingsRuntime');
const { publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
const { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');

/**
 * The Account's installed release is the Settings authority the admitted Action reads; the
 * rendered projection alone never authorizes a write.
 */
function installAccountRelease(fields: readonly Record<string, unknown>[]) {
    const scope = getActiveServerAccountScope();
    if (!scope) throw new Error('Expected the applied Agent settings Account');
    const pluginId = 'test.agent';
    const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
        availabilityCursor: 1, hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
        intent: { pluginId, desiredVersion: '1.0.0', enabled: true, offlineUiHosting: 'enabled', writableCollections: [], revision: 'intent-1' },
        release: {
            ref: { pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest: { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Test Agent',
                engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {
                    settings: [PluginSettingsContributionV2Schema.parse({ id: 'preferences', title: 'Preferences', scope: 'account',
                        target: { kind: 'plugin' }, fields })],
                } },
            collectionContracts: [], uiSlots: [],
            packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] },
        }, packageAssets: [], uiArtifacts: [],
    });
    replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1,
        intentReads: [{ pluginId, response }], materializations: [], snapshots: [], inventoryComplete: true } });
}

async function openPreferences(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const disclosure = screen.findByTestId('settings.plugins.detail.test.agent.settings.preferences.disclosure');
    const header = disclosure?.findAll(node => node.props.accessibilityRole === 'button'
        && typeof node.props.onPress === 'function')[0];
    await pressTestInstanceAsync(header, 'Agent preferences disclosure header');
    await flushHookEffects();
}

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

afterEach(async () => { standardCleanup(); clearPluginAccountAvailabilityProjection(); await account.reset(); });

describe('Agent contributed Account preferences', () => {
    it('recovers Account preference availability after the same Home runtime returns without a machine change', async () => {
        await account.restore({ machines: [], serverIdentityId: 'srv_agent_settings_home' });
        account.home.answer(account.serverId, '/v1/account/plugin-settings/test.agent', {
            body: PluginAccountSettingsReadResponseV1Schema.parse({ status: 'absent' }),
        });
        publishAppliedActiveServerRuntimeAvailability(false);
        const screen = await renderScreen(<AgentContributedSettingsSection agentId="test.agent/agent"
            pluginSettingsProjection={projection}
            targetSelection={selection(false)}
            executionTarget={null}
            daemonOperationsAvailable={false}
        />);
        await flushHookEffects();
        expect(screen.findByTestId('settings.plugins.detail.test.agent.settings.unavailable')).not.toBeNull();
        await act(async () => { publishAppliedActiveServerRuntimeAvailability(true); });
        await flushHookEffects();
        expect(screen.findByTestId('settings.plugins.detail.test.agent.settings.unavailable') === null).toBe(true);
        await openPreferences(screen);
        expect(screen.findByTestId('settings.plugins.detail.test.agent.settings.preferences.enabled')).not.toBeNull();
    });

    it.each([false, true])('admits Account preference editing with no machine, while refusing a foreign target (%s)', async foreign => {
        await account.restore({ machines: [], serverIdentityId: 'srv_agent_settings_home' });
        expect(captureActiveServerAccountScopeLifetime()?.isCurrent()).toBe(true);
        expect(resolveScopedPluginSettingsServerIdentity(getActiveServerSnapshot().serverId)).toBe('srv_agent_settings_home');
        installAccountRelease([{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' } }]);
        // The Account HTTP leaf serves an absent plugin record; the real
        // scoped settings adapter/projection performs all admission and reads.
        account.home.answer(account.serverId, '/v1/account/plugin-settings/test.agent', {
            body: PluginAccountSettingsReadResponseV1Schema.parse({ status: 'absent' }),
        });
        account.home.answer(account.serverId, 'POST /v1/account/plugin-settings/test.agent', {
            body: PluginAccountSettingsMutationResponseV1Schema.parse({ status: 'updated', revision: 1 }),
        });
        const screen = await renderScreen(<AgentContributedSettingsSection agentId="test.agent/agent"
            pluginSettingsProjection={projection}
            targetSelection={selection(foreign)}
            executionTarget={null}
            daemonOperationsAvailable={false}
        />);
        await flushHookEffects();
        if (!foreign) {
            expect(screen.findByTestId('settings.plugins.detail.test.agent.settings.preferences.enabled')).toBeNull();
            await openPreferences(screen);
        }
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
        installAccountRelease([{
            id: 'serverUrl', title: 'Server URL', schema: { type: 'string' },
            presentation: { control: 'text', binding: { kind: 'perActiveServer', fallbackSettingId: 'serverUrl', byServerIdSettingId: 'serverUrlByServerId' } },
        }, {
            id: 'serverUrlByServerId', title: 'Home overrides', schema: { type: 'object', additionalProperties: { type: 'string' } },
            presentation: { control: 'json', hidden: true },
        }]);
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
        const screen = await renderScreen(<AgentContributedSettingsSection agentId="test.agent/agent"
            pluginSettingsProjection={scopedProjection}
            targetSelection={selection(false)}
            executionTarget={null}
            daemonOperationsAvailable={false}
        />);
        await flushHookEffects();
        const prefix = 'settings.plugins.detail.test.agent.settings.preferences.serverUrl';
        expect(screen.findByTestId(`${prefix}.input`)).toBeNull();
        await openPreferences(screen);
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
