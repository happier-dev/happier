import * as React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, pressTestInstance, renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { Settings } from '@/sync/domains/settings/settings';
import { clearTempData } from '@/utils/sessions/tempDataStore';
import { createSessionRouteHomesFixture, installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';
import type {
    SessionOrganizationSnapshot,
    SessionOrganizationFolder,
    SessionOrganizationTag,
} from '@happier-dev/protocol';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';
import { buildQualifiedPluginContributionKey, deriveSessionCreationTagV1, PluginProjectionV2Schema, SessionCreationCorrespondenceV1Schema, SessionOrganizationContentEnvelopeSchema } from '@happier-dev/protocol';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { evaluatePluginUiPolicy } from '@/sync/domains/plugins/ui/policy';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainSessionByIdResponseFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SESSION_ORGANIZATION_SNAPSHOT_VERSION } from '@happier-dev/protocol/sessions/organization/constants';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { SessionMetadataTuplePatchSuccessV1Schema, SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { AUTHORING_MEMORY_ROUTE_V1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { machinePoolActionEndpointPathV1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import { V2SessionByIdNotFoundSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SESSION_ACTION_MARK_READ_ID, SESSION_ACTION_MARK_UNREAD_ID, SESSION_ACTION_MOVE_TO_FOLDER_ID } from '@/components/sessions/actions/sessionActionIds';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { ServerIdentityCapabilitiesSchema } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import type { PluginMachineExecutionOriginV1, PluginSourceCustodyV1 } from '@happier-dev/protocol';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { waitForNetworkResponseForTests } from '@/dev/testkit/mocks/runtimeFetch';
import { tryParseDecryptedSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

vi.mock('@/sync/domains/state/browserRecordStorage', async () => {
    const { createBrowserRecordStorageModuleMock } = await import('@/dev/testkit/mocks/browserRecordStorage');
    return createBrowserRecordStorageModuleMock();
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockSessionId = 'session-1';
let mockServerId: string | undefined;
let mockSession: any = null;
let mockProfile = { ...profileDefaults, id: 'viewer-account' };
let isDataReady = true;
let routeHydrationState: SessionRouteHydrationState = { kind: 'available', sessionId: 'session-1' };
let sessionIsConnected = true;
let machinePresenceObserved = true;
let localDevModeEnabled = false;
const machineListByServerIdState = vi.hoisted(() => ({
    current: {} as Record<string, any[]>,
}));
const machinePoolListByServerIdState = vi.hoisted(() => ({
    current: {} as Record<string, any[] | null>,
}));
const routerPushSpy = vi.fn();
const routerBackSpy = vi.fn();
let machineTargetFixture: Readonly<{ machineId: string; basePath: string }> | null = null;
let cachedSessionServerId: string | null = null;
type CreateDefaultActionExecutorConfig = Readonly<{
    resolveServerIdForSessionId?: (sessionId: string) => string | null;
    openSession?: (
        sessionId: string,
        options?: Readonly<{ serverId?: string | null }>,
    ) => void | Promise<void>;
}>;
const modalAlertSpy = vi.fn();
const modalConfirmSpy = vi.fn(async () => true);
const modalPromptSpy = vi.fn(async () => 'urgent, review');
const modalShowSpy = vi.hoisted(() => vi.fn<typeof import('@/modal').Modal.show>());
let hideInactiveSessions = false;
let metadataMutationStatus = 200;
let organizationPinnedSessionKeys: unknown = null;
let organizationTagsBySessionKey: unknown = null;
let organizationFolders: unknown = null;
let organizationFolderAssignments: Record<string, string> = {};
let backendEnabledByTargetKey: Settings['backendEnabledByTargetKey'] | null = null;
let resolvedServerId = 'server-1';
let sessionHandoffFeatureEnabled = false;
let sessionFoldersFeatureEnabled = false;
const sessionInfoProjectionHomeIdentity = ServerIdentityCapabilitiesSchema.parse({
    serverIdentityId: 'srv_session_info_projection_fixture',
}).serverIdentityId;
if (!sessionInfoProjectionHomeIdentity) throw new Error('Expected the fixture Home to advertise its identity');
let serverFeaturesSnapshot: any = {
    status: 'ready',
    features: {
        features: {
            sessions: {
                enabled: true,
                handoff: {
                    enabled: true,
                },
            },
            machines: {
                enabled: true,
                transfer: {
                    enabled: true,
                    directPeer: {
                        enabled: true,
                    },
                    serverRouted: {
                        enabled: false,
                    },
                },
            },
        },
        capabilities: {},
    },
};
async function serveSessionInfoPluginSections(sections: readonly Readonly<{
    id: string;
    placementId: string;
    order?: number;
    availability?: import('@happier-dev/protocol/plugins/contributions/public-types').PluginAvailabilityDescriptorV2;
}>[]) {
    const { normalizePluginUiInlineSurfaceBindingV1, PluginUiInlineSurfaceBindingV1Schema } = await import('@happier-dev/protocol/plugins/ui');
    const { DaemonContributionRegistryProjectionDescribeResponseSchema, DaemonPluginUiResourceReadResponseSchema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
    const { PluginDeclarativeDocumentV1Schema, PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1 } = await import('@happier-dev/protocol/plugins/contributions/ui/declarativeDocument');
    const { createStablePluginDeclarativeModel } = await import('@happier-dev/protocol/plugins/contributions/ui/declarativeModel');
    const { encodeBase64 } = await import('@/encryption/base64');
    const { createHash } = await import('node:crypto');
    const pluginId = 'acme.preview';
    const occurrenceId = 'session-info-preview-occurrence';
    await restoreInfoAccountIfNeeded();
    if (!accountConnection) throw new Error('Expected the fixture Home Account to be restored');
    machineCensusByServerId['server-1'] = [createPlainMachineRowFixture({ id: 'machine-1', accountId: 'viewer-account' })];
    await sync.refreshMachines({ serverId: accountConnection.serverId });
    const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
    const { getStorage } = await import('@/sync/domains/state/storageStore');
    const profile = getServerProfileById(accountConnection.serverId);
    const machine = getStorage().getState().machines['machine-1'];
    if (!profile?.serverIdentityId || !machine) throw new Error('Expected the restored Home and its published Machine');
    const sourceCustody = { kind: 'development', registeredRootId: 'session-info-preview-root' } satisfies PluginSourceCustodyV1;
    const executionOrigin = resolvePluginMachineExecutionOrigin({ pluginId, sourceCustody,
        context: { serverIdentityId: profile.serverIdentityId, machineId: machine.id } });
    if (!executionOrigin) throw new Error('Expected the daemon producer to admit this exact Home/Machine source');
    const resource = { pluginId, localId: 'session-overview' };
    const document = PluginDeclarativeDocumentV1Schema.parse({ version: 1, root: { kind: 'text', text: 'Session overview from daemon Resource' } });
    const bytes = new TextEncoder().encode(JSON.stringify(document));
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const projection = PluginProjectionV2Schema.parse({
        v: 2, generation: 1,
        installedPackagesById: { [pluginId]: {
            id: pluginId, displayName: 'Session overview', version: '1.0.0', enabled: true,
            source: { kind: 'path', locator: '/plugins/session-info-preview' }, occurrenceId,
            sourceCustody, executionOrigin,
            declaresContributionPoints: false,
        } },
        resourcesById: { [`${pluginId}/${resource.localId}`]: {
            id: resource.localId, pluginId, occurrenceId, executionOrigin, resourceKind: 'asset', scope: 'global',
            path: 'session-overview.json', digest, contentType: PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
        } },
        familiesById: { pluginUi: { family: 'pluginUi', entriesById: Object.fromEntries(sections.map(section => {
            const rendererId = `session-info-${section.id}`;
            const binding = PluginUiInlineSurfaceBindingV1Schema.parse(normalizePluginUiInlineSurfaceBindingV1({
                pluginId, surfaceId: section.id, rendererId, fallbackRendererIds: [],
                availableRendererIds: [rendererId], role: 'sessionInfoSection', target: { kind: 'session' },
            }));
            const documentSource = { kind: 'resource', resourceId: resource.localId };
            // The daemon supplies an admitted static loading model before the
            // Resource-backed document can be read and atomically adopted.
            const model = createStablePluginDeclarativeModel({
                pluginId, occurrenceId,
                renderer: { id: rendererId, kind: 'declarative',
                    root: { kind: 'state', state: 'loading', title: 'Loading' }, documentSource },
                settings: [], actions: [], destinations: [], uiQueries: [],
                availability: { visible: true, enabledActions: {} },
            });
            const renderer = { kind: 'declarative', contributionId: rendererId, documentSource, model };
            const runtime = { resourceCapability: { readable: true, dynamic: false } };
            const id = `sessionInfoSection:${pluginId}:${section.id}`;
            return [id, {
                id, pluginId, occurrenceId, pluginVersion: '1.0.0', contributionKind: 'sessionInfoSection',
                descriptorId: section.id, order: section.order ?? 10, resource, actions: [], renderer, runtime,
                ...(section.availability ? { availability: section.availability } : {}),
                placement: {
                    id: section.placementId, pluginId, occurrenceId, contributionKind: 'surfacePlacement',
                    descriptorId: section.id, binding, target: binding.target, renderer, runtime,
                    display: {}, availability: { state: 'available', reason: 'available', diagnostics: [] }, headerActions: [],
                },
            }];
        })) } },
    });
    network.respond(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
        DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection }));
    network.respond(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ, DaemonPluginUiResourceReadResponseSchema.parse({
        ok: true, resource, kind: 'asset', contentType: PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
        digest, bytesBase64: encodeBase64(bytes, 'base64'),
    }));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

function stripServerSessionKey(serverId: string, keyRaw: unknown): string | null {
    const key = typeof keyRaw === 'string' ? keyRaw.trim() : '';
    const prefix = `${serverId}:`;
    if (!key.startsWith(prefix)) return null;
    const sessionId = key.slice(prefix.length).trim();
    return sessionId || null;
}

function buildSessionOrganizationSnapshotFromFixtures(serverIdRaw: unknown): SessionOrganizationSnapshot {
    const serverId = typeof serverIdRaw === 'string' && serverIdRaw.trim()
        ? serverIdRaw.trim()
        : 'server-1';
    const pinnedSessionIds = Array.isArray(organizationPinnedSessionKeys)
        ? organizationPinnedSessionKeys
            .map((key) => stripServerSessionKey(serverId, key))
            .filter((sessionId): sessionId is string => sessionId != null)
        : [];
    const tagIdByLabel = new Map<string, string>();
    const tagsById: Record<string, SessionOrganizationTag> = {};
    const tagAssignmentsBySessionId: Record<string, string[]> = {};
    if (isPlainRecord(organizationTagsBySessionKey)) {
        for (const [key, tags] of Object.entries(organizationTagsBySessionKey)) {
            const sessionId = stripServerSessionKey(serverId, key);
            if (!sessionId || !Array.isArray(tags)) continue;
            const tagIds: string[] = [];
            for (const tag of tags) {
                if (typeof tag !== 'string') continue;
                let tagId = tagIdByLabel.get(tag);
                if (!tagId) {
                    tagId = `fixture-tag-${tagIdByLabel.size + 1}`;
                    tagIdByLabel.set(tag, tagId);
                    tagsById[tagId] = {
                        tagId,
                        tagKey: tagId,
                        sortKey: null,
                        display: { t: 'plain', v: { label: tag } },
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 1,
                    };
                }
                tagIds.push(tagId);
            }
            tagAssignmentsBySessionId[sessionId] = tagIds;
        }
    }
    const folders = isPlainRecord(organizationFolders) && Array.isArray(organizationFolders.folders)
        ? organizationFolders.folders
        : [];
    const folderEntries: Array<[string, SessionOrganizationFolder]> = [];
    for (const folder of folders) {
        if (!isPlainRecord(folder)) continue;
        const folderId = typeof folder.id === 'string' ? folder.id.trim() : '';
        if (!folderId) continue;
        const parsedWorkspace = SessionOrganizationContentEnvelopeSchema.safeParse({
            t: 'plain',
            v: folder.workspace,
        });
        const workspace = parsedWorkspace.success && parsedWorkspace.data.t === 'plain'
            ? parsedWorkspace.data.v
            : null;
        folderEntries.push([folderId, {
            folderId,
            folderKey: folderId,
            parentFolderId: typeof folder.parentId === 'string' ? folder.parentId : null,
            parentFolderKey: typeof folder.parentId === 'string' ? folder.parentId : null,
            display: {
                t: 'plain',
                v: {
                    name: typeof folder.name === 'string' ? folder.name : folderId,
                    workspace,
                },
            },
            sortKey: typeof folder.sortKey === 'string' ? folder.sortKey : null,
            createdAt: typeof folder.createdAt === 'number' ? folder.createdAt : 0,
            updatedAt: typeof folder.updatedAt === 'number' ? folder.updatedAt : 0,
            archivedAt: null,
        }]);
    }
    return {
        schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION,
        version: 1,
        pins: pinnedSessionIds.map((sessionId, index) => ({
            sessionId, sortKey: String(index + 1).padStart(4, '0'), pinnedAt: index + 1, listPinned: true, railPinned: false,
        })),
        folders: folderEntries.map(([, folder]) => folder),
        attentionStandings: [],
        folderAssignments: Object.entries(organizationFolderAssignments)
            .map(([sessionId, folderId]) => ({ sessionId, folderId })),
        tags: Object.values(tagsById),
        tagAssignments: Object.entries(tagAssignmentsBySessionId).map(([sessionId, tagIds]) => ({ sessionId, tagIds })),
        orderEntries: [],
        labels: [],
    };
}

const routerMock = createExpoRouterMock({
    router: {
        push: routerPushSpy,
        back: routerBackSpy,
        replace: vi.fn(),
        setParams: vi.fn(),
    },
    params: () => ({
        id: mockSessionId,
        serverId: mockServerId,
    }),
});

installSessionRouteCommonModuleMocks({
    router: async () => routerMock.module,
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            confirmResult: true,
            spies: {
                alert: modalAlertSpy,
                confirm: modalConfirmSpy,
                prompt: modalPromptSpy,
                show: modalShowSpy,
            },
        }).module;
    },
});

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));

const routeHomes = createSessionRouteHomesFixture();
const routeHomeIds = ['server-1', 'server-a', 'server-b', 'server-session-info', 'server-cache-info',
    'server_preferred_info', 'server_reactive_info', 'server-owner', 'server-shared'] as const;
routeHomes.seed(routeHomeIds);
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { AppShellPluginUiProjectionProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { sync } = await import('@/sync/sync');
// Consume the daemon's pure source producer without rooting CLI-private types in UI compilation.
const originProducerPath = '../../../../../../../cli/src/plugins/runtime/resolvePluginMachineExecutionOrigin';
const { resolvePluginMachineExecutionOrigin } = await vi.importActual<{
    resolvePluginMachineExecutionOrigin(input: Readonly<{
        pluginId: string;
        context: Readonly<{ serverIdentityId: string; machineId: string }>;
        sourceCustody: PluginSourceCustodyV1;
    }>): PluginMachineExecutionOriginV1 | null;
}>(originProducerPath);
// Call-through observation: admission, selection, and effects stay with their real owners.
const createDefaultActionExecutorSpy = vi.spyOn(await import('@/sync/ops/actions/defaultActionExecutor'), 'createDefaultActionExecutor');
const executeSessionActionSpy = vi.spyOn(await import('@/components/sessions/actions/sessionActionExecution'), 'executeSessionAction');
const useSessionExecutionRunsSupportedSpy = vi.spyOn(await import('@/hooks/server/useSessionExecutionRunsSupported'), 'useSessionExecutionRunsSupported');
const machineRpcWithServerScopeSpy = vi.spyOn(await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc'), 'machineRpcWithServerScope');
const safeRouterBackSpy = vi.spyOn(await import('@/utils/navigation/safeRouterBack'), 'safeRouterBack');
const resolveServerIdForSessionIdFromLocalCacheSpy = vi.spyOn(await import('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache'), 'resolveServerIdForSessionIdFromLocalCache');
const { Item } = await import('@/components/ui/lists/Item');
const { Avatar } = await import('@/components/ui/avatar/Avatar');
const { CodeView } = await import('@/components/ui/media/CodeView');
const credentials = { token: createAccountTokenForTests('viewer-account', { currentAccount: true }) };
let sessionRecordForHttp: ReturnType<typeof createSessionFixture> | null = null;
let sessionByIdForHttp: ReturnType<typeof createPlainSessionByIdResponseFixture> | null = null;
let machineCensusByServerId: Record<string, ReturnType<typeof createPlainMachineRowFixture>[]> = {};
const httpMutations: Array<Readonly<{ serverUrl: string; method: string; path: string; body: unknown }>> = [];
let archiveStatuses: number[] = [];
let accountConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | undefined;
let portal: ReturnType<typeof installReactDomPortalBoundaryForTests> | undefined;
const pendingRouteReads = new Set<() => void>();
let observeCachedSessionUntilTeardown = false;
const SessionInfoScreen = (await import('@/app/(app)/session/[id]/info')).default;

function requestsFor(path: string) {
    return httpMutations.filter(request => request.path === path);
}

function expectSessionStoppedAt(serverId: string) {
    expect(network.requests.filter(request => request.method === RPC_METHODS.STOP_SESSION)).toEqual([
        expect.objectContaining({ serverUrl: `https://${serverId}.example`, token: credentials.token,
            targetId: 'machine-1', payload: { sessionId: 'session-1' } }),
    ]);
}

function browserHostNode(element: Readonly<{ type: React.ReactElement['type']; props: Record<string, unknown> }>) {
    // Retain actual SDK id/nativeID nodes across ref callbacks, as the browser
    // does. Allocating a fresh node here feeds Radix's setNode lifecycle back.
    const id = typeof element.props.id === 'string' ? element.props.id
        : typeof element.props.nativeID === 'string' ? element.props.nativeID : null;
    const tag = typeof element.type === 'string' && /^[a-z]/.test(element.type) ? element.type
        : element.type === 'TextInput' ? 'textarea' : 'div';
    const node = (id ? document.getElementById(id) : null) ?? document.createElement(tag);
    if (id && !node.id) {
        node.id = id;
        document.body.appendChild(node);
    }
    // Test Renderer has no native layout engine. Supply only its measurement
    // port; actual Popover placement, phone presentation and lifecycle stay real.
    return Object.assign(node, {
        setNativeProps() {},
        getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 100, width: 300, height: 100,
            toJSON: () => ({}) }),
        measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 300, 100),
    });
}

function SessionInfoTestProviders({ children }: React.PropsWithChildren) {
    return <InjectedAuthProvider credentials={sync.getCredentials()}>
        <AppShellPluginUiProjectionProvider>{children}</AppShellPluginUiProjectionProvider>
    </InjectedAuthProvider>;
}

async function restoreInfoAccountIfNeeded() {
    if (accountConnection) return;
    // Case-owned server bits and SDK ports must exist before bootstrap observes
    // them. Do not publish an initially disabled descriptor then reset its cache.
    accountConnection = await restoreServerAccountForTest({ serverUrl: 'https://server-1.example',
        serverIdentityId: sessionInfoProjectionHomeIdentity ?? undefined,
        accountId: 'viewer-account', credentials, request: network.request, activation: 'switch',
        additionalRequestOrigins: routeHomeIds.map(id => `https://${id}.example`) });
}

afterAll(async () => {
    await network.dispose();
    routeHomes.restore();
});

describe('/session/[id]/info', () => {
    beforeEach(async () => {
        observeCachedSessionUntilTeardown = false;
                        browser = await installBrowserRuntimeForTests({ url: 'https://session-info-route.test' });
        portal = installReactDomPortalBoundaryForTests();
        mockSessionId = 'session-1';
        mockServerId = undefined;
        mockSession = null;
        mockProfile = { ...profileDefaults, id: 'viewer-account' };
        isDataReady = true;
        routeHydrationState = { kind: 'available', sessionId: 'session-1' };
        sessionIsConnected = true;
        machinePresenceObserved = true;
        localDevModeEnabled = false;
        routerPushSpy.mockReset();
        routerBackSpy.mockReset();
        machineTargetFixture = null;
        cachedSessionServerId = null;
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();
        modalPromptSpy.mockClear();
        modalPromptSpy.mockResolvedValue('urgent, review');
        modalShowSpy.mockReset();
        modalShowSpy.mockReturnValue('modal-id');
        machineRpcWithServerScopeSpy.mockClear();
        useSessionExecutionRunsSupportedSpy.mockClear();
        hideInactiveSessions = false;
        metadataMutationStatus = 200;
        organizationPinnedSessionKeys = null;
        organizationTagsBySessionKey = null;
        organizationFolders = null;
        organizationFolderAssignments = {};
        backendEnabledByTargetKey = null;
        resolvedServerId = 'server-1';
        sessionHandoffFeatureEnabled = false;
        sessionFoldersFeatureEnabled = false;
        machineListByServerIdState.current = {};
        machinePoolListByServerIdState.current = {};
        serverFeaturesSnapshot = {
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: true,
                            },
                            serverRouted: {
                                enabled: false,
                            },
                        },
                    },
                },
                capabilities: {},
            },
        };
        vi.clearAllMocks();
        resetServerFeaturesClientForTests();
        clearTempData();
        routeHomes.seed(routeHomeIds);
        network.resetRequests();
        sessionRecordForHttp = null;
        sessionByIdForHttp = null;
        machineCensusByServerId = {};
        for (const serverId of routeHomeIds) {
            await network.addHome(`https://${serverId}.example`, 'viewer-account', { credentials });
        }
        httpMutations.length = 0;
        archiveStatuses = [];
        network.respond(RPC_METHODS.STOP_SESSION, { status: 'stopped' });
        network.setHttpResponder(async (input, init) => {
            const url = new URL(String(input));
            const fixtureHomeId = routeHomeIds.find(id => `https://${id}.example` === url.origin) ?? resolvedServerId;
            const method = init?.method ?? 'GET';
            const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
            if (method !== 'GET') httpMutations.push({ serverUrl: url.origin, method, path: url.pathname, body });
            if (url.pathname === '/v1/features') {
                const base = createRootLayoutFeaturesResponse(sessionInfoProjectionHomeIdentity && fixtureHomeId === 'server-1'
                    ? { capabilities: { serverIdentity: { serverIdentityId: sessionInfoProjectionHomeIdentity } } } : {});
                const advertised = serverFeaturesSnapshot.features?.features ?? {};
                const features = {
                    ...base,
                    features: {
                        ...base.features,
                        sessions: { ...base.features.sessions, ...advertised.sessions },
                        machines: { ...base.features.machines, ...advertised.machines },
                    },
                };
                tryWriteServerEnabledBitInPlace(features, 'sessions.handoff', sessionHandoffFeatureEnabled);
                tryWriteServerEnabledBitInPlace(features, 'sessions.folders', sessionFoldersFeatureEnabled);
                tryWriteServerEnabledBitInPlace(features, 'automations', false);
                tryWriteServerEnabledBitInPlace(features, 'machines.pools', true);
                return Response.json(features);
            }
            if (url.pathname === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'viewer-account' });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json(AcpCatalogRowReadResponseV1Schema.parse({
                status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: [] } },
            }));
            if (url.pathname === AUTHORING_MEMORY_ROUTE_V1) return Response.json({ rows: [] });
            if (url.pathname === '/v1/artifacts') return Response.json([]);
            if (url.pathname === '/v1/account/project-rows/list') return Response.json(createPlainProjectAccountRowListFixture());
            if (url.pathname === '/v2/session-organization' && method === 'GET') return Response.json(SessionOrganizationSnapshotResponseSchema.parse({
                snapshot: buildSessionOrganizationSnapshotFromFixtures(fixtureHomeId),
            }));
            if (/^\/v2\/sessions\/[^/]+\/read-state$/.test(url.pathname) && method === 'POST') {
                const state = isPlainRecord(body) && body.state === 'read' ? 'read' : 'unread';
                const lastViewedSessionSeq = state === 'read' ? sessionRecordForHttp?.seq ?? 0 : 0;
                return Response.json({ success: true, state, lastViewedSessionSeq, didChange: true,
                    ...(sessionRecordForHttp ? { viewer: createSessionOwnerViewerFixture({
                        ...sessionRecordForHttp, viewer: undefined, lastViewedSessionSeq,
                        unreadSince: state === 'unread' ? Date.now() : null,
                    }) } : {}),
                });
            }
            if (url.pathname === '/v2/sessions' || url.pathname === '/v2/sessions/active') return answerSessionHttp(Response.json({ sessions: sessionRecordForHttp?.serverId === fixtureHomeId && sessionRecordForHttp.encryptionMode === 'plain'
                    ? [sessionByIdForHttp!.session] : [], next: null, hasNext: false }), init?.signal);
            if (url.pathname === '/v2/sessions/session-1' && method === 'PATCH') {
                if (metadataMutationStatus !== 200) return Response.json({ error: 'Forbidden' }, { status: metadataMutationStatus });
                // Explicit Stop commits its owner tuple first; acknowledge the next versions of the tuple it sent.
                const patch = SessionMetadataTuplePatchV1Schema.parse(body);
                if (patch.mode !== 'owner' && patch.mode !== 'owner_migration') throw new Error('Expected an owner metadata mutation');
                return Response.json(SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
                    sharedMetadata: { version: (patch.mode === 'owner' ? patch.sharedMetadata.expectedVersion : patch.source.metadata.version) + 1 },
                    agentState: { version: (patch.mode === 'owner' ? patch.agentState.expectedVersion : patch.source.agentState.version) + 1 } }));
            }
            if (url.pathname === '/v2/sessions/session-1/archive') {
                const status = archiveStatuses.shift() ?? 200;
                return Response.json(status === 409 ? { error: 'session_active' } : { archivedAt: 1 }, { status });
            }
            if (url.pathname === '/v1/sessions/session-1' && method === 'DELETE') return Response.json({ success: true });
            if (url.pathname === machinePoolActionEndpointPathV1('machines.pools.list')) {
                const homeId = routeHomeIds.find(id => `https://${id}.example` === url.origin) ?? resolvedServerId;
                return Response.json({ pools: machinePoolListByServerIdState.current[homeId] ?? [] });
            }
            if (url.pathname === '/v1/machines') return Response.json(machineCensusByServerId[fixtureHomeId] ?? []);
            if (url.pathname === '/v1/machines/read-batch' && method === 'POST') return createMachineReadBatchResponseFixture(body,
                machineId => machineCensusByServerId[fixtureHomeId]?.find(row => row.id === machineId) ?? null);
            const machineRead = /^\/v1\/machines\/([^/]+)$/.exec(url.pathname);
            if (machineRead) {
                const machine = machineCensusByServerId[fixtureHomeId]?.find(row => row.id === decodeURIComponent(machineRead[1]!));
                return machine ? Response.json({ machine }) : Response.json({ error: 'not_found' }, { status: 404 });
            }
            const sessionRead = /^\/v2\/sessions\/([^/]+)$/.exec(url.pathname);
            if (sessionRead && method === 'GET') {
                if (routeHydrationState.kind === 'loading') {
                    return new Promise<Response>(resolve => {
                        const release = () => { pendingRouteReads.delete(release); resolve(Response.json(
                            V2SessionByIdNotFoundSchema.parse({ error: 'Session not found' }), { status: 404 })); };
                        pendingRouteReads.add(release);
                        init?.signal?.addEventListener('abort', release, { once: true });
                    });
                }
                if (routeHydrationState.kind === 'retrying') return Response.json({ error: 'server_unavailable' }, { status: 503 });
                if (!mockSession || routeHydrationState.kind === 'missing') return Response.json(
                    V2SessionByIdNotFoundSchema.parse({ error: 'Session not found' }), { status: 404 });
                const record = sessionRecordForHttp;
                if (!record || record.id !== decodeURIComponent(sessionRead[1]!) || record.serverId !== fixtureHomeId)
                    return Response.json(V2SessionByIdNotFoundSchema.parse({ error: 'not_found' }), { status: 404 });
                // Locked E2EE cache fixtures have no plaintext HTTP producer to disclose.
                if (record.encryptionMode !== 'plain') return Response.json({ error: 'unavailable' }, { status: 503 });
                return answerSessionHttp(Response.json(sessionByIdForHttp), init?.signal);
            }
            const organization = /^\/v2\/session-organization\/(pins|tag-assignments|folder-assignments)\/([^/]+)$/.exec(url.pathname);
            if (organization && method === 'PUT' && isPlainRecord(body)) {
                const sessionId = decodeURIComponent(organization[2]!);
                if (organization[1] === 'pins') return Response.json({ pin: body.pinned ? {
                    sessionId, sortKey: body.sortKey ?? null, pinnedAt: 1,
                    listPinned: body.surface !== 'rail', railPinned: body.surface === 'rail',
                } : null });
                if (organization[1] === 'folder-assignments') {
                    if (typeof body.folderId === 'string') organizationFolderAssignments[sessionId] = body.folderId;
                    else delete organizationFolderAssignments[sessionId];
                }
                return Response.json({ sessionId, ...(organization[1] === 'tag-assignments'
                    ? { tagIds: body.tagIds } : { folderId: body.folderId }) });
            }
            return null;
        });
        const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        await setActiveServerId('server-1');
        const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        clearDaemonMergedProjectionCacheForTests();
    });

    afterEach(async () => {
        // Retire pending custom-modal choices even when an assertion fails.
        // This settles the handler's async act before the next renderer mounts.
        try {
            await act(async () => {
                for (const [config] of modalShowSpy.mock.calls) config.onRequestClose?.();
            });
        } finally {
            try {
                clearTempData();
                standardCleanup();
                for (const release of pendingRouteReads) release();
                // This suite owns the focused runtime, including cases that
                // deliberately replace its Home or native credential boundary.
                // Retire it before removing its HTTP/DOM ports; a restorer's
                // target-fenced disposal may correctly leave a successor alive.
                const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
                await disconnectActiveServerConnection();
                const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
                await serverScopedRpcSocketPool.stopAll();
                const { stopAllEndpointSupervisorsForTests } = await import('@/sync/runtime/connectivity/endpointSupervisorPool');
                await stopAllEndpointSupervisorsForTests();
                const { stopServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
                await stopServerReachabilitySupervisors();
                await accountConnection?.dispose();
                accountConnection = undefined;
                resetRuntimeFetch();
                resetServerFeaturesClientForTests();
                vi.unstubAllGlobals();
            } finally {
                portal?.restore();
                portal = undefined;
                browser?.restore();
                browser = undefined;
            }
        }
    });

    function answerSessionHttp(response: Response, signal?: AbortSignal | null): Promise<Response> {
        if (!observeCachedSessionUntilTeardown) return Promise.resolve(response);
        // A supported layout0 cache can contain fields a new layout1 writer
        // cannot publish. Keep that cache observable while a valid refresh is
        // in flight, using the same abort-obeying HTTP boundary as other holds.
        return waitForNetworkResponseForTests(new Promise<Response>(resolve => {
            const release = () => { pendingRouteReads.delete(release); resolve(response); };
            pendingRouteReads.add(release);
        }), signal);
    }

    async function applyInfoSessionFixture(publishMachineCensus = false) {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        if (mockSessionId === 'session-1' && typeof mockSession?.id === 'string') mockSessionId = mockSession.id;
        const defaults = createSessionFixture();
        const sessionFixture = mockSession ? createSessionFixture({
            ...mockSession,
            sessionTurns: mockSession.sessionTurns ?? null,
            activeAt: sessionIsConnected ? Date.now() : 0,
            presence: sessionIsConnected ? 'online' : 'offline',
            ...(mockSession.metadata ? { metadata: { ...defaults.metadata, name: 'name', ...mockSession.metadata } } : {}),
        }) : null;
        const serverScopedSession = sessionFixture && mockServerId && !sessionFixture.serverId
            ? { ...sessionFixture, serverId: mockServerId } : sessionFixture;
        const session = serverScopedSession && !serverScopedSession.access
            ? { ...serverScopedSession, access: createSessionAccessFixture(serverScopedSession.accessLevel ?? 'owner') }
            : serverScopedSession;
        mockSession = session;
        const serverId = session?.serverId ?? mockServerId ?? resolvedServerId;
        const machine = createMachineFixture({ id: machineTargetFixture?.machineId ?? session?.metadata?.machineId ?? 'machine-1',
            active: true, activeAt: Date.now(), metadata: { ...createMachineFixture().metadata!,
                host: 'info-machine.test', homeDir: '/home/info', happyCliVersion: '999.0.0' } });
        const plainMachineRow = createPlainMachineRowFixture({ id: machine.id, accountId: 'viewer-account' });
        const plainMachine = { ...machine, storageMode: 'plain' as const, access: plainMachineRow.access,
            dataEncryptionKey: plainMachineRow.dataEncryptionKey };
        const sessionRecord = session ? { ...session, serverId,
            ...(session.metadata && machineTargetFixture ? { metadata: {
                ...session.metadata, host: 'info-machine.test', homeDir: '/home/info', path: machineTargetFixture.basePath,
            } } : {}),
        } : null;
        sessionRecordForHttp = observeCachedSessionUntilTeardown && sessionRecord
            ? createSessionFixture({ id: sessionRecord.id, serverId, active: false }) : sessionRecord;
        // Validate producer input synchronously at setup, not in an HTTP
        // callback where a fixture exception looks like a network outage.
        sessionByIdForHttp = sessionRecordForHttp?.encryptionMode === 'plain'
            ? createPlainSessionByIdResponseFixture(sessionRecordForHttp) : null;
        const machineInventory: Record<string, ReturnType<typeof createMachineFixture>[]> = { [serverId]: [plainMachine], ...Object.fromEntries(
                Object.entries(machineListByServerIdState.current).map(([homeId, machines]) => [homeId, machines.map(candidate => ({
                    ...plainMachine, ...candidate, metadata: { ...plainMachine.metadata, ...candidate.metadata },
                }))]),
            ) };
        machineCensusByServerId = Object.fromEntries(Object.entries(machineInventory).map(([homeId, rows]) => [homeId, rows.map(machine => ({
            ...createPlainMachineRowFixture({ id: machine.id, accountId: 'viewer-account' }),
            seq: machine.seq, createdAt: machine.createdAt, updatedAt: machine.updatedAt,
            active: machine.active, activeAt: machine.activeAt,
            metadata: encodePlainMachineStoredContent(machine.metadata), metadataVersion: machine.metadataVersion,
            daemonState: machine.daemonState ? encodePlainMachineStoredContent(machine.daemonState) : null,
            daemonStateVersion: machine.daemonStateVersion,
        }))]));
        const store = getStorage();
        store.setState({
            sessions: sessionRecord ? { [normalizeSessionId(mockSessionId)]: sessionRecord } : {},
            sessionListRowsByServerId: {},
            sessionListIndexByServerId: {},
            concurrentSessionListCacheByServerId: {},
            sessionLocalStateScope: { serverId, accountId: 'viewer-account' },
            machines: { [plainMachine.id]: plainMachine },
            machineListByServerId: machineInventory,
            machineListStatusByServerId: Object.fromEntries([serverId, ...Object.keys(machineListByServerIdState.current)]
                .map(homeId => [homeId, 'idle'])),
            profile: mockProfile,
            isDataReady,
            settings: { ...settingsDefaults, hideInactiveSessions,
                backendEnabledByTargetKey: backendEnabledByTargetKey ?? settingsDefaults.backendEnabledByTargetKey },
            localSettings: { ...localSettingsDefaults, devModeEnabled: localDevModeEnabled },
        });
        for (const homeId of routeHomeIds) {
            store.getState().clearSessionOrganizationForServer(homeId);
            store.getState().applySessionOrganizationSnapshot(homeId, buildSessionOrganizationSnapshotFromFixtures(homeId));
        }
        if (cachedSessionServerId && sessionRecord) {
            const { createSessionListRenderableSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
            const row = createSessionListRenderableSessionFixture(sessionRecord);
            store.setState({ sessionListRowsByServerId: { [cachedSessionServerId]: { [normalizeSessionId(mockSessionId)]: row } } });
        }
        await getServerFeaturesSnapshot({ serverId: 'server-1', force: true });
        if (serverId !== 'server-1') await getServerFeaturesSnapshot({ serverId, force: true });
        if (publishMachineCensus) {
            // Projection cases require a settled HTTP Machine census. Loading
            // route cases deliberately hold the foreground read this awaits.
            await sync.refreshMachines({ serverId });
        }
    }

    async function renderInfoScreen(options?: Readonly<{ publishMachineCensus?: true; onRender?: React.ProfilerOnRenderCallback }>) {
        await restoreInfoAccountIfNeeded();
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        // Account/Profile and SDK connection readiness are independent of the
        // Session reads intentionally held by loading/retry route fixtures.
        await waitForHomeGovernance(() => {
            expect(getActiveServerAccountScope()?.accountId).toBe('viewer-account');
            expect(getStorage().getState().endpointStatus).toBe('online');
        });
        await applyInfoSessionFixture(options?.publishMachineCensus);
        const content = options?.onRender
            ? <React.Profiler id="session-info" onRender={options.onRender}><SessionInfoScreen /></React.Profiler>
            : <SessionInfoScreen />;
        const screen = await renderScreen(content, { wrapper: SessionInfoTestProviders, createNodeMock: browserHostNode });
        if (!machinePresenceObserved) {
            const serverId = mockSession?.serverId ?? mockServerId ?? resolvedServerId;
            // Settle the active Home's HTTP ingress before withdrawing it; a fresh
            // census is a legitimate new presence observation after withdrawal.
            await sync.refreshMachines();
            const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
            const { withdrawMachinePresenceForScope } = await import('@/sync/domains/machines/reachability/machineReachability');
            await act(async () => withdrawMachinePresenceForScope({
                serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'viewer-account',
            }));
        }
        if (routeHydrationState.kind === 'missing' || (!mockSession && routeHydrationState.kind === 'available')) {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('errors.sessionDeleted'));
        }
        return screen;
    }

    async function waitForHeaderMenuOutcome(assertion: () => void) {
        // DropdownMenu defers opening/selection to the next native frame/task.
        // Finish each act before retrying, so its scheduled React state commits
        // instead of remaining batched behind the assertion's unresolved act.
        await vi.waitFor(async () => {
            await flushHookEffects({ cycles: 1 });
            assertion();
        });
    }

    async function settleSessionAction(actionId: string) {
        // useHappyAction deliberately returns void. Observe the genuine Action's
        // completion, not the button callback's already-settled return value.
        await waitForHeaderMenuOutcome(() => {
            expect(modalAlertSpy).not.toHaveBeenCalled();
            expect(executeSessionActionSpy.mock.calls.some(([input]) => input.actionId === actionId)).toBe(true);
        });
        let index = executeSessionActionSpy.mock.calls.length - 1;
        while (index >= 0 && executeSessionActionSpy.mock.calls[index]?.[0].actionId !== actionId) index -= 1;
        expect(index).toBeGreaterThanOrEqual(0);
        const result = executeSessionActionSpy.mock.results[index];
        if (result?.type !== 'return') throw new Error('The Session Action did not return its completion');
        await act(async () => { await result.value; });
    }

    it('shows loading while the route hydration is still in progress', async () => {
        routeHydrationState = { kind: 'loading', sessionId: 'session-1', reason: 'store-miss' };
        const screen = await renderInfoScreen();
        expect(screen.getTextContent()).toContain('common.loading');
    });

    it('shows loading while route hydration is retrying without rendering terminal unavailable', async () => {
        routeHydrationState = { kind: 'retrying', sessionId: 'session-1', cause: 'server_unavailable' };
        const screen = await renderInfoScreen();
        expect(screen.getTextContent()).toContain('common.loading');
        expect(screen.getTextContent()).not.toContain('errors.sessionDeleted');
    });

    it('renders terminal fallback when route hydration is missing', async () => {
        routeHydrationState = { kind: 'missing', sessionId: 'session-1', cause: 'not_found' };
        const screen = await renderInfoScreen();
        expect(screen.getTextContent()).not.toContain('common.loading');
        expect(screen.getTextContent()).toContain('errors.sessionDeleted');
    });

    it('does not keep the route loading after route hydration is available when global data is not ready', async () => {
        isDataReady = false;
        const screen = await renderInfoScreen();
        expect(screen.getTextContent()).not.toContain('common.loading');
        expect(screen.getTextContent()).toContain('errors.sessionDeleted');
    });

    it('fails open and renders the session when the record exists even if global hydration is still in progress', async () => {
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };
        isDataReady = false;
        routeHydrationState = { kind: 'loading', sessionId: 'session-1', reason: 'store-miss' };
        const screen = await renderInfoScreen();
        expect(screen.getTextContent()).not.toContain('common.loading');
        expect(screen.getTextContent()).toContain('name');
    });

    it('uses the encrypted title and hides private detail/actions for a locked recipient', async () => {
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { encodeBase64 } = await import('@/encryption/base64');
        const { fetchAndApplySessionById } = await import('@/sync/engine/sessions/sessionById');
        const { SessionCurrentProjectionRecordV1Schema } = await import('@happier-dev/protocol/sessions/listing/response');
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const sessionId = 'session-locked-recipient';
        const secret = new Uint8Array(32).fill(7);
        const writer = await Encryption.create(secret);
        writer.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        await writer.initializeSessions(new Map([[sessionId, new Uint8Array(32).fill(8)]]));
        const metadata = await writer.getSessionEncryption(sessionId)!.encryptRaw({
            name: 'private name', host: 'private machine', path: '/private/workspace',
        });
        const reader = await Encryption.create(secret);
        reader.configureNativeCryptoWorker({ routing: { mode: 'off' } });
        const { ownerMetadata: _ownerMetadata, ...base } = createPlainSessionCurrentProjectionRecordFixture({ id: sessionId });
        const access = createSessionAccessFixture('view');
        const row = SessionCurrentProjectionRecordV1Schema.parse({
            ...base, encryptionMode: 'e2ee', dataEncryptionKey: null, metadataLayoutVersion: 0, metadata,
            share: { accessLevel: 'view', canApprovePermissions: false },
            effectiveAccess: { v: 1, level: 'view', capabilities: access.capabilities, sources: [] },
        });
        const store = getStorage();
        const hydrated = await fetchAndApplySessionById({
            sessionId, serverId: 'server-1',
            credentials: { token: credentials.token, secret: encodeBase64(secret) },
            accountCurrentness: {
                mode: 'e2ee', version: 1, updatedAt: 1,
                signingKeyFingerprint: 'signing-current', contentKeyFingerprint: 'content-current',
                recipientEnvelopeReadiness: { status: 'available' },
            },
            encryption: reader, sessionDataKeys: new Map(),
            request: async () => Response.json({ session: row }),
            applySessions: store.getState().applySessions,
            getExistingSession: id => store.getState().sessions[id],
            includeTurnsProjection: false,
            log: { log: () => {} },
        });
        expect(hydrated.ok).toBe(true);
        mockSession = store.getState().sessions[sessionId];
        expect(mockSession).toMatchObject({ metadata: null, ownerMetadataView: null,
            encryptedContentAvailability: 'encrypted_access_pending' });

        const screen = await renderInfoScreen();

        expect(screen.findHostByTestId('session-info-header')).not.toBeNull();
        expect(screen.getTextContent()).toContain('session.access.lockedTitleFallback');
        expect(screen.findByTestId('session-info-menu')).toBeNull();
        expect(screen.getTextContent()).not.toContain('private machine');
        expect(screen.getTextContent()).not.toContain('/private/workspace');
        expect(screen.findByTestId('session-info-new-session-same-setup')).toBeNull();
        expect(screen.findByTestId('session-info-collaboration')).toBeNull();
    });

    it('renders an archived locked owner as unavailable with only eligible Delete instead of Loading', async () => {
        sessionIsConnected = false;
        mockSession = createSessionFixture({
            id: 'session-1',
            serverId: 'server-1',
            active: false,
            archivedAt: 5,
            access: createSessionAccessFixture('owner', { deleteSession: true }),
            encryptionMode: 'e2ee',
            encryptedContentAvailability: 'encrypted_content_unavailable',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: null,
            ownerMetadataView: null,
            agentState: null,
        });

        const screen = await renderInfoScreen();

        expect(screen.getTextContent()).not.toContain('common.loading');
        expect(screen.getTextContent()).toContain('session.access.lockedTitleFallback');
        expect(screen.findByTestId('sessionInfo.deleteSession')).not.toBeNull();
        expect(screen.findByTestId('sessionInfo.archiveSession')).toBeNull();
        expect(screen.findByTestId('session-info-rename')).toBeNull();
    });

    it('keeps Archive reachable for an inactive unarchived locked owner so Delete can become eligible in place', async () => {
        sessionIsConnected = false;
        mockSession = createSessionFixture({
            id: 'session-1',
            serverId: 'server-1',
            active: false,
            archivedAt: null,
            access: createSessionAccessFixture('owner', { archiveSession: true, deleteSession: true }),
            encryptionMode: 'e2ee',
            encryptedContentAvailability: 'encrypted_content_unavailable',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: null,
            ownerMetadataView: null,
            agentState: null,
        });

        const screen = await renderInfoScreen();

        expect(screen.getTextContent()).not.toContain('common.loading');
        expect(screen.findByTestId('sessionInfo.archiveSession')).not.toBeNull();
        expect(screen.findByTestId('sessionInfo.deleteSession')).toBeNull();
        expect(screen.findByTestId('session-info-rename')).toBeNull();
    });

    it('shows the current exact Machine and an independently readable creation pool after handoff', async () => {
        const poolId = '0191f11b-4ab2-7ef2-8dd2-268abc9c191f';
        mockSession = {
            id: 'session-1',
            serverId: 'server-1',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine-before-handoff',
                placementOrigin: { kind: 'machine_pool', poolId },
            },
        };
        machineTargetFixture = {
            machineId: 'machine-after-handoff',
            basePath: '/workspace',
        };
        machineListByServerIdState.current = {
            'server-1': [{
                id: 'machine-after-handoff',
                metadata: { displayName: 'Mac Studio' },
            }],
            'server-2': [{
                id: 'machine-after-handoff',
                metadata: { displayName: 'Wrong Home machine' },
            }],
        };
        machinePoolListByServerIdState.current = {
            'server-1': [{
                pool: { id: poolId, name: 'Development', description: null, revision: 1, createdAt: 1, updatedAt: 1, members: [] },
                availability: { state: 'unknown' },
            }],
        };
        const screen = await renderInfoScreen();

        expect(screen.findAllByType(Item).find(node => node.props.testID === 'session-info-execution-machine')?.props).toMatchObject({
            detail: 'Mac Studio',
        });
        await vi.waitFor(() => expect(screen.findAllByType(Item).find(node => node.props.testID === 'session-info-placement-origin')?.props).toMatchObject({
            detail: 'Development',
        }));
    });

    it('does not disclose a stale or unreadable pool name from Session metadata', async () => {
        mockSession = {
            id: 'session-1',
            serverId: 'server-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine-1',
                placementOrigin: {
                    kind: 'machine_pool',
                    poolId: '0191f11b-4ab2-7ef2-8dd2-268abc9c191f',
                },
            },
        };
        machineTargetFixture = { machineId: 'machine-1', basePath: '/workspace' };
        machinePoolListByServerIdState.current = { 'server-1': [] };

        const screen = await renderInfoScreen();

        expect(screen.findAllByType(Item).find(node => node.props.testID === 'session-info-placement-origin')?.props).toMatchObject({
            subtitle: 'machinePools.aMachinePool',
        });
    });

    it('mounts projected Session-info sections through the shared semantic inline host', async () => {
                mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };
        const placement = { id: 'session-info-placement' };
        await serveSessionInfoPluginSections([{ id: 'overview', placementId: placement.id }]);
        const { PluginInlineSurfaceHost } = await import('@/components/plugins/surfaces');

        const screen = await renderInfoScreen({ publishMachineCensus: true });
        await vi.waitFor(() => expect(screen.findAllByType(PluginInlineSurfaceHost)).toHaveLength(1));
        const mounts = screen.findAllByType(PluginInlineSurfaceHost);
        expect(mounts).toHaveLength(1);
        await vi.waitFor(() => expect(screen.findAllByType(PluginInlineSurfaceHost)[0]?.props).toMatchObject({
            placement,
            inlineMount: { role: 'sessionInfoSection', presentation: 'content' },
            sessionId: 'session-1',
            machineId: 'machine-1',
            serverId: sessionInfoProjectionHomeIdentity,
            projectionInteractionEnabled: true,
        }));
        await vi.waitFor(() => expect(machineRpcWithServerScopeSpy.mock.calls.some(([input]) =>
            input.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ)).toBe(true));
        let resourceReadIndex = machineRpcWithServerScopeSpy.mock.calls.length - 1;
        while (resourceReadIndex >= 0 && machineRpcWithServerScopeSpy.mock.calls[resourceReadIndex]?.[0].method
            !== RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ) resourceReadIndex -= 1;
        const resourceRead = machineRpcWithServerScopeSpy.mock.results[resourceReadIndex];
        if (resourceRead?.type !== 'return') throw new Error('The real daemon Resource read did not return its completion');
        let delivered: unknown;
        await act(async () => { delivered = await resourceRead.value; });
        expect(delivered).toMatchObject({ ok: true, resource: { pluginId: 'acme.preview', localId: 'session-overview' } });
        await flushHookEffects({ cycles: 1 });
        await waitForHeaderMenuOutcome(() => expect(screen.getTextContent()).toContain('Session overview from daemon Resource'));
        expect(network.requests).toContainEqual(expect.objectContaining({
            serverUrl: 'https://server-1.example', targetId: 'machine-1',
            method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ,
            payload: expect.objectContaining({ callerPluginId: 'acme.preview',
                expectedCallerOccurrenceId: 'session-info-preview-occurrence',
                resource: { pluginId: 'acme.preview', localId: 'session-overview' } }),
        }));
    });

    it('projects declared session-info section availability through the canonical policy owner', async () => {
                mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };
        const hiddenPlacement = { id: 'session-info-placement-hidden' };
        const disabledPlacement = { id: 'session-info-placement-disabled' };
        const enabledPlacement = { id: 'session-info-placement-enabled' };
        await serveSessionInfoPluginSections([
            { id: 'hidden', placementId: hiddenPlacement.id, availability: {
                when: { fact: 'host.platform', operator: 'equals', value: 'ios' },
            } },
            { id: 'disabled', placementId: disabledPlacement.id, order: 20, availability: {
                disabledWhen: { fact: 'host.platform', operator: 'equals', value: 'web' },
                disabledReason: 'Disabled on web',
            } },
            { id: 'enabled', placementId: enabledPlacement.id, order: 30, availability: {
                when: { fact: 'session.exists', operator: 'equals', value: true },
            } },
        ]);
        const { PluginInlineSurfaceHost } = await import('@/components/plugins/surfaces');

        const screen = await renderInfoScreen({ publishMachineCensus: true });
        await vi.waitFor(() => expect(screen.findAllByType(PluginInlineSurfaceHost)).toHaveLength(2));
        const mounts = screen.findAllByType(PluginInlineSurfaceHost);
        expect(mounts).toHaveLength(2);
        const byPlacementId = new Map(mounts.map((mount) => [
            String(mount.props.placement.id),
            mount.props,
        ] as const));
        expect(byPlacementId.has('session-info-placement-hidden')).toBe(false);
        expect(byPlacementId.get('session-info-placement-disabled')).toMatchObject({
            inlineMount: { role: 'sessionInfoSection' },
            projectionInteractionEnabled: false,
        });
        expect(byPlacementId.get('session-info-placement-enabled')).toMatchObject({
            inlineMount: { role: 'sessionInfoSection' },
            projectionInteractionEnabled: true,
        });
        const mountedPolicyContext = byPlacementId.get('session-info-placement-enabled')?.policyContext;
        expect(evaluatePluginUiPolicy({
            availability: {
                when: { fact: 'session.exists', operator: 'equals', value: true },
            },
        }, mountedPolicyContext ?? {})).toMatchObject({
            visible: true,
            enabled: true,
        });
    });

    it('uses the mounted plugin runtime platform for Session-info policy facts', async () => {
                mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };
        const { createDesktopSecureStorageBoundary } = await import('@/dev/testkit/mocks/desktopSecureStorage');
        // The real platform resolver observes the desktop shell's native bridge.
        vi.stubGlobal('__TAURI_INTERNALS__', createDesktopSecureStorageBoundary());
        // The desktop SDK owns a different credential port. Restore the actual
        // Account through it before any Machine or Resource request captures it.
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        await accountConnection?.dispose();
        accountConnection = await restoreServerAccountForTest({ serverUrl: 'https://server-1.example',
            serverIdentityId: sessionInfoProjectionHomeIdentity, accountId: 'viewer-account', credentials,
            request: network.request, activation: 'switch',
            additionalRequestOrigins: routeHomeIds.map(id => `https://${id}.example`) });
        await serveSessionInfoPluginSections([{ id: 'desktop', placementId: 'session-info-placement-desktop', availability: {
            when: { fact: 'host.platform', operator: 'equals', value: 'desktop' },
        } }]);
        const { PluginInlineSurfaceHost } = await import('@/components/plugins/surfaces');

        const screen = await renderInfoScreen({ publishMachineCensus: true });
        await vi.waitFor(() => expect(screen.findAllByType(PluginInlineSurfaceHost)).toHaveLength(1));
        const mount = screen.findAllByType(PluginInlineSurfaceHost)[0];
        await vi.waitFor(() => expect(screen.findAllByType(PluginInlineSurfaceHost)[0]?.props).toMatchObject({
            placement: { id: 'session-info-placement-desktop' },
            platform: 'desktop',
            policyContext: { platform: 'desktop' },
        }));
    });

    it('normalizes the route id before looking up the session', async () => {
        mockSessionId = ['session-2 '] as any;
        mockSession = {
            id: 'session-2',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };
        const screen = await renderInfoScreen();
        expect(screen.getTextContent()).toContain('name');
        expect(screen.getTextContent()).not.toContain('errors.sessionDeleted');
    });

    it('threads the route session server id into the default action executor fallback', async () => {
        mockSession = {
            id: 'session-1',
            serverId: 'server-session-info',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        await renderInfoScreen();

        const executorConfig = (createDefaultActionExecutorSpy.mock.calls as Array<[CreateDefaultActionExecutorConfig]>).at(-1)?.[0];
        const resolved = await executorConfig?.resolveServerIdForSessionId?.('child-session');
        expect(resolved).toBe('server-session-info');
        await executorConfig?.openSession?.('child-session');
        expect(routerPushSpy).toHaveBeenCalledWith('/session/child-session?serverId=server-session-info');
        expect(useSessionExecutionRunsSupportedSpy).toHaveBeenCalledWith('session-1', 'server-session-info');
    });

    it('uses daemon merged projection titles when resolving the default session action backend label', async () => {
        mockServerId = 'server-session-info';
        // This title reads the addressed Home's Account catalog, not another
        // Home's focused preferences or a fabricated catalog-hook result.
        await accountConnection?.dispose();
        accountConnection = await restoreServerAccountForTest({ serverUrl: 'https://server-session-info.example',
            accountId: 'viewer-account', credentials, request: network.request, activation: 'switch',
            additionalRequestOrigins: routeHomeIds.map(id => `https://${id}.example`) });
        // V2 projects Agent titles, not the retired backend registry. An installed
        // Agent exercises the daemon title without replacing a bundled Agent's brand.
        const agentIdentity = { pluginId: 'acme.review', localId: 'claude' };
        const agentId = buildQualifiedPluginContributionKey(agentIdentity);
        mockSession = {
            id: 'session-merged-projection',
            serverId: 'server-session-info',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine-projection-1',
                runtimeDescriptorV1: { v: 1, agentId, provider: {} },
                sessionCreationCorrespondenceV1: SessionCreationCorrespondenceV1Schema.parse({
                    v: 1,
                    sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'info-test', creationKey: 'projected-agent' }),
                    recipe: {
                        execution: { machineId: 'machine-projection-1', directory: { kind: 'path', path: '/tmp/session' } },
                        organization: { folderId: null, tagIds: [] },
                        agentTarget: { kind: 'agent', identity: agentIdentity },
                        modelSelection: null,
                        profileId: null,
                        requestedPermissionMode: null,
                        agentModeId: null,
                        configuration: null,
                        connectedServices: null,
                        capabilitySelection: null,
                        transcriptStorage: null,
                        terminal: null,
                        agentSessionStartupInstructionsMarkerV1: null,
                        checkout: null,
                    },
                }),
                host: 'host-a',
                path: '/tmp/session',
                homeDir: '/home/me',
            },
        };

        network.respond(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, {
            protocolVersion: 1,
            projection: PluginProjectionV2Schema.parse({
                v: 2,
                generation: 1,
                agentsById: {
                    [agentId]: {
                        id: agentId,
                        identity: agentIdentity,
                        title: 'Claude (daemon)',
                        channel: 'plugin',
                        isBuiltIn: false,
                        catalogAgentId: 'claude',
                        iconAgentId: 'claude',
                    },
                },
            }),
        });

        const screen = await renderInfoScreen({ publishMachineCensus: true });
        await flushHookEffects({ cycles: 10 });
        expect(network.requests).toContainEqual(expect.objectContaining({
            serverUrl: 'https://server-session-info.example', targetId: 'machine-projection-1',
            method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
        }));

        const aiProviderItems = screen
            .findAllByType(Item)
            .filter((node: any) => node.props?.title === 'sessionInfo.aiProvider');
        expect(aiProviderItems).toHaveLength(1);
        expect(aiProviderItems[0]?.props?.subtitle).toBe('Claude (daemon)');
    });

    it('shows no substituted Agent brand for a session whose Agent is unreadable', async () => {
        // Nothing in this session names its Agent, so the screen has no brand to
        // show. Presenting the product default would tell the user the session
        // belongs to Claude.
        mockSession = {
            id: 'session-unknown-agent',
            serverId: 'server-session-info',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine-projection-1',
                host: 'host-a',
                path: '/tmp/session',
                homeDir: '/home/me',
            },
        };

        const screen = await renderInfoScreen();
        await flushHookEffects({ cycles: 10 });

        const avatars = screen.findAllByType(Avatar);
        expect(avatars.length).toBeGreaterThan(0);
        for (const avatar of avatars) {
            expect(avatar.props.flavor ?? null).toBeNull();
        }

        const aiProviderItems = screen
            .findAllByType(Item)
            .filter((node: any) => node.props?.title === 'sessionInfo.aiProvider');
        expect(aiProviderItems).toHaveLength(1);
        expect(aiProviderItems[0]?.props?.subtitle).not.toBe('agentInput.agent.claude');
    });

    it('defers raw dev JSON rendering until a section is opened', async () => {
        localDevModeEnabled = true;
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                path: '/workspace/repo',
                sessionModelsV1: {
                    v: 1,
                    agentId: 'codex',
                    updatedAt: 1,
                    currentModelId: 'model-0',
                    availableModels: Array.from({ length: 50 }, (_, index) => ({
                        id: `model-${index}`,
                        name: `Model ${index}`,
                        description: 'large metadata payload',
                    })),
                },
            },
            agentState: {
                controlledByUser: false,
                requests: {},
            },
        };

        const screen = await renderInfoScreen();
        expect(screen.findAllByType(CodeView)).toHaveLength(0);

        const metadataRawItem = screen.findAllByType(Item)
            .find((node: any) => node.props?.title === 'sessionInfo.metadata' && typeof node.props?.onPress === 'function');
        expect(metadataRawItem).toBeTruthy();

        await act(async () => {
            metadataRawItem?.props.onPress();
        });

        const codeViews = screen.findAllByType(CodeView);
        expect(codeViews).toHaveLength(1);
        expect(codeViews[0]?.props.language).toBe('json');
        expect(codeViews[0]?.props.code).toContain('"sessionModelsV1"');
    });

    it('redacts sensitive fields from copied and expanded dev JSON', async () => {
        localDevModeEnabled = true;
        observeCachedSessionUntilTeardown = true;
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: 1,
            updatedAt: 1,
            seq: 1,
            dataEncryptionKey: 'raw-session-data-key',
            metadata: {
                path: '/workspace/repo',
                apiKey: 'raw-metadata-api-key',
                nested: {
                    authorization: 'Bearer raw-auth-token',
                    visible: 'safe-visible-value',
                },
            },
            agentState: {
                controlledByUser: false,
                requests: {
                    req_1: {
                        secret: 'raw-agent-secret',
                        visible: 'safe-agent-value',
                    },
                },
            },
        };
        // The actual supported layout0 decoder preserves these untrusted root
        // fields. They are cache input, not a new layout1 owner publication.
        mockSession.metadata = tryParseDecryptedSessionMetadata(mockSession.metadata, 0);
        expect(mockSession.metadata).toMatchObject({ apiKey: expect.any(String), nested: { visible: 'safe-visible-value' } });

        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('session-info-about-more');
        const copyMetadataItem = screen.findAllByType(Item)
            .find((node: any) => node.props?.testID === 'session-info-copy-metadata');
        expect(copyMetadataItem?.props.copy).toContain('safe-visible-value');
        expect(copyMetadataItem?.props.copy).not.toContain('raw-metadata-api-key');
        expect(copyMetadataItem?.props.copy).not.toContain('raw-auth-token');

        const fullSessionRawItem = screen.findAllByType(Item)
            .find((node: any) => node.props?.title === 'sessionInfo.fullSessionObject' && typeof node.props?.onPress === 'function');
        expect(fullSessionRawItem).toBeTruthy();

        await act(async () => {
            fullSessionRawItem?.props.onPress();
        });

        const codeViews = screen.findAllByType(CodeView);
        expect(codeViews).toHaveLength(1);
        const rawCode = String(codeViews[0]?.props.code ?? '');
        expect(rawCode).toContain('safe-visible-value');
        expect(rawCode).toContain('safe-agent-value');
        expect(rawCode).toContain('"apiKey": "[redacted]"');
        expect(rawCode).toContain('"authorization": "[redacted]"');
        expect(rawCode).not.toContain('raw-session-data-key');
        expect(rawCode).not.toContain('raw-metadata-api-key');
        expect(rawCode).not.toContain('raw-auth-token');
        expect(rawCode).not.toContain('raw-agent-secret');
    });

    it('keeps expanded dev session JSON stable across live session refreshes until reopened', async () => {
        localDevModeEnabled = true;
        mockSession = {
            id: 'session-1',
            active: true,
            accessLevel: null,
            createdAt: 1,
            updatedAt: 1,
            seq: 1,
            metadata: {
                path: '/workspace/repo',
                name: 'initial-value',
            },
        };

        const screen = await renderInfoScreen();
        const fullSessionRawItem = screen.findAllByType(Item)
            .find((node: any) => node.props?.title === 'sessionInfo.fullSessionObject' && typeof node.props?.onPress === 'function');
        expect(fullSessionRawItem).toBeTruthy();

        await act(async () => {
            fullSessionRawItem?.props.onPress();
        });
        const initialCode = String(screen.findAllByType(CodeView)[0]?.props.code ?? '');
        expect(initialCode).toContain('initial-value');

        mockSession = {
            ...mockSession,
            updatedAt: 2,
            metadataVersion: mockSession.metadataVersion + 1,
            metadata: {
                ...mockSession.metadata,
                name: 'refreshed-value',
            },
        };
        const Screen = (await import('@/app/(app)/session/[id]/info')).default;
        await act(async () => { await applyInfoSessionFixture(); });
        await screen.update(<Screen />);

        const refreshedCode = String(screen.findAllByType(CodeView)[0]?.props.code ?? '');
        expect(refreshedCode).toBe(initialCode);
        expect(refreshedCode).not.toContain('refreshed-value');

        const reopenedRawItem = screen.findAllByType(Item)
            .find((node: any) => node.props?.title === 'sessionInfo.fullSessionObject' && typeof node.props?.onPress === 'function');
        await act(async () => {
            reopenedRawItem?.props.onPress();
        });
        await act(async () => {
            reopenedRawItem?.props.onPress();
        });

        const reopenedCode = String(screen.findAllByType(CodeView)[0]?.props.code ?? '');
        expect(reopenedCode).toContain('refreshed-value');
    });

    it('shows projected product activity status without raw thinking diagnostics outside dev mode', async () => {
        const previousDevFlag = (globalThis as { __DEV__?: boolean }).__DEV__;
        (globalThis as { __DEV__?: boolean }).__DEV__ = false;
        localDevModeEnabled = false;
        mockSession = {
            id: 'session-projected-status',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
            thinking: true,
            thinkingAt: Date.now(),
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: Date.now(),
        };

        try {
            const screen = await renderInfoScreen();
            const items = screen.findAllByType(Item);

            // One status, in the identity line; the duplicate Activity row is gone.
            expect(screen.findByTestId('session-info-status')?.props.children).toBe('status.ready');
            expect(items.some((node: any) => node.props?.title === 'sessionInfo.sessionStatus')).toBe(false);
            expect(items.some((node: any) => node.props?.title === 'sessionInfo.thinking')).toBe(false);
        } finally {
            (globalThis as { __DEV__?: boolean }).__DEV__ = previousDevFlag;
        }
    });

    it('fails closed and hides the handoff quick action when direct peer truth is runtime-unknown and server-routed fallback would make the UI untruthful', async () => {
        sessionHandoffFeatureEnabled = true;
        machinePresenceObserved = false;
        serverFeaturesSnapshot = {
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: true,
                            },
                            serverRouted: {
                                enabled: true,
                            },
                        },
                    },
                },
                capabilities: {},
            },
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine_source',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };

        const screen = await renderInfoScreen();
        const handoffItems = screen.findAllByType(Item).filter((node: any) => node.props?.title === 'Hand off session');
        expect(handoffItems).toHaveLength(0);
    });

    it('fails closed and hides the handoff quick action when the selected server only exposes direct-peer handoff transport', async () => {
        sessionHandoffFeatureEnabled = true;
        machinePresenceObserved = false;
        serverFeaturesSnapshot = {
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: true,
                            },
                            serverRouted: {
                                enabled: false,
                            },
                        },
                    },
                },
                capabilities: {},
            },
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            serverId: 'server_reactive_info',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine_source',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };

        const screen = await renderInfoScreen();
        const handoffItems = screen.findAllByType(Item).filter((node: any) => node.props?.title === 'Hand off session');
        expect(handoffItems).toHaveLength(0);
    });

    it('updates mounted read-state actions and status after scoped mark-unread and mark-read', async () => {
        // The suite already owns this exact restored Home/Account. A second
        // restoration would compete for its physical connection and cleanup.
        mockServerId = 'server-1';
        mockSession = {
            id: 'session-read-state',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 4,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'completed',
            metadata: {
                machineId: 'machine_source',
                flavor: 'claude',
            },
        };
        let commits = 0;
        const screen = await renderInfoScreen({ onRender: () => { commits += 1; } });
        await flushHookEffects({ frames: 1 });
        const item = screen.findByProps({ testID: 'session-info-mark-unread' });
        expect(item).toBeTruthy();

        await act(async () => {
            await item.props.onPress();
        });
        await settleSessionAction(SESSION_ACTION_MARK_UNREAD_ID);

        expect(httpMutations).toContainEqual(expect.objectContaining({
            serverUrl: 'https://server-1.example', method: 'POST',
            path: '/v2/sessions/session-read-state/read-state', body: { state: 'unread' },
        }));
        // The same mounted Info must consume the read-state owner's publication.
        // Reopening would hide the shell's intentionally stable Session snapshot.
        expect(screen.findAllByProps({ testID: 'session-info-mark-unread' })).toHaveLength(0);
        expect(screen.findByProps({ testID: 'session-info-mark-read' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'session-info-status' }).props.children).toBe('status.unread');

        await act(async () => { screen.findByProps({ testID: 'session-info-mark-read' }).props.onPress(); });
        await settleSessionAction(SESSION_ACTION_MARK_READ_ID);
        expect(screen.findAllByProps({ testID: 'session-info-mark-read' })).toHaveLength(0);
        expect(screen.findByProps({ testID: 'session-info-mark-unread' })).toBeTruthy();
        expect(screen.findByProps({ testID: 'session-info-status' }).props.children).not.toBe('status.unread');

        // An unrelated Session's read frontier must not invalidate this Info tree.
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const store = getStorage();
        const unrelated = createSessionFixture({ id: 'unrelated-read-state', serverId: mockSession.serverId, seq: 4, lastViewedSessionSeq: 4 });
        await act(async () => { store.getState().applySessions([unrelated], 'projection'); });
        await flushHookEffects();
        commits = 0;
        await act(async () => { store.getState().applySessions([{ ...unrelated, lastViewedSessionSeq: 0 }], 'projection'); });
        await flushHookEffects();
        expect(commits).toBe(0);

        const current = store.getState().sessions[mockSession.id]!;
        commits = 0;
        await act(async () => { store.getState().applySessions([{ ...current, seq: current.seq + 1 }], 'projection'); });
        await flushHookEffects();
        expect(commits).toBe(0);
    });

    it('hides manual read-state quick actions for archived sessions', async () => {
        mockSession = {
            id: 'session-read-state-archived',
            active: false,
            accessLevel: null,
            archivedAt: 123,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 4,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'completed',
            metadata: {
                machineId: 'machine_source',
                flavor: 'claude',
            },
        };

        const screen = await renderInfoScreen();

        expect(screen.findAllByProps({ testID: 'session-info-mark-unread' })).toHaveLength(0);
        expect(screen.findAllByProps({ testID: 'session-info-mark-read' })).toHaveLength(0);
    });

    it('hides pin quick action for archived sessions', async () => {
        mockServerId = 'server-b';
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            archivedAt: 123,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 2,
            lastViewedSessionSeq: 2,
            latestTurnStatus: 'completed',
            metadata: {},
        };

        const screen = await renderInfoScreen();

        expect(screen.findAllByProps({ testID: 'session-info-session-pin' })).toHaveLength(0);
        expect(screen.findAllByProps({ testID: 'session-info-session-unpin' })).toHaveLength(0);
    });

    it('surfaces pin and tag actions from the session view quick actions', async () => {
        mockServerId = 'server-b';
        organizationPinnedSessionKeys = [];
        organizationTagsBySessionKey = { 'server-b:session-1': ['existing'] };
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 2,
            lastViewedSessionSeq: 1,
            latestTurnStatus: 'completed',
            archivedAt: null,
            metadata: {},
        };

        const screen = await renderInfoScreen();

        await screen.pressByTestIdAsync('session-info-session-pin');
        await settleSessionAction('ui.session.pin');
        expect(requestsFor('/v2/session-organization/pins/session-1')).toEqual([expect.objectContaining({
            serverUrl: 'https://server-b.example', method: 'PUT',
            body: expect.objectContaining({ pinned: true }),
        })]);

        await screen.pressByTestIdAsync('session-info-session-tags-edit');
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        await screen.pressByTestIdAsync('session-tags-menu-item:fixture-tag-1');
        await waitForHeaderMenuOutcome(() => expect(requestsFor('/v2/session-organization/tag-assignments/session-1')).toEqual([expect.objectContaining({
            serverUrl: 'https://server-b.example', method: 'PUT', body: { tagIds: [] },
        })]));
    });

    it('surfaces the existing info-screen error when organization mutation scope is unavailable', async () => {
        mockServerId = 'server-b';
        organizationPinnedSessionKeys = [];
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 2,
            lastViewedSessionSeq: 1,
            latestTurnStatus: 'completed',
            archivedAt: null,
            metadata: {},
        };
        await TokenStorage.removeCredentialsForServerUrl('https://server-b.example', { serverId: 'server-b' });

        const screen = await renderInfoScreen();

        await screen.pressByTestIdAsync('session-info-session-pin');
        await act(async () => { await vi.waitFor(() => expect(modalAlertSpy).toHaveBeenCalledWith(
            'common.error', 'errors.unknownError', [{ text: 'common.ok', style: 'cancel' }],
        )); });
        expect(requestsFor('/v2/session-organization/pins/session-1')).toEqual([]);
    });

    it.each(['select', 'cancel'] as const)('surfaces move-to-folder from the session view when folder targets match the session workspace (%s)', async (choice) => {
            mockServerId = 'server-1';
            sessionFoldersFeatureEnabled = true;
            await restoreInfoAccountIfNeeded();
            if (!accountConnection) throw new Error('Expected the folder workspace Home to be restored');
            organizationFolders = {
                v: 1,
                folders: [{
                    id: 'folder-1',
                    workspace: {
                        t: 'workspaceScope',
                        serverId: accountConnection.serverId,
                        machineId: 'machine-1',
                        rootPath: '/repo',
                    },
                    parentId: null,
                    name: 'Planning',
                    createdAt: 1,
                    updatedAt: 1,
                }],
            };
            organizationFolderAssignments = { 'session-1': 'folder-existing' };
            mockSession = {
                id: 'session-1',
                active: false,
                accessLevel: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                seq: 2,
                lastViewedSessionSeq: 1,
                latestTurnStatus: 'completed',
                archivedAt: null,
                metadata: {
                    machineId: 'machine-1',
                    path: '/repo',
                },
            };
            modalShowSpy.mockImplementation((config) => {
                const props = config.props as Readonly<{
                    sourceLabel: string;
                    targets: readonly import('@/sync/domains/session/folders').SessionFolderMoveTarget[];
                    onSelect: (target: import('@/sync/domains/session/folders').SessionFolderMoveTarget) => void;
                }>;
                expect(props.sourceLabel).toBe('name');
                const target = props.targets.find((candidate) => candidate.folderId === 'folder-1');
                expect(target).toMatchObject({ id: 'session-info-move-folder:folder-1', title: 'Planning', disabled: false });
                if (!target) throw new Error('Matching folder target is missing');
                queueMicrotask(() => {
                    if (choice === 'select') props.onSelect(target);
                    else config.onRequestClose?.();
                });
                return 'modal-id';
            });

            const { getStorage } = await import('@/sync/domains/state/storageStore');
            const { buildSessionOrganizationServerKey } = await import('@/sync/domains/session/organization');
            const { createSessionRouteServerScope } = await import('@/hooks/session/sessionRouteServerScope');
            const screen = await renderInfoScreen();
            try {
                const addressedHomeId = createSessionRouteServerScope({ id: 'session-1', serverId: mockServerId }).serverId;
                expect(addressedHomeId).toBe(accountConnection.serverId);
                if (!addressedHomeId) throw new Error('Expected the folder selection to address its restored Home');
                await waitForHeaderMenuOutcome(() => {
                    const state = getStorage().getState();
                    const session = state.sessions['session-1'];
                    const folder = state.sessionOrganizationFoldersByFolderKey[
                        buildSessionOrganizationServerKey(addressedHomeId, 'folder-1')
                    ];
                    expect(folder?.display).toMatchObject({ t: 'plain', v: { workspace: {
                        t: 'workspaceScope', serverId: addressedHomeId,
                        machineId: session ? readSessionOwnerMetadataView(session)?.machineId : undefined, rootPath: session?.metadata?.path,
                    } } });
                });
                expect(network.httpRequests).toContainEqual(expect.objectContaining({
                    url: 'https://server-1.example/v1/features',
                }));
                await screen.pressByTestIdAsync('session-info-session-move-to-folder');
                await waitForHeaderMenuOutcome(() => {
                    expect(modalShowSpy).toHaveBeenCalledOnce();
                    expect(modalAlertSpy).not.toHaveBeenCalled();
                });
                if (choice === 'select') await settleSessionAction(SESSION_ACTION_MOVE_TO_FOLDER_ID);

                await vi.waitFor(() => {
                    const assignment = getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey[
                        sessionAddressKey({ serverId: addressedHomeId, sessionId: 'session-1' })
                    ];
                    if (choice === 'select') {
                        expect(requestsFor('/v2/session-organization/folder-assignments/session-1')).toEqual([
                            expect.objectContaining({ serverUrl: 'https://server-1.example', method: 'PUT', body: { folderId: 'folder-1' } }),
                        ]);
                        expect(assignment).toEqual({ sessionId: 'session-1', folderId: 'folder-1' });
                        expect(network.credentialRequests).toContainEqual({ serverUrl: 'https://server-1.example', serverId: 'server-1' });
                    } else {
                        expect(requestsFor('/v2/session-organization/folder-assignments/session-1')).toEqual([]);
                        expect(assignment).toEqual({ sessionId: 'session-1', folderId: 'folder-existing' });
                    }
                    expect(getStorage().getState().sessionOrganizationOptimisticRecords).toEqual({});
                });
            } finally {
                await screen.unmount();
            }
    });

    it('shows the handoff quick action when server-routed transfer is the only transport the selected server advertises', async () => {
        sessionHandoffFeatureEnabled = true;
        serverFeaturesSnapshot = {
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: false,
                            },
                            serverRouted: {
                                enabled: true,
                            },
                        },
                    },
                },
                capabilities: {},
            },
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine_source',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };

        const screen = await renderInfoScreen();
        const handoffItems = screen.findAllByType(Item).filter((node: any) => node.props?.title === 'Hand off session');
        expect(handoffItems).toHaveLength(1);
    });

    it('reacts when machine-rpc direct-peer viability becomes available for the reachable machine target after metadata goes stale', async () => {
        sessionHandoffFeatureEnabled = true;
        machinePresenceObserved = false;
        resolvedServerId = 'server_reactive_info';
        machineTargetFixture = {
            machineId: 'machine_rebound',
            basePath: '/workspace/repo',
        };
        serverFeaturesSnapshot = {
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: true,
                            },
                            serverRouted: {
                                enabled: false,
                            },
                        },
                    },
                },
                capabilities: {},
            },
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine_source',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };

        const screen = await renderInfoScreen();
        let handoffItems = screen.findAllByType(Item).filter((node: any) => node.props?.title === 'Hand off session');
        expect(handoffItems).toHaveLength(0);

        const { recordCachedMachineRpcDirectRouteViable } = await import('@/sync/domains/transfers/runtime/transferRouteCache');
        await act(async () => {
            recordCachedMachineRpcDirectRouteViable({
                serverId: 'server_reactive_info',
                remoteMachineId: 'machine_rebound',
            });
        });
        await flushHookEffects({ cycles: 10 });

        handoffItems = screen.findAllByType(Item).filter((node: any) => node.props?.title === 'Hand off session');
        expect(handoffItems).toHaveLength(1);
    });

    it('falls back to the canonical target server when the local server cache misses and still surfaces handoff after a scoped reachability probe succeeds', async () => {
        sessionHandoffFeatureEnabled = true;
        resolvedServerId = 'server_preferred_info';
        network.respond(RPC_METHODS.CAPABILITIES_DESCRIBE, {});
        serverFeaturesSnapshot = {
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: true,
                            },
                            serverRouted: {
                                enabled: false,
                            },
                        },
                    },
                },
                capabilities: {},
            },
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine_source',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };

        const screen = await renderInfoScreen();
        await flushHookEffects({ cycles: 10 });

        const handoffItems = screen.findAllByType(Item).filter((node: any) => node.props?.title === 'Hand off session');
        expect(handoffItems).toHaveLength(1);
    });

    it('shows the configured ACP backend title in AI provider metadata when a concrete backend target is stored on the session', async () => {
        observeCachedSessionUntilTeardown = true;
        const { buildAcpConfiguredBackendV1 } = await import('@happier-dev/protocol/sessions/metadata/acpConfiguredBackendV1');
        const { resolveBackendTargetKeyV2 } = await import('@/agents/backendCatalog/backendTargetKeyV2');
        backendEnabledByTargetKey = {
            [resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'qa-acp-stub', configuredBackendId: 'qa-acp-stub' })]: false,
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                flavor: 'custom-acp',
                agent: 'custom-acp',
                acpConfiguredBackendV1: buildAcpConfiguredBackendV1({
                    updatedAt: 1,
                    backendId: 'qa-acp-stub',
                    title: 'QA ACP Stub Backend',
                }),
            },
        };
        // The configured-ACP compatibility reader still inspects the legacy
        // `agent` spelling without turning it into a current Agent identity.
        mockSession.metadata = tryParseDecryptedSessionMetadata(mockSession.metadata, 0);
        expect(mockSession.metadata).toMatchObject({ acpConfiguredBackendV1: { backendId: 'qa-acp-stub' } });

        const screen = await renderInfoScreen();
        const providerItem = screen.findAllByType(Item).find(node => node.props.title === 'sessionInfo.aiProvider');
        expect(providerItem?.props.subtitle).toBe('QA ACP Stub Backend');
    });

    it('shows the provider resume surfaces from the current runtime and native resume identities', async () => {
        const { RuntimeDescriptorV1Schema, writeRuntimeDescriptorV1ForPersistence } = await import(
            '@happier-dev/protocol/sessions/metadata/runtimeDescriptorV1'
        );
        const { AgentNativeResumeIdentityV1Schema } = await import('@happier-dev/protocol/agents/nativeResumeIdentityV1');
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                flavor: 'opencode',
                runtimeDescriptorV1: writeRuntimeDescriptorV1ForPersistence(RuntimeDescriptorV1Schema.parse({
                    v: 1,
                    agentId: 'opencode',
                    agent: { backendMode: 'server' },
                })),
                nativeResumeIdentityV1: AgentNativeResumeIdentityV1Schema.parse({
                    v: 1, vendorResumeId: 'runtime-session-1234567890',
                }),
            },
        };

        const screen = await renderInfoScreen();
        // The resume command leads About for an inactive Session; the vendor id is one disclosure away.
        const resumeCommand = screen.findAllByType(Item).find(node => node.props.testID === 'session-info-resume-command');
        expect(resumeCommand).toBeTruthy();
        expect(resumeCommand?.props.copy).toEqual(expect.any(String));
        expect(resumeCommand?.props.copy).not.toBe('');
        expect(resumeCommand?.props.copy).toBe(resumeCommand?.props.detail);
        await screen.pressByTestIdAsync('session-info-about-more');
        const resumeIdentity = screen.findAllByType(Item).find(node => node.props.title === 'sessionInfo.opencodeSessionId');
        expect(resumeIdentity?.props.copy).toBe('runtime-session-1234567890');
    });

    it('infers the provider from the current runtime descriptor when flavor is missing', async () => {
        const { RuntimeDescriptorV1Schema, writeRuntimeDescriptorV1ForPersistence } = await import(
            '@happier-dev/protocol/sessions/metadata/runtimeDescriptorV1'
        );
        const { AgentNativeResumeIdentityV1Schema } = await import('@happier-dev/protocol/agents/nativeResumeIdentityV1');
        const { Avatar } = await import('@/components/ui/avatar/Avatar');
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                runtimeDescriptorV1: writeRuntimeDescriptorV1ForPersistence(RuntimeDescriptorV1Schema.parse({
                    v: 1,
                    agentId: 'opencode',
                    agent: { backendMode: 'server' },
                })),
                nativeResumeIdentityV1: AgentNativeResumeIdentityV1Schema.parse({
                    v: 1, vendorResumeId: 'runtime-session-1234567890',
                }),
            },
        };

        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('session-info-about-more');
        const resumeIdentity = screen.findAllByType(Item).find(node => node.props.title === 'sessionInfo.opencodeSessionId');
        expect(resumeIdentity?.props.copy).toBe('runtime-session-1234567890');
        const avatar = screen.findByType(Avatar);
        expect(avatar.props.flavor).toBe('opencode');
    });

    it('routes View Machine to the reachable machine target when session metadata is stale after handoff', async () => {
        machineTargetFixture = {
            machineId: 'machine-target',
            basePath: '/workspace/repo',
        };
        mockSession = {
            id: 'session-1',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine-source',
                path: '/workspace/repo',
                flavor: 'claude',
            },
        };

        const screen = await renderInfoScreen();
        // About's Run on is the way to the Machine (no separate View machine row).
        const runOnItem = screen.findAllByType(Item).find(node => node.props.testID === 'session-info-execution-machine');
        expect(runOnItem).toBeTruthy();
        expect(screen.findAllByType(Item).filter(node => node.props.title === 'sessionInfo.viewMachine')).toHaveLength(0);
        expect(screen.findAllByType(Item).find(node => node.props.testID === 'session-info-folder')).toBeTruthy();

        pressTestInstance(runOnItem);

        expect(routerPushSpy).toHaveBeenCalledWith(`/machines/machine-target?serverId=${sessionInfoProjectionHomeIdentity}`);
    });

    it('opens a new session seeded from the current session configuration', async () => {
        observeCachedSessionUntilTeardown = true;
        machineTargetFixture = {
            machineId: 'machine-target',
            basePath: '/workspace/repo',
        };
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            encryptionMode: 'plain',
            metadata: {
                machineId: 'machine-source',
                path: '/workspace/source',
                homeDir: '/workspace',
                host: 'source.local',
                flavor: 'codex',
                backendTarget: { kind: 'backend', backendId: 'codex' },
                profileId: 'profile-1',
                transcriptStorage: 'direct',
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'codex',
                    agent: { backendMode: 'appServer' },
                },
                placementOrigin: {
                    kind: 'machine_pool',
                    poolId: '0191f11b-4ab2-7ef2-8dd2-268abc9c191f',
                },
                sessionModeOverrideV1: {
                    v: 1,
                    updatedAt: 100,
                    modeId: 'plan',
                },
            },
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 101,
            modelMode: 'gpt-5',
            modelModeUpdatedAt: 102,
        };
        // This consumer still reads the supported layout0 transcript-storage
        // carrier; do not reinterpret it as a new layout1 owner publication.
        mockSession.metadata = tryParseDecryptedSessionMetadata(mockSession.metadata, 0);
        expect(mockSession.metadata).toMatchObject({ transcriptStorage: 'direct',
            backendTarget: { kind: 'backend', backendId: 'codex' } });

        const screen = await renderInfoScreen();
        screen.pressByTestId('session-info-new-session-same-setup');
        await vi.waitFor(() => expect(routerPushSpy).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/new' })));
        const pushArg = routerPushSpy.mock.calls.find(([href]) => href.pathname === '/new')?.[0] as {
            pathname: string; params: { draftId: string; draftServerId: string; draftAccountId: string };
        };
        expect(pushArg).toEqual({
            pathname: '/new',
            params: {
                draftId: expect.any(String),
                draftServerId: expect.any(String),
                draftAccountId: 'viewer-account',
            },
        });
        const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const draft = readNewSessionDraftFromRepository({ scope: {
            serverId: pushArg.params.draftServerId, accountId: pushArg.params.draftAccountId,
        }, draftId: pushArg.params.draftId });
        expect(draft).toEqual(expect.objectContaining({
            input: '',
            selectedMachineId: 'machine-target',
            selectedPath: '/workspace/repo',
            selectedProfileId: 'profile-1',
            transcriptStorage: 'direct',
            permissionMode: 'safe-yolo',
            modelSelection: {
                v: 1,
                ref: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    modelId: 'gpt-5',
                    providerConnectionId: null,
                },
                updatedAt: 102,
            },
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'appServer' },
            },
            acpSessionModeId: 'plan',
        }));
        expect(draft?.organizationPlacement).toEqual({ folderId: null, tagIds: [] });
        expect(draft).not.toHaveProperty('resumeSessionId');
    });

    it('offers Session log navigation only in developer mode', async () => {
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        const screen = await renderInfoScreen();
        expect(screen.findByTestId('session-info-session-log')).toBeNull();
        expect(screen.findAllByType(Item).find(node => node.props.title === 'sessionInfo.viewSessionLogTitle')).toBeUndefined();
    });

    it('shows the session log path row when a sessionLogPath is present even when developer mode is disabled', async () => {
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                sessionLogPath: '/tmp/.happier/logs/session.log',
            },
        };

        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('session-info-about-more');
        expect(screen.findAllByType(Item).find(node => node.props.testID === 'session-info-session-log-path')).toBeTruthy();
    });

    it('copies developer debug information and omits unknown provider artifact lines', async () => {
        const Clipboard = await import('expo-clipboard');
        localDevModeEnabled = true;
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                host: 'host',
                path: '/workspace/repo',
                homeDir: '/Users/agent',
                sessionLogPath: '/tmp/.happier/logs/session.log',
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'codex',
                    agent: { backendMode: 'appServer' },
                },
                nativeResumeIdentityV1: { v: 1, vendorResumeId: 'codex-session-1' },
            },
        };

        const screen = await renderInfoScreen();
        const copyDebugRow = screen.findAllByType(Item).find(node => node.props.testID === 'session-info-copy-debug-information');
        expect(copyDebugRow?.props.copy).toBe([
            'Happier session ID: session-1',
            'agentInput.agent.codex session ID: codex-session-1',
            'Happier logs: /tmp/.happier/logs/session.log',
        ].join('\n'));
        expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
    });

    it('shows and copies provider session logs when a provider artifact path is known', async () => {
        const Clipboard = await import('expo-clipboard');
        localDevModeEnabled = true;
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                host: 'host',
                path: '/workspace/repo',
                homeDir: '/Users/agent',
                claudeSessionId: 'claude-session-1',
                claudeTranscriptPath: '/tmp/claude/session.jsonl',
            },
        };

        const screen = await renderInfoScreen();
        const providerLogsRow = screen.findAllByType(Item).find(node => node.props.title === 'sessionInfo.providerSessionLogs');
        expect(providerLogsRow?.props.copy).toBe('/tmp/claude/session.jsonl');
        expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
    });

    it('stops without archiving even when inactive sessions are hidden and unpinned', async () => {
        mockServerId = 'server-b';
        hideInactiveSessions = true;
        organizationPinnedSessionKeys = [];
        mockSession = {
            id: 'session-1',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('sessionInfo.stopSession');
        await act(async () => { await vi.waitFor(() => expectSessionStoppedAt('server-b')); });

        // Stop is catalogued as approval:none; it must not prompt to archive.
        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expect(modalAlertSpy).not.toHaveBeenCalled();

        expectSessionStoppedAt('server-b');
        expect(requestsFor('/v2/sessions/session-1/archive')).toEqual([]);
        expect(routerBackSpy).toHaveBeenCalledTimes(2);
        expect(safeRouterBackSpy).toHaveBeenCalledTimes(2);
        expect(safeRouterBackSpy).toHaveBeenNthCalledWith(1, {
            router: expect.any(Object),
            fallbackHref: '/session/session-1?serverId=server-b',
        });
        expect(safeRouterBackSpy).toHaveBeenNthCalledWith(2, {
            router: expect.any(Object),
            fallbackHref: '/',
        });
    });

    it('stops and retries archiving in place when an inactive session is still active server-side', async () => {
        mockServerId = 'server-b';
        archiveStatuses = [409, 200];
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: { path: '/workspace' },
            archivedAt: null,
        };

        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('sessionInfo.archiveSession');
        await act(async () => { await vi.waitFor(() => expect(requestsFor('/v2/sessions/session-1/archive')).toHaveLength(2)); });

        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(requestsFor('/v2/sessions/session-1/archive')).toHaveLength(2);
        expectSessionStoppedAt('server-b');
        expect(safeRouterBackSpy).not.toHaveBeenCalled();
    });

    it('stops with the cached owning server id when route scope and preferred scope are unavailable', async () => {
        mockServerId = undefined;
        hideInactiveSessions = true;
        organizationPinnedSessionKeys = [];
        resolvedServerId = 'server-cache-info';
        cachedSessionServerId = 'server-cache-info';
        mockSession = {
            id: 'session-1',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('sessionInfo.stopSession');
        await act(async () => { await vi.waitFor(() => expectSessionStoppedAt('server-cache-info')); });

        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expectSessionStoppedAt('server-cache-info');
    });

    it('uses the explicit route Home for actions instead of a bare same-id cache', async () => {
        mockServerId = 'server-b';
        hideInactiveSessions = true;
        organizationPinnedSessionKeys = [];
        resolvedServerId = 'server-preferred';
        cachedSessionServerId = 'server-a';
        mockSession = {
            id: 'session-1',
            serverId: 'server-b',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('sessionInfo.stopSession');
        await act(async () => { await vi.waitFor(() => expectSessionStoppedAt('server-b')); });

        expect(modalConfirmSpy).not.toHaveBeenCalled();
        expectSessionStoppedAt('server-b');
        expect(resolveServerIdForSessionIdFromLocalCacheSpy).not.toHaveBeenCalled();
    });

    it('does not render a cached same-id Session from another Home while the explicit route is pending', async () => {
        mockServerId = 'server-b';
        routeHydrationState = {
            kind: 'loading',
            sessionId: 'session-1',
            serverId: 'server-b',
            reason: 'store-miss',
        };
        mockSession = {
            id: 'session-1',
            serverId: 'server-a',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        const screen = await renderInfoScreen();

        expect(screen.getTextContent()).toContain('common.loading');
        expect(screen.findByTestId('sessionInfo.stopSession')).toBeNull();
    });

    it('does not render a cached same-id Session from another Home when the explicit route is missing', async () => {
        mockServerId = 'server-b';
        routeHydrationState = {
            kind: 'missing',
            sessionId: 'session-1',
            serverId: 'server-b',
            cause: 'not_found',
        };
        mockSession = {
            id: 'session-1',
            serverId: 'server-a',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        const screen = await renderInfoScreen();

        expect(screen.getTextContent()).toContain('errors.sessionDeleted');
        expect(screen.findByTestId('sessionInfo.stopSession')).toBeNull();
    });

    it('stops without prompting to archive when the session is pinned', async () => {
        mockServerId = 'server-b';
        hideInactiveSessions = true;
        organizationPinnedSessionKeys = ['server-b:session-1'];
        resolvedServerId = 'server-b';
        mockSession = {
            id: 'session-1',
            serverId: 'server-b',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('sessionInfo.stopSession');
        await act(async () => { await vi.waitFor(() => expectSessionStoppedAt('server-b')); });

        expect(modalConfirmSpy).not.toHaveBeenCalled();

        expectSessionStoppedAt('server-b');
        expect(requestsFor('/v2/sessions/session-1/archive')).toEqual([]);
        expect(routerBackSpy).toHaveBeenCalledTimes(2);
        expect(safeRouterBackSpy).toHaveBeenCalledTimes(2);
        expect(safeRouterBackSpy).toHaveBeenNthCalledWith(1, {
            router: expect.any(Object),
            fallbackHref: '/session/session-1?serverId=server-b',
        });
        expect(safeRouterBackSpy).toHaveBeenNthCalledWith(2, {
            router: expect.any(Object),
            fallbackHref: '/',
        });
    });

    it('archives an inactive session in place so Delete remains reachable', async () => {
        mockServerId = 'server-b';
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: { path: '/workspace' },
            archivedAt: null,
        };

        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('sessionInfo.archiveSession');
        await act(async () => { await vi.waitFor(() => expect(requestsFor('/v2/sessions/session-1/archive')).toHaveLength(1)); });

        expect(modalConfirmSpy).toHaveBeenCalledWith(
            'sessionInfo.archiveSession',
            'sessionInfo.archiveSessionConfirm',
            {
                cancelText: 'common.cancel',
                confirmText: 'sessionInfo.archiveSession',
                destructive: true,
            },
        );
        expect(modalAlertSpy).not.toHaveBeenCalled();

        expect(requestsFor('/v2/sessions/session-1/archive')).toEqual([
            expect.objectContaining({ serverUrl: 'https://server-b.example', method: 'POST' }),
        ]);
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(safeRouterBackSpy).not.toHaveBeenCalled();
    });

    it('deletes a session and exits via the safe back helper', async () => {
        mockServerId = 'server-b';
        sessionIsConnected = false;
        mockSession = createSessionFixture({
            id: 'session-1',
            serverId: 'server-b',
            active: false,
            archivedAt: 5,
            access: createSessionAccessFixture('owner', { deleteSession: true }),
            encryptionMode: 'e2ee',
            encryptedContentAvailability: 'encrypted_content_unavailable',
            metadata: null,
            ownerMetadataView: null,
            agentState: null,
        });

        const screen = await renderInfoScreen();
        screen.pressByTestId('sessionInfo.deleteSession');

        await act(async () => {
            await vi.waitFor(() => expect(requestsFor('/v1/sessions/session-1').filter(request => request.method === 'DELETE')).toHaveLength(1));
        });

        expect(modalConfirmSpy).toHaveBeenCalledWith(
            'sessionInfo.deleteSession',
            'sessionInfo.deleteSessionWarning',
            {
                cancelText: 'common.cancel',
                confirmText: 'sessionInfo.deleteSession',
                destructive: true,
            },
        );
        expect(modalAlertSpy).not.toHaveBeenCalled();

        expect(requestsFor('/v1/sessions/session-1')).toContainEqual(expect.objectContaining({
            serverUrl: 'https://server-b.example', method: 'DELETE',
        }));
        expect(routerBackSpy).toHaveBeenCalledTimes(2);
        expect(safeRouterBackSpy).toHaveBeenCalledTimes(2);
        expect(safeRouterBackSpy).toHaveBeenNthCalledWith(1, {
            router: expect.any(Object),
            fallbackHref: '/session/session-1?serverId=server-b',
        });
        expect(safeRouterBackSpy).toHaveBeenNthCalledWith(2, {
            router: expect.any(Object),
            fallbackHref: '/',
        });
    });

    it('archives an active session by stopping it first and then archiving it', async () => {
        mockServerId = 'server-b';
        mockSession = {
            id: 'session-1',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: { path: '/workspace' },
        };

        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('sessionInfo.archiveSession');
        await act(async () => { await vi.waitFor(() => expect(requestsFor('/v2/sessions/session-1/archive')).toHaveLength(1)); });

        expect(modalConfirmSpy).toHaveBeenCalledTimes(1);

        expectSessionStoppedAt('server-b');
        expect(requestsFor('/v2/sessions/session-1/archive')).toEqual([
            expect.objectContaining({ serverUrl: 'https://server-b.example', method: 'POST' }),
        ]);
        expect(safeRouterBackSpy).not.toHaveBeenCalled();
    });

    it('shows loading on the stop and archive buttons while their mutations are running', async () => {
                const { createDeferred } = await import('@/dev/testkit');
        const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const { RPC_ERROR_CODES } = await import('@happier-dev/protocol/rpc');
        const stopGate = createDeferred<void>();
        const archiveGate = createDeferred<void>();
        let archiveDispatched = false;
        mockSession = {
            id: 'session-1',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
            archivedAt: null,
        };

        const screen = await renderInfoScreen();

        network.setRpcAckResponder(async (request) => {
            if (request.method !== RPC_METHODS.STOP_SESSION) {
                return { ok: false, error: 'RPC method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
            }
            await stopGate.promise;
            return { ok: true, result: { status: 'stopped' } };
        });
        // Preserve the suite's Home responses, holding only the archive request
        // at the external HTTP port until the test releases its acknowledgement.
        setRuntimeFetch(async (input, init) => {
            if (new URL(String(input)).pathname === '/v2/sessions/session-1/archive'
                && init?.method === 'POST') {
                archiveDispatched = true;
                await archiveGate.promise;
            }
            return network.request(input, init);
        });

        const control = (testID: string) => screen.root.findAllByProps({ testID })
            .find(node => 'loading' in (node.props ?? {}));
        try {
            await screen.pressByTestIdAsync('sessionInfo.stopSession');
            await waitForHomeGovernance(() => {
                expect(network.requests.some(request => request.method === RPC_METHODS.STOP_SESSION)).toBe(true);
                expect(control('sessionInfo.stopSession')?.props.loading).toBe(true);
                expect(control('sessionInfo.archiveSession')?.props.loading).toBe(false);
            });
            await act(async () => { stopGate.resolve(); });
            await waitForHomeGovernance(() => expect(control('sessionInfo.stopSession')?.props.loading).not.toBe(true));

            await screen.pressByTestIdAsync('sessionInfo.archiveSession');
            await waitForHomeGovernance(() => {
                expect(archiveDispatched).toBe(true);
                expect(control('sessionInfo.archiveSession')?.props.loading).toBe(true);
                expect(control('sessionInfo.stopSession')?.props.loading).not.toBe(true);
            });
        } finally {
            await act(async () => {
                stopGate.resolve();
                archiveGate.resolve();
            });
            await waitForHomeGovernance(() => {
                expect(control('sessionInfo.stopSession')?.props.loading).not.toBe(true);
                expect(control('sessionInfo.archiveSession')?.props.loading).not.toBe(true);
            });
        }
        expect(requestsFor('/v2/sessions/session-1/archive')).toEqual([
            expect.objectContaining({ serverUrl: 'https://server-1.example', method: 'POST' }),
        ]);
        expect(modalAlertSpy).not.toHaveBeenCalled();
    });

    it('offers rename from the page header menu to a session owner', async () => {
        modalPromptSpy.mockResolvedValueOnce('');
        mockSession = createSessionFixture();

        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('session-info-menu.trigger');
        await waitForHeaderMenuOutcome(() => expect(screen.findByTestId('session-info-rename')).not.toBeNull());
        await screen.pressByTestIdAsync('session-info-rename');

        await waitForHeaderMenuOutcome(() => expect(modalPromptSpy).toHaveBeenCalledWith(
            'sessionInfo.renameSession',
            'sessionInfo.renameSessionSubtitle',
            expect.objectContaining({ confirmText: 'common.save' }),
        ));
    });

    it('reports a refused rename in the existing in-app alert and keeps the current title', async () => {
        metadataMutationStatus = 403;
        modalPromptSpy.mockResolvedValueOnce('QA43 Codex via Team share');
        mockSession = createSessionFixture({ metadata: { path: '/repo', host: 'tester.local', summary: { text: 'Ready', updatedAt: 1 } } });
        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('session-info-menu.trigger');
        await waitForHeaderMenuOutcome(() => expect(screen.findByTestId('session-info-rename')).not.toBeNull());
        await screen.pressByTestIdAsync('session-info-rename');
        await waitForHeaderMenuOutcome(() => expect(modalAlertSpy).toHaveBeenCalledWith(
            'common.error', 'sessionInfo.failedToRenameSession', [{ text: 'common.ok', style: 'cancel' }],
        ));
        expect(screen.getTextContent()).toContain('Ready');
    });

    it('settles a refused gentle Stop in the existing in-app alert without archiving or navigating away', async () => {
        mockSession = createSessionFixture({ active: true });
        network.respond(RPC_METHODS.STOP_SESSION, { status: 'incomplete', reason: 'destroy_failed' });
        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('sessionInfo.stopSession');
        await waitForHomeGovernance(() => expect(modalAlertSpy).toHaveBeenCalledWith(
            'common.error', 'Session stop incomplete: destroy_failed', [{ text: 'common.ok', style: 'cancel' }],
        ));
        expect(requestsFor('/v2/sessions/session-1/archive')).toEqual([]);
        expect(safeRouterBackSpy).not.toHaveBeenCalled();
    });

    it.each([true, false])('offers Delete in Leave (not the header menu) for a retired eligible session with rename rights %s and the existing confirmation', async (canRename) => {
        sessionIsConnected = false;
        modalConfirmSpy.mockResolvedValueOnce(false);
        mockSession = createSessionFixture({
            access: createSessionAccessFixture('owner', { renameSession: canRename }),
            metadataLayoutVersion: 1,
            ownerMetadataView: {
                path: '/repo',
                host: 'tester.local',
                terminal: { controlServiceabilityV1: { v: 1, state: 'unknown', observedAt: 1, retired: true } },
            },
        });

        const screen = await renderInfoScreen();
        if (canRename) {
            await screen.pressByTestIdAsync('session-info-menu.trigger');
            await waitForHeaderMenuOutcome(() => expect(screen.findByTestId('session-info-rename')).not.toBeNull());
            expect(screen.findByTestId('session-info-delete')).toBeNull();
        } else {
            expect(screen.findByTestId('session-info-menu.trigger')).toBeNull();
        }
        await screen.pressByTestIdAsync('sessionInfo.deleteSession');

        await waitForHeaderMenuOutcome(() => expect(modalConfirmSpy).toHaveBeenCalledWith(
            'sessionInfo.deleteSession',
            'sessionInfo.deleteSessionWarning',
            expect.objectContaining({ destructive: true, confirmText: 'sessionInfo.deleteSession' }),
        ));
        expect(requestsFor('/v1/sessions/session-1').filter(request => request.method === 'DELETE')).toEqual([]);
        expect(safeRouterBackSpy).not.toHaveBeenCalled();
    });

    it.each([
        { reason: 'active', active: true, connected: false, retired: true, canDelete: true },
        { reason: 'connected', active: false, connected: true, retired: true, canDelete: true },
        { reason: 'recoverable', active: false, connected: false, retired: false, canDelete: true },
        { reason: 'without deletion rights', active: false, connected: false, retired: true, canDelete: false },
    ])('suppresses Delete for a session that is $reason', async ({ active, connected, retired, canDelete }) => {
        sessionIsConnected = connected;
        mockSession = createSessionFixture({
            active,
            access: createSessionAccessFixture('owner', { deleteSession: canDelete }),
            metadataLayoutVersion: 1,
            ownerMetadataView: {
                path: '/repo',
                host: 'tester.local',
                terminal: { mode: 'plain', controlServiceabilityV1: { v: 1, state: retired ? 'unknown' : 'recoverable_unservable', observedAt: 1, retired } },
            },
        });

        const screen = await renderInfoScreen();
        expect(screen.findByTestId('session-info-delete')).toBeNull();
        expect(screen.findByTestId('sessionInfo.deleteSession')).toBeNull();
    });

    it.each([
        { reason: 'active', active: true, connected: false, retired: true, canDelete: true, stopFirst: true },
        { reason: 'disconnected', active: false, connected: false, retired: true, canDelete: true, stopFirst: false },
        { reason: 'recoverable', active: false, connected: false, retired: false, canDelete: true, stopFirst: true },
        { reason: 'without deletion rights', active: false, connected: false, retired: true, canDelete: false, stopFirst: false },
    ])('uses the owning delete flow for a session that is $reason', async ({ active, connected, retired, canDelete, stopFirst }) => {
        sessionIsConnected = connected;
        modalConfirmSpy.mockResolvedValueOnce(false);
        mockSession = createSessionFixture({
            active,
            access: createSessionAccessFixture('owner', { deleteSession: canDelete }),
            metadataLayoutVersion: 1,
            ownerMetadataView: {
                path: '/repo',
                host: 'tester.local',
                terminal: { mode: 'plain', controlServiceabilityV1: { v: 1, state: retired ? 'unknown' : 'recoverable_unservable', observedAt: 1, retired } },
            },
        });

        const screen = await renderInfoScreen();
        expect(screen.findByTestId('session-info-delete')).toBeNull();
        if (!canDelete) {
            expect(screen.findByTestId('sessionInfo.deleteSession')).toBeNull();
            return;
        }
        expect(screen.findByTestId('sessionInfo.deleteSession')).not.toBeNull();
        await screen.pressByTestIdAsync('sessionInfo.deleteSession');
        await waitForHeaderMenuOutcome(() => expect(modalConfirmSpy).toHaveBeenCalledWith(
            'sessionInfo.deleteSession',
            stopFirst ? 'sessionInfo.stopAndDeleteSessionWarning' : 'sessionInfo.deleteSessionWarning',
            expect.objectContaining({ destructive: true, confirmText: stopFirst ? 'sessionInfo.stopAndDeleteSession' : 'sessionInfo.deleteSession' }),
        ));
        expect(requestsFor('/v1/sessions/session-1').filter(request => request.method === 'DELETE')).toEqual([]);
        expect(network.requests.filter(request => request.method === RPC_METHODS.STOP_SESSION)).toEqual([]);
        expect(safeRouterBackSpy).not.toHaveBeenCalled();
    });

    it.each(['view', 'edit'] as const)('hides rename quick action for %s shared sessions', async (accessLevel) => {
        mockServerId = 'server-b';
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
            archivedAt: null,
        };

        const screen = await renderInfoScreen();
        const renameItems = screen.findAllByType(Item)
            .filter((node: any) => node.props?.title === 'sessionInfo.renameSession');

        expect(renameItems).toHaveLength(0);
        // Rename lives in the page header's ⋯ menu for those who may rename.
        expect(screen.findByTestId('session-info-menu.trigger')).toBeNull();
    });

    it('routes a session owner to remote permission grant management with the current server scope', async () => {
        mockServerId = 'server-owner';
        mockProfile = { ...profileDefaults, id: 'current-account' };
        mockSession = {
            id: 'session-1',
            owner: 'current-account',
            active: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
            archivedAt: null,
        };

        const screen = await renderInfoScreen();

        expect(screen.findByTestId('session-info-remote-permission-grants')).toBeTruthy();
        await act(async () => {
            screen.pressByTestId('session-info-remote-permission-grants');
        });
        expect(routerPushSpy).toHaveBeenCalledWith('/session/session-1/permissions?serverId=server-owner');
    });

    it('does not expose remote permission grant management to a shared admin approver', async () => {
        mockServerId = 'server-shared';
        mockProfile = { ...profileDefaults, id: 'current-account' };
        mockSession = {
            id: 'session-1',
            owner: 'other-account',
            accessLevel: 'admin',
            canApprovePermissions: true,
            active: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
            archivedAt: null,
        };

        const screen = await renderInfoScreen();

        expect(screen.findByTestId('session-info-remote-permission-grants')).toBeNull();
    });
});
