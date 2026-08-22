import * as React from 'react';
import { Pressable } from 'react-native';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';

import type {
    PluginProjectionEditableSettingField,
    PluginProjectionEntry,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { createDeferred, flattenTestStyle, renderScreen } from '@/dev/testkit';
import type {
    MachinePluginSecretDeleteResult,
    MachinePluginSecretSetResult,
    MachinePluginSecretStatusResult,
    MachinePluginSettingsResult,
    MachinePluginSettingsSetResult,
} from '@/sync/ops/machineContributionRegistryProjection';
import type {
    ScopedPluginDaemonSecretReadInput,
    ScopedPluginDaemonSecretWriteResult,
    ScopedPluginDaemonSecretWriteInput,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

const machinePluginSettingsGetMock = vi.hoisted(() => vi.fn());
const machinePluginSettingsSetMock = vi.hoisted(() => vi.fn());
const machinePluginSecretStatusMock = vi.hoisted(() => vi.fn());
const machinePluginSecretSetMock = vi.hoisted(() => vi.fn());
const machinePluginSecretDeleteMock = vi.hoisted(() => vi.fn());
const accountPluginSecretReadMock = vi.hoisted(() => vi.fn());
const accountPluginSecretWriteMock = vi.hoisted(() => vi.fn());
const modalShowMock = vi.hoisted(() => vi.fn());
const scopedSettingsWatchMock = vi.hoisted(() => vi.fn());
const scopedSettingsReadMock = vi.hoisted(() => vi.fn());
const scopedSettingsWriteMock = vi.hoisted(() => vi.fn());
const scopedDaemonSecretReadMock = vi.hoisted(() => vi.fn());
const scopedDaemonSecretWriteMock = vi.hoisted(() => vi.fn());
const platformEnvironment = vi.hoisted(() => ({
    platform: 'web' as 'web' | 'ios' | 'android',
}));
const activeAccountLifetimeState = vi.hoisted(() => ({
    current: null as ActiveServerAccountScopeLifetime | null,
}));

installSettingsViewCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { show: modalShowMock } }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformEnvironment.platform;
                },
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
    machinePluginSettingsGet: (...args: unknown[]) => machinePluginSettingsGetMock(...args),
    machinePluginSettingsSet: (...args: unknown[]) => machinePluginSettingsSetMock(...args),
    machinePluginSecretStatus: (...args: unknown[]) => machinePluginSecretStatusMock(...args),
    machinePluginSecretSet: (...args: unknown[]) => machinePluginSecretSetMock(...args),
    machinePluginSecretDelete: (...args: unknown[]) => machinePluginSecretDeleteMock(...args),
}));

vi.mock('@/sync/domains/plugins/settings/scopedPluginSettingsRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/plugins/settings/scopedPluginSettingsRuntime')>();
    return {
        ...actual,
        resolveScopedPluginSettingsServerIdentity: () => 'server-identity-1',
        scopedPluginSettingsAdapter: {
            ...actual.scopedPluginSettingsAdapter,
            read: (...args: Parameters<typeof actual.scopedPluginSettingsAdapter.read>) => {
                const result = scopedSettingsReadMock(...args);
                return result === undefined
                    ? actual.scopedPluginSettingsAdapter.read(...args)
                    : result;
            },
            write: (...args: Parameters<typeof actual.scopedPluginSettingsAdapter.write>) => {
                const result = scopedSettingsWriteMock(...args);
                return result === undefined
                    ? actual.scopedPluginSettingsAdapter.write(...args)
                    : result;
            },
            daemonSecret: {
                read: (...args: Parameters<NonNullable<typeof actual.scopedPluginSettingsAdapter.daemonSecret>['read']>) => {
                    const result = scopedDaemonSecretReadMock(...args);
                    return result === undefined
                        ? actual.scopedPluginSettingsAdapter.daemonSecret!.read(...args)
                        : result;
                },
                write: (...args: Parameters<NonNullable<typeof actual.scopedPluginSettingsAdapter.daemonSecret>['write']>) => {
                    const result = scopedDaemonSecretWriteMock(...args);
                    return result === undefined
                        ? actual.scopedPluginSettingsAdapter.daemonSecret!.write(...args)
                        : result;
                },
            },
            watch: (...args: unknown[]) => scopedSettingsWatchMock(...args),
        },
        scopedPluginAccountSecretSettingsAdapter: {
            read: (...args: unknown[]) => accountPluginSecretReadMock(...args),
            write: (...args: unknown[]) => accountPluginSecretWriteMock(...args),
        },
    };
});

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({
        serverId: 'server-1',
        serverUrl: 'https://server-1.example.test',
        generation: 1,
    }),
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => activeAccountLifetimeState.current,
}));

const PLUGIN_ID = 'acme.hooks';
const GROUP_ID = 'acme.hooks.settings';
const OPENCODE_PLUGIN_ID = 'happier.agent.opencode';
const OPENCODE_GROUP_ID = 'agent-settings';
const OPENCODE_SERVER_PASSWORD_SETTING_ID = 'opencodeServerPassword';
const ENDPOINT_INPUT_ID = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.endpoint.input`;
const ENDPOINT_SAVE_ID = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.endpoint.save`;
const SECRET_INPUT_ID = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.apiToken.input`;
const SECRET_SAVE_ID = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.apiToken.save`;
const SECRET_DELETE_ID = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.apiToken.delete`;
const SECRET_STATUS_ID = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.apiToken.status`;
const SWITCH_ID = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.enabled`;
const RECOVERY_SECRET_INPUT_ID = `settings.plugins.detail.${PLUGIN_ID}.settings.account-recovery.apiToken.input`;
const RECOVERY_DAEMON_SECRET_INPUT_ID = `settings.plugins.detail.${PLUGIN_ID}.settings.daemon-recovery.daemonToken.input`;
const ACCOUNT_SECRET_INPUT_ID = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.accountToken.input`;
const ACCOUNT_SECRET_SAVE_ID = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.accountToken.save`;
const ACCOUNT_SECRET_DELETE_ID = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.accountToken.delete`;
const ACCOUNT_SECRET_UNBIND_ID = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.accountToken.unbind`;
const ACCOUNT_SECRET_STATUS_ID = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.accountToken.status`;
const OPENCODE_SECRET_INPUT_ID = `settings.plugins.detail.${OPENCODE_PLUGIN_ID}.settings.${OPENCODE_GROUP_ID}.${OPENCODE_SERVER_PASSWORD_SETTING_ID}.input`;
const OPENCODE_SECRET_SAVE_ID = `settings.plugins.detail.${OPENCODE_PLUGIN_ID}.settings.${OPENCODE_GROUP_ID}.${OPENCODE_SERVER_PASSWORD_SETTING_ID}.save`;
const OPENCODE_SECRET_STATUS_ID = `settings.plugins.detail.${OPENCODE_PLUGIN_ID}.settings.${OPENCODE_GROUP_ID}.${OPENCODE_SERVER_PASSWORD_SETTING_ID}.status`;
const EXTERNAL_NOTIFICATION_PLUGIN_ID = 'examples.action-contract-producer';
const EXTERNAL_NOTIFICATION_GROUP_ID = 'notification-channel/webhook';
const EXTERNAL_NOTIFICATION_SECTION_ID = `${EXTERNAL_NOTIFICATION_GROUP_ID}/configuration`;
const EXTERNAL_NOTIFICATION_ENDPOINT_FIELD_ID = 'webhook.endpoint';
const EXTERNAL_NOTIFICATION_ENDPOINT_INPUT_ID = `settings.plugins.detail.${EXTERNAL_NOTIFICATION_PLUGIN_ID}.settings.${EXTERNAL_NOTIFICATION_SECTION_ID}.${EXTERNAL_NOTIFICATION_ENDPOINT_FIELD_ID}.input`;
const EXTERNAL_NOTIFICATION_ENDPOINT_SAVE_ID = `settings.plugins.detail.${EXTERNAL_NOTIFICATION_PLUGIN_ID}.settings.${EXTERNAL_NOTIFICATION_SECTION_ID}.${EXTERNAL_NOTIFICATION_ENDPOINT_FIELD_ID}.save`;

const ACCOUNT_RECOVERY_DECLARATION: PluginPortableReleaseManifestV1 = PluginManifestV2Schema.parse({
    schemaVersion: 2,
    id: PLUGIN_ID,
    version: '1.0.0',
    displayName: 'Acme hooks',
    engines: { happier: '^1.0.0' },
    runtime: { apiVersion: 1 },
    contributes: {
        settings: [{
            id: 'account-recovery',
            version: 1,
            title: 'Account recovery',
            target: { kind: 'plugin' },
            scope: 'account',
            fields: [{
                id: 'apiToken',
                title: 'API token',
                schema: { type: 'string' },
                secret: true,
            }],
        }, {
            id: 'daemon-recovery',
            version: 1,
            title: 'Daemon recovery',
            target: { kind: 'plugin' },
            scope: 'daemon',
            fields: [{
                id: 'daemonToken',
                title: 'Daemon token',
                schema: { type: 'string' },
                secret: { custody: 'daemon' },
            }],
        }],
    },
});

const SETTINGS_FIELDS: readonly PluginProjectionEditableSettingField[] = [
    {
        key: 'endpoint',
        control: 'text',
        valueType: 'string',
        valueSchema: { type: 'string' },
        title: 'Endpoint URL',
        subtitle: 'Used when hook handlers call the remote API.',
        order: 1,
        groupId: null,
        secretCustody: null,
        redaction: 'none',
        clearWhenEmpty: 'persist',
    },
    {
        key: 'apiToken',
        control: 'password',
        valueType: 'string',
        valueSchema: { type: 'string' },
        title: 'API token',
        subtitle: 'Stored locally for this plugin.',
        order: 2,
        groupId: null,
        secretCustody: 'daemon',
        redaction: 'secret',
        clearWhenEmpty: 'omit',
    },
    {
        key: 'enabled',
        control: 'switch',
        valueType: 'boolean',
        valueSchema: { type: 'boolean' },
        title: 'Enable hooks',
        subtitle: null,
        order: 3,
        groupId: null,
        secretCustody: null,
        redaction: 'none',
        clearWhenEmpty: 'persist',
        defaultBooleanValue: true,
    },
];

const ACCOUNT_SECRET_FIELD: PluginProjectionEditableSettingField = {
    key: 'accountToken',
    control: 'password',
    valueType: 'string',
    valueSchema: { type: 'string' },
    title: 'Account token',
    subtitle: 'Stored in Account SavedSecret custody.',
    order: 2,
    groupId: null,
    secretCustody: 'account',
    redaction: 'secret',
    clearWhenEmpty: 'omit',
};

function createProjection(
    generation: number,
    fields: readonly PluginProjectionEditableSettingField[] = SETTINGS_FIELDS,
    scope: 'account' | 'daemon' = 'daemon',
): PluginProjectionEntry {
    return {
        pluginId: PLUGIN_ID,
        immutableGenerationId: `generation-${generation}`,
        title: 'Acme hooks',
        description: null,
        version: '1.0.0',
        enabled: true,
        generation,
        generationLabel: String(generation),
        status: null,
        provenance: null,
        diagnostics: [],
        actions: [],
        resources: [],
        editableSettingsGroups: [{
            id: GROUP_ID,
            pluginId: PLUGIN_ID,
            version: 1,
            title: 'Acme hook settings',
            scope: { kind: scope },
            presentation: { sections: [], subagentSections: [] },
            target: { kind: 'plugin' },
            fields,
        }],
    };
}

/** Exact daemon-projected shape produced for an external channel's Account settings. */
function createExternalNotificationChannelProjection(): PluginProjectionEntry {
    return {
        pluginId: EXTERNAL_NOTIFICATION_PLUGIN_ID,
        immutableGenerationId: 'external-notification-generation-1',
        title: 'Document Reviewer Target',
        description: null,
        version: '0.1.0',
        enabled: true,
        generation: 1,
        generationLabel: '1',
        status: null,
        provenance: {
            sourceKind: 'package',
            sourceLabel: '@example/happier-action-contract-producer',
            trustPolicy: 'trusted',
        },
        diagnostics: [],
        actions: [],
        resources: [],
        editableSettingsGroups: [{
            id: EXTERNAL_NOTIFICATION_GROUP_ID,
            pluginId: EXTERNAL_NOTIFICATION_PLUGIN_ID,
            version: 1,
            title: 'Document review webhook',
            scope: { kind: 'account' },
            presentation: {
                sections: [{
                    id: 'configuration',
                    title: 'Document review webhook',
                    fields: [EXTERNAL_NOTIFICATION_ENDPOINT_FIELD_ID],
                }],
                subagentSections: [],
            },
            target: { kind: 'plugin' },
            fields: [{
                key: EXTERNAL_NOTIFICATION_ENDPOINT_FIELD_ID,
                control: 'text',
                valueType: 'string',
                valueSchema: { type: 'string', minLength: 1 },
                title: 'Webhook URL',
                secretCustody: null,
                redaction: 'none',
                clearWhenEmpty: 'persist',
            }],
        }],
    };
}

function createOpenCodeProjection(): PluginProjectionEntry {
    return {
        pluginId: OPENCODE_PLUGIN_ID,
        title: 'OpenCode',
        description: null,
        version: '1.0.0',
        enabled: true,
        generation: 1,
        generationLabel: '1',
        status: null,
        provenance: null,
        diagnostics: [],
        actions: [],
        resources: [],
        editableSettingsGroups: [{
            id: OPENCODE_GROUP_ID,
            pluginId: OPENCODE_PLUGIN_ID,
            version: 1,
            title: 'OpenCode',
            scope: { kind: 'account' },
            presentation: { sections: [], subagentSections: [] },
            target: {
                kind: 'agent',
                agent: { pluginId: OPENCODE_PLUGIN_ID, localId: 'opencode' },
            },
            fields: [{
                key: 'opencodeServerBaseUrl',
                control: 'text',
                valueType: 'string',
                valueSchema: { type: 'string' },
                title: 'Existing OpenCode server URL',
                subtitle: 'Optional OpenCode server URL.',
                secretCustody: null,
                redaction: 'none',
                clearWhenEmpty: 'persist',
                presentation: {
                    control: 'text',
                    binding: {
                        kind: 'perActiveServer',
                        fallbackSettingId: 'opencodeServerBaseUrl',
                        byServerIdSettingId: 'opencodeServerBaseUrlByServerIdV1',
                    },
                },
            }, {
                key: OPENCODE_SERVER_PASSWORD_SETTING_ID,
                control: 'password',
                valueType: 'string',
                valueSchema: { type: 'string' },
                title: 'Existing OpenCode server password',
                subtitle: 'Stored encrypted on this machine and never synced.',
                secretCustody: 'daemon',
                managedServiceOrigin: { endpointSettingId: 'opencodeServerBaseUrl' },
                redaction: 'secret',
                clearWhenEmpty: 'omit',
            }],
        }],
    };
}

function settingsResult(
    values: Readonly<Record<string, unknown>>,
    redactedKeys: readonly string[] = ['apiToken'],
    revision = '0',
    pluginId = PLUGIN_ID,
): Extract<MachinePluginSettingsResult, { supported: true }> {
    return {
        supported: true,
        snapshot: {
            protocolVersion: 1,
            pluginId,
            scope: { kind: 'daemon' },
            revision,
            values,
            redactedKeys: [...redactedKeys],
        },
    };
}

function settingsSetResult(
    values: Readonly<Record<string, unknown>>,
    redactedKeys: readonly string[] = ['apiToken'],
    revision = '0',
    pluginId = PLUGIN_ID,
): Extract<MachinePluginSettingsSetResult, { supported: true }> {
    return {
        supported: true,
        result: {
            status: 'applied',
            snapshot: settingsResult(values, redactedKeys, revision, pluginId).snapshot,
        },
    };
}

function secretStatusResult(
    state: 'configured' | 'missing' | 'denied' | 'unavailable',
    revision = 'origin-0',
    pluginId = PLUGIN_ID,
    secretId = 'apiToken',
): Extract<MachinePluginSecretStatusResult, { supported: true }> {
    return {
        supported: true,
        result: {
            protocolVersion: 1,
            pluginId,
            secretId,
            state,
            revision,
        },
    };
}

function secretSetResult(
    state: 'configured' | 'missing' | 'denied' | 'unavailable',
    revision = 'origin-0',
): Extract<MachinePluginSecretSetResult, { supported: true }> {
    return { supported: true, result: secretStatusResult(state, revision).result };
}

function secretDeleteResult(
    state: 'configured' | 'missing' | 'denied' | 'unavailable',
    revision = 'origin-0',
): Extract<MachinePluginSecretDeleteResult, { supported: true }> {
    return { supported: true, result: secretStatusResult(state, revision).result };
}

function scopedDaemonSecretReady(input: Readonly<{
    target: Readonly<{
        kind: 'daemon';
        serverIdentityId: string;
        machineId: string;
        serverId: string;
    }>;
    pluginId: string;
    secretId: string;
}>, state: 'configured' | 'missing' | 'denied' | 'unavailable', revision: string) {
    return {
        status: 'ready' as const,
        snapshot: {
            target: input.target,
            pluginId: input.pluginId,
            secretId: input.secretId,
            state,
            revision,
        },
    };
}

function createTestAccountLifetime(params: Readonly<{ accountId?: string }> = {}): ActiveServerAccountScopeLifetime {
    return Object.freeze({
        scope: Object.freeze({ serverId: 'server-1', accountId: params.accountId ?? 'account-1' }),
        isCurrent: () => true,
        onRetire: () => Object.freeze({ dispose(): void {} }),
    });
}

function createRetirableTestAccountLifetime(accountId = 'account-a'): Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    invalidate(): void;
    retire(): void;
}> {
    let current = true;
    const cancellations = new Set<() => void>();
    const lifetime = Object.freeze({
        scope: Object.freeze({ serverId: 'server-1', accountId }),
        isCurrent: () => current,
        onRetire: (cancel: () => void) => {
            cancellations.add(cancel);
            return Object.freeze({
                dispose: () => cancellations.delete(cancel),
            });
        },
    });
    return Object.freeze({
        lifetime,
        invalidate: () => {
            current = false;
        },
        retire: () => {
            current = false;
            for (const cancel of cancellations) cancel();
            cancellations.clear();
        },
    });
}

function readyOpenCodeAccountSettings(
    selectedEndpoint: string,
    target: Readonly<{ kind: 'account'; serverIdentityId: string }> = {
        kind: 'account',
        serverIdentityId: 'server-identity-1',
    },
) {
    return {
        status: 'ready' as const,
        snapshot: {
            scope: { kind: 'account' as const },
            target,
            revision: { kind: 'account' as const, value: 3 },
            values: {
                opencodeServerBaseUrl: 'https://fallback.example.test',
                opencodeServerBaseUrlByServerIdV1: {
                    'server-identity-1': selectedEndpoint,
                },
            },
        },
    };
}

const unsupportedResult: MachinePluginSettingsResult = {
    supported: false,
    reason: 'error',
};

const unsupportedSetResult: MachinePluginSettingsSetResult = {
    supported: false,
    reason: 'error',
};

async function flushAsync(): Promise<void> {
    await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
}

async function renderSection(
    projection: PluginProjectionEntry | null = createProjection(1),
    options: Readonly<{
        accountSettingsDeclaration?: PluginPortableReleaseManifestV1 | null;
        daemonOperationsAvailable?: boolean;
        isDaemonTargetCurrent?: (target: Readonly<{
            kind: 'daemon';
            machineId: string;
            serverId: string;
            serverIdentityId: string;
        }>) => boolean;
        machineId?: string | null;
        serverId?: string | null;
        daemonServerIdentityId?: string | null;
    }> = {},
) {
    const { PluginDetailGenericSettingsSection } = await import('./PluginDetailGenericSettingsSection');
    const pluginId = projection?.pluginId ?? PLUGIN_ID;
    const element = (
        <PluginDetailGenericSettingsSection
            pluginId={pluginId}
            projection={projection}
            accountSettingsDeclaration={options.accountSettingsDeclaration}
            machineId={options.machineId === undefined ? 'machine-1' : options.machineId}
            serverId={options.serverId === undefined ? 'server-1' : options.serverId}
            accountServerIdentityId="server-identity-1"
            daemonServerIdentityId={options.daemonServerIdentityId === undefined
                ? 'server-identity-1'
                : options.daemonServerIdentityId}
            daemonOperationsAvailable={options.daemonOperationsAvailable ?? true}
            isDaemonTargetCurrent={options.isDaemonTargetCurrent}
        />
    );
    const screen = await renderScreen(element);
    await flushAsync();
    return { PluginDetailGenericSettingsSection, element, screen };
}

function findSwitch(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen.findAll((node) => (
        typeof node.props?.onValueChange === 'function'
        && typeof node.props?.value === 'boolean'
    ))[0] ?? null;
}

function hasPressableTestIdAncestor(
    node: ReturnType<typeof findSwitch>,
    testID: string,
): boolean {
    let ancestor = node?.parent ?? null;
    while (ancestor) {
        if (ancestor.type === Pressable && ancestor.props?.testID === testID) return true;
        ancestor = ancestor.parent;
    }
    return false;
}

describe('PluginDetailGenericSettingsSection', () => {
    beforeEach(() => {
        platformEnvironment.platform = 'web';
        activeAccountLifetimeState.current = createTestAccountLifetime();
        machinePluginSettingsGetMock.mockReset();
        machinePluginSettingsSetMock.mockReset();
        machinePluginSecretStatusMock.mockReset();
        machinePluginSecretSetMock.mockReset();
        machinePluginSecretDeleteMock.mockReset();
        machinePluginSecretStatusMock.mockResolvedValue(secretStatusResult('missing'));
        machinePluginSecretSetMock.mockResolvedValue(secretSetResult('configured', 'origin-1'));
        machinePluginSecretDeleteMock.mockResolvedValue(secretDeleteResult('missing', 'origin-2'));
        scopedSettingsWatchMock.mockReset();
        scopedSettingsWatchMock.mockReturnValue({ dispose: vi.fn() });
        scopedSettingsReadMock.mockReset();
        scopedSettingsWriteMock.mockReset();
        scopedDaemonSecretReadMock.mockReset();
        scopedDaemonSecretWriteMock.mockReset();
        machinePluginSettingsGetMock.mockResolvedValue(settingsResult({
            endpoint: 'https://api.example.test',
            apiToken: 'must-not-render',
            enabled: true,
        }));
        accountPluginSecretReadMock.mockReset();
        accountPluginSecretWriteMock.mockReset();
        modalShowMock.mockReset();
        accountPluginSecretReadMock.mockResolvedValue({
            status: 'ready',
            snapshot: {
                scope: { kind: 'account' },
                target: { kind: 'account', serverIdentityId: 'server-identity-1' },
                revision: { kind: 'account-secret', value: 5 },
                values: {},
                secretStates: { apiToken: 'configured', accountToken: 'configured' },
            },
        });
        accountPluginSecretWriteMock.mockResolvedValue({
            status: 'ready',
            snapshot: {
                scope: { kind: 'account' },
                target: { kind: 'account', serverIdentityId: 'server-identity-1' },
                revision: { kind: 'account-secret', value: 6 },
                values: {},
                secretStates: { apiToken: 'configured', accountToken: 'configured' },
            },
        });
    });

    it('refreshes mounted generic and declarative Settings consumers from one shared record watch', async () => {
        let endpoint = 'https://before.example.test';
        let revision = '0';
        let invalidate: (() => void) | null = null;
        machinePluginSettingsGetMock.mockImplementation(() => Promise.resolve(settingsResult(
            { endpoint },
            [],
            revision,
        )));
        scopedSettingsWatchMock.mockImplementation((input: Readonly<{ onInvalidated(): void }>) => {
            invalidate = input.onInvalidated;
            return { dispose: vi.fn() };
        });
        const { PluginDetailGenericSettingsSection } = await import('./PluginDetailGenericSettingsSection');
        const { DeclarativePluginSurface } = await import('@/components/plugins/surfaces/DeclarativePluginSurface');
        const screen = await renderScreen(
            <>
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={createProjection(1, [SETTINGS_FIELDS[0]!])}
                    machineId="machine-1"
                    serverId="server-1"
                    accountServerIdentityId="server-identity-1"
                    daemonServerIdentityId="server-identity-1"
                    daemonOperationsAvailable
                />
                <DeclarativePluginSurface
                    pluginId={PLUGIN_ID}
                    model={{
                        identity: {
                            pluginId: PLUGIN_ID,
                            localId: 'shared-settings',
                            qualifiedId: `${PLUGIN_ID}/shared-settings`,
                            generation: '1',
                        },
                        visible: true,
                        requiredHostMethods: [],
                        nodes: [],
                        root: {
                            kind: 'group',
                            path: 'root',
                            order: 0,
                            children: [{
                                kind: 'field',
                                path: 'root.endpoint',
                                order: 1,
                                label: 'Endpoint',
                                control: { kind: 'text', settingId: 'endpoint' },
                                setting: {
                                    id: 'endpoint',
                                    descriptor: { scope: 'daemon', schema: { type: 'string' } },
                                },
                            }],
                        },
                    }}
                    machineId="machine-1"
                    serverId="server-1"
                    accountLifetime={activeAccountLifetimeState.current}
                    interactionEnabled={true}
                    daemonInteractionEnabled={true}
                    dispatchAction={async () => null}
                    actionAvailable
                    openSurface={async () => null}
                    openSurfaceAvailable={false}
                    authorityGeneration={1}
                />
            </>,
        );
        await act(async () => {
            await Promise.resolve();
        });

        expect(machinePluginSettingsGetMock).toHaveBeenCalledOnce();
        expect(scopedSettingsWatchMock).toHaveBeenCalledOnce();
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe(endpoint);
        expect(screen.findByTestId('plugin-declarative-field:root.endpoint')?.props.value).toBe(endpoint);

        endpoint = 'https://changed-elsewhere.example.test';
        revision = '1';
        await act(async () => {
            invalidate?.();
        });
        await act(async () => {
            await Promise.resolve();
        });

        expect(machinePluginSettingsGetMock).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe(endpoint);
        expect(screen.findByTestId('plugin-declarative-field:root.endpoint')?.props.value).toBe(endpoint);
    });

    it('renders an external notification channel through the canonical Account Plugin Settings record', async () => {
        const accountTarget = { kind: 'account' as const, serverIdentityId: 'server-identity-1' };
        scopedSettingsReadMock.mockImplementation((input: Readonly<{ scope?: Readonly<{ kind?: string }> }>) => (
            input.scope?.kind === 'account'
                ? Promise.resolve({
                    status: 'ready' as const,
                    snapshot: {
                        scope: { kind: 'account' as const },
                        target: accountTarget,
                        revision: { kind: 'account' as const, value: 4 },
                        values: {
                            [EXTERNAL_NOTIFICATION_ENDPOINT_FIELD_ID]: 'https://review.example.test/hooks/ready',
                        },
                    },
                })
                : undefined
        ));
        scopedSettingsWriteMock.mockResolvedValue({
            status: 'ready',
            snapshot: {
                scope: { kind: 'account' },
                target: accountTarget,
                revision: { kind: 'account', value: 5 },
                values: {
                    [EXTERNAL_NOTIFICATION_ENDPOINT_FIELD_ID]: 'https://review.example.test/hooks/updated',
                },
            },
        });

        const { screen } = await renderSection(createExternalNotificationChannelProjection());

        expect(scopedSettingsReadMock).toHaveBeenCalledWith(expect.objectContaining({
            pluginId: EXTERNAL_NOTIFICATION_PLUGIN_ID,
            scope: { kind: 'account' },
            target: accountTarget,
            fields: [expect.objectContaining({ key: EXTERNAL_NOTIFICATION_ENDPOINT_FIELD_ID })],
        }));
        expect(screen.getTextContent()).toContain('Document review webhook');
        expect(screen.findByTestId(EXTERNAL_NOTIFICATION_ENDPOINT_INPUT_ID)?.props.value)
            .toBe('https://review.example.test/hooks/ready');

        await act(async () => {
            screen.changeTextByTestId(
                EXTERNAL_NOTIFICATION_ENDPOINT_INPUT_ID,
                'https://review.example.test/hooks/updated',
            );
        });
        expect(screen.findByTestId(EXTERNAL_NOTIFICATION_ENDPOINT_SAVE_ID)?.props.disabled).toBe(false);
        await act(async () => {
            screen.pressByTestId(EXTERNAL_NOTIFICATION_ENDPOINT_SAVE_ID);
            await Promise.resolve();
        });

        expect(scopedSettingsWriteMock).toHaveBeenCalledWith(expect.objectContaining({
            pluginId: EXTERNAL_NOTIFICATION_PLUGIN_ID,
            scope: { kind: 'account' },
            target: accountTarget,
            fieldId: EXTERNAL_NOTIFICATION_ENDPOINT_FIELD_ID,
            mutation: { kind: 'set', value: 'https://review.example.test/hooks/updated' },
            expectedRevision: { kind: 'account', value: 4 },
        }));
    });

    it('renders an Account-custodied field through SavedSecret without exposing its value', async () => {
        const { screen } = await renderSection(createProjection(1, [ACCOUNT_SECRET_FIELD], 'account'));

        expect(accountPluginSecretReadMock).toHaveBeenCalledWith({
            pluginId: PLUGIN_ID,
            scope: { kind: 'account' },
            target: { kind: 'account', serverIdentityId: 'server-identity-1' },
            fields: [expect.objectContaining({ key: 'accountToken', redacted: true })],
        });
        expect(screen.findByTestId(ACCOUNT_SECRET_INPUT_ID)).not.toBeNull();
        expect(screen.findByTestId(ACCOUNT_SECRET_INPUT_ID)?.props.value).toBe('');
        expect(screen.findByTestId(ACCOUNT_SECRET_INPUT_ID)?.props.accessibilityLabel).toBe('Account token');
        expect(screen.findByTestId(ACCOUNT_SECRET_INPUT_ID)?.props.accessibilityHint)
            .toBe('memorySearchSettings.embeddings.secretSet');

        await act(async () => {
            screen.changeTextByTestId(ACCOUNT_SECRET_INPUT_ID, 'account-secret-value');
        });
        expect(screen.findByTestId(ACCOUNT_SECRET_SAVE_ID)?.props.disabled).toBe(false);
        await act(async () => {
            screen.pressByTestId(ACCOUNT_SECRET_SAVE_ID);
            await Promise.resolve();
        });

        expect(accountPluginSecretWriteMock).toHaveBeenCalledWith(expect.objectContaining({
            pluginId: PLUGIN_ID,
            scope: { kind: 'account' },
            target: { kind: 'account', serverIdentityId: 'server-identity-1' },
            fieldId: 'accountToken',
            mutation: { kind: 'set', value: 'account-secret-value' },
            expectedRevision: { kind: 'account-secret', value: 5 },
        }));
        expect(machinePluginSettingsGetMock).not.toHaveBeenCalled();
        expect(machinePluginSettingsSetMock).not.toHaveBeenCalled();
    });

    it('routes a daemon-scoped Account-custodied secret through SavedSecret', async () => {
        const { screen } = await renderSection(createProjection(1, [ACCOUNT_SECRET_FIELD], 'daemon'));

        expect(accountPluginSecretReadMock).toHaveBeenCalledWith({
            pluginId: PLUGIN_ID,
            scope: { kind: 'account' },
            target: { kind: 'account', serverIdentityId: 'server-identity-1' },
            fields: [expect.objectContaining({ key: 'accountToken', redacted: true })],
        });
        expect(machinePluginSettingsGetMock).not.toHaveBeenCalled();

        // The SavedSecret projection settles independently of the daemon
        // Settings section, so wait for its owner-bound revision before save.
        await flushAsync();
        expect(accountPluginSecretReadMock).toHaveBeenCalledOnce();
        expect(screen.findByTestId(ACCOUNT_SECRET_STATUS_ID)).not.toBeNull();
        expect(screen.findByTestId(ACCOUNT_SECRET_SAVE_ID)?.props.disabled).toBe(true);

        await act(async () => {
            screen.changeTextByTestId(ACCOUNT_SECRET_INPUT_ID, 'portable-account-secret');
        });
        expect(screen.findByTestId(ACCOUNT_SECRET_SAVE_ID)?.props.disabled).toBe(false);

        await act(async () => {
            screen.pressByTestId(ACCOUNT_SECRET_SAVE_ID);
            await Promise.resolve();
        });

        expect(accountPluginSecretWriteMock).toHaveBeenCalledWith(expect.objectContaining({
            pluginId: PLUGIN_ID,
            scope: { kind: 'account' },
            target: { kind: 'account', serverIdentityId: 'server-identity-1' },
            fieldId: 'accountToken',
            mutation: { kind: 'set', value: 'portable-account-secret' },
            expectedRevision: { kind: 'account-secret', value: 5 },
        }));
        expect(machinePluginSettingsSetMock).not.toHaveBeenCalled();
    });

    it('routes the selected per-active-server OpenCode endpoint origin through the exact daemon secret owner', async () => {
        scopedSettingsReadMock.mockImplementation((input: Readonly<{ scope?: Readonly<{ kind?: string }> }>) => (
            input.scope?.kind === 'account'
                ? Promise.resolve(readyOpenCodeAccountSettings('https://OpenCode.Example.test:443/path?ignored=true#fragment'))
                : undefined
        ));
        scopedDaemonSecretReadMock.mockImplementation((input: ScopedPluginDaemonSecretReadInput) => (
            Promise.resolve(scopedDaemonSecretReady(input, 'missing', 'origin-3'))
        ));
        scopedDaemonSecretWriteMock.mockImplementation((input: ScopedPluginDaemonSecretWriteInput) => (
            Promise.resolve(scopedDaemonSecretReady(input, 'configured', 'origin-4'))
        ));
        const { screen } = await renderSection(createOpenCodeProjection());

        expect(scopedDaemonSecretReadMock).toHaveBeenCalledWith(expect.objectContaining({
            target: {
                kind: 'daemon',
                serverId: 'server-1',
                serverIdentityId: 'server-identity-1',
                machineId: 'machine-1',
            },
            pluginId: OPENCODE_PLUGIN_ID,
            secretId: OPENCODE_SERVER_PASSWORD_SETTING_ID,
            canonicalOrigin: 'https://opencode.example.test',
        }));
        expect(accountPluginSecretReadMock).not.toHaveBeenCalled();
        expect(screen.findByTestId(OPENCODE_SECRET_INPUT_ID)?.props.value).toBe('');
        await flushAsync();
        expect(screen.findByTestId(OPENCODE_SECRET_SAVE_ID)?.props.disabled).toBe(true);

        await act(async () => {
            screen.changeTextByTestId(OPENCODE_SECRET_INPUT_ID, 'machine-only-opencode-password');
        });
        expect(screen.findByTestId(OPENCODE_SECRET_SAVE_ID)?.props.disabled).toBe(false);

        await act(async () => {
            screen.pressByTestId(OPENCODE_SECRET_SAVE_ID);
            await Promise.resolve();
        });
        await flushAsync();

        expect(scopedDaemonSecretWriteMock).toHaveBeenCalledWith(expect.objectContaining({
            target: {
                kind: 'daemon',
                serverId: 'server-1',
                serverIdentityId: 'server-identity-1',
                machineId: 'machine-1',
            },
            pluginId: OPENCODE_PLUGIN_ID,
            secretId: OPENCODE_SERVER_PASSWORD_SETTING_ID,
            canonicalOrigin: 'https://opencode.example.test',
            expectedRevision: 'origin-3',
            mutation: { kind: 'set', value: 'machine-only-opencode-password' },
        }));
        expect(machinePluginSecretStatusMock).not.toHaveBeenCalled();
        expect(machinePluginSecretSetMock).not.toHaveBeenCalled();
        expect(machinePluginSecretDeleteMock).not.toHaveBeenCalled();
        expect(machinePluginSettingsGetMock).not.toHaveBeenCalled();
        expect(machinePluginSettingsSetMock).not.toHaveBeenCalled();
        expect(accountPluginSecretWriteMock).not.toHaveBeenCalled();
        await screen.unmount();
        // Let the aborted status effect settle before the next test resets the
        // shared transport spies; a late aborted call is not current-origin work.
        await flushAsync();
    });

    it('does not let an older ambiguous origin-bound secret write replace a newer draft or its status', async () => {
        const pendingWrite = createDeferred<ScopedPluginDaemonSecretWriteResult>();
        const writeInputs: ScopedPluginDaemonSecretWriteInput[] = [];
        scopedSettingsReadMock.mockImplementation((input: Readonly<{ scope?: Readonly<{ kind?: string }> }>) => (
            input.scope?.kind === 'account'
                ? Promise.resolve(readyOpenCodeAccountSettings('https://opencode.example.test'))
                : undefined
        ));
        scopedDaemonSecretReadMock.mockImplementation((input: ScopedPluginDaemonSecretReadInput) => (
            Promise.resolve(scopedDaemonSecretReady(input, 'missing', 'origin-3'))
        ));
        scopedDaemonSecretWriteMock.mockImplementation((input: ScopedPluginDaemonSecretWriteInput) => {
            writeInputs.push(input);
            return pendingWrite.promise;
        });
        const { screen } = await renderSection(createOpenCodeProjection());
        await flushAsync();
        expect(screen.findByTestId(OPENCODE_SECRET_SAVE_ID)?.props.disabled).toBe(true);

        await act(async () => {
            screen.changeTextByTestId(OPENCODE_SECRET_INPUT_ID, 'older-secret');
            await Promise.resolve();
        });
        expect(screen.findByTestId(OPENCODE_SECRET_SAVE_ID)?.props.disabled).toBe(false);
        await act(async () => {
            screen.pressByTestId(OPENCODE_SECRET_SAVE_ID);
            await Promise.resolve();
        });
        await act(async () => {
            screen.changeTextByTestId(OPENCODE_SECRET_INPUT_ID, 'newer-secret');
            await Promise.resolve();
        });
        const olderWrite = writeInputs.at(-1);
        if (!olderWrite) throw new Error('Expected the first origin-bound write');

        await act(async () => {
            pendingWrite.resolve({
                status: 'outcomeUnknown',
                snapshot: {
                    target: olderWrite.target,
                    pluginId: olderWrite.pluginId,
                    secretId: olderWrite.secretId,
                    state: 'configured',
                    revision: 'origin-4',
                },
            });
            await pendingWrite.promise;
        });
        await flushAsync();

        expect(screen.findByTestId(OPENCODE_SECRET_INPUT_ID)?.props.value).toBe('newer-secret');
        expect(screen.findByTestId(OPENCODE_SECRET_SAVE_ID)?.props.accessibilityLabel)
            .toBe('common.save: Existing OpenCode server password');
        expect(screen.findByTestId(OPENCODE_SECRET_STATUS_ID)).toBeNull();
        expect(screen.getTextContent())
            .not.toContain('settingsProviders.errors.mutationOutcomeUnknownDescription');
    });

    it('does not settle an origin-bound daemon-secret write into a replacement Account with the same origin and daemon target', async () => {
        const accountA = createRetirableTestAccountLifetime();
        const accountB = createTestAccountLifetime({ accountId: 'account-b' });
        activeAccountLifetimeState.current = accountA.lifetime;
        const pendingWrite = createDeferred<ScopedPluginDaemonSecretWriteResult>();
        const writeInputs: ScopedPluginDaemonSecretWriteInput[] = [];
        scopedSettingsReadMock.mockImplementation((input: Readonly<{
            scope?: Readonly<{ kind?: string }>;
            target?: Readonly<{ kind?: string; serverIdentityId?: string }>;
        }>) => {
            const serverIdentityId = input.target?.serverIdentityId;
            if (input.scope?.kind !== 'account' || input.target?.kind !== 'account' || !serverIdentityId) {
                return undefined;
            }
            return Promise.resolve(readyOpenCodeAccountSettings(
                'https://opencode.example.test',
                { kind: 'account', serverIdentityId },
            ));
        });
        scopedDaemonSecretReadMock.mockImplementation((input: ScopedPluginDaemonSecretReadInput) => (
            Promise.resolve(scopedDaemonSecretReady(input, 'missing', 'origin-current'))
        ));
        scopedDaemonSecretWriteMock.mockImplementation((input: ScopedPluginDaemonSecretWriteInput) => {
            writeInputs.push(input);
            return pendingWrite.promise;
        });
        const { element, screen } = await renderSection(createOpenCodeProjection());
        await flushAsync();
        expect(screen.findByTestId(OPENCODE_SECRET_SAVE_ID)?.props.disabled).toBe(true);

        await act(async () => {
            screen.changeTextByTestId(OPENCODE_SECRET_INPUT_ID, 'account-a-secret');
            await Promise.resolve();
        });
        expect(screen.findByTestId(OPENCODE_SECRET_SAVE_ID)?.props.disabled).toBe(false);
        await act(async () => {
            screen.pressByTestId(OPENCODE_SECRET_SAVE_ID);
            await Promise.resolve();
        });
        const accountAWrite = writeInputs.at(-1);
        if (!accountAWrite) throw new Error('Expected the Account-A origin-bound write');

        // Active Account scope can change before this React consumer recaptures
        // its lifetime and dispatches the synchronous retirement callbacks.
        // A late daemon-secret settlement must still consult currentness.
        activeAccountLifetimeState.current = accountB;
        accountA.invalidate();
        await act(async () => {
            pendingWrite.resolve({
                status: 'outcomeUnknown',
                snapshot: {
                    target: accountAWrite.target,
                    pluginId: accountAWrite.pluginId,
                    secretId: accountAWrite.secretId,
                    state: 'configured',
                    revision: 'origin-account-a',
                },
            });
            await pendingWrite.promise;
            await Promise.resolve();
        });
        await flushAsync();

        expect(screen.findByTestId(OPENCODE_SECRET_STATUS_ID)).toBeNull();
        expect(screen.getTextContent())
            .not.toContain('settingsProviders.errors.mutationOutcomeUnknownDescription');

        await act(async () => {
            screen.tree.update(React.cloneElement(element));
            await Promise.resolve();
        });
        await flushAsync();

        expect(scopedSettingsReadMock).toHaveBeenCalledWith(expect.objectContaining({
            scope: { kind: 'account' },
            target: { kind: 'account', serverIdentityId: 'server-identity-1' },
        }));
        expect(screen.findByTestId(OPENCODE_SECRET_INPUT_ID)?.props.value).toBe('');
        expect(screen.findByTestId(OPENCODE_SECRET_STATUS_ID)).toBeNull();
        expect(screen.getTextContent())
            .not.toContain('settingsProviders.errors.mutationOutcomeUnknownDescription');
    });

    it('clears an Account-A managed daemon-secret presentation when the Account lifetime retires', async () => {
        const accountA = createRetirableTestAccountLifetime();
        const accountB = createTestAccountLifetime({ accountId: 'account-b' });
        activeAccountLifetimeState.current = accountA.lifetime;
        let secretReadCount = 0;
        scopedSettingsReadMock.mockImplementation((input: Readonly<{
            scope?: Readonly<{ kind?: string }>;
            target?: Readonly<{ kind?: string; serverIdentityId?: string }>;
        }>) => {
            const serverIdentityId = input.target?.serverIdentityId;
            if (input.scope?.kind !== 'account' || input.target?.kind !== 'account' || !serverIdentityId) {
                return undefined;
            }
            return Promise.resolve(readyOpenCodeAccountSettings(
                'https://opencode.example.test',
                { kind: 'account', serverIdentityId },
            ));
        });
        scopedDaemonSecretReadMock.mockImplementation((input: ScopedPluginDaemonSecretReadInput) => {
            secretReadCount += 1;
            return Promise.resolve(scopedDaemonSecretReady(
                input,
                secretReadCount === 1 ? 'configured' : 'missing',
                `origin-${secretReadCount}`,
            ));
        });
        const { screen } = await renderSection(createOpenCodeProjection());
        await flushAsync();
        expect(screen.findByTestId(OPENCODE_SECRET_STATUS_ID)).not.toBeNull();

        await act(async () => {
            screen.changeTextByTestId(OPENCODE_SECRET_INPUT_ID, 'account-a-secret');
            await Promise.resolve();
        });
        expect(screen.findByTestId(OPENCODE_SECRET_INPUT_ID)?.props.value).toBe('account-a-secret');

        await act(async () => {
            activeAccountLifetimeState.current = accountB;
            accountA.retire();
            await Promise.resolve();
        });
        await flushAsync();

        expect(screen.findByTestId(OPENCODE_SECRET_INPUT_ID)?.props.value).toBe('');
        expect(screen.findByTestId(OPENCODE_SECRET_STATUS_ID)).toBeNull();
    });

    it('keeps a persisted non-loopback HTTP OpenCode override inert without reading a credential', async () => {
        scopedSettingsReadMock.mockImplementation((input: Readonly<{ scope?: Readonly<{ kind?: string }> }>) => (
            input.scope?.kind === 'account'
                ? Promise.resolve(readyOpenCodeAccountSettings('http://192.168.1.50:4096'))
                : undefined
        ));
        const { screen } = await renderSection(createOpenCodeProjection());

        expect(screen.findByTestId(OPENCODE_SECRET_INPUT_ID)?.props.editable).toBe(false);
        const currentSecretStatusCalls = machinePluginSecretStatusMock.mock.calls.filter((call) => {
            const input = call[1] as Readonly<{ signal?: AbortSignal }> | undefined;
            return input?.signal?.aborted !== true;
        });
        expect(currentSecretStatusCalls).toEqual([]);
        expect(machinePluginSecretSetMock).not.toHaveBeenCalled();
        expect(machinePluginSettingsGetMock).not.toHaveBeenCalled();
        expect(machinePluginSettingsSetMock).not.toHaveBeenCalled();
        expect(accountPluginSecretReadMock).not.toHaveBeenCalled();
    });

    it('uses current release declarations for offline Account recovery without presenting daemon-custodied secrets', async () => {
        const { screen } = await renderSection(null, {
            accountSettingsDeclaration: ACCOUNT_RECOVERY_DECLARATION,
            daemonOperationsAvailable: false,
            machineId: null,
            serverId: null,
            daemonServerIdentityId: null,
        });

        expect(screen.findByTestId(RECOVERY_SECRET_INPUT_ID)).not.toBeNull();
        expect(screen.findByTestId(RECOVERY_DAEMON_SECRET_INPUT_ID)).toBeNull();
        expect(accountPluginSecretReadMock).toHaveBeenCalledWith({
            pluginId: PLUGIN_ID,
            scope: { kind: 'account' },
            target: { kind: 'account', serverIdentityId: 'server-identity-1' },
            fields: [expect.objectContaining({ key: 'apiToken', redacted: true })],
        });
        expect(machinePluginSettingsGetMock).not.toHaveBeenCalled();
        expect(machinePluginSettingsSetMock).not.toHaveBeenCalled();
    });

    it('requires an explicit edit to replace a configured Account secret with empty data and deletes only through its explicit action', async () => {
        const { screen } = await renderSection(createProjection(1, [ACCOUNT_SECRET_FIELD], 'account'));

        expect(screen.findByTestId(ACCOUNT_SECRET_STATUS_ID)).not.toBeNull();
        expect(screen.findByTestId(ACCOUNT_SECRET_SAVE_ID)?.props.disabled).toBe(true);

        await act(async () => {
            screen.changeTextByTestId(ACCOUNT_SECRET_INPUT_ID, '');
        });
        expect(screen.findByTestId(ACCOUNT_SECRET_SAVE_ID)?.props.disabled).toBe(false);

        await act(async () => {
            screen.pressByTestId(ACCOUNT_SECRET_SAVE_ID);
            await Promise.resolve();
        });
        await flushAsync();

        expect(accountPluginSecretWriteMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            fieldId: 'accountToken',
            mutation: { kind: 'set', value: '' },
            expectedRevision: { kind: 'account-secret', value: 5 },
        }));
        expect(screen.findByTestId(ACCOUNT_SECRET_DELETE_ID)).not.toBeNull();

        await act(async () => {
            screen.pressByTestId(ACCOUNT_SECRET_DELETE_ID);
            await Promise.resolve();
        });
        await flushAsync();

        expect(accountPluginSecretWriteMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            fieldId: 'accountToken',
            mutation: { kind: 'delete' },
            expectedRevision: { kind: 'account-secret', value: 6 },
        }));
    });

    it('binds an existing SavedSecret through the host picker and can explicitly unbind it', async () => {
        const { screen } = await renderSection(createProjection(1, [ACCOUNT_SECRET_FIELD], 'account'));

        const bindExistingSecret = screen.findByProps({
            accessibilityLabel: 'settings.mcpServersImportMappingSavedSecret: Account token',
        });
        expect(bindExistingSecret).toBeTruthy();
        await act(async () => {
            bindExistingSecret.props.onPress();
        });

        const { SavedSecretPickerModal } = await import('@/components/ui/forms/valueRefs/SavedSecretPickerModal');
        const shown = modalShowMock.mock.calls[0]?.[0] as Readonly<{
            component: unknown;
            chrome: Readonly<{
                title: string;
            }>;
            props: Readonly<{
                selectedId: string | null;
                includeNoneRow?: boolean;
                allowAdd?: boolean;
                allowEdit?: boolean;
                onSelectId(id: string | null): void;
            }>;
        }>;
        expect(shown.component).toBe(SavedSecretPickerModal);
        expect(shown.chrome.title).toBe('settings.mcpServersPickSecretTitle');
        expect(shown.props).toMatchObject({
            selectedId: null,
            includeNoneRow: false,
            allowAdd: false,
            allowEdit: false,
        });

        await act(async () => {
            shown.props.onSelectId('saved-secret-owned-by-user');
            await Promise.resolve();
        });
        await flushAsync();

        expect(accountPluginSecretWriteMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
            pluginId: PLUGIN_ID,
            scope: { kind: 'account' },
            target: { kind: 'account', serverIdentityId: 'server-identity-1' },
            fieldId: 'accountToken',
            mutation: { kind: 'bind', savedSecretId: 'saved-secret-owned-by-user' },
            expectedRevision: { kind: 'account-secret', value: 5 },
        }));
        expect(screen.findByTestId(ACCOUNT_SECRET_INPUT_ID)?.props.value).toBe('');
        expect(screen.getTextContent()).not.toContain('saved-secret-owned-by-user');
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('saved-secret-owned-by-user');
        const accessibilityLabels = screen.findAll((node) => true)
            .map((node) => String(node.props?.accessibilityLabel ?? ''))
            .join('\n');
        expect(accessibilityLabels).not.toContain('saved-secret-owned-by-user');

        expect(screen.findByTestId(ACCOUNT_SECRET_UNBIND_ID)).not.toBeNull();
        await act(async () => {
            screen.pressByTestId(ACCOUNT_SECRET_UNBIND_ID);
            await Promise.resolve();
        });
        await flushAsync();

        expect(accountPluginSecretWriteMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            fieldId: 'accountToken',
            mutation: { kind: 'unbind' },
            expectedRevision: { kind: 'account-secret', value: 6 },
        }));
    });

    it('adopts a rejected Account-secret CAS snapshot without replaying the draft', async () => {
        accountPluginSecretWriteMock
            .mockResolvedValueOnce({
                status: 'conflict',
                snapshot: {
                    scope: { kind: 'account' },
                    target: { kind: 'account', serverIdentityId: 'server-identity-1' },
                    revision: { kind: 'account-secret', value: 6 },
                    values: {},
                    secretStates: { accountToken: 'missing' },
                },
            })
            .mockResolvedValueOnce({
                status: 'ready',
                snapshot: {
                    scope: { kind: 'account' },
                    target: { kind: 'account', serverIdentityId: 'server-identity-1' },
                    revision: { kind: 'account-secret', value: 7 },
                    values: {},
                    secretStates: { accountToken: 'configured' },
                },
            });
        const { screen } = await renderSection(createProjection(1, [ACCOUNT_SECRET_FIELD], 'account'));

        act(() => {
            screen.changeTextByTestId(ACCOUNT_SECRET_INPUT_ID, 'draft-that-needs-explicit-retry');
        });
        act(() => {
            screen.pressByTestId(ACCOUNT_SECRET_SAVE_ID);
        });
        expect(accountPluginSecretWriteMock).toHaveBeenCalledTimes(1);
        await act(async () => {
            await accountPluginSecretWriteMock.mock.results[0]!.value;
        });

        expect(screen.findByTestId(ACCOUNT_SECRET_INPUT_ID)?.props.value).toBe('draft-that-needs-explicit-retry');
        expect(screen.findByTestId(ACCOUNT_SECRET_SAVE_ID)?.props.accessibilityLabel).toBe('common.retry: Account token');
        expect(screen.findByTestId(ACCOUNT_SECRET_DELETE_ID)).toBeNull();

        act(() => {
            screen.pressByTestId(ACCOUNT_SECRET_SAVE_ID);
        });
        expect(accountPluginSecretWriteMock).toHaveBeenCalledTimes(2);
        await act(async () => {
            await accountPluginSecretWriteMock.mock.results[1]!.value;
        });

        expect(accountPluginSecretWriteMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            mutation: { kind: 'set', value: 'draft-that-needs-explicit-retry' },
            expectedRevision: { kind: 'account-secret', value: 6 },
        }));
    });

    it('keeps an Account SavedSecret draft ambiguous after its safe snapshot and requires an explicit retry', async () => {
        accountPluginSecretWriteMock.mockResolvedValueOnce({
            status: 'outcomeUnknown',
            snapshot: {
                scope: { kind: 'account' },
                target: { kind: 'account', serverIdentityId: 'server-identity-1' },
                revision: { kind: 'account-secret', value: 6 },
                values: {},
                secretStates: { accountToken: 'configured' },
            },
        });
        const { screen } = await renderSection(createProjection(1, [ACCOUNT_SECRET_FIELD], 'account'));

        act(() => {
            screen.changeTextByTestId(ACCOUNT_SECRET_INPUT_ID, 'possibly-applied-account-secret');
        });
        act(() => {
            screen.pressByTestId(ACCOUNT_SECRET_SAVE_ID);
        });
        await flushAsync();

        expect(accountPluginSecretWriteMock).toHaveBeenCalledOnce();
        expect(screen.findByTestId(ACCOUNT_SECRET_INPUT_ID)?.props.value)
            .toBe('possibly-applied-account-secret');
        expect(screen.findByTestId(ACCOUNT_SECRET_SAVE_ID)?.props.accessibilityLabel)
            .toBe('common.retry: Account token');
        expect(screen.getTextContent())
            .toContain('settingsProviders.errors.mutationOutcomeUnknownDescription');
        expect(screen.getTextContent()).not.toContain('settingsPlugins.genericSettingsSaveError');
    });

    it('retires an Account-secret draft and stale settlement when its immutable generation is replaced', async () => {
        const pendingWrite = createDeferred<{
            status: 'conflict';
            snapshot: {
                scope: { kind: 'account' };
                target: { kind: 'account'; serverIdentityId: string };
                revision: { kind: 'account-secret'; value: number };
                values: Record<string, never>;
                secretStates: Record<string, 'configured' | 'missing'>;
            };
        }>();
        accountPluginSecretWriteMock.mockReturnValueOnce(pendingWrite.promise);
        const firstProjection = createProjection(1, [ACCOUNT_SECRET_FIELD], 'account');
        const secondProjection = {
            ...createProjection(1, [ACCOUNT_SECRET_FIELD], 'account'),
            immutableGenerationId: 'generation-2',
        };
        const { PluginDetailGenericSettingsSection, screen } = await renderSection(firstProjection);

        act(() => {
            screen.changeTextByTestId(ACCOUNT_SECRET_INPUT_ID, 'generation-one-account-secret');
        });
        act(() => {
            screen.pressByTestId(ACCOUNT_SECRET_SAVE_ID);
        });
        expect(accountPluginSecretWriteMock).toHaveBeenCalledOnce();

        await act(async () => {
            screen.tree.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={secondProjection}
                    machineId="machine-1"
                    serverId="server-1"
                    accountServerIdentityId="server-identity-1"
                    daemonServerIdentityId="server-identity-1"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();

        expect(screen.findByTestId(ACCOUNT_SECRET_INPUT_ID)?.props.value).toBe('');

        await act(async () => {
            pendingWrite.resolve({
                status: 'conflict',
                snapshot: {
                    scope: { kind: 'account' },
                    target: { kind: 'account', serverIdentityId: 'server-identity-1' },
                    revision: { kind: 'account-secret', value: 6 },
                    values: {},
                    secretStates: { accountToken: 'configured' },
                },
            });
            await pendingWrite.promise;
        });

        expect(screen.findByTestId(ACCOUNT_SECRET_INPUT_ID)?.props.value).toBe('');
        expect(screen.findByTestId(ACCOUNT_SECRET_SAVE_ID)?.props.accessibilityLabel)
            .toBe('common.save: Account token');
    });

    it('clears an Account SavedSecret presentation and ignores its late settlement when the same lifetime retires', async () => {
        const accountA = createRetirableTestAccountLifetime();
        const accountB = createTestAccountLifetime({ accountId: 'account-b' });
        activeAccountLifetimeState.current = accountA.lifetime;
        const pendingWrite = createDeferred<{
            status: 'conflict';
            snapshot: {
                scope: { kind: 'account' };
                target: { kind: 'account'; serverIdentityId: string };
                revision: { kind: 'account-secret'; value: number };
                values: Record<string, never>;
                secretStates: Record<string, 'configured' | 'missing'>;
            };
        }>();
        accountPluginSecretWriteMock.mockReturnValueOnce(pendingWrite.promise);
        const { screen } = await renderSection(createProjection(1, [ACCOUNT_SECRET_FIELD], 'account'));

        expect(screen.findByTestId(ACCOUNT_SECRET_STATUS_ID)).not.toBeNull();
        act(() => {
            screen.changeTextByTestId(ACCOUNT_SECRET_INPUT_ID, 'account-a-raw-secret');
        });
        act(() => {
            screen.pressByTestId(ACCOUNT_SECRET_SAVE_ID);
        });
        expect(accountPluginSecretWriteMock).toHaveBeenCalledOnce();

        await act(async () => {
            activeAccountLifetimeState.current = accountB;
            accountA.retire();
            await Promise.resolve();
        });

        expect(screen.findByTestId(ACCOUNT_SECRET_INPUT_ID)?.props.value).toBe('');
        expect(screen.findByTestId(ACCOUNT_SECRET_STATUS_ID)).toBeNull();
        expect(screen.findByTestId(ACCOUNT_SECRET_SAVE_ID)?.props.accessibilityLabel)
            .toBe('common.save: Account token');
        expect(screen.getTextContent()).not.toContain('settingsPlugins.genericSettingsSaveError');

        await act(async () => {
            pendingWrite.resolve({
                status: 'conflict',
                snapshot: {
                    scope: { kind: 'account' },
                    target: { kind: 'account', serverIdentityId: 'server-identity-1' },
                    revision: { kind: 'account-secret', value: 6 },
                    values: {},
                    secretStates: { accountToken: 'configured' },
                },
            });
            await pendingWrite.promise;
        });

        expect(screen.findByTestId(ACCOUNT_SECRET_INPUT_ID)?.props.value).toBe('');
        expect(screen.findByTestId(ACCOUNT_SECRET_STATUS_ID)).toBeNull();
        expect(screen.findByTestId(ACCOUNT_SECRET_SAVE_ID)?.props.accessibilityLabel)
            .toBe('common.save: Account token');
        expect(screen.getTextContent()).not.toContain('settingsPlugins.genericSettingsSaveError');
    });

    it('retires a daemon-secret draft when clear behavior changes under the same generation', async () => {
        const secretField = SETTINGS_FIELDS[1]!;
        const replacementField: PluginProjectionEditableSettingField = {
            ...secretField,
            clearWhenEmpty: 'persist',
        };
        const firstProjection = createProjection(1, [secretField], 'daemon');
        const replacementProjection = createProjection(1, [replacementField], 'daemon');
        const { PluginDetailGenericSettingsSection, screen } = await renderSection(firstProjection);

        act(() => {
            screen.changeTextByTestId(SECRET_INPUT_ID, 'superseded-clear-behavior-draft');
        });

        await act(async () => {
            screen.tree.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={replacementProjection}
                    machineId="machine-1"
                    serverId="server-1"
                    accountServerIdentityId="server-identity-1"
                    daemonServerIdentityId="server-identity-1"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();

        expect(screen.findByTestId(SECRET_INPUT_ID)?.props.value).toBe('');

        act(() => {
            screen.pressByTestId(SECRET_SAVE_ID);
        });
        await flushAsync();

        expect(machinePluginSettingsSetMock).not.toHaveBeenCalled();
    });

    it('retires a daemon-secret draft when its normalized direct binding changes under the same generation', async () => {
        const boundSecretField: PluginProjectionEditableSettingField = {
            ...SETTINGS_FIELDS[1]!,
            presentation: {
                binding: { kind: 'direct', settingId: 'legacyApiToken' },
            },
        };
        const replacementField: PluginProjectionEditableSettingField = {
            ...boundSecretField,
            presentation: {
                binding: { kind: 'direct', settingId: 'replacementApiToken' },
            },
        };
        const firstProjection = createProjection(1, [boundSecretField], 'daemon');
        const replacementProjection = createProjection(1, [replacementField], 'daemon');
        const { PluginDetailGenericSettingsSection, screen } = await renderSection(firstProjection);

        act(() => {
            screen.changeTextByTestId(SECRET_INPUT_ID, 'superseded-daemon-secret-draft');
        });

        await act(async () => {
            screen.tree.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={replacementProjection}
                    machineId="machine-1"
                    serverId="server-1"
                    accountServerIdentityId="server-identity-1"
                    daemonServerIdentityId="server-identity-1"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();

        expect(screen.findByTestId(SECRET_INPUT_ID)?.props.value).toBe('');

        act(() => {
            screen.pressByTestId(SECRET_SAVE_ID);
        });
        await flushAsync();

        expect(machinePluginSettingsSetMock).not.toHaveBeenCalled();
    });

    it('retires a daemon-secret draft and stale settlement when its immutable generation is replaced', async () => {
        const pendingWrite = createDeferred<MachinePluginSecretSetResult>();
        machinePluginSecretSetMock.mockReturnValueOnce(pendingWrite.promise);
        const secretField = SETTINGS_FIELDS[1]!;
        const firstProjection = createProjection(1, [secretField], 'account');
        const secondProjection = {
            ...createProjection(1, [secretField], 'account'),
            immutableGenerationId: 'generation-2',
        };
        const { PluginDetailGenericSettingsSection, screen } = await renderSection(firstProjection);

        act(() => {
            screen.changeTextByTestId(SECRET_INPUT_ID, 'generation-one-daemon-secret');
        });
        act(() => {
            screen.pressByTestId(SECRET_SAVE_ID);
        });
        expect(machinePluginSecretSetMock).toHaveBeenCalledOnce();

        await act(async () => {
            screen.tree.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={secondProjection}
                    machineId="machine-1"
                    serverId="server-1"
                    accountServerIdentityId="server-identity-1"
                    daemonServerIdentityId="server-identity-1"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();

        expect(screen.findByTestId(SECRET_INPUT_ID)?.props.value).toBe('');

        await act(async () => {
            pendingWrite.resolve({ supported: false, reason: 'error' });
            await pendingWrite.promise;
        });

        expect(screen.findByTestId(SECRET_INPUT_ID)?.props.value).toBe('');
        expect(screen.findByTestId(SECRET_SAVE_ID)?.props.accessibilityLabel)
            .toBe('common.save: API token');
    });

    it('keeps generic text controls at least 44 points tall', async () => {
        const { screen } = await renderSection();

        expect(flattenTestStyle(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.style))
            .toMatchObject({ minHeight: 44 });
        expect(flattenTestStyle(screen.findByTestId(SECRET_INPUT_ID)?.props.style))
            .toMatchObject({ minHeight: 44 });
    });

    it('keeps generic text controls at least 48dp tall on Android', async () => {
        platformEnvironment.platform = 'android';
        try {
            const { screen } = await renderSection();
            expect(flattenTestStyle(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.style))
                .toMatchObject({ minHeight: 48 });
            expect(flattenTestStyle(screen.findByTestId(SECRET_INPUT_ID)?.props.style))
                .toMatchObject({ minHeight: 48 });
        } finally {
            platformEnvironment.platform = 'web';
        }
    });

    it('does not restart an exact scoped snapshot read when its parent rerenders', async () => {
        const projection = createProjection(1);
        const { PluginDetailGenericSettingsSection, screen } = await renderSection(projection);
        expect(machinePluginSettingsGetMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            screen.tree.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={projection}
                    machineId="machine-1"
                    serverId="server-1"
                    accountServerIdentityId="server-identity-1"
                    daemonServerIdentityId="server-identity-1"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();

        expect(machinePluginSettingsGetMock).toHaveBeenCalledTimes(1);
    });

    it('keeps retained values inert and performs no settings GET or SET while daemon operations are unavailable', async () => {
        const { PluginDetailGenericSettingsSection, screen } = await renderSection();
        expect(machinePluginSettingsGetMock).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://api.example.test');

        await act(async () => {
            screen.tree.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={createProjection(1)}
                    machineId="machine-1"
                    serverId="server-1"
                    accountServerIdentityId="server-identity-1"
                    daemonServerIdentityId="server-identity-1"
                    daemonOperationsAvailable={false}
                />,
            );
        });
        await flushAsync();

        expect(machinePluginSettingsGetMock).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://api.example.test');
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.editable).toBe(false);
        expect(screen.findByTestId(ENDPOINT_SAVE_ID)?.props.disabled).toBe(true);
        expect(findSwitch(screen)?.props.disabled).toBe(true);

        await act(async () => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://offline.example.test');
            screen.pressByTestId(ENDPOINT_SAVE_ID);
            findSwitch(screen)?.props.onValueChange(false);
            await Promise.resolve();
        });

        expect(machinePluginSettingsGetMock).toHaveBeenCalledTimes(1);
        expect(machinePluginSettingsSetMock).not.toHaveBeenCalled();
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://api.example.test');

        machinePluginSettingsGetMock.mockResolvedValueOnce(settingsResult({
            endpoint: 'https://reconnected.example.test',
            enabled: false,
        }));
        await act(async () => {
            screen.tree.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={createProjection(1)}
                    machineId="machine-1"
                    serverId="server-1"
                    accountServerIdentityId="server-identity-1"
                    daemonServerIdentityId="server-identity-1"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();

        expect(machinePluginSettingsGetMock).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://reconnected.example.test');
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.editable).toBe(true);
    });

    it('ignores a settings save that completes after daemon operations become unavailable', async () => {
        const pendingSave = createDeferred<MachinePluginSettingsSetResult>();
        machinePluginSettingsSetMock.mockReturnValueOnce(pendingSave.promise);
        const { PluginDetailGenericSettingsSection, screen } = await renderSection();

        act(() => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://pending.example.test');
        });
        act(() => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
        });
        expect(machinePluginSettingsSetMock).toHaveBeenCalledTimes(1);
        expect(machinePluginSettingsSetMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            fieldId: 'endpoint',
            mutation: { kind: 'set', value: 'https://pending.example.test' },
        }));

        await act(async () => {
            screen.tree.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={createProjection(1)}
                    machineId="machine-1"
                    serverId="server-1"
                    accountServerIdentityId="server-identity-1"
                    daemonServerIdentityId="server-identity-1"
                    daemonOperationsAvailable={false}
                />,
            );
        });

        await act(async () => {
            pendingSave.resolve(settingsSetResult({
                endpoint: 'https://late-result.example.test',
                enabled: true,
            }));
            await pendingSave.promise;
        });

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://pending.example.test');
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.editable).toBe(false);
        expect(machinePluginSettingsSetMock).toHaveBeenCalledTimes(1);
    });

    it('does not dispatch a daemon settings write after its owning target is no longer current', async () => {
        const isDaemonTargetCurrent = vi.fn(() => false);
        const { screen } = await renderSection(createProjection(1), { isDaemonTargetCurrent });

        act(() => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://stale-target.example.test');
        });
        await screen.pressByTestIdAsync(ENDPOINT_SAVE_ID);

        expect(isDaemonTargetCurrent).toHaveBeenCalledWith({
            kind: 'daemon',
            machineId: 'machine-1',
            serverId: 'server-1',
            serverIdentityId: 'server-identity-1',
        });
        expect(machinePluginSettingsSetMock).not.toHaveBeenCalled();
    });

    it('keeps text edits local until Save and preserves a newer draft when that save completes', async () => {
        const firstSave = createDeferred<MachinePluginSettingsSetResult>();
        machinePluginSettingsSetMock
            .mockReturnValueOnce(firstSave.promise)
            .mockResolvedValueOnce(settingsSetResult({
                endpoint: 'https://api.newer.test',
                enabled: true,
            }));
        const { screen } = await renderSection();

        await act(async () => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://api.first.test');
        });

        expect(machinePluginSettingsSetMock).not.toHaveBeenCalled();
        expect(screen.findByTestId(ENDPOINT_SAVE_ID)?.props.accessibilityLabel)
            .toBe('common.save: Endpoint URL');

        act(() => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
        });

        expect(machinePluginSettingsSetMock).toHaveBeenCalledTimes(1);
        expect(machinePluginSettingsSetMock).toHaveBeenNthCalledWith(1, 'machine-1', {
            serverId: 'server-1',
            serverIdentityId: 'server-identity-1',
            pluginId: PLUGIN_ID,
            fieldId: 'endpoint',
            mutation: { kind: 'set', value: 'https://api.first.test' },
            expectedRevision: '0',
        });

        act(() => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://api.newer.test');
        });
        await act(async () => {
            firstSave.resolve(settingsSetResult({
                endpoint: 'https://api.first.test',
                enabled: true,
            }));
            await firstSave.promise;
        });

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://api.newer.test');
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.editable).toBe(true);

        await act(async () => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
            await Promise.resolve();
        });
        await flushAsync();

        expect(machinePluginSettingsSetMock).toHaveBeenCalledTimes(2);
        expect(machinePluginSettingsSetMock.mock.calls[1]?.[1]).toMatchObject({
            fieldId: 'endpoint',
            mutation: { kind: 'set', value: 'https://api.newer.test' },
        });
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://api.newer.test');
        expect(screen.findByTestId(ENDPOINT_SAVE_ID)?.props.disabled).toBe(true);
    });

    // UI-T28: the host-rendered settings form is the recovery path for a plugin
    // whose executable side is down. It must stay usable exactly then.
    it('stays editable for a plugin whose daemon activation failed', async () => {
        machinePluginSettingsSetMock.mockResolvedValue(settingsSetResult({
            endpoint: 'https://api.repaired.test',
            enabled: true,
        }));
        const degraded: PluginProjectionEntry = {
            ...createProjection(1),
            enabled: true,
            diagnostics: [{
                code: 'plugin_activation_failed',
                message: "Plugin 'acme.hooks' activation failed: missing API token",
                severity: 'error',
            }],
        };
        const { screen } = await renderSection(degraded);

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)).toBeTruthy();

        await act(async () => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://api.repaired.test');
        });
        await act(async () => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
            await Promise.resolve();
        });
        await flushAsync();

        expect(machinePluginSettingsSetMock).toHaveBeenCalledWith('machine-1', {
            serverId: 'server-1',
            serverIdentityId: 'server-identity-1',
            pluginId: PLUGIN_ID,
            fieldId: 'endpoint',
            mutation: { kind: 'set', value: 'https://api.repaired.test' },
            expectedRevision: '0',
        });
    });

    it('does not attribute an older failed save to a newer text draft', async () => {
        const firstSave = createDeferred<MachinePluginSettingsSetResult>();
        machinePluginSettingsSetMock
            .mockReturnValueOnce(firstSave.promise)
            .mockResolvedValueOnce(settingsSetResult({
                endpoint: 'https://api.newer.test',
                enabled: true,
            }));
        const { screen } = await renderSection();

        act(() => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://api.first.test');
        });
        act(() => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
        });
        act(() => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://api.newer.test');
        });

        await act(async () => {
            firstSave.resolve(unsupportedSetResult);
            await firstSave.promise;
        });

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://api.newer.test');
        expect(screen.findByTestId(ENDPOINT_SAVE_ID)?.props.accessibilityLabel)
            .toBe('common.save: Endpoint URL');
        expect(screen.getTextContent()).not.toContain('settingsPlugins.genericSettingsSaveError');

        await act(async () => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
            await Promise.resolve();
        });
        await flushAsync();

        expect(machinePluginSettingsSetMock.mock.calls.map((call) => call[1]?.mutation)).toEqual([
            { kind: 'set', value: 'https://api.first.test' },
            { kind: 'set', value: 'https://api.newer.test' },
        ]);
    });

    it('renders an adapter-owned unknown SET outcome after one safe readback without replaying the mutation', async () => {
        machinePluginSettingsGetMock
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://before.example.test',
                enabled: true,
            }, [], '0'))
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://possibly-applied.example.test',
                enabled: true,
            }, [], '1'));
        machinePluginSettingsSetMock.mockResolvedValueOnce({
            supported: false,
            reason: 'outcomeUnknown',
        } satisfies MachinePluginSettingsSetResult);
        const { screen } = await renderSection();

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.editable).toBe(true);

        await act(async () => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://possibly-applied.example.test');
        });
        expect(screen.findByTestId(ENDPOINT_SAVE_ID)?.props.disabled).toBe(false);

        await act(async () => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
            await Promise.resolve();
        });
        await flushAsync();

        expect(machinePluginSettingsSetMock).toHaveBeenCalledOnce();
        expect(machinePluginSettingsGetMock).toHaveBeenCalledTimes(2);
        expect(screen.getTextContent())
            .toContain('settingsProviders.errors.mutationOutcomeUnknownDescription');
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value)
            .toBe('https://possibly-applied.example.test');
    });

    it('keeps a daemon SavedSecret draft ambiguous after its safe readback without replaying it', async () => {
        machinePluginSecretStatusMock
            .mockResolvedValueOnce(secretStatusResult('missing', 'secret-0'))
            .mockResolvedValueOnce(secretStatusResult('configured', 'secret-1'));
        machinePluginSecretSetMock.mockResolvedValueOnce({
            supported: false,
            reason: 'outcomeUnknown',
        } satisfies MachinePluginSecretSetResult);
        const { screen } = await renderSection();

        act(() => {
            screen.changeTextByTestId(SECRET_INPUT_ID, 'possibly-applied-daemon-secret');
        });
        act(() => {
            screen.pressByTestId(SECRET_SAVE_ID);
        });
        await flushAsync();

        expect(machinePluginSecretSetMock).toHaveBeenCalledOnce();
        expect(machinePluginSecretStatusMock).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId(SECRET_INPUT_ID)?.props.value)
            .toBe('possibly-applied-daemon-secret');
        expect(screen.findByTestId(SECRET_SAVE_ID)?.props.accessibilityLabel)
            .toBe('common.retry: API token');
        expect(screen.getTextContent())
            .toContain('settingsProviders.errors.mutationOutcomeUnknownDescription');
        expect(screen.getTextContent()).not.toContain('settingsPlugins.genericSettingsSaveError');
    });

    it('preserves a failed secret draft for retry and clears only the exact successful draft', async () => {
        const retrySave = createDeferred<MachinePluginSecretSetResult>();
        machinePluginSecretSetMock
            .mockResolvedValueOnce({ supported: false, reason: 'error' })
            .mockReturnValueOnce(retrySave.promise)
            .mockResolvedValueOnce(secretSetResult('configured', 'secret-3'));
        const { screen } = await renderSection();

        expect(screen.findByTestId(SECRET_INPUT_ID)?.props.value).toBe('');
        expect(screen.findByTestId(SECRET_INPUT_ID)?.props.secureTextEntry).toBe(true);
        expect(screen.getTextContent()).not.toContain('must-not-render');

        await act(async () => {
            screen.changeTextByTestId(SECRET_INPUT_ID, 'retry-secret');
        });
        expect(machinePluginSecretSetMock).not.toHaveBeenCalled();
        expect(screen.getTextContent()).not.toContain('retry-secret');

        await act(async () => {
            screen.pressByTestId(SECRET_SAVE_ID);
            await Promise.resolve();
        });
        await flushAsync();

        expect(screen.findByTestId(SECRET_INPUT_ID)?.props.value).toBe('retry-secret');
        expect(screen.findByTestId(SECRET_SAVE_ID)?.props.accessibilityLabel)
            .toBe('common.retry: API token');
        expect(screen.getTextContent()).toContain('settingsPlugins.genericSettingsSaveError');
        expect(screen.getTextContent()).not.toContain('retry-secret');

        act(() => {
            screen.pressByTestId(SECRET_SAVE_ID);
        });
        act(() => {
            screen.changeTextByTestId(SECRET_INPUT_ID, 'newer-secret');
        });
        await act(async () => {
            retrySave.resolve(secretSetResult('configured', 'secret-2'));
            await retrySave.promise;
        });

        expect(screen.findByTestId(SECRET_INPUT_ID)?.props.value).toBe('newer-secret');
        expect(screen.getTextContent()).not.toContain('retry-secret');
        expect(screen.getTextContent()).not.toContain('newer-secret');

        await act(async () => {
            screen.pressByTestId(SECRET_SAVE_ID);
            await Promise.resolve();
        });
        await flushAsync();

        expect(machinePluginSecretSetMock.mock.calls.map((call) => call[1]?.value)).toEqual([
            'retry-secret',
            'retry-secret',
            'newer-secret',
        ]);
        expect(screen.findByTestId(SECRET_INPUT_ID)?.props.value).toBe('');
        expect(screen.getTextContent()).not.toContain('newer-secret');
    });

    it('persists an empty daemon secret as data rather than inferring a delete', async () => {
        machinePluginSecretSetMock.mockResolvedValueOnce(secretSetResult('configured', 'secret-1'));
        const { screen } = await renderSection();

        await act(async () => {
            screen.changeTextByTestId(SECRET_INPUT_ID, '');
            await Promise.resolve();
        });
        await act(async () => {
            screen.pressByTestId(SECRET_SAVE_ID);
            await Promise.resolve();
        });
        await flushAsync();

        expect(machinePluginSecretSetMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            secretId: 'apiToken',
            value: '',
        }));
        expect(machinePluginSecretDeleteMock).not.toHaveBeenCalled();
    });

    it('keeps a pending save serialized and authoritative across a same-scope projection refresh', async () => {
        const pendingSave = createDeferred<MachinePluginSettingsSetResult>();
        machinePluginSettingsSetMock.mockReturnValueOnce(pendingSave.promise);
        machinePluginSettingsGetMock
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://projection-one.test',
                enabled: true,
            }))
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://projection-two.test',
                enabled: false,
            }));
        const firstProjection = createProjection(1);
        const secondProjection = createProjection(2);
        const { PluginDetailGenericSettingsSection, screen } = await renderSection(firstProjection);

        act(() => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://old-scope-draft.test');
        });
        act(() => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
        });

        await act(async () => {
            screen.tree.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={secondProjection}
                    machineId="machine-1"
                    serverId="server-1"
                    accountServerIdentityId="server-identity-1"
                    daemonServerIdentityId="server-identity-1"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();

        expect(machinePluginSettingsGetMock).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://old-scope-draft.test');
        expect(screen.findByTestId(ENDPOINT_SAVE_ID)?.props.disabled).toBe(true);

        await act(async () => {
            pendingSave.resolve(settingsSetResult({
                endpoint: 'https://old-scope-draft.test',
                enabled: true,
            }));
            await pendingSave.promise;
        });

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://old-scope-draft.test');
        expect(screen.findByTestId(ENDPOINT_SAVE_ID)?.props.disabled).toBe(true);
        expect(findSwitch(screen)?.props.value).toBe(false);
    });

    it('keeps a replaced-source draft visible but inert after refresh failure until the replacement source edits it', async () => {
        const refresh = createDeferred<MachinePluginSettingsResult>();
        machinePluginSettingsGetMock
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://projection-one.test',
                enabled: true,
            }))
            .mockReturnValueOnce(refresh.promise);
        machinePluginSettingsSetMock.mockResolvedValueOnce(settingsSetResult({
            endpoint: 'https://local-draft.test',
            enabled: true,
        }));
        const { PluginDetailGenericSettingsSection, screen } = await renderSection(createProjection(1));

        act(() => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://local-draft.test');
        });
        await act(async () => {
            screen.tree.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={createProjection(2)}
                    machineId="machine-1"
                    serverId="server-1"
                    accountServerIdentityId="server-identity-1"
                    daemonServerIdentityId="server-identity-1"
                    daemonOperationsAvailable
                />,
            );
        });

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://local-draft.test');
        expect(screen.findByTestId(ENDPOINT_SAVE_ID)?.props.disabled).toBe(true);

        await act(async () => {
            refresh.resolve(unsupportedResult);
            await refresh.promise;
        });

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://local-draft.test');
        expect(screen.findByTestId(ENDPOINT_SAVE_ID)?.props.disabled).toBe(true);
        expect(screen.getTextContent()).toContain('settingsPlugins.genericSettingsLoadError');

        act(() => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://replacement-source-draft.test');
        });
        expect(screen.findByTestId(ENDPOINT_SAVE_ID)?.props.disabled).toBe(false);

        await act(async () => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
            await Promise.resolve();
        });
        await flushAsync();

        expect(machinePluginSettingsSetMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            fieldId: 'endpoint',
            mutation: { kind: 'set', value: 'https://replacement-source-draft.test' },
        }));
    });

    it('serializes different-field saves through the shared scoped record owner', async () => {
        const endpointSave = createDeferred<MachinePluginSettingsSetResult>();
        const switchSave = createDeferred<MachinePluginSettingsSetResult>();
        machinePluginSettingsSetMock
            .mockReturnValueOnce(endpointSave.promise)
            .mockReturnValueOnce(switchSave.promise);
        const { screen } = await renderSection();

        act(() => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://api.changed.test');
        });
        await act(async () => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
            await Promise.resolve();
        });

        expect(machinePluginSettingsSetMock).toHaveBeenCalledTimes(1);
        expect(findSwitch(screen)?.props.disabled).toBe(true);

        act(() => {
            screen.pressByTestId(SWITCH_ID);
        });
        expect(machinePluginSettingsSetMock).toHaveBeenCalledTimes(1);
        expect(findSwitch(screen)?.props.value).toBe(true);

        await act(async () => {
            endpointSave.resolve(settingsSetResult({
                endpoint: 'https://api.changed.test',
                enabled: true,
            }, [], '1'));
            await endpointSave.promise;
        });

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://api.changed.test');
        expect(findSwitch(screen)?.props.value).toBe(true);
        expect(findSwitch(screen)?.props.disabled).toBe(false);

        await act(async () => {
            screen.pressByTestId(SWITCH_ID);
            await Promise.resolve();
        });
        expect(machinePluginSettingsSetMock).toHaveBeenCalledTimes(2);
        expect(machinePluginSettingsSetMock).toHaveBeenNthCalledWith(2, 'machine-1', expect.objectContaining({
            fieldId: 'enabled',
            expectedRevision: '1',
            mutation: { kind: 'set', value: false },
        }));

        await act(async () => {
            switchSave.resolve(settingsSetResult({
                endpoint: 'https://api.changed.test',
                enabled: false,
            }, [], '2'));
            await switchSave.promise;
        });

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://api.changed.test');
        expect(findSwitch(screen)?.props.value).toBe(false);
    });

    it('invalidates a pending switch save once its field is removed, even if the key is reintroduced', async () => {
        const removedFieldSave = createDeferred<MachinePluginSettingsSetResult>();
        machinePluginSettingsSetMock.mockReturnValueOnce(removedFieldSave.promise);
        machinePluginSettingsGetMock
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://projection-one.test',
                enabled: true,
            }))
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://projection-two.test',
            }))
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://projection-three.test',
                enabled: true,
            }));
        const fieldsWithoutSwitch = SETTINGS_FIELDS.filter((field) => field.key !== 'enabled');
        const { PluginDetailGenericSettingsSection, screen } = await renderSection(createProjection(1));

        act(() => {
            screen.pressByTestId(SWITCH_ID);
        });
        await act(async () => {
            screen.tree.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={createProjection(2, fieldsWithoutSwitch)}
                    machineId="machine-1"
                    serverId="server-1"
                    accountServerIdentityId="server-identity-1"
                    daemonServerIdentityId="server-identity-1"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();
        expect(findSwitch(screen)).toBeNull();

        await act(async () => {
            screen.tree.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={createProjection(3)}
                    machineId="machine-1"
                    serverId="server-1"
                    accountServerIdentityId="server-identity-1"
                    daemonServerIdentityId="server-identity-1"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();

        expect(machinePluginSettingsGetMock).toHaveBeenCalledTimes(3);
        expect(findSwitch(screen)?.props.value).toBe(true);
        expect(findSwitch(screen)?.props.disabled).toBe(false);

        await act(async () => {
            removedFieldSave.resolve(settingsSetResult({
                endpoint: 'https://projection-one.test',
                enabled: false,
            }));
            await removedFieldSave.promise;
        });

        expect(findSwitch(screen)?.props.value).toBe(true);
        expect(findSwitch(screen)?.props.disabled).toBe(false);
    });

    it('invalidates a pending save when the machine storage scope changes', async () => {
        const oldMachineSave = createDeferred<MachinePluginSettingsSetResult>();
        machinePluginSettingsSetMock.mockReturnValueOnce(oldMachineSave.promise);
        machinePluginSettingsGetMock
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://machine-one.test',
                enabled: true,
            }))
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://machine-two.test',
                enabled: false,
            }));
        const projection = createProjection(1);
        const { PluginDetailGenericSettingsSection, screen } = await renderSection(projection);

        act(() => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://old-machine-draft.test');
        });
        act(() => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
        });

        await act(async () => {
            screen.tree.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={projection}
                    machineId="machine-2"
                    serverId="server-1"
                    accountServerIdentityId="server-identity-1"
                    daemonServerIdentityId="server-identity-1"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://machine-two.test');

        await act(async () => {
            oldMachineSave.resolve(settingsSetResult({
                endpoint: 'https://old-machine-draft.test',
                enabled: true,
            }));
            await oldMachineSave.promise;
        });

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://machine-two.test');
        expect(findSwitch(screen)?.props.value).toBe(false);
    });

    it('serializes rapid switch interaction and restores the persisted value after failure', async () => {
        const firstSave = createDeferred<MachinePluginSettingsSetResult>();
        machinePluginSettingsSetMock
            .mockReturnValueOnce(firstSave.promise)
            .mockResolvedValueOnce(settingsSetResult({
                endpoint: 'https://api.example.test',
                enabled: false,
            }));
        const { screen } = await renderSection();

        const initialSwitch = findSwitch(screen);
        expect(initialSwitch?.props.value).toBe(true);
        expect(initialSwitch?.props.accessibilityLabel).toBe('Enable hooks');
        expect(hasPressableTestIdAncestor(initialSwitch, SWITCH_ID)).toBe(false);

        act(() => {
            screen.pressByTestId(SWITCH_ID);
            screen.pressByTestId(SWITCH_ID);
        });

        expect(machinePluginSettingsSetMock).toHaveBeenCalledTimes(1);
        expect(machinePluginSettingsSetMock.mock.calls[0]?.[1]).toMatchObject({
            fieldId: 'enabled',
            mutation: { kind: 'set', value: false },
        });
        expect(findSwitch(screen)?.props.value).toBe(false);
        expect(findSwitch(screen)?.props.disabled).toBe(true);

        await act(async () => {
            firstSave.resolve(unsupportedSetResult);
            await firstSave.promise;
        });

        expect(findSwitch(screen)?.props.value).toBe(true);
        expect(findSwitch(screen)?.props.disabled).toBe(false);
        expect(screen.getTextContent()).toContain('settingsPlugins.genericSettingsSaveError');

        await act(async () => {
            screen.pressByTestId(SWITCH_ID);
            await Promise.resolve();
        });
        await flushAsync();

        expect(machinePluginSettingsSetMock).toHaveBeenCalledTimes(2);
        expect(findSwitch(screen)?.props.value).toBe(false);
        expect(findSwitch(screen)?.props.disabled).toBe(false);
    });

    it('renders a per-active-server field from canonical presentation and writes its hidden backing map', async () => {
        const boundFields: readonly PluginProjectionEditableSettingField[] = [{
            key: 'serverUrl',
            control: 'text',
            valueType: 'string',
            valueSchema: { type: 'string' },
            title: 'Server URL',
            secretCustody: null,
            redaction: 'none',
            clearWhenEmpty: 'persist',
            presentation: {
                control: 'text',
                binding: {
                    kind: 'perActiveServer',
                    fallbackSettingId: 'serverUrl',
                    byServerIdSettingId: 'serverUrlByServerId',
                },
            },
        }, {
            key: 'serverUrlByServerId',
            control: 'json',
            valueType: 'object',
            valueSchema: { type: 'object', additionalProperties: { type: 'string' } },
            title: 'Per-server URLs',
            secretCustody: null,
            redaction: 'none',
            clearWhenEmpty: 'persist',
            presentation: { control: 'json', hidden: true },
        }];
        machinePluginSettingsGetMock.mockResolvedValueOnce(settingsResult({
            serverUrl: 'https://fallback.example',
            serverUrlByServerId: { 'server-identity-1': 'https://scoped.example' },
        }, []));
        machinePluginSettingsSetMock.mockResolvedValueOnce(settingsSetResult({
            serverUrl: 'https://fallback.example',
            serverUrlByServerId: { 'server-identity-1': 'https://updated.example' },
        }, [], '1'));
        const { screen } = await renderSection(createProjection(1, boundFields));
        const inputId = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.serverUrl.input`;
        const saveId = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.serverUrl.save`;

        expect(screen.findByTestId(inputId)?.props.value).toBe('https://scoped.example');
        expect(screen.getTextContent()).not.toContain('Per-server URLs');
        act(() => {
            screen.findByTestId(inputId)?.props.onChangeText('https://updated.example');
        });
        await act(async () => {
            screen.pressByTestId(saveId);
            await Promise.resolve();
        });

        expect(machinePluginSettingsSetMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            fieldId: 'serverUrlByServerId',
            mutation: { kind: 'set', value: { 'server-identity-1': 'https://updated.example' } },
        }));
    });

    it('keeps the active Account record target while binding a per-active-server field to the exact Administration server identity', async () => {
        const boundFields: readonly PluginProjectionEditableSettingField[] = [{
            key: 'serverUrl',
            control: 'text',
            valueType: 'string',
            valueSchema: { type: 'string' },
            title: 'Server URL',
            secretCustody: null,
            redaction: 'none',
            clearWhenEmpty: 'persist',
            presentation: {
                control: 'text',
                binding: {
                    kind: 'perActiveServer',
                    fallbackSettingId: 'serverUrl',
                    byServerIdSettingId: 'serverUrlByServerId',
                },
            },
        }, {
            key: 'serverUrlByServerId',
            control: 'json',
            valueType: 'object',
            valueSchema: { type: 'object', additionalProperties: { type: 'string' } },
            title: 'Per-server URLs',
            secretCustody: null,
            redaction: 'none',
            clearWhenEmpty: 'persist',
            presentation: { control: 'json', hidden: true },
        }];
        const accountTarget = { kind: 'account' as const, serverIdentityId: 'server-identity-1' };
        scopedSettingsReadMock.mockImplementation((input: Readonly<{ scope?: Readonly<{ kind?: string }> }>) => (
            input.scope?.kind === 'account'
                ? Promise.resolve({
                    status: 'ready' as const,
                    snapshot: {
                        scope: { kind: 'account' as const },
                        target: accountTarget,
                        revision: { kind: 'account' as const, value: 3 },
                        values: {
                            serverUrl: 'https://fallback.example.test',
                            serverUrlByServerId: {
                                'server-identity-1': 'https://active-account.example.test',
                                'server-identity-b': 'https://selected-administration.example.test',
                            },
                        },
                    },
                })
                : undefined
        ));
        scopedSettingsWriteMock.mockResolvedValue({
            status: 'ready',
            snapshot: {
                scope: { kind: 'account' },
                target: accountTarget,
                revision: { kind: 'account', value: 4 },
                values: {
                    serverUrl: 'https://fallback.example.test',
                    serverUrlByServerId: {
                        'server-identity-1': 'https://active-account.example.test',
                        'server-identity-b': 'https://updated-administration.example.test',
                    },
                },
            },
        });

        const { screen } = await renderSection(createProjection(1, boundFields, 'account'), {
            daemonServerIdentityId: 'server-identity-b',
        });
        const inputId = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.serverUrl.input`;
        const saveId = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.serverUrl.save`;

        expect(scopedSettingsReadMock).toHaveBeenCalledWith(expect.objectContaining({
            scope: { kind: 'account' },
            target: accountTarget,
        }));
        expect(screen.findByTestId(inputId)?.props.value).toBe('https://selected-administration.example.test');

        await act(async () => {
            screen.changeTextByTestId(inputId, 'https://updated-administration.example.test');
        });
        expect(screen.findByTestId(saveId)?.props.disabled).toBe(false);
        await act(async () => {
            screen.pressByTestId(saveId);
            await Promise.resolve();
        });

        expect(scopedSettingsWriteMock).toHaveBeenCalledWith(expect.objectContaining({
            scope: { kind: 'account' },
            target: accountTarget,
            fieldId: 'serverUrlByServerId',
            mutation: {
                kind: 'set',
                value: {
                    'server-identity-1': 'https://active-account.example.test',
                    'server-identity-b': 'https://updated-administration.example.test',
                },
            },
        }));
    });

});
