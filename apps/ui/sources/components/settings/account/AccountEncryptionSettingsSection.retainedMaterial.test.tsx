import { installTokenStorageTestIsolation, installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderSettingsView, standardCleanup } from '@/dev/testkit';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { getCurrentAuth } from '@/auth/context/currentAuth';
import { AuthProvider } from '@/auth/context/AuthContext';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { deriveAccountSigningPublicKey } from '@/auth/flows/challenge';
import { buildContentKeyBinding } from '@/auth/oauth/contentKeyBinding';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { DiscussionAccountEncryptionInventoryV1Schema } from '@happier-dev/protocol/discussions/accountEncryptionMigration';
import { SESSION_FOLLOW_RULES_ROUTE_V1, ListSessionFollowRulesResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse, createEmptyAccountMigrationCensusHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { storage } from '@/sync/domains/state/storage';
import { disconnectActiveServerConnection } from '@/sync/runtime/orchestration/connectionManager';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { ActionsSettingsV1Schema} from '@happier-dev/protocol/actions/actionSettings';
import { AutomationTriggerIdSchema} from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { openAutomationTemplateStoredV1} from '@happier-dev/protocol/automations/automationTemplateStoredV1';
import { serializeAutomationStoredDefinitionExecutionRecipeV1} from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';
import {
    serializeAutomationStoredWorkflowDefinitionRecipeV2} from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { AccountEncryptionMigrateRequestSchema, AccountEncryptionMigrateSuccessResponseSchema, AccountEncryptionMigrateAutomationsInventoryResponseSchema,
    type AccountEncryptionMigrateRequest,
    type AccountEncryptionMigrateAutomationsInventoryResponse, AccountEncryptionMigrateTodosInventoryResponseSchema } from '@happier-dev/protocol/account/encryptionMigrate';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { ManagedMachinePresetAccountEncryptionMigrationInventoryV1Schema, type ManagedMachinePresetAccountEncryptionMigrationInventoryV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { transitionManagedMachinePresetContentEncryptionModeV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { ArtifactAccountEncryptionMigrationInventoryV1Schema, type ArtifactAccountEncryptionMigrationInventoryV1} from '@happier-dev/protocol/artifacts/artifactAccountEncryptionMigrationV1';
import {
    decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createPackageAssetArchiveV1, encodePackageAssetArchiveBodyV1 } from '@happier-dev/protocol/plugins/availability';
import { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { updateEffectiveHomeViewState } from '@/sync/domains/server/selection/homeViewSelectionState';
import { getActiveServerAccountScope, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { Modal, ModalProvider } from '@/modal';
import { act } from 'react-test-renderer';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { AUTOMATION_TEMPLATE_V02_ENCRYPTED, AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED } from '../../../../../../packages/protocol/src/automations/automationTemplateV02.testFixtures';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema, openPromptLibraryContentV1, sealPromptLibraryContentV1,
    type PromptLibraryContentV1, type PromptLibraryCatalogKeyV1, type PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { PROJECT_TRUST_ROUTE_V1 } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { WORKSPACE_EXECUTION_CONFIG_ROUTE_V1 } from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    openProviderConnectionsContentV1, sealProviderConnectionsContentV1,
    ProviderConnectionsCatalogV1Schema, ProviderConnectionsRowMutationV1Schema, ProviderConnectionsRowMutationResponseV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { REMOTE_HOST_ROWS_ROUTE_V1, RemoteHostCatalogRecordV1Schema } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1, NotificationChannelCatalogRecordV1Schema } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1,
    ConnectedPresentationRecordV1Schema, ConnectedAcknowledgementsRecordV1Schema } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';

import { V2SessionRecordSchema } from '@happier-dev/protocol/sessions/control/contract';
import { AccountEncryptionCurrentnessResponseSchema, AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const D10_CATALOGS = [
    { field: 'remoteHosts', route: REMOTE_HOST_ROWS_ROUTE_V1, kind: 'account_remote_host_catalog', collection: 'hosts',
        record: RemoteHostCatalogRecordV1Schema.parse({ v: 1, hosts: [{ id: 'host-a', name: 'Work', ssh: { target: 'dev@example.com', authMode: 'agent' },
            createdAt: 1, updatedAt: 2, lastUsedAt: null }] }) },
    { field: 'notificationChannels', route: NOTIFICATION_CHANNELS_ROUTE_V1, kind: 'account_notification_channels', collection: 'channels',
        record: NotificationChannelCatalogRecordV1Schema.parse({ v: 1, channels: [{ v: 1, id: 'channel-a', kind: 'webhook', enabled: true,
            topics: { ready: true, permissionRequest: false, userActionRequest: true, connectedServiceAccountSwitch: false,
                connectedServiceQuotaBlocked: false, connectedServiceQuotaRecovered: true, connectedServiceUsage: false, machines: false },
            readyIncludeMessageText: false, requestIncludeMessageText: false, url: 'https://hooks.example.test', signingSecretRef: null }] }) },
    { field: 'connectedPresentation', route: CONNECTED_PRESENTATION_ROWS_ROUTE_V1, kind: 'account_connected_presentation_catalog', collection: 'entries',
        record: ConnectedPresentationRecordV1Schema.parse({ v: 1, entries: [{ v: 1, subject: { kind: 'account', account: {
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'default' } }, label: 'Work' }] }) },
    { field: 'connectedAcknowledgements', route: CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1, kind: 'account_connected_acknowledgement_catalog', collection: 'entries',
        record: ConnectedAcknowledgementsRecordV1Schema.parse({ v: 1, entries: [{ v: 1, subject: { kind: 'warning', warningId: 'installation',
            scope: { kind: 'machine', machineId: 'exact-machine' } }, acknowledged: false }] }) },
] as const;

installTokenStorageWebPlatformMocks();
installTokenStorageTestIsolation('account-encryption-retained-material', { preserveGenerations: true });
const auth = { get credentials() { return getCurrentAuth()?.credentials ?? null; } };
installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true, renderCustomModals: true }).module);
// The native Markdown package is a rendering boundary, not part of Account custody.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
let restoreExecutorModuleLoader: (() => void) | null = null;
let restoreStorage: (() => void) | undefined;
let restoreLocks: (() => void) | undefined;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
type TemplateRow = AccountEncryptionMigrateAutomationsInventoryResponse['templates'][number];
type RunRow = AccountEncryptionMigrateAutomationsInventoryResponse['runs'][number];
const row = (automationId: string, templateCiphertext = AUTOMATION_TEMPLATE_V02_ENCRYPTED): TemplateRow => ({
    automationId, expectedTemplateVersion: 2, templateCiphertext, triggerDefinitionEnvelopes: [],
});
function retainedSession(sessionId: string, encryptionMode: 'plain' | 'e2ee') {
    return V2SessionRecordSchema.parse({ id: sessionId, encryptionMode, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        metadata: 'metadata', metadataVersion: 1, agentState: null, agentStateVersion: 1,
        dataEncryptionKey: null, share: null });
}

/** Replacement Homes have real token-only Accounts and complete empty bootstrap replies. */
function restoreOtherHome(serverUrl: string) {
    return restoreServerAccountForTest({ serverUrl, request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/features' || path === '/v1/features/authenticated') return json(createRootLayoutFeaturesResponse());
        if (path === '/v1/account/encryption') return json(AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 1 }));
        if (path === '/v1/account/encryption/currentness') return json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v1/account/profile') return json(AccountProfileSchema.parse({ ...profileDefaults, id: 'account-a' }));
        if (path === '/v2/account/settings') return json(AccountSettingsV2GetResponseSchema.parse({ content: null, version: 0 }));
        return createEmptyAccountBootstrapHttpResponse(path, init) ?? createEmptyAccountMigrationCensusHttpResponse(path, init);
    } });
}

async function mount(params: Readonly<{
    templates?: TemplateRow[]; archivedSessions?: ReturnType<typeof retainedSession>[];
    runs?: RunRow[];
    failInventory?: boolean; conflict?: boolean; beforeInventory?: () => Promise<void>; waitForControls?: boolean;
    initialMode?: 'plain' | 'e2ee';
    modeAfterRestore?: 'plain' | 'e2ee';
    modeReadResponse?: (mode: 'plain' | 'e2ee') => Response | undefined;
    managedMachinePresetsInventory?: ManagedMachinePresetAccountEncryptionMigrationInventoryV1;
    /** This device's custody of its keys; a plain fixture defaults to retained history. */
    initialCustody?: 'active' | 'historical';
    currentnessOverride?: () => ReturnType<typeof createPlainAccountEncryptionCurrentnessFixture> | null;
    readAccountVersion?: () => number;
    afterCommitArchivedSessions?: ReturnType<typeof retainedSession>[];
    afterCommitInventoryFails?: boolean;
    beforeMigrationAcknowledgement?: () => void;
    artifactRows?: ArtifactAccountEncryptionMigrationInventoryV1['items'];
    beforeArtifactInventory?: () => Promise<void>;
    promptLibraryRows?: readonly Readonly<{ key: PromptLibraryCatalogKeyV1; revision: number; content: PromptLibraryContentV1 | null }>[];
    /** The HTTP boundary retains original stored JSON, including migration-only metadata. */
    providerConnectionsRow?: Readonly<{ revision: number; content: unknown }>;
    /** Raw HTTP boundary bodies intentionally permit malformed stored catalog fixtures. */
    d10CatalogRows?: Readonly<Record<string, unknown>>;
    beforeD10Read?: () => Promise<void>;
    settingsVersion?: number;
    rawSettings?: Readonly<Record<string, unknown>>;
    settingsHistoryPages?: readonly Readonly<{ items: readonly unknown[]; nextBeforeVersion: number | null }>[];
}> = {}) {
    await loadSyncSingletonForTests();
    restoreExecutorModuleLoader = await installRealActionExecutorModuleLoader();
    const templates = params.templates ?? [];
    const writes: Array<{ id: string; expectedTemplateVersion: number; templateCiphertext: string }> = [];
    const migrations: AccountEncryptionMigrateRequest[] = [];
    const unmatchedHttpRequests: Array<Readonly<{ path: string; method: string }>> = [];
    const d10CatalogReads: string[] = [];
    const settingsHistoryReads: (string | null)[] = [];
    let promptLibraryRows = PromptLibraryCatalogKeyV1Schema.options.map(key =>
        params.promptLibraryRows?.find(row => row.key === key) ?? { key, revision: 1, content: null });
    let providerConnectionsRow = params.providerConnectionsRow;
    const d10CatalogRows = new Map(Object.entries(params.d10CatalogRows ?? {}));
    let mode = params.initialMode ?? 'plain';
    let committedAccountVersion: number | null = null;
    let settingsVersion = params.settingsVersion ?? 0;
    const accountVersion = () => committedAccountVersion ?? params.readAccountVersion?.() ?? 1;
    const createdSessions: Array<Omit<ReturnType<typeof retainedSession>, 'dataEncryptionKey'> & { dataEncryptionKey: string | null }> = [];
    const initialCredentials: AuthCredentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.signature', secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url'),
        ...((params.initialCustody ?? (mode === 'plain' ? 'historical' : 'active')) === 'historical' ? { custody: 'historical' as const } : {}) };
    const seed = new Uint8Array(32).fill(7);
    const contentBinding = await buildContentKeyBinding(seed);
    const signingKeyFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(deriveAccountSigningPublicKey(seed));
    const contentKeyFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(decodeBase64(contentBinding.contentPublicKey));
    let settingsContent = params.rawSettings === undefined ? null : mode === 'plain'
        ? { t: 'plain' as const, v: params.rawSettings }
        : { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
            material: resolveAccountScopedCryptoMaterialFromCredentials(initialCredentials), payload: params.rawSettings,
            randomBytes: length => new Uint8Array(length).fill(8) }) };
    const restored = await restoreServerAccountForTest({ serverUrl: `https://retained-${crypto.randomUUID()}.test`,
        credentials: initialCredentials,
        request: async (url, init) => {
            const target = new URL(String(url));
            if (target.pathname === '/health') return json({});
            if (target.pathname === '/v1/features' || target.pathname === '/v1/features/authenticated') return json(createRootLayoutFeaturesResponse({
                features: { encryption: { accountOptOut: { enabled: true }, plaintextStorage: { enabled: true } } },
            }));
            if (target.pathname === '/v1/account/encryption') return params.modeReadResponse?.(mode) ?? json(AccountEncryptionModeResponseSchema.parse({ mode, updatedAt: 1 }));
            if (target.pathname === '/v1/account/encryption/currentness') {
                const overridden = params.currentnessOverride?.();
                if (overridden) return json(overridden);
                return json(AccountEncryptionCurrentnessResponseSchema.parse({ mode, version: accountVersion(),
                updatedAt: 1, signingKeyFingerprint, contentKeyFingerprint,
                recipientEnvelopeReadiness: mode === 'plain' ? { status: 'unavailable', reason: 'plain_account' } : { status: 'available' } }));
            }
            if (target.pathname === '/v1/account/security') return json({ v: 1, encryptionMode: mode,
                nativeEmail: null, password: { status: 'not_enrolled', revision: null } });
            if (target.pathname === '/v1/kv') return json({ items: [] });
            if (target.pathname === '/v1/account/encryption/migrate/settings-history/inventory') {
                settingsHistoryReads.push(target.searchParams.get('beforeVersion'));
                return json(params.settingsHistoryPages?.[settingsHistoryReads.length - 1] ?? { items: [], nextBeforeVersion: null });
            }
            if (target.pathname === '/v1/account/encryption/migrate/review-comments/inventory') return json({ v: 1, items: [] });
            if (target.pathname === '/v1/account/encryption/migrate/managed-machine-presets/inventory') {
                return json(ManagedMachinePresetAccountEncryptionMigrationInventoryV1Schema.parse(params.managedMachinePresetsInventory ?? { presets: [], snapshots: [] }));
            }
            if (target.pathname === '/v1/account/encryption/migrate/discussions/inventory')
                return json(DiscussionAccountEncryptionInventoryV1Schema.parse({ items: [] }));
            if (target.pathname === SESSION_FOLLOW_RULES_ROUTE_V1)
                return json(ListSessionFollowRulesResponseV1Schema.parse({ rules: [] }));
            if (target.pathname === '/v1/account/encryption/migrate/session-organization/inventory') return json({ version: 0, folders: [], tags: [], labels: [] });
            if (target.pathname === '/v1/account/encryption/migrate' && init?.method === 'POST') {
                const migration = AccountEncryptionMigrateRequestSchema.parse(JSON.parse(String(init.body)));
                migrations.push(migration);
                if (params.readAccountVersion && migration.expectedAccountVersion !== params.readAccountVersion()) {
                    return json({ error: 'invalid-params', reason: 'migration_inventory_changed' }, 400);
                }
                mode = migration.toMode;
                committedAccountVersion = migration.expectedAccountVersion + 1;
                settingsVersion += 1;
                settingsContent = migration.settingsContent ?? null;
                if (migration.promptLibrary) promptLibraryRows = promptLibraryRows.map(row => {
                    const replacement = migration.promptLibrary!.items.find(item => item.key === row.key);
                    return replacement ? { key: row.key, revision: replacement.expectedRevision + 1, content: replacement.content } : row;
                });
                if (migration.providerConnections?.content) providerConnectionsRow = {
                    revision: migration.providerConnections.expectedRevision + 1, content: migration.providerConnections.content,
                };
                const d10Results = Object.fromEntries(D10_CATALOGS.flatMap(({ field }) => {
                    const directive = migration[field];
                    if (!directive) return [];
                    const revision = directive.expectedRevision + (directive.content === null ? 0 : 1);
                    d10CatalogRows.set(field, directive.content === null ? { status: 'deleted', revision }
                        : { status: 'present', revision, content: directive.content });
                    return [[field, { revision, content: directive.content }]];
                }));
                params.beforeMigrationAcknowledgement?.();
                // The browser transport rejects an aborted pending response even after the server commits.
                if (init.signal?.aborted) throw init.signal.reason;
                return json(AccountEncryptionMigrateSuccessResponseSchema.parse({ success: true, mode, accountVersion: committedAccountVersion, settingsVersion,
                    ...d10Results,
                    ...(migration.providerConnections ? { providerConnections: { row: providerConnectionsRow ?? null } } : {}),
                    ...(migration.promptLibrary ? { promptLibrary: { rows: migration.promptLibrary.items.map(item => ({
                        key: item.key, revision: item.expectedRevision + 1, content: item.content,
                    })) } } : {}),
                    ...(migration.profileRows ? { profileRows: { rows: [], referenceGuardRevision: 'absent',
                        transferControl: { status: 'absent' } } } : {}),
                }));
            }
            if (target.pathname === PROMPT_LIBRARY_ROWS_ROUTE_V1) return json({ status: 'listed', rows: promptLibraryRows });
            if (target.pathname === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1) {
                if (init?.method === 'POST') {
                    const mutation = ProviderConnectionsRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    const currentRevision = providerConnectionsRow?.revision ?? 'absent';
                    if (mutation.expectedRevision !== currentRevision) return json(ProviderConnectionsRowMutationResponseV1Schema.parse({
                        status: 'conflict', revision: providerConnectionsRow?.revision ?? -1,
                    }));
                    if (mutation.sourceSettingsVersion !== undefined && mutation.sourceSettingsVersion !== settingsVersion) {
                        return json(ProviderConnectionsRowMutationResponseV1Schema.parse({ status: 'settings-conflict', revision: settingsVersion }));
                    }
                    const revision = (providerConnectionsRow?.revision ?? -1) + 1;
                    providerConnectionsRow = { revision, content: mutation.content };
                    return json(ProviderConnectionsRowMutationResponseV1Schema.parse({ status: 'updated', revision, cursor: revision }));
                }
                return json(providerConnectionsRow ? providerConnectionsRow.content === null
                    ? { status: 'deleted', revision: providerConnectionsRow.revision }
                    : { status: 'present', ...providerConnectionsRow } : { status: 'absent' });
            }
            if (target.pathname === ACP_CATALOG_ROWS_ROUTE_V1 || target.pathname === MCP_SERVER_CATALOG_ROWS_ROUTE_V1)
                return json({ status: 'absent' });
            if (target.pathname === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/configurations`
                || target.pathname === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`) return json({ status: 'absent' });
            const d10Catalog = D10_CATALOGS.find(catalog => catalog.route === target.pathname);
            if (d10Catalog) {
                d10CatalogReads.push(d10Catalog.field);
                await params.beforeD10Read?.();
                return json(d10CatalogRows.get(d10Catalog.field) ?? { status: 'absent' });
            }
            if (target.pathname === PROFILE_ROWS_ROUTE_V1) return json({ status: 'listed', rows: [], nextCursor: null,
                complete: true, referenceGuardRevision: 'absent', transferControl: { status: 'absent' }, diagnostics: [] });
            if (target.pathname === PROFILE_REFERENCE_GUARD_ROUTE_V1) return json({ status: 'ready', revision: 'absent' });
            if (target.pathname === PROFILE_TRANSFER_ROUTE_V1) return json({ status: 'absent' });
            if (target.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return json({ status: 'listed', rows: [], coverage: 'complete' });
            if (target.pathname === `${PROJECT_TRUST_ROUTE_V1}/list` || target.pathname === WORKSPACE_EXECUTION_CONFIG_ROUTE_V1)
                return json({ rows: [] });
            if (target.pathname === '/v1/account/encryption/migrate/automations/inventory') {
                await params.beforeInventory?.();
                if (params.failInventory || (params.afterCommitInventoryFails && migrations.length > 0)) return json({ error: 'unavailable' }, 503);
                return json(AccountEncryptionMigrateAutomationsInventoryResponseSchema.parse({ templates, runs: params.runs ?? [] }));
            }
            // Session creation/listing is an HTTP boundary; stored ciphertext uses the real codec.
            if (target.pathname === '/v1/sessions' && init?.method === 'POST') {
                const input = JSON.parse(String(init.body)) as { tag: string; encryptionMode: 'e2ee'; metadata: string; dataEncryptionKey: string };
                const session = { ...retainedSession(input.tag, input.encryptionMode), metadata: input.metadata, dataEncryptionKey: input.dataEncryptionKey };
                createdSessions.push(session);
                return json({ session });
            }
            if (target.pathname === '/v2/sessions' || target.pathname === '/v2/sessions/active') return json({ sessions: createdSessions, hasNext: false, nextCursor: null });
            if (target.pathname === '/v2/sessions/archived') return json({ sessions: migrations.length > 0
                ? params.afterCommitArchivedSessions ?? params.archivedSessions ?? [] : params.archivedSessions ?? [], hasNext: false, nextCursor: null });
            if (target.pathname.startsWith('/v3/automations/') && init?.method === 'PATCH') {
                const id = decodeURIComponent(target.pathname.slice('/v3/automations/'.length));
                const update = JSON.parse(String(init.body)) as { expectedTemplateVersion: number; templateCiphertext: string };
                if (params.conflict) return json({ error: 'automation_template_version_conflict' }, 409);
                writes.push({ id, ...update });
                const template = templates.find((item) => item.automationId === id)!;
                template.templateCiphertext = update.templateCiphertext;
                template.expectedTemplateVersion += 1;
                return json({ id, name: 'Old trigger', description: null, enabled: true,
                    targetType: 'newSession', existingSessionId: null, templateVersion: template.expectedTemplateVersion,
                    lastRunAt: null, createdAt: 1, updatedAt: 1, workflowDefinitionId: null, scopeSessionId: null,
                    assignments: [], triggers: [], templateCiphertext: update.templateCiphertext });
            }
            if (target.pathname === '/v1/machines') return json([]);
            if (target.pathname === '/v1/account/profile') return json({ ...profileDefaults, id: 'account-a' });
            if (target.pathname === '/v1/artifacts') return json([]);
            if (target.pathname === '/v1/account/encryption/migrate/todos/inventory') return json(AccountEncryptionMigrateTodosInventoryResponseSchema.parse({ items: [] }));
            if (target.pathname === '/v1/account/saved-secrets/resources/materials') return json(SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [] }));
            if (target.pathname === '/v1/account/encryption/artifacts') {
                await params.beforeArtifactInventory?.();
                const rows = params.artifactRows ?? [];
                const afterId = target.searchParams.get('afterId');
                const offset = afterId === null ? 0 : rows.findIndex(row => row.id === afterId) + 1;
                const items = rows.slice(offset, offset + Number(target.searchParams.get('limit')));
                return json(ArtifactAccountEncryptionMigrationInventoryV1Schema.parse({ ownerAccountId: 'account-a', encryptionMode: mode, items,
                    nextCursor: offset + items.length < rows.length ? items.at(-1)!.id : null }));
            }
            if (target.pathname === '/v1/account/authoring-memory') return json({ rows: [] });
            if (target.pathname === '/v2/account/settings') return json({ content: settingsContent, version: settingsVersion });
            const emptyCensus = createEmptyAccountBootstrapHttpResponse(target.pathname, init)
                ?? createEmptyAccountMigrationCensusHttpResponse(target.pathname, init);
            if (emptyCensus) return emptyCensus;
            unmatchedHttpRequests.push({ path: target.pathname, method: init?.method ?? 'GET' });
            return json({ error: 'not_found' }, 404);
        } });
    if (params.modeAfterRestore) {
        mode = params.modeAfterRestore;
        invalidateAccountEncryptionModeCache();
    }
    storage.getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1 }), experiments: true, featureToggles: { 'encryption.accountOptOut': true },
        clientEncryptionRequirementV1: 'follow_account', clientEncryptionRequirementLocalV1: 'follow_account' });
    await updateEffectiveHomeViewState(current => ({ ...current, activeTargetKind: 'server', activeTargetId: restored.home.id }), { scope: 'tab' });
    const { AccountEncryptionSettingsSection } = await import('./AccountEncryptionSettingsSection');
    const rendered = await renderSettingsView(<AuthProvider initialCredentials={initialCredentials}><ModalProvider><AccountEncryptionSettingsSection /></ModalProvider></AuthProvider>);
    const screen = { ...rendered, unmount: async () => {
        await rendered.unmount();
        // Auth's credential adoption can still be switching the live Account.
        // Settle that owner before restored.dispose removes its HTTP boundary.
        await disconnectActiveServerConnection();
    } };
    try {
        if (params.waitForControls !== false) await vi.waitFor(() => expect(screen.findAll((node) => node.props.testID === 'settings-account-encryption-mode-switch'
            && typeof node.props.onValueChange === 'function' && node.props.disabled === false && node.props.value === (mode === 'e2ee')).length).toBeGreaterThan(0), { timeout: 5000 });
    } catch (error) {
        await screen.unmount(); await restored.dispose(); throw error;
    }
    vi.mocked(Modal.alertAsync).mockClear();
    const request = createServerFetchAtEndpoint({ endpointUrl: restored.home.serverUrl,
        serverId: restored.home.id, credentials: initialCredentials });
    const readCredentials = () => TokenStorage.getCredentialsForServerUrl(restored.home.serverUrl, { serverId: restored.home.id });
    const expectCredentialsUnchanged = async () => { expect(await readCredentials()).toEqual(initialCredentials); };
    return { screen, restored, writes, migrations, request, createdSessions, unmatchedHttpRequests, d10CatalogReads, settingsHistoryReads,
        readCredentials, expectCredentialsUnchanged };
}

/** Answer the carried review through its real public approval control. */
async function completeActionReview(screen: Awaited<ReturnType<typeof mount>>['screen'], invoke: () => unknown): Promise<void> {
    let completion!: Promise<unknown>;
    let settled = false;
    await act(async () => {
        completion = Promise.resolve(invoke());
        void completion.then(() => { settled = true; }, () => { settled = true; });
    });
    await vi.waitFor(() => expect(settled || screen.findByTestId('actions.confirmation-review.decision-approve') !== null).toBe(true));
    if (!settled) await screen.pressByTestIdAsync('actions.confirmation-review.decision-approve');
    await act(async () => { await completion; });
}

async function convertWithReview(screen: Awaited<ReturnType<typeof mount>>['screen'], enabled: boolean): Promise<void> {
    const toggle = screen.findAll(node => node.props.testID === 'settings-account-encryption-mode-switch'
        && typeof node.props.onValueChange === 'function')[0]!;
    await completeActionReview(screen, () => toggle.props.onValueChange(enabled));
}

async function forgetWithReview(screen: Awaited<ReturnType<typeof mount>>['screen']): Promise<void> {
    const button = screen.findAll(node => node.props.testID === 'settings-account-encryption-forget-key'
        && typeof node.props.action === 'function')[0]!;
    await completeActionReview(screen, () => button.props.action());
}

/** The converting device keeps its key bytes and only reclassifies them as history. */
async function expectKeysKeptAsHistory(h: Awaited<ReturnType<typeof mount>>): Promise<void> {
    expect(await h.readCredentials()).toEqual({ token: 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.signature',
        secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url'), custody: 'historical' });
    expect(auth.credentials).toEqual(await h.readCredentials());
}

beforeEach(() => {
    restoreStorage = installLocalStorageMock().restore;
    restoreLocks = installWebLockManagerMock().restore;
});
afterEach(async () => {
    restoreExecutorModuleLoader?.(); restoreExecutorModuleLoader = null;
    await standardCleanup(); invalidateAccountEncryptionModeCache(); vi.restoreAllMocks();
    restoreLocks?.(); restoreStorage?.();
});

describe('Account encryption historical material custody', () => {
    it('seals personal presets and retained acquisitions through the actual Account mode switch', async () => {
        const source = { contentEncryptionMode: 'plain' as const, recipientEnvelope: null,
            content: { t: 'plain' as const, v: { v: 1 as const, name: 'Private preset recipe',
                setup: { scripts: [{ body: 'printf retained-private-setup' }] } } } };
        const h = await mount({ initialMode: 'plain', managedMachinePresetsInventory: {
            presets: [{ presetId: 'personal-preset', expectedRevision: 7, ...source }],
            snapshots: [{ managedId: 'retained-guest', presetId: 'personal-preset', ...source }],
        } });
        try {
            await convertWithReview(h.screen, true);
            expect(h.migrations, JSON.stringify({ alerts: vi.mocked(Modal.alertAsync).mock.calls,
                unmatched: h.unmatchedHttpRequests })).toHaveLength(1);
            const directive = h.migrations[0]!.managedMachinePresets;
            expect(directive?.presets[0]).toMatchObject({ presetId: 'personal-preset', expectedRevision: 7 });
            expect(directive?.snapshots[0]).toMatchObject({ managedId: 'retained-guest', presetId: 'personal-preset',
                expectedContentEncryptionMode: 'plain', expectedContent: source.content, expectedRecipientEnvelope: null });
            if (!directive || !auth.credentials) throw new Error('Expected the captured preset conversion');
            const encryption = await createEncryptionFromAuthCredentials(auth.credentials);
            if (!encryption) throw new Error('Expected the converted Account encryption material');
            for (const { replacement } of [...directive.presets, ...directive.snapshots]) {
                expect(replacement.content.t).toBe('encrypted');
                expect(JSON.stringify(replacement)).not.toContain('retained-private-setup');
                const envelope = replacement.recipients.find(row => row.accountId === 'account-a')?.envelope;
                const sourceDataKey = envelope ? await encryption.decryptEncryptionKey(envelope.encryptedDataKey) : null;
                if (!sourceDataKey || !envelope) throw new Error('Expected the converted owner envelope');
                expect(transitionManagedMachinePresetContentEncryptionModeV1({
                    presetId: 'personal-preset', fromMode: 'e2ee', toMode: 'plain',
                    source: { content: replacement.content, recipientEnvelope: envelope }, sourceDataKey,
                })).toEqual({ content: source.content, recipients: [] });
            }
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it.each(['e2ee', 'plain'] as const)('captures the Account version after catalog admission while converting from %s', async initialMode => {
        let accountVersion = 5;
        const h = await mount({ initialMode, readAccountVersion: () => accountVersion,
            beforeD10Read: async () => { accountVersion = 15; } });
        try {
            await convertWithReview(h.screen, initialMode === 'plain');
            expect(h.migrations).toHaveLength(1);
            expect(h.migrations[0]!.expectedAccountVersion).toBe(15);
            expect(h.migrations[0]!.settingsContent).toBeNull();
            expect(vi.mocked(Modal.alertAsync)).not.toHaveBeenCalled();
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('pages retained Settings history once per cursor through the real Settings Action before submitting exact restore content', async () => {
        const raw = { schemaVersion: 1, unknownRetainedRoot: { items: [false, null, 3] }, executionRunsGuidanceEnabled: 'historical' };
        const material = resolveAccountScopedCryptoMaterialFromCredentials({ token: 'fixture', secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') });
        const content = { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material,
            payload: raw, randomBytes: length => new Uint8Array(length).fill(15) }) };
        const createdAt = '2026-10-01T01:02:03.000Z';
        const h = await mount({ initialMode: 'e2ee', settingsHistoryPages: [
            { items: [{ version: 8, createdAt, encryptionMode: 'e2ee', content }], nextBeforeVersion: 8 },
            { items: [{ version: 7, createdAt, encryptionMode: 'e2ee', content: null }], nextBeforeVersion: null },
        ] });
        try {
            await convertWithReview(h.screen, false);
            expect(h.settingsHistoryReads).toEqual([null, '8']);
            expect(h.migrations.length).toBe(1);
            const items = h.migrations[0]!.settingsHistory?.items;
            expect(items?.map(row => row.version)).toEqual([8, 7]);
            expect(JSON.stringify(items?.[0]?.content) === JSON.stringify({ t: 'plain', v: raw })).toBe(true);
            expect(items?.[0]?.expectedContent).toEqual(content);
            expect(items?.[1]).toEqual({ version: 7, expectedContent: null, content: null });
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it.each(['mixed-mode', 'corrupt'] as const)('refuses %s Settings history without a conversion POST', async failure => {
        const h = await mount({ initialMode: 'e2ee', settingsHistoryPages: [{ items: [{ version: 8,
            createdAt: '2026-10-01T01:02:03.000Z', encryptionMode: 'e2ee', content: failure === 'mixed-mode'
                ? { t: 'plain', v: {} } : { t: 'encrypted', c: 'invalid-ciphertext' } }], nextBeforeVersion: null }] });
        try {
            await convertWithReview(h.screen, false);
            expect(h.settingsHistoryReads).toEqual([null]);
            expect(h.migrations.length).toBe(0);
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('locks instead of following a moved plain mode while this device holds active keys', async () => {
        let moved = false;
        const h = await mount({ initialMode: 'e2ee', currentnessOverride: () => moved ? createPlainAccountEncryptionCurrentnessFixture() : null });
        try {
            moved = true;
            await convertWithReview(h.screen, false);
            expect(h.migrations).toEqual([]);
            await vi.waitFor(() => expect(h.screen.findAll(node => node.props.testID === 'settings-account-encryption-downgrade')).not.toHaveLength(0));
            await h.expectCredentialsUnchanged();
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('cannot bypass disabled settings.invoke through the whole-Account mode switch', async () => {
        const h = await mount({ initialMode: 'e2ee' });
        try {
            storage.getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({
                v: 1, actions: { 'settings.invoke': { enabled: false } },
            }) });
            await convertWithReview(h.screen, false);
            expect(h.migrations).toEqual([]);
            expect(h.d10CatalogReads).toEqual([]);
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it.each([
        ['plain', 'live'], ['plain', 'deleted'], ['e2ee', 'live'], ['e2ee', 'deleted'],
    ] as const)('includes exact D10 singleton catalog census in the actual mode switch (%s source, %s rows)', async (initialMode, state) => {
        const material = resolveAccountScopedCryptoMaterialFromCredentials({ token: 'fixture-token', secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') });
        const d10CatalogRows = Object.fromEntries(D10_CATALOGS.map(({ field, kind, record }) => [field,
            state === 'deleted' ? { status: 'deleted', revision: 7 } : { status: 'present', revision: 7,
                content: initialMode === 'plain' ? { t: 'plain', v: record }
                    : { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind, material, payload: record,
                        randomBytes: length => new Uint8Array(length).fill(36) }) } }]));
        const h = await mount({ initialMode, d10CatalogRows });
        try {
            await convertWithReview(h.screen, initialMode === 'plain');
            expect(h.migrations, JSON.stringify({ alerts: vi.mocked(Modal.alertAsync).mock.calls,
                unmatchedHttpRequests: h.unmatchedHttpRequests, d10CatalogReads: h.d10CatalogReads })).toHaveLength(1);
            if (!auth.credentials) throw new Error('Missing conversion credentials');
            for (const { field, kind, record } of D10_CATALOGS) {
                const directive = h.migrations[0]![field];
                expect(directive?.expectedRevision).toBe(7);
                if (state === 'deleted') expect(directive?.content).toBeNull();
                else if (initialMode === 'e2ee') expect(directive?.content).toEqual({ t: 'plain', v: record });
                else {
                    if (directive?.content?.t !== 'encrypted') throw new Error(`Missing ${field} ciphertext`);
                    expect(openAccountScopedBlobCiphertext({ kind, material: resolveAccountScopedCryptoMaterialFromCredentials(auth.credentials),
                        ciphertext: directive.content.c })?.value).toEqual(record);
                }
            }
            const completedToggle = h.screen.findAll(node => node.props.testID === 'settings-account-encryption-mode-switch'
                && typeof node.props.onValueChange === 'function')[0]!;
            expect(completedToggle.props.value, JSON.stringify(vi.mocked(Modal.alertAsync).mock.calls)).toBe(initialMode === 'plain');
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it.each(D10_CATALOGS)('refuses a partial encrypted $field census before submitting the actual mode switch', async ({ field, kind, record, collection }) => {
        const material = resolveAccountScopedCryptoMaterialFromCredentials({ token: 'fixture-token', secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') });
        const entries: readonly unknown[] = 'hosts' in record ? record.hosts : 'channels' in record ? record.channels : record.entries;
        const h = await mount({ initialMode: 'e2ee', d10CatalogRows: {
            [field]: { status: 'present', revision: 7, content: { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind, material,
                payload: { ...record, [collection]: [...entries, { malformed: true }] }, randomBytes: length => new Uint8Array(length).fill(36),
            }) } },
        } });
        try {
            await convertWithReview(h.screen, false);
            expect(h.d10CatalogReads, JSON.stringify(h.unmatchedHttpRequests)).toContain(field);
            expect(h.migrations).toHaveLength(0);
            await h.expectCredentialsUnchanged();
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('retires the initiating Account conversion when Home changes during D10 raw census', async () => {
        let startSwitch = false;
        let switched = false;
        let other: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
        const h = await mount({ initialMode: 'e2ee', beforeD10Read: async () => {
            if (!startSwitch || switched) return;
            switched = true;
            other = await restoreOtherHome(`https://other-d10-${crypto.randomUUID()}.test`);
        } });
        try {
            startSwitch = true;
            await convertWithReview(h.screen, false);
            expect(switched).toBe(true);
            expect(h.migrations).toHaveLength(0);
            await h.expectCredentialsUnchanged();
        } finally { await h.screen.unmount(); await other?.dispose(); await h.restored.dispose(); }
    });

    it.each(['plain', 'e2ee'] as const)('includes the demanded Provider catalog in the actual Account mode switch (%s source)', async initialMode => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1 as const, id: 'pc_a', source: { kind: 'contribution' as const, contributionKey: 'plugin/provider' },
                role: 'default' as const, displayName: 'Provider', displayNameMode: 'automatic' as const,
                deployment: { kind: 'external' as const }, revision: 2, createdAt: 1, updatedAt: 2 }],
            secretBindingsByConnectionId: { pc_a: { account: { apiKey: formatSharedSavedSecretRefV1('secret-a') },
                byMachineId: { machine_a: { apiKey: formatSharedSavedSecretRefV1('secret-b') } } } },
        });
        const credentials: AuthCredentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.signature', secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
        const content = sealProviderConnectionsContentV1({ catalog, mode: initialMode,
            material: initialMode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(credentials) });
        const h = await mount({ initialMode, providerConnectionsRow: { revision: 7, content } });
        try {
            await convertWithReview(h.screen, initialMode === 'plain');
            expect(h.migrations, JSON.stringify(vi.mocked(Modal.alertAsync).mock.calls)).toHaveLength(1);
            const directive = h.migrations[0]!.providerConnections;
            expect(directive?.expectedRevision).toBe(7);
            if (!auth.credentials) throw new Error('Missing conversion credentials');
            const targetMode = initialMode === 'plain' ? 'e2ee' : 'plain';
            expect(openProviderConnectionsContentV1({ mode: targetMode,
                material: targetMode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(auth.credentials),
                content: directive?.content })).toEqual({ status: 'opened', catalog });
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });
    it.each(['plain', 'e2ee'] as const)('migrates current prompt catalog rows from %s with exact captured revisions', async (initialMode) => {
        const record: PromptLibraryRecordV1 = { key: 'folders', value: { v: 1,
            folders: [{ id: 'catalog-folder', name: 'Private catalog folder', parentId: null }] } };
        const credentials: AuthCredentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.signature',
            secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
        const content = sealPromptLibraryContentV1({ record, mode: initialMode,
            material: initialMode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(credentials) });
        const h = await mount({ initialMode, settingsVersion: 11, rawSettings: { preferredLanguage: 'fr' },
            promptLibraryRows: [{ key: 'folders', revision: 4, content }] });
        try {
            // The displayed facade can lag the captured server baseline. Its
            // preference and revision must not be paired with a fresh CAS basis.
            storage.getState().applySettings({ ...storage.getState().settings, preferredLanguage: 'en' }, 3);
            await convertWithReview(h.screen, initialMode === 'plain');
            expect(h.migrations, JSON.stringify(vi.mocked(Modal.alertAsync).mock.calls)).toHaveLength(1);
            const item = h.migrations[0]!.promptLibrary?.items[0];
            expect(item).toMatchObject({ key: 'folders', expectedRevision: 4 });
            if (!item || !auth.credentials) throw new Error('Missing prompt catalog conversion');
            const targetMode = initialMode === 'plain' ? 'e2ee' : 'plain';
            expect(openPromptLibraryContentV1({ key: 'folders', mode: targetMode,
                material: targetMode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(auth.credentials),
                content: item.content })).toEqual({ status: 'opened', record });
            const migration = h.migrations[0]!;
            const settingsContent = migration.settingsContent;
            const settings = settingsContent?.t === 'plain' ? settingsContent.v
                : settingsContent?.t === 'encrypted' ? openAccountScopedBlobCiphertext({ kind: 'account_settings',
                    material: resolveAccountScopedCryptoMaterialFromCredentials(auth.credentials),
                    ciphertext: settingsContent.c })?.value : null;
            if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Missing converted settings');
            expect(migration.expectedSettingsVersion).toBe(11);
            expect('preferredLanguage' in settings && settings.preferredLanguage).toBe('fr');
            for (const root of ['promptStacksV1', 'promptFoldersV1', 'promptInvocationsV1', 'promptExternalLinksV1',
                'promptRegistrySourcesV1', 'contextSelectionsV1', 'rolesV1', 'executionRunsGuidanceEntries', 'executionRunsGuidanceEnabled']) {
                expect(Object.hasOwn(settings, root), root).toBe(false);
            }
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('refuses a partial prompt census instead of converting only the readable neighbor', async () => {
        const record: PromptLibraryRecordV1 = { key: 'folders', value: { v: 1, folders: [] } };
        const credentials: AuthCredentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.signature',
            secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
        const content = sealPromptLibraryContentV1({ record, mode: 'e2ee',
            material: resolveAccountScopedCryptoMaterialFromCredentials(credentials) });
        const h = await mount({ initialMode: 'e2ee', promptLibraryRows: [
            { key: 'folders', revision: 4, content },
            // Genuine encrypted content for a different addressed key is unreadable authority.
            { key: 'voice', revision: 5, content },
        ] });
        try {
            await convertWithReview(h.screen, false);
            expect(h.migrations).toHaveLength(0);
            await h.expectCredentialsUnchanged();
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('migrates every paged Artifact and exact qualified archive history through Settings', async () => {
        const archive = createPackageAssetArchiveV1({
            manifest: { schemaVersion: 2, id: 'com.acme.archive', version: '1.0.0', displayName: 'Archive', runtime: { apiVersion: 1 },
                contributes: { resources: [{ id: 'icon', kind: 'asset', path: 'icon.png', contentType: 'image/png' }] } },
            files: [{ path: 'icon.png', bytes: Uint8Array.of(137, 80, 78) }],
        });
        if (!archive) throw new Error('Invalid package fixture');
        const encryption = await Encryption.create(new Uint8Array(32).fill(7));
        const dataKey = ArtifactEncryption.generateDataEncryptionKey();
        const artifactEncryption = new ArtifactEncryption(dataKey);
        const ordinary = { ownership: { kind: 'ordinary' as const }, publicAudience: 'none' as const, headerVersion: 1, bodyVersion: 2,
            header: await artifactEncryption.encryptHeader({ title: 'Document' }),
            body: await artifactEncryption.encryptBody({ body: 'Content' }),
            dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(dataKey), 'base64'), revisions: [] };
        const archiveBody = { body: encodePackageAssetArchiveBodyV1(archive.body) };
        const protectedRow = { ...ordinary, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            ownership: { kind: 'packageAsset' as const, pluginId: 'com.acme.archive', descriptor: archive.descriptor },
            header: await artifactEncryption.encryptHeader(archive.header), body: await artifactEncryption.encryptBody(archiveBody),
            revisions: [{ bodyVersion: 1, body: await artifactEncryption.encryptBody(archiveBody) }] };
        const rows = [...Array.from({ length: 501 }, (_, index) => ({ ...ordinary,
            id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` })), protectedRow];
        const h = await mount({ initialMode: 'e2ee', artifactRows: rows });
        try {
            await convertWithReview(h.screen, false);
            expect(h.migrations, JSON.stringify(vi.mocked(Modal.alertAsync).mock.calls)).toHaveLength(1);
            const converted = h.migrations[0]!.artifacts;
            if (!converted || converted.action !== 'migrate') throw new Error('Missing Artifact conversion');
            expect(converted.items).toHaveLength(502);
            const stored = converted.items.find(item => item.artifactId === protectedRow.id)!;
            expect(decodePlainArtifactStoredContent(stored.header)).toEqual(archive.header);
            expect(decodePlainArtifactStoredContent(stored.revisions[0]!.body)).toEqual(archiveBody);
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });
    it('does not submit a transition after Home changes during Artifact inventory', async () => {
        let other: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
        const h = await mount({ initialMode: 'e2ee', beforeArtifactInventory: async () => {
            other = await restoreOtherHome(`https://other-artifacts-${crypto.randomUUID()}.test`);
        } });
        try {
            await convertWithReview(h.screen, false);
            expect(h.migrations).toEqual([]);
        } finally { await h.screen.unmount(); await other?.dispose(); await h.restored.dispose(); }
    });

    it('routes recovery through Action admission before rewriting any template', async () => {
        const h = await mount({ templates: [row('old')] });
        try {
            storage.getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
                'account.encryption.automationTemplates.recover': { enabled: false },
            } }) });
            await h.screen.pressByTestIdAsync('settings-account-encryption-recover-templates');
            expect(h.writes).toEqual([]);
            await h.expectCredentialsUnchanged();
            expect(Modal.alertAsync).toHaveBeenCalled();
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('routes the Forget button through Action admission instead of writing credentials directly', async () => {
        const h = await mount();
        try {
            storage.getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
                'account.encryption.historicalKey.forget': { enabled: false },
            } }) });
            await forgetWithReview(h.screen);
            await h.expectCredentialsUnchanged();
            expect(Modal.confirm).not.toHaveBeenCalled();
            expect(Modal.alertAsync).toHaveBeenCalled();
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('keeps historical credentials when opening a plain Account with archived encrypted Sessions', async () => {
        const h = await mount({ archivedSessions: [retainedSession('session-old', 'e2ee')], waitForControls: false });
        try { await h.expectCredentialsUnchanged(); }
        finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('recovers a plain-target template only on explicit action, through template CAS', async () => {
        const current = [serializeAutomationStoredDefinitionExecutionRecipeV1({ v: 1, templateVersion: 2,
            template: { t: 'plain', v: { v: 1, prompt: 'Current task' } }, triggerEvidence: null,
            target: { kind: 'executionRun', request: { intent: 'task',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'read_only',
                retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' } } }),
        serializeAutomationStoredWorkflowDefinitionRecipeV2({ v: 2, templateVersion: 2,
            workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' } } },
            triggerEvidence: null })].map((serialized, index) => {
            if (serialized.kind !== 'available') throw new Error('Invalid current recipe fixture');
            return row(`current-${index}`, serialized.serialized);
        });
        const originalCurrentBytes = current.map(template => template.templateCiphertext);
        const h = await mount({ templates: [row('plain-target'), ...current] });
        try {
            expect(h.writes).toEqual([]);
            await h.expectCredentialsUnchanged();
            expect(getActiveServerAccountScope()).toMatchObject({ accountId: 'account-a' });
            await h.screen.pressByTestIdAsync('settings-account-encryption-recover-templates');
            await vi.waitFor(() => expect(h.writes).toHaveLength(1));
            expect(h.writes[0]).toMatchObject({ id: 'plain-target', expectedTemplateVersion: 2 });
            expect(openAutomationTemplateStoredV1({ accountMode: 'plain', templateCiphertext: h.writes[0]!.templateCiphertext })).toMatchObject({ ok: true });
            await vi.waitFor(() => expect(Modal.alertAsync).toHaveBeenCalled());
            await h.expectCredentialsUnchanged();
            expect(current.map(template => template.templateCiphertext)).toEqual(originalCurrentBytes);
            expect(h.writes).toHaveLength(1);
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it.each(['retained', 'decryption-failed', 'conflict', 'inventory-failed'] as const)('retains genuine material when recovery is %s', async (reason) => {
        const h = await mount({ templates: [row('old', reason === 'retained' ? AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED
            : reason === 'decryption-failed' ? '{"kind":"happier_automation_template_encrypted_v1","payloadCiphertext":"broken"}' : AUTOMATION_TEMPLATE_V02_ENCRYPTED)],
            archivedSessions: reason === 'retained' ? [retainedSession('session-old', 'e2ee')] : [],
            conflict: reason === 'conflict', failInventory: reason === 'inventory-failed',
        });
        try {
            await h.screen.pressByTestIdAsync('settings-account-encryption-recover-templates');
            await vi.waitFor(() => expect(Modal.alertAsync).toHaveBeenCalled());
            await h.expectCredentialsUnchanged();
            expect(h.writes).toEqual([]);
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it.each(['retained-summary', 'encrypted-trigger'] as const)('does not retire material while the complete Automation inventory contains %s', async (content) => {
        const summaryCiphertext = AUTOMATION_TEMPLATE_V02_ENCRYPTED;
        const retainedRun: RunRow = { runId: 'retained-run', expectedRunRevision: 1,
            automationId: 'old', occurrenceKey: null, triggerId: null, summaryCiphertext,
            triggerEvidenceEnvelope: null, occurrenceEvidenceEqualityTag: null, executionInputEnvelope: null,
            resultEnvelope: JSON.stringify({ t: 'legacySummaryCiphertext', c: summaryCiphertext }),
            replyContextEnvelope: null, failureDetailEnvelope: null };
        const template = row('old');
        if (content === 'encrypted-trigger') template.triggerDefinitionEnvelopes = [{ triggerId: AutomationTriggerIdSchema.parse('trigger-old'), triggerRevision: 1,
            envelope: JSON.stringify({ t: 'encrypted', c: 'retained-trigger-ciphertext' }) }];
        const h = await mount({ templates: content === 'retained-summary' ? [] : [template],
            runs: content === 'retained-summary' ? [retainedRun] : [] });
        try {
            await h.screen.pressByTestIdAsync('settings-account-encryption-recover-templates');
            await vi.waitFor(() => expect(Modal.alertAsync).toHaveBeenCalled());
            await h.expectCredentialsUnchanged();
            expect(h.writes).toHaveLength(content === 'retained-summary' ? 0 : 1);
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('keeps historical material after switching to plain while an archived E2EE Session remains', async () => {
        const h = await mount({ initialMode: 'e2ee', archivedSessions: [retainedSession('session-old', 'e2ee')] });
        try {
            await convertWithReview(h.screen, false);
            await vi.waitFor(() => expect(h.migrations).toHaveLength(1));
            expect(h.migrations[0]?.toMode).toBe('plain');
            await expectKeysKeptAsHistory(h);
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });
    it('does not retire material when a retained E2EE Session appears after the migration census', async () => {
        const h = await mount({ initialMode: 'e2ee', afterCommitArchivedSessions: [retainedSession('session-concurrent', 'e2ee')] });
        try {
            await convertWithReview(h.screen, false);
            await vi.waitFor(() => expect(h.migrations).toHaveLength(1));
            await expectKeysKeptAsHistory(h);
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it.each([false, true])('retains material after migration even with no current dependencies (inventory failure: %s)', async (afterCommitInventoryFails) => {
        const h = await mount({ initialMode: 'e2ee', afterCommitInventoryFails });
        try {
            await convertWithReview(h.screen, false);
            expect(h.migrations).toHaveLength(1);
            await expectKeysKeptAsHistory(h);
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('does not recover or retire material after the captured Home changes during inventory', async () => {
        const switched: { current: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null } = { current: null };
        const h = await mount({ templates: [row('old')], beforeInventory: async () => {
            switched.current = await restoreOtherHome(`https://other-${crypto.randomUUID()}.test`);
        } });
        try {
            await h.screen.pressByTestIdAsync('settings-account-encryption-recover-templates');
            expect(h.writes).toEqual([]);
            await h.expectCredentialsUnchanged();
        } finally { await h.screen.unmount(); await switched.current?.dispose(); await h.restored.dispose(); }
    });

    it('keeps a concurrently created encrypted Session usable after recovery, until confirmed forgetting', async () => {
        const inventory = createDeferred<void>();
        const resumeInventory = createDeferred<void>();
        let holdInventory = false;
        const h = await mount({ templates: [row('old')], beforeInventory: async () => {
            if (!holdInventory) return;
            inventory.resolve();
            await resumeInventory.promise;
        } });
        try {
            const encryption = await createEncryptionFromAuthCredentials(auth.credentials!);
            const dataKey = new Uint8Array(32).fill(11);
            const cipher = await encryption.openEncryption(dataKey);
            const [encryptedHistory] = await cipher.encrypt([{ text: 'Retained session history' }]);
            const history = encodeBase64(encryptedHistory!, 'base64');
            const envelope = encodeBase64(await encryption.encryptEncryptionKey(dataKey), 'base64');
            holdInventory = true;
            const recovery = h.screen.pressByTestIdAsync('settings-account-encryption-recover-templates');
            await inventory.promise;
            const response = await h.request('/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag: 'session-concurrent', encryptionMode: 'e2ee', metadata: history, dataEncryptionKey: envelope }) });
            expect(response.ok).toBe(true);
            holdInventory = false;
            resumeInventory.resolve();
            await recovery;
            await h.expectCredentialsUnchanged();
            const reopened = await createEncryptionFromAuthCredentials(auth.credentials!);
            const reopenedKey = await reopened.decryptEncryptionKey(envelope);
            expect(reopenedKey).toEqual(dataKey);
            expect(await (await reopened.openEncryption(reopenedKey)).decrypt([encryptedHistory!])).toEqual([{ text: 'Retained session history' }]);
            vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
            await forgetWithReview(h.screen);
            expect(await h.readCredentials()).toEqual({ token: h.restored.credentials.token });
            expect(auth.credentials).toEqual(await h.readCredentials());
            await expect(createEncryptionFromAuthCredentials(auth.credentials!)).rejects.toThrow('token-only');
        } finally { resumeInventory.resolve(); await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('lists affected encrypted Sessions, templates and run history; cancelling keeps their key', async () => {
        const h = await mount({ templates: [row('trigger-old', AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED)],
            archivedSessions: [retainedSession('session-old', 'e2ee'), retainedSession('session-plain', 'plain')],
            runs: [{ runId: 'run-old', expectedRunRevision: 1, automationId: 'trigger-old', occurrenceKey: null, triggerId: null,
                summaryCiphertext: AUTOMATION_TEMPLATE_V02_ENCRYPTED, triggerEvidenceEnvelope: null, occurrenceEvidenceEqualityTag: null,
                executionInputEnvelope: null, resultEnvelope: null, replyContextEnvelope: null, failureDetailEnvelope: null }] });
        try {
            vi.mocked(Modal.confirm).mockImplementation(async title => title !== 'settingsAccount.forgetEncryptionKeyConfirm');
            await forgetWithReview(h.screen);
            const message = vi.mocked(Modal.confirm).mock.calls.find(([title]) => title === 'settingsAccount.forgetEncryptionKeyConfirm')?.[1];
            expect(message).toContain('session-old');
            expect(message).toContain('trigger-old');
            expect(message).toContain('run-old');
            expect(message).not.toContain('session-plain');
            await h.expectCredentialsUnchanged();
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('does not forget when the dependency listing is unavailable', async () => {
        const h = await mount({ failInventory: true });
        try {
            vi.mocked(Modal.confirm).mockClear();
            await forgetWithReview(h.screen);
            expect(vi.mocked(Modal.confirm).mock.calls.filter(([title]) => title === 'settingsAccount.forgetEncryptionKeyConfirm')).toEqual([]);
            await h.expectCredentialsUnchanged();
            expect(Modal.alertAsync).toHaveBeenCalled();
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('does not adopt token-only credentials when the Home changes during Forget confirmation', async () => {
        const h = await mount();
        const other: { current: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null } = { current: null };
        try {
            vi.mocked(Modal.confirm).mockImplementationOnce(async () => {
                other.current = await restoreOtherHome(`https://forget-other-${crypto.randomUUID()}.test`);
                return true;
            });
            await forgetWithReview(h.screen);
            await h.expectCredentialsUnchanged();
        } finally { await h.screen.unmount(); await other.current?.dispose(); await h.restored.dispose(); }
    });

    it('locks a device holding active keys when the Home reports plain, and keeps its keys as history only on the person\'s tap', async () => {
        const h = await mount({ initialMode: 'e2ee', modeAfterRestore: 'plain', initialCustody: 'active', waitForControls: false });
        try {
            await vi.waitFor(() => expect(h.screen.findAll(node => node.props.testID === 'settings-account-encryption-downgrade')).not.toHaveLength(0));
            expect(h.screen.findAll(node => node.props.testID === 'settings-account-encryption-forget-key')).toHaveLength(0);
            await h.expectCredentialsUnchanged();
            await h.screen.pressByTestIdAsync('settings-account-encryption-keep-key');
            await vi.waitFor(async () => expect(await h.readCredentials()).toEqual({ token: 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.signature',
                secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url'), custody: 'historical' }));
            expect(h.migrations).toEqual([]);
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it.each(['retired', 'denied'] as const)('keeps the committed conversion and retained keys after a %s post-conversion mode read', async refusal => {
        let readAfterConversion = false;
        const h = await mount({ initialMode: 'e2ee', modeReadResponse: mode => {
            if (mode !== 'plain') return undefined;
            readAfterConversion = true;
            if (refusal === 'denied') return json({ error: 'forbidden' }, 403);
            // A mode push withdraws an incumbent read. The real readiness owner
            // must refuse its otherwise valid response without disclosing it.
            invalidateAccountEncryptionModeCache();
            return json({ mode: 'plain', updatedAt: 2 });
        } });
        try {
            await convertWithReview(h.screen, false);
            await vi.waitFor(() => expect(readAfterConversion).toBe(true));
            expect(h.migrations).toHaveLength(1);
            expect(h.migrations[0]?.toMode).toBe('plain');
            await expectKeysKeptAsHistory(h);
            expect(Modal.alertAsync).not.toHaveBeenCalled();
            expect(h.screen.findAll(node => node.props.testID === 'settings-account-encryption-mode-switch'
                && node.props.value === false && node.props.disabled === false).length).toBeGreaterThan(0);
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('keeps a committed conversion successful when its Account lifetime retires before the POST acknowledgement', async () => {
        const h = await mount({ initialMode: 'plain',
            beforeMigrationAcknowledgement: () => {
                retireActiveServerAccountScopeLifetime();
            } });
        try {
            await convertWithReview(h.screen, true);
            expect(h.migrations).toHaveLength(1);
            expect(h.migrations[0]?.toMode).toBe('e2ee');
            expect(Modal.alertAsync).not.toHaveBeenCalled();
            expect(h.screen.findAll(node => node.props.testID === 'settings-account-encryption-mode-switch'
                && node.props.value === true).length).toBeGreaterThan(0);
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('makes retained keys active again when this device re-enables end-to-end encryption', async () => {
        const h = await mount({ initialMode: 'plain' });
        try {
            await convertWithReview(h.screen, true);
            await vi.waitFor(() => expect(h.migrations).toHaveLength(1));
            expect(h.migrations[0]?.toMode).toBe('e2ee');
            await vi.waitFor(async () => expect(await h.readCredentials()).toEqual({ token: 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.signature',
                secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') }));
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });
});
