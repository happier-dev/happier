import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, renderSettingsView, standardCleanup } from '@/dev/testkit';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { getCurrentAuth, setCurrentAuth } from '@/auth/context/currentAuth';
import type { AuthContextType } from '@/auth/context/AuthContext';
import { readCredentialAuthorityKind } from '@/auth/context/credentialAuthority';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { deriveAccountSigningPublicKey } from '@/auth/flows/challenge';
import { buildContentKeyBinding } from '@/auth/oauth/contentKeyBinding';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { storage } from '@/sync/domains/state/storage';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { ActionsSettingsV1Schema, AutomationTriggerIdSchema, openAutomationTemplateStoredV1, serializeAutomationStoredDefinitionExecutionRecipeV1,
    serializeAutomationStoredWorkflowDefinitionRecipeV2, type AccountEncryptionMigrateRequest,
    type AccountEncryptionMigrateAutomationsInventoryResponse, type ArtifactAccountEncryptionMigrationInventoryV1,
    decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { createPackageAssetArchiveV1, encodePackageAssetArchiveBodyV1 } from '@happier-dev/protocol/plugins/availability';
import { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { updateEffectiveHomeViewState } from '@/sync/domains/server/selection/homeViewSelectionState';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { Modal } from '@/modal';
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
    ProviderConnectionsRowMutationV1Schema, ProviderConnectionsRowMutationResponseV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { REMOTE_HOST_ROWS_ROUTE_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { CONNECTED_PRESENTATION_ROWS_ROUTE_V1, CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';

const D10_CATALOGS = [
    { field: 'remoteHosts', route: REMOTE_HOST_ROWS_ROUTE_V1, kind: 'account_remote_host_catalog', collection: 'hosts',
        record: { v: 1, hosts: [{ id: 'host-a', name: 'Work', ssh: { target: 'dev@example.com', authMode: 'agent' },
            createdAt: 1, updatedAt: 2, lastUsedAt: null }] } },
    { field: 'notificationChannels', route: NOTIFICATION_CHANNELS_ROUTE_V1, kind: 'account_notification_channels', collection: 'channels',
        record: { v: 1, channels: [{ v: 1, id: 'channel-a', kind: 'webhook', enabled: true,
            topics: { ready: true, permissionRequest: false, userActionRequest: true, connectedServiceAccountSwitch: false,
                connectedServiceQuotaBlocked: false, connectedServiceQuotaRecovered: true, connectedServiceUsage: false },
            readyIncludeMessageText: false, requestIncludeMessageText: false, url: 'https://hooks.example.test', signingSecretRef: null }] } },
    { field: 'connectedPresentation', route: CONNECTED_PRESENTATION_ROWS_ROUTE_V1, kind: 'account_connected_presentation_catalog', collection: 'entries',
        record: { v: 1, entries: [{ v: 1, subject: { kind: 'account', account: {
            service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'default' } }, label: 'Work' }] } },
    { field: 'connectedAcknowledgements', route: CONNECTED_ACKNOWLEDGEMENTS_ROWS_ROUTE_V1, kind: 'account_connected_acknowledgement_catalog', collection: 'entries',
        record: { v: 1, entries: [{ v: 1, subject: { kind: 'warning', warningId: 'installation',
            scope: { kind: 'machine', machineId: 'exact-machine' } }, acknowledged: false }] } },
] as const;

const auth = vi.hoisted(() => ({ credentials: null as AuthCredentials | null,
    loginWithCredentials: vi.fn<(credentials: AuthCredentials) => Promise<{ kind: 'completed' }>>(async () => ({ kind: 'completed' })),
}));
// Auth credentials and credential persistence are the device-storage boundary.
vi.mock('@/auth/context/AuthContext', () => ({ useAuth: () => ({
    credentials: auth.credentials, isAuthenticated: true, loginWithCredentials: auth.loginWithCredentials,
}) }));
installDisconnectedServerSocketBoundary((socket) => {
    socket.connect = vi.fn<typeof socket.connect>(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
// The native Markdown package is a rendering boundary, not part of Account custody.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
let restoreExecutorModuleLoader: (() => void) | null = null;
let previousAuth: AuthContextType | null;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
type TemplateRow = AccountEncryptionMigrateAutomationsInventoryResponse['templates'][number];
type RunRow = AccountEncryptionMigrateAutomationsInventoryResponse['runs'][number];
const row = (automationId: string, templateCiphertext = AUTOMATION_TEMPLATE_V02_ENCRYPTED): TemplateRow => ({
    automationId, expectedTemplateVersion: 2, templateCiphertext, triggerDefinitionEnvelopes: [],
});
function retainedSession(sessionId: string, encryptionMode: 'plain' | 'e2ee') {
    return { id: sessionId, encryptionMode, seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        metadata: 'metadata', metadataVersion: 1, agentState: null, agentStateVersion: 1,
        dataEncryptionKey: null, share: null };
}

async function mount(params: Readonly<{
    templates?: TemplateRow[]; archivedSessions?: ReturnType<typeof retainedSession>[];
    runs?: RunRow[];
    failInventory?: boolean; conflict?: boolean; beforeInventory?: () => Promise<void>; waitForControls?: boolean;
    initialMode?: 'plain' | 'e2ee';
    afterCommitArchivedSessions?: ReturnType<typeof retainedSession>[];
    afterCommitInventoryFails?: boolean;
    beforeRetirementCurrentness?: () => Promise<void>;
    beforeCredentialAdoption?: () => Promise<void>;
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
}> = {}) {
    await loadSyncSingletonForTests();
    restoreExecutorModuleLoader = await installRealActionExecutorModuleLoader();
    const templates = params.templates ?? [];
    const writes: Array<{ id: string; expectedTemplateVersion: number; templateCiphertext: string }> = [];
    const migrations: AccountEncryptionMigrateRequest[] = [];
    const unmatchedHttpRequests: Array<Readonly<{ path: string; method: string }>> = [];
    const d10CatalogReads: string[] = [];
    let promptLibraryRows = PromptLibraryCatalogKeyV1Schema.options.map(key =>
        params.promptLibraryRows?.find(row => row.key === key) ?? { key, revision: 1, content: null });
    let providerConnectionsRow = params.providerConnectionsRow;
    const d10CatalogRows = new Map(Object.entries(params.d10CatalogRows ?? {}));
    let mode = params.initialMode ?? 'plain';
    let inventoryReads = 0;
    const createdSessions: Array<Omit<ReturnType<typeof retainedSession>, 'dataEncryptionKey'> & { dataEncryptionKey: string | null }> = [];
    const initialCredentials: AuthCredentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.signature', secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
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
        ...(mode === 'e2ee' ? { credentials: initialCredentials } : {}),
        request: async (url, init) => {
            const target = new URL(String(url));
            if (target.pathname === '/health') return json({});
            if (target.pathname === '/v1/features' || target.pathname === '/v1/features/authenticated') return json(createRootLayoutFeaturesResponse({
                features: { encryption: { accountOptOut: { enabled: true }, plaintextStorage: { enabled: true } } },
            }));
            if (target.pathname === '/v1/account/encryption') return json({ mode, updatedAt: 1 });
            if (target.pathname === '/v1/account/encryption/currentness') {
                if (inventoryReads >= 2) await params.beforeRetirementCurrentness?.();
                return json({ mode, version: 1,
                updatedAt: 1, signingKeyFingerprint, contentKeyFingerprint,
                recipientEnvelopeReadiness: mode === 'plain' ? { status: 'unavailable', reason: 'plain_account' } : { status: 'available' } });
            }
            if (target.pathname === '/v1/account/security') return json({ v: 1, encryptionMode: mode,
                terminalPresentUserPolicy: 'allowed', nativeEmail: null, password: { status: 'not_enrolled', revision: null } });
            if (target.pathname === '/v1/kv') return json({ items: [] });
            if (target.pathname === '/v1/account/encryption/migrate/review-comments/inventory') return json({ v: 1, items: [] });
            if (target.pathname === '/v1/account/encryption/migrate/session-organization/inventory') return json({ version: 0, folders: [], tags: [], labels: [] });
            if (target.pathname === '/v1/account/encryption/migrate' && init?.method === 'POST') {
                const migration = JSON.parse(String(init.body)) as AccountEncryptionMigrateRequest;
                migrations.push(migration);
                mode = migration.toMode;
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
                return json({ success: true, mode, accountVersion: 2, settingsVersion: 1,
                    ...d10Results,
                    ...(migration.providerConnections ? { providerConnections: { row: providerConnectionsRow ?? null } } : {}),
                    ...(migration.promptLibrary ? { promptLibrary: { rows: migration.promptLibrary.items.map(item => ({
                        key: item.key, revision: item.expectedRevision + 1, content: item.content,
                    })) } } : {}),
                    ...(migration.profileRows ? { profileRows: { rows: [], referenceGuardRevision: 'absent',
                        transferControl: { status: 'absent' } } } : {}),
                });
            }
            if (target.pathname === PROMPT_LIBRARY_ROWS_ROUTE_V1) return json({ status: 'listed', rows: promptLibraryRows });
            if (target.pathname === PROVIDER_CONNECTIONS_ROWS_ROUTE_V1) {
                if (init?.method === 'POST') {
                    const mutation = ProviderConnectionsRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    const currentRevision = providerConnectionsRow?.revision ?? 'absent';
                    if (mutation.expectedRevision !== currentRevision) return json(ProviderConnectionsRowMutationResponseV1Schema.parse({
                        status: 'conflict', revision: providerConnectionsRow?.revision ?? -1,
                    }));
                    if (mutation.sourceSettingsVersion !== undefined && mutation.sourceSettingsVersion !== (params.settingsVersion ?? 0)) {
                        return json(ProviderConnectionsRowMutationResponseV1Schema.parse({ status: 'settings-conflict', revision: params.settingsVersion ?? 0 }));
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
                inventoryReads += 1;
                await params.beforeInventory?.();
                if (params.failInventory || (params.afterCommitInventoryFails && migrations.length > 0)) return json({ error: 'unavailable' }, 503);
                return json({ templates, runs: params.runs ?? [] });
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
            if (target.pathname === '/v1/account/encryption/artifacts') {
                await params.beforeArtifactInventory?.();
                const rows = params.artifactRows ?? [];
                const afterId = target.searchParams.get('afterId');
                const offset = afterId === null ? 0 : rows.findIndex(row => row.id === afterId) + 1;
                const items = rows.slice(offset, offset + Number(target.searchParams.get('limit')));
                return json({ ownerAccountId: 'account-a', encryptionMode: mode, items,
                    nextCursor: offset + items.length < rows.length ? items.at(-1)!.id : null });
            }
            if (target.pathname === '/v1/account/authoring-memory') return json({ rows: [] });
            if (target.pathname === '/v2/changes') return json({ changes: [], nextCursor: 0 });
            if (target.pathname === '/v2/account/settings') return json({ content: settingsContent, version: params.settingsVersion ?? 0 });
            unmatchedHttpRequests.push({ path: target.pathname, method: init?.method ?? 'GET' });
            return json({ error: 'not_found' }, 404);
        } });
    auth.credentials = initialCredentials;
    vi.mocked(TokenStorage.getCredentialsForServerUrl).mockImplementation(async (url) => url === restored.home.serverUrl ? auth.credentials : null);
    auth.loginWithCredentials.mockReset();
    auth.loginWithCredentials.mockImplementation(async credentials => {
        await params.beforeCredentialAdoption?.();
        auth.credentials = credentials;
        return { kind: 'completed' as const };
    });
    setCurrentAuth({
        isAuthenticated: true,
        get credentials() { return auth.credentials; },
        credentialAuthorityKind: readCredentialAuthorityKind(initialCredentials.token),
        loginWithCredentials: auth.loginWithCredentials,
        login: async () => { throw new Error('Unexpected password login in historical custody fixture'); },
        logout: async () => { throw new Error('Unexpected logout in historical custody fixture'); },
        refreshFromActiveServer: async () => {},
    } satisfies AuthContextType);
    storage.getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1 }), experiments: true, featureToggles: { 'encryption.accountOptOut': true },
        clientEncryptionRequirementV1: 'follow_account', clientEncryptionRequirementLocalV1: 'follow_account' });
    await updateEffectiveHomeViewState(current => ({ ...current, activeTargetKind: 'server', activeTargetId: restored.home.id }), { scope: 'tab' });
    const { AccountEncryptionSettingsSection } = await import('./AccountEncryptionSettingsSection');
    const screen = await renderSettingsView(<AccountEncryptionSettingsSection />);
    try {
        if (params.waitForControls !== false) await vi.waitFor(() => expect(screen.findAll((node) => node.props.testID === 'settings-account-encryption-mode-switch'
            && typeof node.props.onValueChange === 'function' && node.props.disabled === false && node.props.value === (mode === 'e2ee')).length).toBeGreaterThan(0), { timeout: 5000 });
    } catch (error) {
        await screen.unmount(); await restored.dispose(); throw error;
    }
    vi.mocked(Modal.alertAsync).mockClear();
    const request = createServerFetchAtEndpoint({ endpointUrl: restored.home.serverUrl,
        serverId: restored.home.id, credentials: initialCredentials });
    return { screen, restored, writes, migrations, request, createdSessions, unmatchedHttpRequests, d10CatalogReads };
}

beforeEach(() => { previousAuth = getCurrentAuth(); });
afterEach(async () => {
    restoreExecutorModuleLoader?.(); restoreExecutorModuleLoader = null;
    setCurrentAuth(previousAuth); await standardCleanup(); invalidateAccountEncryptionModeCache(); vi.restoreAllMocks(); });

describe('Account encryption historical material custody', () => {
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
            const toggle = h.screen.findAll(node => node.props.testID === 'settings-account-encryption-mode-switch'
                && typeof node.props.onValueChange === 'function')[0]!;
            await act(async () => { await toggle.props.onValueChange(initialMode === 'plain'); });
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
            const toggle = h.screen.findAll(node => node.props.testID === 'settings-account-encryption-mode-switch'
                && typeof node.props.onValueChange === 'function')[0]!;
            await act(async () => { await toggle.props.onValueChange(false); });
            expect(h.d10CatalogReads, JSON.stringify(h.unmatchedHttpRequests)).toContain(field);
            expect(h.migrations).toHaveLength(0);
            expect(auth.loginWithCredentials).not.toHaveBeenCalled();
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('retires the initiating Account conversion when Home changes during D10 raw census', async () => {
        let startSwitch = false;
        let switched = false;
        let other: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
        const h = await mount({ initialMode: 'e2ee', beforeD10Read: async () => {
            if (!startSwitch || switched) return;
            switched = true;
            other = await restoreServerAccountForTest({ serverUrl: `https://other-d10-${crypto.randomUUID()}.test` });
        } });
        try {
            startSwitch = true;
            const toggle = h.screen.findAll(node => node.props.testID === 'settings-account-encryption-mode-switch'
                && typeof node.props.onValueChange === 'function')[0]!;
            await act(async () => { await toggle.props.onValueChange(false); });
            expect(switched).toBe(true);
            expect(h.migrations).toHaveLength(0);
            expect(auth.loginWithCredentials).not.toHaveBeenCalled();
        } finally { await h.screen.unmount(); await other?.dispose(); await h.restored.dispose(); }
    });

    it.each(['plain', 'e2ee'] as const)('includes the demanded Provider catalog in the actual Account mode switch (%s source)', async initialMode => {
        const catalog = { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1 as const, id: 'pc_a', source: { kind: 'contribution' as const, contributionKey: 'plugin/provider' },
                role: 'default' as const, displayName: 'Provider', displayNameMode: 'automatic' as const,
                deployment: { kind: 'external' as const }, revision: 2, createdAt: 1, updatedAt: 2 }],
            secretBindingsByConnectionId: { pc_a: { account: { apiKey: formatSharedSavedSecretRefV1('secret-a') },
                byMachineId: { machine_a: { apiKey: formatSharedSavedSecretRefV1('secret-b') } } } },
        };
        const credentials: AuthCredentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.signature', secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
        const content = sealProviderConnectionsContentV1({ catalog, mode: initialMode,
            material: initialMode === 'plain' ? null : resolveAccountScopedCryptoMaterialFromCredentials(credentials) });
        const h = await mount({ initialMode, providerConnectionsRow: { revision: 7, content } });
        try {
            const toggle = h.screen.findAll(node => node.props.testID === 'settings-account-encryption-mode-switch'
                && typeof node.props.onValueChange === 'function')[0]!;
            await act(async () => { await toggle.props.onValueChange(initialMode === 'plain'); });
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
            const toggle = h.screen.findAll(node => node.props.testID === 'settings-account-encryption-mode-switch'
                && typeof node.props.onValueChange === 'function')[0]!;
            await act(async () => { await toggle.props.onValueChange(initialMode === 'plain'); });
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
            const toggle = h.screen.findAll(node => node.props.testID === 'settings-account-encryption-mode-switch'
                && typeof node.props.onValueChange === 'function')[0]!;
            await act(async () => { await toggle.props.onValueChange(false); });
            expect(h.migrations).toHaveLength(0);
            expect(auth.loginWithCredentials).not.toHaveBeenCalled();
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
        const ordinary = { ownership: { kind: 'ordinary' as const }, headerVersion: 1, bodyVersion: 2,
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
            const toggle = h.screen.findAll(node => node.props.testID === 'settings-account-encryption-mode-switch'
                && typeof node.props.onValueChange === 'function')[0]!;
            await act(async () => { await toggle.props.onValueChange(false); });
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
            other = await restoreServerAccountForTest({ serverUrl: `https://other-artifacts-${crypto.randomUUID()}.test` });
        } });
        try {
            const toggle = h.screen.findAll(node => node.props.testID === 'settings-account-encryption-mode-switch'
                && typeof node.props.onValueChange === 'function')[0]!;
            await act(async () => { await toggle.props.onValueChange(false); });
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
            expect(auth.loginWithCredentials).not.toHaveBeenCalled();
            expect(Modal.alertAsync).toHaveBeenCalled();
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('routes the Forget button through Action admission instead of writing credentials directly', async () => {
        const h = await mount();
        try {
            storage.getState().applySettingsLocal({ actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {
                'account.encryption.historicalKey.forget': { enabled: false },
            } }) });
            await h.screen.pressByTestIdAsync('settings-account-encryption-forget-key');
            expect(auth.loginWithCredentials).not.toHaveBeenCalled();
            expect(Modal.confirm).not.toHaveBeenCalled();
            expect(Modal.alertAsync).toHaveBeenCalled();
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('keeps historical credentials when opening a plain Account with archived encrypted Sessions', async () => {
        const h = await mount({ archivedSessions: [retainedSession('session-old', 'e2ee')], waitForControls: false });
        try { expect(auth.loginWithCredentials).not.toHaveBeenCalled(); }
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
            expect(auth.loginWithCredentials).not.toHaveBeenCalled();
            expect(getActiveServerAccountScope()).toMatchObject({ accountId: 'account-a' });
            await h.screen.pressByTestIdAsync('settings-account-encryption-recover-templates');
            await vi.waitFor(() => expect(h.writes).toHaveLength(1));
            expect(h.writes[0]).toMatchObject({ id: 'plain-target', expectedTemplateVersion: 2 });
            expect(openAutomationTemplateStoredV1({ accountMode: 'plain', templateCiphertext: h.writes[0]!.templateCiphertext })).toMatchObject({ ok: true });
            await vi.waitFor(() => expect(Modal.alertAsync).toHaveBeenCalled());
            expect(auth.loginWithCredentials).not.toHaveBeenCalled();
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
            expect(auth.loginWithCredentials).not.toHaveBeenCalled();
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
            expect(auth.loginWithCredentials).not.toHaveBeenCalled();
            expect(h.writes).toHaveLength(content === 'retained-summary' ? 0 : 1);
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('keeps historical material after switching to plain while an archived E2EE Session remains', async () => {
        const h = await mount({ initialMode: 'e2ee', archivedSessions: [retainedSession('session-old', 'e2ee')] });
        try {
            const toggle = h.screen.findAll(node => node.props.testID === 'settings-account-encryption-mode-switch'
                && typeof node.props.onValueChange === 'function')[0]!;
            await act(async () => { await toggle.props.onValueChange(false); });
            await vi.waitFor(() => expect(h.migrations).toHaveLength(1));
            expect(h.migrations[0]?.toMode).toBe('plain');
            expect(auth.loginWithCredentials).not.toHaveBeenCalled();
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });
    it('does not retire material when a retained E2EE Session appears after the migration census', async () => {
        const h = await mount({ initialMode: 'e2ee', afterCommitArchivedSessions: [retainedSession('session-concurrent', 'e2ee')] });
        try {
            const toggle = h.screen.findAll(node => node.props.testID === 'settings-account-encryption-mode-switch'
                && typeof node.props.onValueChange === 'function')[0]!;
            await act(async () => { await toggle.props.onValueChange(false); });
            await vi.waitFor(() => expect(h.migrations).toHaveLength(1));
            expect(auth.loginWithCredentials).not.toHaveBeenCalled();
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it.each([false, true])('retains material after migration even with no current dependencies (inventory failure: %s)', async (afterCommitInventoryFails) => {
        const h = await mount({ initialMode: 'e2ee', afterCommitInventoryFails });
        try {
            const toggle = h.screen.findAll(node => node.props.testID === 'settings-account-encryption-mode-switch'
                && typeof node.props.onValueChange === 'function')[0]!;
            await act(async () => { await toggle.props.onValueChange(false); });
            expect(h.migrations).toHaveLength(1);
            expect(auth.loginWithCredentials).not.toHaveBeenCalled();
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('does not recover or retire material after the captured Home changes during inventory', async () => {
        const switched: { current: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null } = { current: null };
        const h = await mount({ templates: [row('old')], beforeInventory: async () => {
            switched.current = await restoreServerAccountForTest({ serverUrl: `https://other-${crypto.randomUUID()}.test` });
        } });
        try {
            await h.screen.pressByTestIdAsync('settings-account-encryption-recover-templates');
            expect(h.writes).toEqual([]);
            expect(auth.loginWithCredentials).not.toHaveBeenCalled();
        } finally { await h.screen.unmount(); await switched.current?.dispose(); await h.restored.dispose(); }
    });

    it('keeps a concurrently created encrypted Session usable after recovery, until confirmed forgetting', async () => {
        const currentness = createDeferred<void>();
        const resumeCurrentness = createDeferred<void>();
        const adoption = createDeferred<void>();
        const resumeAdoption = createDeferred<void>();
        const h = await mount({ templates: [row('old')], beforeRetirementCurrentness: async () => {
            currentness.resolve();
            await resumeCurrentness.promise;
        }, beforeCredentialAdoption: async () => {
            adoption.resolve();
            await resumeAdoption.promise;
        } });
        try {
            const encryption = await createEncryptionFromAuthCredentials(auth.credentials!);
            const dataKey = new Uint8Array(32).fill(11);
            const cipher = await encryption.openEncryption(dataKey);
            const [encryptedHistory] = await cipher.encrypt([{ text: 'Retained session history' }]);
            const history = encodeBase64(encryptedHistory!, 'base64');
            const envelope = encodeBase64(await encryption.encryptEncryptionKey(dataKey), 'base64');
            const recovery = h.screen.pressByTestIdAsync('settings-account-encryption-recover-templates');
            // Old code waits after its final census. The corrected path finishes without that read.
            await Promise.race([currentness.promise, recovery]);
            const response = await h.request('/v1/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag: 'session-concurrent', encryptionMode: 'e2ee', metadata: history, dataEncryptionKey: envelope }) });
            expect(response.ok).toBe(true);
            resumeCurrentness.resolve();
            await Promise.race([adoption.promise, recovery]);
            resumeAdoption.resolve();
            await recovery;
            expect(auth.loginWithCredentials).not.toHaveBeenCalled();
            const reopened = await createEncryptionFromAuthCredentials(auth.credentials!);
            const reopenedKey = await reopened.decryptEncryptionKey(envelope);
            expect(reopenedKey).toEqual(dataKey);
            expect(await (await reopened.openEncryption(reopenedKey)).decrypt([encryptedHistory!])).toEqual([{ text: 'Retained session history' }]);
            vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
            await h.screen.pressByTestIdAsync('settings-account-encryption-forget-key');
            expect(auth.credentials).toEqual({ token: h.restored.credentials.token });
            await expect(createEncryptionFromAuthCredentials(auth.credentials!)).rejects.toThrow('token-only');
        } finally { resumeCurrentness.resolve(); resumeAdoption.resolve(); await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('lists affected encrypted Sessions, templates and run history; cancelling keeps their key', async () => {
        const h = await mount({ templates: [row('trigger-old', AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED)],
            archivedSessions: [retainedSession('session-old', 'e2ee'), retainedSession('session-plain', 'plain')],
            runs: [{ runId: 'run-old', expectedRunRevision: 1, automationId: 'trigger-old', occurrenceKey: null, triggerId: null,
                summaryCiphertext: AUTOMATION_TEMPLATE_V02_ENCRYPTED, triggerEvidenceEnvelope: null, occurrenceEvidenceEqualityTag: null,
                executionInputEnvelope: null, resultEnvelope: null, replyContextEnvelope: null, failureDetailEnvelope: null }] });
        try {
            vi.mocked(Modal.confirm).mockResolvedValueOnce(false);
            await h.screen.pressByTestIdAsync('settings-account-encryption-forget-key');
            const message = vi.mocked(Modal.confirm).mock.calls.at(-1)?.[1];
            expect(message).toContain('session-old');
            expect(message).toContain('trigger-old');
            expect(message).toContain('run-old');
            expect(message).not.toContain('session-plain');
            expect(auth.loginWithCredentials).not.toHaveBeenCalled();
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('does not forget when the dependency listing is unavailable', async () => {
        const h = await mount({ failInventory: true });
        try {
            vi.mocked(Modal.confirm).mockClear();
            await h.screen.pressByTestIdAsync('settings-account-encryption-forget-key');
            expect(Modal.confirm).not.toHaveBeenCalled();
            expect(auth.loginWithCredentials).not.toHaveBeenCalled();
            expect(Modal.alertAsync).toHaveBeenCalled();
        } finally { await h.screen.unmount(); await h.restored.dispose(); }
    });

    it('does not adopt token-only credentials when the Home changes during Forget confirmation', async () => {
        const h = await mount();
        const other: { current: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null } = { current: null };
        try {
            vi.mocked(Modal.confirm).mockImplementationOnce(async () => {
                other.current = await restoreServerAccountForTest({ serverUrl: `https://forget-other-${crypto.randomUUID()}.test` });
                return true;
            });
            await h.screen.pressByTestIdAsync('settings-account-encryption-forget-key');
            expect(auth.loginWithCredentials).not.toHaveBeenCalled();
        } finally { await h.screen.unmount(); await other.current?.dispose(); await h.restored.dispose(); }
    });
});
