import * as React from 'react';
import { Pressable } from 'react-native';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginManifestV2Schema } from '@happier-dev/protocol';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import { PluginAccountAvailabilityIntentReadResponseV1Schema, PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityIntentsListActionOutputV1Schema, PluginAvailabilityMaterializationsReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { PluginAccountSettingsMutationRequestV1Schema, PluginAccountSettingsMutationResponseV1Schema,
    PluginAccountSettingsReadResponseV1Schema, PluginAccountSettingsValuesV1Schema } from '@happier-dev/protocol/plugins/settings/accountSettingsV1';
import { PluginSettingsContributionV2Schema, type PluginSettingFieldV2 } from '@happier-dev/protocol/plugins/contributions/settings';
import { PluginProjectionV2Schema, projectPluginSettingsContributionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { AccountSettingsV2UpdateRequestSchema, type AccountSettingsV2UpdateRequest } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { applyAccountSettingsSavedSecretMutation, resolveAccountSettingsPluginSecretBinding, resolveAccountSettingsPluginSecret } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import type { HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import { parseToken } from '@/utils/auth/parseToken';
import type { InvalidateSync } from '@/utils/sessions/sync';

import type {
    PluginProjectionEditableSettingField,
    PluginProjectionEntry,
} from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { createDeferred, createMachineFixture, flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';
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
    ScopedPluginSettingsReadResult,
    ScopedPluginSettingsWriteResult,
} from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

const machinePluginSettingsGetMock = vi.hoisted(() => vi.fn());
const machinePluginSettingsSetMock = vi.hoisted(() => vi.fn());
const machinePluginSecretStatusMock = vi.hoisted(() => vi.fn());
const machinePluginSecretSetMock = vi.hoisted(() => vi.fn());
const machinePluginSecretDeleteMock = vi.hoisted(() => vi.fn());
const modalShowMock = vi.hoisted(() => vi.fn());
const modalConfirmMock = vi.hoisted(() => vi.fn(async () => true));
const scopedSettingsWatchMock = vi.hoisted(() => vi.fn());
const scopedSettingsReadMock = vi.hoisted(() => vi.fn());
const scopedSettingsWriteMock = vi.hoisted(() => vi.fn());
const scopedDaemonSecretReadMock = vi.hoisted(() => vi.fn());
const scopedDaemonSecretWriteMock = vi.hoisted(() => vi.fn());
const routerPushSpy = vi.hoisted(() => vi.fn());
const platformEnvironment = vi.hoisted(() => ({
    platform: 'web' as 'web' | 'ios' | 'android',
}));
const activeAccountLifetimeState = vi.hoisted(() => ({
    current: null as ActiveServerAccountScopeLifetime | null,
}));

await vi.hoisted(async () => {
    const { installSettingsViewCommonModuleMocks } = await import('../../settingsViewTestHelpers');
    installSettingsViewCommonModuleMocks({
        storage: 'real',
        modal: async () => {
            const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
            return createModalModuleMock({ spies: { show: modalShowMock, confirm: modalConfirmMock } }).module;
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
            // Keys render as themselves. The secret-deletion prompt is the one
            // exception: its interpolated name carries the record-owner label under
            // test, so that single key keeps its argument.
            return createTextModuleMock({
                translate: (key, params) => {
                    const name = (params as Readonly<{ name?: unknown }> | undefined)?.name;
                    return key === 'secrets.prompts.deleteConfirm' && typeof name === 'string'
                        ? `${key}:${name}`
                        : key;
                },
            });
        },
        router: async () => {
            const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
            return createExpoRouterMock({ router: { push: routerPushSpy } }).module;
        },
    });
});

const { createProviderSettingsAccountHarness } = await import('@/dev/testkit/harness/providerSettingsHarness');
const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
const account = createProviderSettingsAccountHarness();
const { installRealActionExecutorModuleLoader, createAccountSettingsHttpBoundary } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
const disposeActionExecutorLoader = await installRealActionExecutorModuleLoader();
afterAll(disposeActionExecutorLoader);
const pluginSettingsAnalytics = await import('@/track/settingsAnalytics/emitPluginSettingChangedEvent');
const emitPluginSettingChangedEventMock = vi.spyOn(pluginSettingsAnalytics, 'emitPluginSettingChangedEvent');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { projectScopedPluginSettingsFields } = await import('@/sync/domains/plugins/settings/scopedPluginSettingsProjection');
const accountRecordPaths = new Set<string>();
const accountSettingsWrites: AccountSettingsV2UpdateRequest[] = [];
let accountSettingsHttp: ReturnType<typeof createAccountSettingsHttpBoundary>;
let accountSettingsPost: ((input: AccountSettingsV2UpdateRequest, next: () => Promise<HomeDomainAnswer>) => Promise<HomeDomainAnswer>) | null = null;
let persistedAccountSettings: Readonly<Record<string, unknown>> = {};
let daemonProjection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {}, actionsById: {},
     resourcesById: {}, settingsById: {}, installedPackagesById: {}, diagnostics: [] });

async function publishSettingsDeclaration(projection: PluginProjectionEntry | null) {
    if (!projection) return;
    const definitions = projection.editableSettingsGroups.map(group => PluginSettingsContributionV2Schema.parse({
            id: group.id, title: group.title, scope: group.scope.kind,
            target: group.target, presentation: group.presentation,
            fields: [...group.fields.map(field => ({ id: field.key, title: field.title, schema: field.valueSchema,
                ...(field.subtitle ? { description: field.subtitle } : {}),
                ...(field.secretCustody ? { secret: { custody: field.secretCustody,
                    ...(field.managedServiceOrigin ? { managedServiceOrigin: field.managedServiceOrigin } : {}) } }
                    : field.defaultValue !== undefined || field.defaultBooleanValue !== undefined
                        ? { default: field.defaultValue ?? field.defaultBooleanValue } : {}),
                ...(field.presentation ? { presentation: field.presentation } : {}),
                ...(field.availability ? { availability: field.availability } : {}),
                ...(field.analytics ? { analytics: field.analytics } : {}),
            })), ...group.fields.flatMap((field): PluginSettingFieldV2[] => {
                const binding = field.presentation?.binding;
                return binding?.kind === 'perActiveServer' && !group.fields.some(candidate => candidate.key === binding.byServerIdSettingId) ? [{
                    id: binding.byServerIdSettingId, title: `${field.title} overrides`,
                    schema: { type: 'object', additionalProperties: field.valueSchema }, presentation: { hidden: true },
                }] : binding?.kind === 'direct' && binding.settingId !== undefined && binding.settingId !== field.key
                    && !group.fields.some(candidate => candidate.key === binding.settingId) ? [{
                    id: binding.settingId, title: `${field.title} storage`, schema: field.valueSchema,
                    presentation: { hidden: true }, ...(field.secretCustody ? { secret: { custody: field.secretCustody } } : {}),
                }] : [];
            })],
        }));
    const settings = definitions.map(definition => projectPluginSettingsContributionV2({ pluginId: projection.pluginId, definition }));
    daemonProjection = PluginProjectionV2Schema.parse({ ...daemonProjection, generation: projection.generation,
        settingsById: Object.fromEntries(settings.map(setting => [setting.id, setting])),
        installedPackagesById: { [projection.pluginId]: { id: projection.pluginId, displayName: projection.title,
            version: projection.version, enabled: projection.enabled, source: { kind: 'localPath', locator: '/fixture/plugin' },
            occurrenceId: projection.occurrenceId } },
    });
    const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
        hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
        intent: { pluginId: projection.pluginId, desiredVersion: projection.version, enabled: true,
            offlineUiHosting: 'enabled', writableCollections: [], revision: 'settings-fixture' },
        release: { ref: { pluginId: projection.pluginId, version: projection.version },
            archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest: PluginManifestV2Schema.parse({ schemaVersion: 2, id: projection.pluginId, version: projection.version,
                displayName: projection.title, engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
                contributes: { settings: definitions } }), collectionContracts: [], uiSlots: [],
            packageAssetArchive: { archiveDigestSha256: `sha256:${'c'.repeat(64)}`, resources: [] } },
        packageAssets: [], uiArtifacts: [],
    });
    account.home.answer(account.serverId, PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'], {
        body: PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse({ availabilityCursor: 1, snapshots: [] }),
    });
    account.home.answer(account.serverId, PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], {
        body: PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1, pluginIds: [projection.pluginId],
            intentReads: [{ pluginId: projection.pluginId, response }], failedPluginIds: [] }),
    });
    const { sync } = await import('@/sync/sync');
    const queue = Reflect.get(sync, 'pluginAvailabilitySync') as Pick<InvalidateSync, 'invalidate' | 'awaitQueue'>;
    queue.invalidate();
    await queue.awaitQueue();
    installAccountPluginSettingsRow(projection);
}

function installAccountPluginSettingsRow(projection: PluginProjectionEntry) {
    const path = `/v1/account/plugin-settings/${encodeURIComponent(projection.pluginId)}`;
    if (accountRecordPaths.has(path)) return;
    accountRecordPaths.add(path);
    const readInput = { pluginId: projection.pluginId, scope: { kind: 'account' as const },
        target: { kind: 'account' as const, serverIdentityId: 'srv_settings' },
        fields: projectScopedPluginSettingsFields(projection.editableSettingsGroups.filter(group => group.scope.kind === 'account')
            .flatMap(group => group.fields)),
    };
    const rows = new Map<string, Readonly<{ revision: number; values: Readonly<Record<string, unknown>> }>>();
    function accountOf(init: RequestInit | undefined) {
        const authorization = new Headers(init?.headers).get('Authorization');
        if (!authorization?.startsWith('Bearer ')) return null;
        try { return parseToken(authorization.slice('Bearer '.length)); } catch { return null; }
    }
    account.home.answer(account.serverId, `GET ${path}`, { select: async (_input, request) => {
        const accountId = accountOf(request.init);
        if (!accountId) return { status: 401 };
        let row = rows.get(accountId);
        if (!row) {
            const reply: ScopedPluginSettingsReadResult | undefined = await scopedSettingsReadMock(readInput);
            if (reply) {
                if (reply.status !== 'ready' || reply.snapshot.revision.kind !== 'account'
                    || typeof reply.snapshot.revision.value !== 'number') return { status: 503 };
                row = { revision: reply.snapshot.revision.value, values: reply.snapshot.values };
            } else {
                row = { revision: 1, values: {} };
            }
            rows.set(accountId, row);
        }
        return { body: PluginAccountSettingsReadResponseV1Schema.parse({ status: 'present', revision: row.revision,
            content: { t: 'plain', v: { v: 1, values: row.values } } }) };
    } });
    account.home.answer(account.serverId, `POST ${path}`, { select: async (input, request) => {
        const accountId = accountOf(request.init);
        if (!accountId) return { status: 401 };
        const row = rows.get(accountId);
        const mutation = PluginAccountSettingsMutationRequestV1Schema.parse(input);
        const reply: ScopedPluginSettingsWriteResult | undefined = await scopedSettingsWriteMock(mutation);
        if (!row || mutation.expectedRevision !== row.revision) return { body:
            PluginAccountSettingsMutationResponseV1Schema.parse({ status: 'conflict', revision: row?.revision ?? 0 }) };
        if (mutation.content?.t !== 'plain') throw new Error('Generic Settings fixture requires its Plain Account envelope');
        const updated = { revision: row.revision + 1, values: PluginAccountSettingsValuesV1Schema.parse(mutation.content.v).values };
        rows.set(accountId, updated);
        if (reply && reply.status !== 'ready' && reply.status !== 'applied') {
            if (reply.status === 'outcomeUnknown') return { dispatchThenFail: true };
            return { status: 503 };
        }
        return { body: PluginAccountSettingsMutationResponseV1Schema.parse({ status: 'updated', revision: updated.revision }) };
    } });
}

function installGenericSettingsSocketBoundary() {
    const replies = new Map<string, typeof machinePluginSettingsGetMock>([
        [RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET, machinePluginSettingsGetMock],
        [RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET, machinePluginSettingsSetMock],
        [RPC_METHODS.DAEMON_PLUGIN_SECRET_STATUS, machinePluginSecretStatusMock],
        [RPC_METHODS.DAEMON_PLUGIN_SECRET_SET, machinePluginSecretSetMock],
        [RPC_METHODS.DAEMON_PLUGIN_SECRET_DELETE, machinePluginSecretDeleteMock],
    ]);
    installDisconnectedServerSocketBoundary(socket => {
        socket.connect = vi.fn<typeof socket.connect>(() => {
            socket.connected = true;
            for (const listener of socket.listeners('connect')) listener();
            return socket;
        });
        socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event: string, packet: unknown) => {
            if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
            if (!packet || typeof packet !== 'object' || !('method' in packet) || typeof packet.method !== 'string'
                || !('params' in packet) || !packet.params || typeof packet.params !== 'object') {
                throw new Error('Malformed Generic Settings Socket request');
            }
            const separator = packet.method.indexOf(':');
            const method = packet.method.slice(separator + 1);
            if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: true, result: { protocolVersion: 1, projection: daemonProjection } };
            }
            if (method === RPC_METHODS.DAEMON_PLUGIN_SETTINGS_WATCH) {
                return { ok: true, result: await scopedSettingsWatchMock(packet.params) };
            }
            if ('canonicalOrigin' in packet.params && (method === RPC_METHODS.DAEMON_PLUGIN_SECRET_STATUS
                || method === RPC_METHODS.DAEMON_PLUGIN_SECRET_SET || method === RPC_METHODS.DAEMON_PLUGIN_SECRET_DELETE)) {
                const params = packet.params as Readonly<Record<string, unknown>>;
                const input = { target: { kind: 'daemon', serverId: resolveServerProfileScopeIdForIdentifier(account.serverId),
                    serverIdentityId: params.serverIdentityId, machineId: params.machineId },
                    pluginId: params.pluginId, secretId: params.secretId, canonicalOrigin: params.canonicalOrigin,
                    ...(method === RPC_METHODS.DAEMON_PLUGIN_SECRET_STATUS ? {} : { expectedRevision: params.expectedRevision,
                        mutation: method === RPC_METHODS.DAEMON_PLUGIN_SECRET_SET ? { kind: 'set', value: params.value } : { kind: 'delete' } }),
                };
                const response: unknown = await (method === RPC_METHODS.DAEMON_PLUGIN_SECRET_STATUS
                    ? scopedDaemonSecretReadMock(input) : scopedDaemonSecretWriteMock(input));
                if (response && typeof response === 'object' && 'status' in response) {
                    if (response.status !== 'ready' || !('snapshot' in response) || !response.snapshot
                        || typeof response.snapshot !== 'object') return { ok: true, result: null };
                    const snapshot = response.snapshot as Readonly<Record<string, unknown>>;
                    return { ok: true, result: { protocolVersion: 1, pluginId: snapshot.pluginId, secretId: snapshot.secretId,
                        state: snapshot.state, revision: snapshot.revision } };
                }
            }
            const reply = replies.get(method);
            if (!reply) throw new Error(`Unexpected Generic Settings Socket method: ${method}`);
            const params = { ...packet.params } as Record<string, unknown>;
            delete params.machineId;
            delete params.scope;
            const response: unknown = await reply(packet.method.slice(0, separator), {
                ...params, serverId: resolveServerProfileScopeIdForIdentifier(account.serverId),
            });
            if (!response || typeof response !== 'object' || !('supported' in response) || !response.supported) {
                return { ok: true, result: null };
            }
            return { ok: true, result: 'snapshot' in response ? response.snapshot : 'result' in response ? response.result : null };
        });
    });
}

function seededAccountSecrets() {
    let settings: Record<string, unknown> = {};
    for (const localId of ['apiToken', 'accountToken']) {
        const id = `saved-${localId}`;
        settings = applyAccountSettingsSavedSecretMutation(settings, { kind: 'add', secret: {
            id, name: `Existing ${localId}`, kind: 'token',
            // Synthetic legacy ingress; Plain Accounts have no client encryption key.
            encryptedValue: { _isSecretValue: true, value: 'must-not-render' }, createdAt: 1, updatedAt: 1,
        } }).settings;
        settings = applyAccountSettingsSavedSecretMutation(settings, { kind: 'bindPluginSecret',
            target: { pluginId: PLUGIN_ID, localId }, expectedSecretId: null, expectedSecretUpdatedAt: null, secretId: id,
        }).settings;
    }
    return settings;
}

async function restoreTestAccount(accountId = 'account-a', settings = seededAccountSecrets()) {
    installGenericSettingsSocketBoundary();
    await account.restore({ accountId, currentAccount: true, serverIdentityId: 'srv_settings',
        settings,
        machines: [createMachineFixture({ activeAt: Date.now() }), createMachineFixture({ id: 'machine-2', activeAt: Date.now() })] });
    const home = account.home.findByServerUrl('https://provider-settings-account.test');
    if (!home) throw new Error('Generic Settings requires its restored HTTP Home');
    const settingsHttp = createAccountSettingsHttpBoundary({ serverUrl: home.serverUrl,
        initialAccounts: [{ accountId, snapshot: { version: 1, content: { t: 'plain', v: settings } } }],
    });
    accountSettingsHttp = settingsHttp;
    persistedAccountSettings = settings;
    account.home.answer(account.serverId, '/v2/account/settings', { select: async (input, request) => {
        const next = async (): Promise<HomeDomainAnswer> => {
            const response = settingsHttp.handle(request.url, request.init);
            if (!response) throw new Error('Missing Generic Settings Account HTTP route');
            const body: unknown = await response.json();
            if (input && typeof body === 'object' && body !== null && 'success' in body && body.success === true) {
                const mutation = AccountSettingsV2UpdateRequestSchema.parse(input);
                if (mutation.content?.t === 'plain') persistedAccountSettings = mutation.content.v;
            }
            return { status: response.status, body };
        };
        if (request.init?.method !== 'POST') return next();
        const mutation = AccountSettingsV2UpdateRequestSchema.parse(input);
        accountSettingsWrites.push(mutation);
        return accountSettingsPost ? accountSettingsPost(mutation, next) : next();
    } });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Generic Settings fixture requires its real applied Account lifetime');
    activeAccountLifetimeState.current = lifetime;
    return lifetime;
}

const PLUGIN_ID = 'acme.hooks';
const GROUP_ID = 'settings';
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
    pluginId = PLUGIN_ID,
    occurrenceId = `occurrence-${generation}`,
): PluginProjectionEntry {
    return {
        pluginId,
        occurrenceId,
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
            pluginId,
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
        occurrenceId: 'external-notification-occurrence-1',
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
        occurrenceId: 'opencode-occurrence-1',
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

function readyOpenCodeAccountSettings(
    selectedEndpoint: string,
    target: Readonly<{ kind: 'account'; serverIdentityId: string }> = {
        kind: 'account',
        serverIdentityId: 'srv_settings',
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
                    'srv_settings': selectedEndpoint,
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
        perActiveServerIdentityId?: string | null;
        /** The platform fact the app's presentation provider supplies (touch floors). */
        uiPlatform?: 'ios' | 'android' | 'web';
        presentation?: Readonly<{ kind: 'disclosures'; title: string }>;
    }> = {},
) {
    await publishSettingsDeclaration(projection);
    const { PluginDetailGenericSettingsSection } = await import('./PluginDetailGenericSettingsSection');
    const pluginId = projection?.pluginId ?? PLUGIN_ID;
    const element = (
        <PluginDetailGenericSettingsSection
            pluginId={pluginId}
            projection={projection}
            accountSettingsDeclaration={options.accountSettingsDeclaration}
            machineId={options.machineId === undefined ? 'machine-1' : options.machineId}
            serverId={options.serverId === undefined ? account.serverId : options.serverId}
            accountServerIdentityId="srv_settings"
            daemonServerIdentityId={options.daemonServerIdentityId === undefined
                ? 'srv_settings'
                : options.daemonServerIdentityId}
            perActiveServerIdentityId={options.perActiveServerIdentityId === undefined
                ? 'srv_settings'
                : options.perActiveServerIdentityId}
            daemonOperationsAvailable={options.daemonOperationsAvailable ?? true}
            isDaemonTargetCurrent={options.isDaemonTargetCurrent}
            presentation={options.presentation}
        />
    );
    const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
    const screen = await renderScreen(options.uiPlatform
        ? <HappierUiPlatformProvider platform={{ platform: options.uiPlatform, colorScheme: 'light' }}>{element}</HappierUiPlatformProvider>
        : element);
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

// Initialize the real screen after the declared platform boundaries during
// collection, outside individual interaction-test deadlines.
await import('./PluginDetailGenericSettingsSection');

describe('PluginDetailGenericSettingsSection', () => {
    beforeEach(async () => {
        platformEnvironment.platform = 'web';
        accountRecordPaths.clear();
        machinePluginSettingsGetMock.mockReset();
        machinePluginSettingsSetMock.mockReset();
        machinePluginSecretStatusMock.mockReset();
        machinePluginSecretSetMock.mockReset();
        machinePluginSecretDeleteMock.mockReset();
        machinePluginSecretStatusMock.mockResolvedValue(secretStatusResult('missing'));
        machinePluginSecretSetMock.mockResolvedValue(secretSetResult('configured', 'origin-1'));
        machinePluginSecretDeleteMock.mockResolvedValue(secretDeleteResult('missing', 'origin-2'));
        scopedSettingsWatchMock.mockReset();
        // A parked daemon watch owns no timer here; the real caller's retirement cancels it.
        scopedSettingsWatchMock.mockImplementation(() => new Promise(() => {}));
        scopedSettingsReadMock.mockReset();
        scopedSettingsWriteMock.mockReset();
        scopedDaemonSecretReadMock.mockReset();
        scopedDaemonSecretWriteMock.mockReset();
        routerPushSpy.mockReset();
        emitPluginSettingChangedEventMock.mockClear();
        machinePluginSettingsGetMock.mockResolvedValue(settingsResult({
            endpoint: 'https://api.example.test',
            apiToken: 'must-not-render',
            enabled: true,
        }));
        accountSettingsWrites.length = 0;
        accountSettingsPost = null;
        modalShowMock.mockReset();
        modalConfirmMock.mockReset();
        modalConfirmMock.mockResolvedValue(true);
        await restoreTestAccount();
    });

    afterEach(async () => {
        await standardCleanup();
        await account.reset();
        activeAccountLifetimeState.current = null;
    });

    it('draws no section for a settings group with nothing the user can set', async () => {
        const { screen } = await renderSection(createProjection(1, []));
        expect(screen.findByTestId(`settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.empty`)).toBeNull();
        expect(screen.findAll((node) => node.props?.title === 'Acme hook settings')).toHaveLength(0);
    });

    it('summarises each section as a closed disclosure on a page about something else, and opens it on a save failure', async () => {
        machinePluginSettingsSetMock.mockResolvedValue(unsupportedSetResult);
        const disclosureId = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.disclosure`;
        const { screen } = await renderSection(createProjection(1), {
            presentation: { kind: 'disclosures', title: 'Plugin settings' },
        });
        const header = () => screen.findAll((node) => (
            node.props?.title === 'Acme hook settings' && node.props?.accessibilityState !== undefined
        ))[0] ?? null;

        // Closed, with the endpoint (no declared default) counted as changed and `enabled` at its default.
        expect(header()?.props.accessibilityState).toEqual({ expanded: false });
        expect(header()?.props.detail).toContain('settingsPlugins.genericSettingsChangedCount');
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)).toBeNull();

        await act(async () => {
            header()?.props.onPress();
        });
        await act(async () => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://api.next.test');
        });
        await act(async () => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
            await Promise.resolve();
        });
        await flushAsync();
        await act(async () => {
            header()?.props.onPress();
        });

        // A failed save is never hidden behind a closed row.
        expect(header()?.props.accessibilityState).toEqual({ expanded: true });
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)).toBeTruthy();
        expect(screen.findByTestId(disclosureId)).toBeTruthy();
    });

    it('refreshes mounted generic and declarative Settings consumers from one shared record watch', async () => {
        let endpoint = 'https://before.example.test';
        let region = 'eu-before';
        let revision = '0';
        let invalidate: (() => void) | null = null;
        machinePluginSettingsGetMock.mockImplementation(() => Promise.resolve(settingsResult(
            { endpoint, region },
            [],
            revision,
        )));
        scopedSettingsWatchMock.mockImplementation(() => new Promise(resolve => {
            invalidate = () => resolve({ status: 'changed', revision });
        }));
        const { DeclarativePluginSurface } = await import('@/components/plugins/surfaces/DeclarativePluginSurface');
        const { PluginDetailGenericSettingsSection } = await import('./PluginDetailGenericSettingsSection');
        const declarativeSettings = ['endpoint', 'region'].map((id) => Object.freeze({
            id,
            contributionId: 'settings',
            qualifiedId: `${PLUGIN_ID}/${id}`,
            descriptor: Object.freeze({
                id,
                title: id === 'endpoint' ? 'Endpoint' : 'Region',
                target: Object.freeze({ kind: 'plugin' as const }),
                scope: 'daemon' as const,
                schema: Object.freeze({ type: 'string' as const }),
            }),
        }));
        const screen = await renderScreen(
            <>
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={createProjection(1, [SETTINGS_FIELDS[0]!])}
                    machineId="machine-1"
                    serverId={account.serverId}
                    accountServerIdentityId="srv_settings"
                    daemonServerIdentityId="srv_settings"
                    perActiveServerIdentityId="srv_settings"
                    daemonOperationsAvailable
                />
                <DeclarativePluginSurface
                    pluginId={PLUGIN_ID}
                    model={{
                        identity: {
                            pluginId: PLUGIN_ID,
                            localId: 'shared-settings',
                            qualifiedId: `${PLUGIN_ID}/shared-settings`,
                            occurrenceId: 'shared-settings-occurrence-1',
                        },
                        visible: true,
                        requiredHostMethods: [],
                        declarativeInventory: {
                            actions: [],
                            destinations: [],
                            settings: declarativeSettings.map((setting) => ({
                                pluginId: PLUGIN_ID,
                                id: setting.id,
                                qualifiedId: setting.qualifiedId,
                                schema: setting.descriptor.schema,
                                secret: false,
                                setting,
                            })),
                            uiQueries: [],
                        },
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
                                setting: declarativeSettings[0],
                            }, {
                                // Declared only here. The generic section never
                                // asks for it, so it can only render from the
                                // record this declarative consumer joined.
                                kind: 'field',
                                path: 'root.region',
                                order: 2,
                                label: 'Region',
                                control: { kind: 'text', settingId: 'region' },
                                setting: declarativeSettings[1],
                            }],
                        },
                    }}
                    machineId="machine-1"
                    serverId={account.serverId}
                    accountLifetime={activeAccountLifetimeState.current}
                    interactionEnabled={true}
                    daemonInteractionEnabled={true}
                    dispatchAction={async () => null}
                    actionAvailable
                    openSurface={async () => null}
                    openSurfaceAvailable={false}
                />
            </>,
        );
        await act(async () => {
            await Promise.resolve();
        });

        // One read and one watch for both consumers, and the declarative-only
        // `region` control proves the declarative surface is a member of that
        // one record rather than a mount the counts below ignore.
        expect(machinePluginSettingsGetMock).toHaveBeenCalledOnce();
        expect(scopedSettingsWatchMock).toHaveBeenCalledOnce();
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe(endpoint);
        expect(screen.findByTestId('plugin-declarative-field:root.endpoint')?.props.value).toBe(endpoint);
        expect(screen.findByTestId('plugin-declarative-field:root.region')?.props.value).toBe(region);

        endpoint = 'https://changed-elsewhere.example.test';
        region = 'eu-after';
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
        expect(screen.findByTestId('plugin-declarative-field:root.region')?.props.value).toBe(region);
    });

    it('preserves the declaring external Agent identity in its settings cross-link', async () => {
        const baseGroup = createProjection(1).editableSettingsGroups[0]!;
        const projection: PluginProjectionEntry = {
            ...createProjection(1),
            editableSettingsGroups: [{
                ...baseGroup,
                target: {
                    kind: 'agent',
                    agent: { pluginId: 'example.agent-two', localId: 'assistant' },
                },
                presentation: {
                    sections: [],
                    subagentSections: [{
                        id: 'external-agent-settings',
                        title: 'External Agent settings',
                        description: 'Open the matching external Agent settings.',
                        items: [{
                            id: 'open-external-agent-settings',
                            title: 'Open external Agent settings',
                            description: 'Open settings for this Agent.',
                            iconIonName: 'people-outline',
                        }],
                    }],
                },
            }],
        };

        const { screen } = await renderSection(projection);
        const settingsLink = screen.findAll((node) => (
            node.props?.title === 'Open external Agent settings'
            && typeof node.props?.onPress === 'function'
        ))[0];
        expect(settingsLink).toBeTruthy();

        await act(async () => {
            settingsLink?.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith(
            '/(app)/settings/agents/assistant?pluginId=example.agent-two',
        );
    });

    it('drops the link to the Agent page when the settings already sit on that page', async () => {
        const baseGroup = createProjection(1).editableSettingsGroups[0]!;
        const projection: PluginProjectionEntry = {
            ...createProjection(1),
            editableSettingsGroups: [{
                ...baseGroup,
                target: { kind: 'agent', agent: { pluginId: 'example.agent-two', localId: 'assistant' } },
                presentation: {
                    sections: [],
                    subagentSections: [{
                        id: 'external-agent-settings',
                        title: 'External Agent settings',
                        items: [{ id: 'open-external-agent-settings', title: 'Open external Agent settings' }],
                    }],
                },
            }],
        };
        const { screen } = await renderSection(projection, {
            presentation: { kind: 'disclosures', title: 'Plugin settings' },
        });
        expect(screen.findAll((node) => node.props?.title === 'Open external Agent settings')).toHaveLength(0);
        expect(screen.findAll((node) => node.props?.title === 'External Agent settings')).toHaveLength(0);
        // The settings themselves are still there, as the page's disclosures.
        expect(screen.findAll((node) => node.props?.title === 'Acme hook settings').length).toBeGreaterThan(0);
    });

    it('renders an external notification channel through the canonical Account Plugin Settings record', async () => {
        const accountTarget = { kind: 'account' as const, serverIdentityId: 'srv_settings' };
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
            content: { t: 'plain', v: { v: 1, values: {
                [EXTERNAL_NOTIFICATION_ENDPOINT_FIELD_ID]: 'https://review.example.test/hooks/updated',
            } } },
            expectedRevision: 4,
        }));
    });

    it('renders an Account-custodied field through SavedSecret without exposing its value', async () => {
        const { screen } = await renderSection(createProjection(1, [ACCOUNT_SECRET_FIELD], 'account'));

        expect(resolveAccountSettingsPluginSecretBinding(persistedAccountSettings, { pluginId: PLUGIN_ID, localId: 'accountToken' })).not.toBeNull();
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
        await flushAsync();

        expect(accountSettingsWrites).toHaveLength(1);
        expect(accountSettingsWrites[0]?.expectedVersion).toBe(1);
        expect(resolveAccountSettingsPluginSecret(persistedAccountSettings, { pluginId: PLUGIN_ID, localId: 'accountToken' })?.secret.encryptedValue)
            .toMatchObject({ _isSecretValue: true, value: 'account-secret-value' });
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('account-secret-value');
        expect(machinePluginSettingsGetMock).not.toHaveBeenCalled();
        expect(machinePluginSettingsSetMock).not.toHaveBeenCalled();
    });

    it('routes a daemon-scoped Account-custodied secret through SavedSecret', async () => {
        const { screen } = await renderSection(createProjection(1, [ACCOUNT_SECRET_FIELD], 'daemon'));

        expect(resolveAccountSettingsPluginSecretBinding(persistedAccountSettings, { pluginId: PLUGIN_ID, localId: 'accountToken' })).not.toBeNull();
        expect(machinePluginSettingsGetMock).not.toHaveBeenCalled();

        // The SavedSecret projection settles independently of the daemon
        // Settings section, so wait for its owner-bound revision before save.
        await flushAsync();
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
        await flushAsync();

        expect(accountSettingsWrites).toHaveLength(1);
        expect(resolveAccountSettingsPluginSecret(persistedAccountSettings, { pluginId: PLUGIN_ID, localId: 'accountToken' })?.secret.encryptedValue)
            .toMatchObject({ _isSecretValue: true, value: 'portable-account-secret' });
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
                serverId: resolveServerProfileScopeIdForIdentifier(account.serverId),
                serverIdentityId: 'srv_settings',
                machineId: 'machine-1',
            },
            pluginId: OPENCODE_PLUGIN_ID,
            secretId: OPENCODE_SERVER_PASSWORD_SETTING_ID,
            canonicalOrigin: 'https://opencode.example.test',
        }));
        expect(accountSettingsWrites).toHaveLength(0);
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
                serverId: resolveServerProfileScopeIdForIdentifier(account.serverId),
                serverIdentityId: 'srv_settings',
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
        expect(accountSettingsWrites).toHaveLength(0);
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
        await act(async () => { await restoreTestAccount('account-b'); });
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
            await screen.update(React.cloneElement(element));
            await Promise.resolve();
        });
        await flushAsync();

        expect(scopedSettingsReadMock).toHaveBeenCalledWith(expect.objectContaining({
            scope: { kind: 'account' },
            target: { kind: 'account', serverIdentityId: 'srv_settings' },
        }));
        expect(screen.findByTestId(OPENCODE_SECRET_INPUT_ID)?.props.value).toBe('');
        expect(screen.findByTestId(OPENCODE_SECRET_STATUS_ID)).toBeNull();
        expect(screen.getTextContent())
            .not.toContain('settingsProviders.errors.mutationOutcomeUnknownDescription');
    });

    it('clears an Account-A managed daemon-secret presentation when the Account lifetime retires', async () => {
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
            await restoreTestAccount('account-b');
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
        expect(accountSettingsWrites).toHaveLength(0);
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
        expect(screen.findByTestId(RECOVERY_SECRET_INPUT_ID)?.props.accessibilityHint)
            .toBe('memorySearchSettings.embeddings.secretSet');
        expect(JSON.stringify(screen.tree.toJSON())).not.toContain('must-not-render');
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

        expect(accountSettingsWrites).toHaveLength(1);
        expect(resolveAccountSettingsPluginSecret(persistedAccountSettings, { pluginId: PLUGIN_ID, localId: 'accountToken' })?.secret.encryptedValue)
            .toMatchObject({ _isSecretValue: true, value: '' });
        expect(screen.findByTestId(ACCOUNT_SECRET_DELETE_ID)).not.toBeNull();

        await act(async () => {
            screen.pressByTestId(ACCOUNT_SECRET_DELETE_ID);
            await Promise.resolve();
        });
        await flushAsync();

        expect(modalConfirmMock).not.toHaveBeenCalled();
        expect(accountSettingsWrites).toHaveLength(2);
        expect(resolveAccountSettingsPluginSecretBinding(persistedAccountSettings, { pluginId: PLUGIN_ID, localId: 'accountToken' })).toBeNull();
    });

    it('binds an existing SavedSecret through the host picker and can explicitly unbind it', async () => {
        await restoreTestAccount('account-a', applyAccountSettingsSavedSecretMutation(seededAccountSecrets(), {
            kind: 'add', secret: { id: 'saved-secret-owned-by-user', name: 'User key', kind: 'token',
                encryptedValue: { _isSecretValue: true, value: 'user-private-material' }, createdAt: 1, updatedAt: 1 },
        }).settings);
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

        expect(accountSettingsWrites).toHaveLength(1);
        expect(resolveAccountSettingsPluginSecretBinding(persistedAccountSettings, { pluginId: PLUGIN_ID, localId: 'accountToken' })?.savedSecretId)
            .toBe('saved-secret-owned-by-user');
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

        expect(accountSettingsWrites).toHaveLength(2);
        expect(resolveAccountSettingsPluginSecretBinding(persistedAccountSettings, { pluginId: PLUGIN_ID, localId: 'accountToken' })).toBeNull();
    });

    it('adopts a rejected Account-secret CAS snapshot without replaying the draft', async () => {
        const { screen } = await renderSection(createProjection(1, [ACCOUNT_SECRET_FIELD], 'account'));
        const winner = applyAccountSettingsSavedSecretMutation(seededAccountSecrets(), { kind: 'unbindPluginSecret',
            target: { pluginId: PLUGIN_ID, localId: 'accountToken' }, expectedSecretId: 'saved-accountToken', expectedSecretUpdatedAt: 1,
        }).settings;
        accountSettingsHttp.replaceAccountSettings('account-a', { version: 2, content: { t: 'plain', v: winner } });

        act(() => {
            screen.changeTextByTestId(ACCOUNT_SECRET_INPUT_ID, 'draft-that-needs-explicit-retry');
        });
        await act(async () => {
            screen.pressByTestId(ACCOUNT_SECRET_SAVE_ID);
        });
        await flushAsync();
        expect(accountSettingsWrites).toHaveLength(1);

        expect(screen.findByTestId(ACCOUNT_SECRET_INPUT_ID)?.props.value).toBe('draft-that-needs-explicit-retry');
        expect(screen.findByTestId(ACCOUNT_SECRET_SAVE_ID)?.props.accessibilityLabel).toBe('common.retry: Account token');
        expect(screen.findByTestId(ACCOUNT_SECRET_DELETE_ID)).toBeNull();

        await act(async () => {
            screen.pressByTestId(ACCOUNT_SECRET_SAVE_ID);
        });
        await flushAsync();
        expect(accountSettingsWrites).toHaveLength(2);
        expect(accountSettingsWrites.map(write => write.expectedVersion)).toEqual([1, 2]);
        expect(resolveAccountSettingsPluginSecret(persistedAccountSettings, { pluginId: PLUGIN_ID, localId: 'accountToken' })?.secret.encryptedValue)
            .toMatchObject({ value: 'draft-that-needs-explicit-retry' });
    });

    it('keeps an Account SavedSecret draft ambiguous after its safe snapshot and requires an explicit retry', async () => {
        accountSettingsPost = async (_input, next) => {
            accountSettingsPost = null;
            await next();
            return { dispatchThenFail: true };
        };
        const { screen } = await renderSection(createProjection(1, [ACCOUNT_SECRET_FIELD], 'account'));

        act(() => {
            screen.changeTextByTestId(ACCOUNT_SECRET_INPUT_ID, 'possibly-applied-account-secret');
        });
        await act(async () => {
            screen.pressByTestId(ACCOUNT_SECRET_SAVE_ID);
        });
        await flushAsync();
        await flushAsync();

        expect(accountSettingsWrites).toHaveLength(1);
        expect(resolveAccountSettingsPluginSecret(persistedAccountSettings, { pluginId: PLUGIN_ID, localId: 'accountToken' })?.secret.encryptedValue)
            .toMatchObject({ value: 'possibly-applied-account-secret' });
        expect(screen.findByTestId(ACCOUNT_SECRET_INPUT_ID)?.props.value)
            .toBe('possibly-applied-account-secret');
        expect(screen.findByTestId(ACCOUNT_SECRET_SAVE_ID)?.props.accessibilityLabel)
            .toBe('common.retry: Account token');
        expect(screen.getTextContent())
            .toContain('settingsProviders.errors.mutationOutcomeUnknownDescription');
        expect(screen.getTextContent()).not.toContain('settingsPlugins.genericSettingsSaveError');
    });

    it('keeps an Account-secret draft across custody changes and retires it when its occurrence is replaced', async () => {
        const pendingWrite = createDeferred<void>();
        accountSettingsPost = async (_input, next) => { await pendingWrite.promise; return next(); };
        const firstProjection = createProjection(1, [ACCOUNT_SECRET_FIELD], 'account');
        const secondProjection = {
            ...createProjection(1, [ACCOUNT_SECRET_FIELD], 'account'),
            immutableGenerationId: 'generation-2',
        };
        const thirdProjection = {
            ...secondProjection,
            occurrenceId: 'occurrence-2',
        };
        const { PluginDetailGenericSettingsSection, screen } = await renderSection(firstProjection);

        act(() => {
            screen.changeTextByTestId(ACCOUNT_SECRET_INPUT_ID, 'generation-one-account-secret');
        });
        await act(async () => {
            screen.pressByTestId(ACCOUNT_SECRET_SAVE_ID);
        });
        await flushAsync();
        expect(accountSettingsWrites).toHaveLength(1);

        await act(async () => {
            await screen.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={secondProjection}
                    machineId="machine-1"
                    serverId={account.serverId}
                    accountServerIdentityId="srv_settings"
                    daemonServerIdentityId="srv_settings"
                    perActiveServerIdentityId="srv_settings"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();

        expect(screen.findByTestId(ACCOUNT_SECRET_INPUT_ID)?.props.value)
            .toBe('generation-one-account-secret');

        await act(async () => {
            await screen.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={thirdProjection}
                    machineId="machine-1"
                    serverId={account.serverId}
                    accountServerIdentityId="srv_settings"
                    daemonServerIdentityId="srv_settings"
                    perActiveServerIdentityId="srv_settings"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();

        expect(screen.findByTestId(ACCOUNT_SECRET_INPUT_ID)?.props.value).toBe('');

        await act(async () => {
            pendingWrite.resolve();
            await pendingWrite.promise;
        });

        expect(screen.findByTestId(ACCOUNT_SECRET_INPUT_ID)?.props.value).toBe('');
        expect(screen.findByTestId(ACCOUNT_SECRET_SAVE_ID)?.props.accessibilityLabel)
            .toBe('common.save: Account token');
    });

    it('clears an Account SavedSecret presentation and ignores its late settlement when the same lifetime retires', async () => {
        const pendingWrite = createDeferred<void>();
        accountSettingsPost = async (_input, next) => { await pendingWrite.promise; return next(); };
        const { screen } = await renderSection(createProjection(1, [ACCOUNT_SECRET_FIELD], 'account'));

        expect(screen.findByTestId(ACCOUNT_SECRET_STATUS_ID)).not.toBeNull();
        act(() => {
            screen.changeTextByTestId(ACCOUNT_SECRET_INPUT_ID, 'account-a-raw-secret');
        });
        await act(async () => {
            screen.pressByTestId(ACCOUNT_SECRET_SAVE_ID);
        });
        await flushAsync();
        expect(accountSettingsWrites).toHaveLength(1);

        await act(async () => {
            await restoreTestAccount('account-b', {});
            await Promise.resolve();
        });

        expect(screen.findByTestId(ACCOUNT_SECRET_INPUT_ID)?.props.value).toBe('');
        expect(screen.findByTestId(ACCOUNT_SECRET_STATUS_ID)).toBeNull();
        expect(screen.findByTestId(ACCOUNT_SECRET_SAVE_ID)?.props.accessibilityLabel)
            .toBe('common.save: Account token');
        expect(screen.getTextContent()).not.toContain('settingsPlugins.genericSettingsSaveError');

        await act(async () => {
            pendingWrite.resolve();
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
            await screen.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={replacementProjection}
                    machineId="machine-1"
                    serverId={account.serverId}
                    accountServerIdentityId="srv_settings"
                    daemonServerIdentityId="srv_settings"
                    perActiveServerIdentityId="srv_settings"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();

        expect(screen.findByTestId(SECRET_INPUT_ID)?.props.value).toBe('');

        await act(async () => {
            screen.pressByTestId(SECRET_SAVE_ID);
        });
        await flushAsync();
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
            await screen.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={replacementProjection}
                    machineId="machine-1"
                    serverId={account.serverId}
                    accountServerIdentityId="srv_settings"
                    daemonServerIdentityId="srv_settings"
                    perActiveServerIdentityId="srv_settings"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();

        expect(screen.findByTestId(SECRET_INPUT_ID)?.props.value).toBe('');

        await act(async () => {
            screen.pressByTestId(SECRET_SAVE_ID);
        });
        await flushAsync();
        await flushAsync();

        expect(machinePluginSettingsSetMock).not.toHaveBeenCalled();
    });

    it('keeps a daemon-secret draft across custody changes and retires it when its occurrence is replaced', async () => {
        const pendingWrite = createDeferred<MachinePluginSecretSetResult>();
        machinePluginSecretSetMock.mockReturnValueOnce(pendingWrite.promise);
        const secretField = SETTINGS_FIELDS[1]!;
        const firstProjection = createProjection(1, [secretField], 'account');
        const secondProjection = {
            ...createProjection(1, [secretField], 'account'),
            immutableGenerationId: 'generation-2',
        };
        const thirdProjection = {
            ...secondProjection,
            occurrenceId: 'occurrence-2',
        };
        const { PluginDetailGenericSettingsSection, screen } = await renderSection(firstProjection);

        act(() => {
            screen.changeTextByTestId(SECRET_INPUT_ID, 'generation-one-daemon-secret');
        });
        await act(async () => {
            screen.pressByTestId(SECRET_SAVE_ID);
        });
        await flushAsync();
        expect(machinePluginSecretSetMock).toHaveBeenCalledOnce();

        await act(async () => {
            await screen.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={secondProjection}
                    machineId="machine-1"
                    serverId={account.serverId}
                    accountServerIdentityId="srv_settings"
                    daemonServerIdentityId="srv_settings"
                    perActiveServerIdentityId="srv_settings"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();

        expect(screen.findByTestId(SECRET_INPUT_ID)?.props.value)
            .toBe('generation-one-daemon-secret');

        await act(async () => {
            await screen.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={thirdProjection}
                    machineId="machine-1"
                    serverId={account.serverId}
                    accountServerIdentityId="srv_settings"
                    daemonServerIdentityId="srv_settings"
                    perActiveServerIdentityId="srv_settings"
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

    /**
     * A declaration's placeholder and `disabledReason` are localized author
     * copy. The host renderer is the only thing standing between them and the
     * person, so dropping either leaves a field that is inert for no stated
     * reason and unlabelled about what belongs in it.
     */
    it('carries the declared localized placeholder and disabledReason into the generic control', async () => {
        const declared: PluginProjectionEditableSettingField = {
            key: 'endpoint',
            control: 'text',
            valueType: 'string',
            valueSchema: { type: 'string' },
            title: 'Endpoint URL',
            secretCustody: null,
            redaction: 'none',
            clearWhenEmpty: 'persist',
            presentation: {
                control: 'text',
                placeholder: { key: 'acme.endpoint.placeholder', fallback: 'https://api.example.test' },
            },
            availability: {
                // The host cannot resolve this fact here, and an unresolved
                // `disabledWhen` fails closed to disabled — still the author's
                // own condition, so it is the author's reason that is shown.
                disabledWhen: { fact: 'host.platform', operator: 'equals', value: 'web' },
                disabledReason: {
                    key: 'acme.endpoint.disabled',
                    fallback: 'Connect this machine before changing the endpoint.',
                },
            },
        };
        const { screen } = await renderSection(createProjection(1, [declared]));

        const input = screen.findByTestId(ENDPOINT_INPUT_ID);
        expect(input?.props.placeholder).toBe('https://api.example.test');
        expect(input?.props.editable).toBe(false);
        // The author's reason is its own line of the field, read as written.
        expect(screen.findByTestId(
            `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.endpoint.disabledReason`,
        )).not.toBeNull();
        expect(screen.getTextContent()).toContain('Connect this machine before changing the endpoint.');
    });

    it('leaves daemon-secret confirmation to the admitted Action owner', async () => {
        modalConfirmMock.mockResolvedValue(false);
        machinePluginSecretStatusMock.mockResolvedValue(secretStatusResult('configured'));
        const { screen } = await renderSection();

        await act(async () => {
            screen.pressByTestId(SECRET_DELETE_ID);
            await Promise.resolve();
        });
        await flushAsync();

        expect(modalConfirmMock).not.toHaveBeenCalled();
    });

    it('keeps generic text controls at the native touch floor on phones (44 pt iOS, 48 dp Android)', async () => {
        for (const [uiPlatform, floor] of [['ios', 44], ['android', 48]] as const) {
            const { screen } = await renderSection(createProjection(1), { uiPlatform });
            expect(flattenTestStyle(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.style)).toMatchObject({ minHeight: floor });
            expect(flattenTestStyle(screen.findByTestId(SECRET_INPUT_ID)?.props.style)).toMatchObject({ minHeight: floor });
            standardCleanup();
        }
    });

    it('does not restart an exact scoped snapshot read when its parent rerenders', async () => {
        const projection = createProjection(1);
        const { PluginDetailGenericSettingsSection, screen } = await renderSection(projection);
        expect(machinePluginSettingsGetMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            await screen.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={projection}
                    machineId="machine-1"
                    serverId={account.serverId}
                    accountServerIdentityId="srv_settings"
                    daemonServerIdentityId="srv_settings"
                    perActiveServerIdentityId="srv_settings"
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
            await screen.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={createProjection(1)}
                    machineId="machine-1"
                    serverId={account.serverId}
                    accountServerIdentityId="srv_settings"
                    daemonServerIdentityId="srv_settings"
                    perActiveServerIdentityId="srv_settings"
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
            await screen.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={createProjection(1)}
                    machineId="machine-1"
                    serverId={account.serverId}
                    accountServerIdentityId="srv_settings"
                    daemonServerIdentityId="srv_settings"
                    perActiveServerIdentityId="srv_settings"
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
        await act(async () => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
        });
        await flushAsync();
        expect(machinePluginSettingsSetMock).toHaveBeenCalledTimes(1);
        expect(machinePluginSettingsSetMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            fieldId: 'endpoint',
            mutation: { kind: 'set', value: 'https://pending.example.test' },
        }));

        await act(async () => {
            await screen.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={createProjection(1)}
                    machineId="machine-1"
                    serverId={account.serverId}
                    accountServerIdentityId="srv_settings"
                    daemonServerIdentityId="srv_settings"
                    perActiveServerIdentityId="srv_settings"
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
            serverId: account.serverId,
            serverIdentityId: 'srv_settings',
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

        await act(async () => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
        });
        await flushAsync();

        expect(machinePluginSettingsSetMock).toHaveBeenCalledTimes(1);
        expect(machinePluginSettingsSetMock).toHaveBeenNthCalledWith(1, 'machine-1', {
            serverId: resolveServerProfileScopeIdForIdentifier(account.serverId),
            serverIdentityId: 'srv_settings',
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
            serverId: resolveServerProfileScopeIdForIdentifier(account.serverId),
            serverIdentityId: 'srv_settings',
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
        await act(async () => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
        });
        await flushAsync();
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
        await act(async () => {
            screen.pressByTestId(SECRET_SAVE_ID);
        });
        await flushAsync();
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

        await act(async () => {
            screen.pressByTestId(SECRET_SAVE_ID);
        });
        await flushAsync();
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
        await act(async () => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
        });
        await flushAsync();

        await act(async () => {
            await screen.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={secondProjection}
                    machineId="machine-1"
                    serverId={account.serverId}
                    accountServerIdentityId="srv_settings"
                    daemonServerIdentityId="srv_settings"
                    perActiveServerIdentityId="srv_settings"
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

    it('attributes a save to the current plugin after the mounted target is reused', async () => {
        const replacementPluginId = 'example.replacement-settings';
        const replacementProjection = createProjection(2, SETTINGS_FIELDS, 'daemon', replacementPluginId);
        const { PluginDetailGenericSettingsSection, screen } = await renderSection(createProjection(1));

        machinePluginSettingsGetMock.mockResolvedValue(settingsResult({
            endpoint: 'https://replacement.example.test',
            enabled: true,
        }, ['apiToken'], '1', replacementPluginId));
        machinePluginSettingsSetMock.mockResolvedValue(settingsSetResult({
            endpoint: 'https://replacement-updated.example.test',
            enabled: true,
        }, ['apiToken'], '2', replacementPluginId));

        await act(async () => {
            await screen.update(
                <PluginDetailGenericSettingsSection
                    pluginId={replacementPluginId}
                    projection={replacementProjection}
                    machineId="machine-1"
                    serverId={account.serverId}
                    accountServerIdentityId="srv_settings"
                    daemonServerIdentityId="srv_settings"
                    perActiveServerIdentityId="srv_settings"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();

        const replacementInputId = `settings.plugins.detail.${replacementPluginId}.settings.${GROUP_ID}.endpoint.input`;
        const replacementSaveId = `settings.plugins.detail.${replacementPluginId}.settings.${GROUP_ID}.endpoint.save`;
        act(() => {
            screen.changeTextByTestId(replacementInputId, 'https://replacement-updated.example.test');
        });
        await screen.pressByTestIdAsync(replacementSaveId);
        await flushAsync();

        expect(emitPluginSettingChangedEventMock).toHaveBeenCalledWith(expect.objectContaining({
            pluginId: replacementPluginId,
            scope: 'daemon',
        }));
    });

    it('retries an initial settings read failure through the existing scoped record', async () => {
        machinePluginSettingsGetMock
            .mockResolvedValueOnce(unsupportedResult)
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://recovered.example.test',
                enabled: true,
            }));

        const { screen } = await renderSection();
        const errorId = `settings.plugins.detail.${PLUGIN_ID}.settings.error`;
        expect(screen.getTextContent()).toContain('common.retry');

        await screen.pressByTestIdAsync(errorId);
        await flushAsync();

        expect(machinePluginSettingsGetMock).toHaveBeenCalledTimes(2);
        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://recovered.example.test');
    });

    it('keeps the record custody visible beside an authored settings purpose', async () => {
        const projection = createProjection(1);
        const purpose = 'Send review updates to the configured endpoint.';
        const { screen } = await renderSection({
            ...projection,
            editableSettingsGroups: projection.editableSettingsGroups.map((group) => ({ ...group, description: purpose })),
        });

        expect(screen.findByTestId(ENDPOINT_INPUT_ID)?.props.value).toBe('https://api.example.test');
        expect(screen.getTextContent()).toContain(purpose);
        expect(screen.getTextContent()).toContain('settingsPlugins.genericSettingsFooter');
    });

    it.each([
        ['account', 'settingsPlugins.genericSettingsAccountFooter'],
        ['daemon', 'settingsPlugins.genericSettingsFooter'],
    ] as const)('uses the %s record footer when the plugin does not declare one', async (scope, footer) => {
        if (scope === 'account') {
            scopedSettingsReadMock.mockResolvedValue({
                status: 'ready',
                snapshot: {
                    scope: { kind: 'account' },
                    target: { kind: 'account', serverIdentityId: 'srv_settings' },
                    revision: { kind: 'account', value: 1 },
                    values: { endpoint: 'https://account.example.test', enabled: true },
                },
            });
        }
        const { screen } = await renderSection(createProjection(1, undefined, scope));

        expect(screen.getTextContent()).toContain(footer);
    });

    it('keeps a replaced-source draft visible but inert after refresh failure until the replacement source edits it', async () => {
        const refresh = createDeferred<MachinePluginSettingsResult>();
        machinePluginSettingsGetMock
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://projection-one.test',
                enabled: true,
            }))
            .mockReturnValueOnce(refresh.promise)
            .mockResolvedValueOnce(settingsResult({
                endpoint: 'https://projection-two.test',
                enabled: true,
            }));
        machinePluginSettingsSetMock.mockResolvedValueOnce(settingsSetResult({
            endpoint: 'https://local-draft.test',
            enabled: true,
        }));
        const { PluginDetailGenericSettingsSection, screen } = await renderSection(createProjection(1));

        act(() => {
            screen.changeTextByTestId(ENDPOINT_INPUT_ID, 'https://local-draft.test');
        });
        await act(async () => {
            await screen.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={createProjection(2)}
                    machineId="machine-1"
                    serverId={account.serverId}
                    accountServerIdentityId="srv_settings"
                    daemonServerIdentityId="srv_settings"
                    perActiveServerIdentityId="srv_settings"
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
        expect(screen.getTextContent()).toContain('common.retry');

        await screen.pressByTestIdAsync(`settings.plugins.detail.${PLUGIN_ID}.settings.error`);
        await flushAsync();

        expect(machinePluginSettingsGetMock).toHaveBeenCalledTimes(3);
        expect(screen.findByTestId(`settings.plugins.detail.${PLUGIN_ID}.settings.error`)).toBeNull();

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

        await act(async () => {
            screen.pressByTestId(SWITCH_ID);
        });
        await flushAsync();
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

        await act(async () => {
            screen.pressByTestId(SWITCH_ID);
        });
        await flushAsync();
        await act(async () => {
            await screen.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={createProjection(2, fieldsWithoutSwitch)}
                    machineId="machine-1"
                    serverId={account.serverId}
                    accountServerIdentityId="srv_settings"
                    daemonServerIdentityId="srv_settings"
                    perActiveServerIdentityId="srv_settings"
                    daemonOperationsAvailable
                />,
            );
        });
        await flushAsync();
        expect(findSwitch(screen)).toBeNull();

        await act(async () => {
            await screen.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={createProjection(3)}
                    machineId="machine-1"
                    serverId={account.serverId}
                    accountServerIdentityId="srv_settings"
                    daemonServerIdentityId="srv_settings"
                    perActiveServerIdentityId="srv_settings"
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
        await act(async () => {
            screen.pressByTestId(ENDPOINT_SAVE_ID);
        });
        await flushAsync();

        await act(async () => {
            await screen.update(
                <PluginDetailGenericSettingsSection
                    pluginId={PLUGIN_ID}
                    projection={projection}
                    machineId="machine-2"
                    serverId={account.serverId}
                    accountServerIdentityId="srv_settings"
                    daemonServerIdentityId="srv_settings"
                    perActiveServerIdentityId="srv_settings"
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

    it('renders a per-active-server Account field from canonical presentation and writes its hidden backing map', async () => {
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
        scopedSettingsReadMock.mockResolvedValueOnce({ status: 'ready', snapshot: {
            scope: { kind: 'account' }, target: { kind: 'account', serverIdentityId: 'srv_settings' },
            revision: { kind: 'account', value: 1 }, values: {
                serverUrl: 'https://fallback.example',
                serverUrlByServerId: { 'srv_settings': 'https://scoped.example' },
            },
        } });
        const { screen } = await renderSection(createProjection(1, boundFields, 'account'));
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

        expect(scopedSettingsWriteMock).toHaveBeenCalledWith(expect.objectContaining({
            expectedRevision: 1, content: { t: 'plain', v: { v: 1, values: {
                serverUrl: 'https://fallback.example', serverUrlByServerId: { 'srv_settings': 'https://updated.example' },
            } } },
        }));
        expect(machinePluginSettingsSetMock).not.toHaveBeenCalled();
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
        const accountTarget = { kind: 'account' as const, serverIdentityId: 'srv_settings' };
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
                                'srv_settings': 'https://active-account.example.test',
                                'srv_settings_admin': 'https://selected-administration.example.test',
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
                        'srv_settings': 'https://active-account.example.test',
                        'srv_settings_admin': 'https://updated-administration.example.test',
                    },
                },
            },
        });

        const { screen } = await renderSection(createProjection(1, boundFields, 'account'), {
            daemonServerIdentityId: 'srv_settings_admin',
            perActiveServerIdentityId: 'srv_settings_admin',
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
            content: { t: 'plain', v: { v: 1, values: {
                serverUrl: 'https://fallback.example.test',
                serverUrlByServerId: {
                    'srv_settings': 'https://active-account.example.test',
                    'srv_settings_admin': 'https://updated-administration.example.test',
                },
            } } },
        }));
    });

    it('keeps an offline Administration server override separate from the Account default', async () => {
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
        const accountTarget = { kind: 'account' as const, serverIdentityId: 'srv_settings' };
        scopedSettingsReadMock.mockImplementation((input: Readonly<{ scope?: Readonly<{ kind?: string }> }>) => (
            input.scope?.kind === 'account'
                ? Promise.resolve({
                    status: 'ready' as const,
                    snapshot: {
                        scope: { kind: 'account' as const },
                        target: accountTarget,
                        revision: { kind: 'account' as const, value: 7 },
                        values: {
                            serverUrl: 'https://account-default.example.test',
                            serverUrlByServerId: {
                                'srv_offline_selected': 'https://offline-selected.example.test',
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
                revision: { kind: 'account', value: 8 },
                values: {
                    serverUrl: 'https://account-default.example.test',
                    serverUrlByServerId: {
                        'srv_offline_selected': 'https://updated-offline-selected.example.test',
                    },
                },
            },
        });

        const { screen } = await renderSection(createProjection(1, boundFields, 'account'), {
            machineId: null,
            serverId: null,
            daemonServerIdentityId: null,
            daemonOperationsAvailable: false,
            perActiveServerIdentityId: 'srv_offline_selected',
        });
        const inputId = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.serverUrl.input`;
        const saveId = `settings.plugins.detail.${PLUGIN_ID}.settings.${GROUP_ID}.serverUrl.save`;

        expect(screen.findByTestId(inputId)?.props.value).toBe('https://offline-selected.example.test');
        await act(async () => {
            screen.changeTextByTestId(inputId, 'https://updated-offline-selected.example.test');
        });
        await act(async () => {
            screen.pressByTestId(saveId);
            await Promise.resolve();
        });

        expect(scopedSettingsWriteMock).toHaveBeenCalledWith(expect.objectContaining({
            content: { t: 'plain', v: { v: 1, values: {
                serverUrl: 'https://account-default.example.test',
                serverUrlByServerId: {
                    'srv_offline_selected': 'https://updated-offline-selected.example.test',
                },
            } } },
        }));
        expect(scopedSettingsWriteMock).toHaveBeenCalledOnce();
    });

});
