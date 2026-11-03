import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderHook, renderScreen } from '@/dev/testkit';
import { SELECTION_LIST_DEFAULT_DYNAMIC_DEBOUNCE_MS } from '@/components/ui/selectionList/_constants';
import { AccountProfileSchema, ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent, PluginProjectionV2Schema, tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storage';
import { DocumentShareSheet } from './DocumentShareSheet';
import { artifactHtmlBundleFromBodyV1, ARTIFACT_HTML_BUNDLE_MIME_V1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { hashArtifactBinaryContent } from '@/sync/domains/artifacts/artifactBinaryContent';
import { encodeBase64 } from '@/encryption/base64';
import { useDocumentShareController } from './useDocumentShareController';
import { useProjectDashboardDocument } from '@/components/widgets/area/useProjectDashboardDocument';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { ArtifactAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { useDocumentPublicLinkController } from './useDocumentPublicLinkController';
import { buildWidgetDefinitionArtifactHeaderV1, buildWidgetSurfaceArtifactHeaderV1, buildWidgetSurfaceArtifactIdV1, WidgetAreaLayoutV1Schema, WidgetDefinitionV1Schema, type WidgetDefinitionV1, type WidgetInputBindingsV1 } from '@happier-dev/protocol/widgets';
import { widgetInstalledPackage, widgetProjectionEntry } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { NO_TEAM_CAPABILITIES_V1, resolveTeamAdmissionProjectionV1, TeamsPageV1Schema } from '@happier-dev/protocol/teams';
import { resetScopedHomeActionExecutorsForTests } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { t } from '@/text';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createArtifactReadBatchHttpResponse, projectArtifactStoredKind } from '@/dev/testkit/harness/artifactStoreBoundary';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
vi.mock('expo-file-system', async () =>
    (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock().module);
// The virtualized list is a third-party rendering boundary; the testkit owns it.
vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit');
    return { LegendList: createCapturingLegendListMock({ renderItems: true, renderItemLimit: 40 }).module.LegendList };
});
vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({ announceAccessibilityMessage: vi.fn() }));
const modal = vi.hoisted(() => ({ alert: vi.fn(), confirm: vi.fn(async () => true),
    show: vi.fn((_config: unknown) => 'artifact-network-confirmation'), hide: vi.fn() }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: modal }).module;
});

// Load the genuine generic approval presentation after platform boundaries are installed,
// before the sheet harness replaces timers for its debounced controls.
const { useApprovalDecisionHandler } = await import('@/components/tools/shell/approvals/useApprovalDecisionHandler');
await import('@/components/sharing/publicLinkApprovalPreparation');
const { Modal: renderedModalHost } = await import('@/modal');
const showNetworkConfirmation = vi.mocked(renderedModalHost.show);
const confirmAction = vi.mocked(renderedModalHost.confirm);

/**
 * HTTP is the sheet's boundary: the real Action front door, its policy, the Artifact grant Actions,
 * the document-kind adapters and the Home's account context all run. The fake Home keeps one stored
 * document and its grant list and answers the routes the way the server does.
 */
const host = vi.hoisted(() => ({
    serverId: '',
    /** Grant requests the Home received: `GET`, or the mutation with its body. */
    requests: [] as Array<Readonly<{ method: string; body?: Record<string, unknown> }>>,
    access: 'owner' as import('@happier-dev/protocol').ArtifactCallerAccessV1 | null,
    ownerAccountId: 'owner',
    revokeOnRemove: false,
    grants: [] as any[],
    grantStatus: 200,
    document: { header: {} as Record<string, unknown>, body: '' },
    publicShare: null as import('@happier-dev/protocol').StoredContentPublicShareV1 | null,
    publicRequests: [] as Array<Readonly<{ method: string; body?: unknown }>>,
    publicCreateError: null as string | null,
    networkAtPublicCreate: [] as unknown[],
    publicDeleteError: null as string | null,
    documentUpdates: [] as Array<Readonly<Record<string, unknown>>>,
    documentUpdateGate: null as Promise<void> | null,
    documentUpdateError: null as string | null,
    rewidenAfterNetworkUpdate: false,
    approvalUpdateIds: [] as string[],
    artifactRequests: [] as Array<Readonly<{ home: string; method: string; path: string; accountId: string | null }>>,
    approvalArtifacts: new Map<string, import('@/sync/domains/artifacts/artifactTypes').Artifact>(),
    documentVersion: 1,
    binaryHtml: false,
    blobUnavailable: false,
    settings: {} as Record<string, unknown>,
}));

const WORKFLOW_DOCUMENT = {
    header: { kind: 'workflow-definition.v1', definitionId: 'wf-1', revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Workflow' } },
    body: 'definition',
};
const PROFILE_DOCUMENT = {
    header: { kind: 'launch-profile.v1', profileId: 'deploy', name: 'Deploy' },
    body: JSON.stringify({ kind: 'launch-profile.v1', profile: { v: 2, id: 'deploy', name: 'Deploy', createdAt: 1, updatedAt: 1 }, secretBindings: {} }),
};

function dashboardDocument(bindings: WidgetInputBindingsV1 = {}, authored?: WidgetDefinitionV1) {
    const surface = { serverId: host.serverId, accountId: 'owner', owner: { kind: 'project' as const, projectId: 'project' } };
    const definition = authored ?? WidgetDefinitionV1Schema.parse({ v: 1, id: 'metric', name: 'Metric',
        sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
        body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Metric' } } },
        inputs: { fields: [
            { path: 'connection', title: 'Connection', widget: 'json' },
            { path: 'label', title: 'Label', widget: 'text' },
        ] }, inputSchema: { type: 'object' }, provenance: { source: { kind: 'authored' } } });
    const layout = WidgetAreaLayoutV1Schema.parse({ v: 1, surface, name: 'Dashboard', items: [{ kind: 'widget', area: 'main', instance: {
            v: 1, id: 'metric', definition: { kind: 'inline', definition }, bindings,
        } }] });
    return { artifactId: buildWidgetSurfaceArtifactIdV1(surface), document: {
        header: buildWidgetSurfaceArtifactHeaderV1(layout),
        body: JSON.stringify(layout),
    } };
}

let servedHome: Awaited<ReturnType<typeof serveActionHomes>> | null = null;
let widgetHomeActive = false;
function binaryBlobId() { return `00000000-0000-4000-8000-${host.documentVersion.toString(16).padStart(12, '0')}`; }
function storedArtifact(artifactId: string) {
    const bytes = new TextEncoder().encode(host.document.body);
    const body = host.binaryHtml ? { blobId: binaryBlobId(), mime: ARTIFACT_HTML_BUNDLE_MIME_V1,
        sizeBytes: bytes.length, sha256: hashArtifactBinaryContent(bytes) } : host.document.body;
    return { id: artifactId, header: encodePlainArtifactStoredContent(host.document.header),
        body: encodePlainArtifactStoredContent({ body }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: host.documentVersion, bodyVersion: host.documentVersion, seq: 1, createdAt: 1, updatedAt: 1,
        ownerAccountId: host.ownerAccountId, access: host.access, encryptionMode: 'plain',
        publicAudience: host.publicShare ? 'retained' : 'none' };
}
async function serveHome(): Promise<void> {
    const teamPage = TeamsPageV1Schema.parse({
        items: [{ id: 'payments', name: 'Payments squad', description: null, logo: null, archivedAt: null,
            counts: { members: 1, suspendedMembers: 0, groups: 0, waitingInvitations: null },
            recovery: null, viewerRole: 'member', capabilities: { ...NO_TEAM_CAPABILITIES_V1, viewTeam: true },
            admission: resolveTeamAdmissionProjectionV1(), policy: { v: 1, sessionCreationPolicy: 'private_default',
                externalSharingPolicy: 'allowed', defaultSessionHistoryAccess: 'from_membership',
                admissionMode: 'invite_only', authenticationPolicy: null } }], nextCursor: null,
    });
    const served = await serveActionHomes({
        homes: [
            { key: 'home', serverUrl: 'https://document-share-sheet.test', accountId: 'owner', currentAccount: true, settings: host.settings },
            { key: 'focused', serverUrl: 'https://document-share-focused.test', accountId: 'another-owner' },
        ],
        route: async (request) => {
            if (request.path.startsWith('/v1/artifacts')) host.artifactRequests.push({
                home: request.home, method: request.method, path: request.path, accountId: request.accountId,
            });
            // The sheet targets its captured profile scope, not the focused Home's transport.
            if (request.home !== 'home') return undefined;
            if (request.path === '/v1/artifacts/read' && request.method === 'POST') {
                return createArtifactReadBatchHttpResponse(request.body, artifactId => {
                    const approval = host.approvalArtifacts.get(artifactId);
                    if (approval) return { artifactId, ok: true, artifact: approval, recipientCensus: null };
                    const layout = host.document.header.kind === 'widget-area-layout.v1'
                        ? WidgetAreaLayoutV1Schema.safeParse(JSON.parse(host.document.body)) : null;
                    return host.access !== null && layout?.success && buildWidgetSurfaceArtifactIdV1(layout.data.surface) === artifactId
                        ? { artifactId, ok: true, artifact: storedArtifact(artifactId), recipientCensus: null }
                        : { artifactId, ok: false, error: 'artifact_not_found', status: 404, retryable: false };
                });
            }
            if (request.path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (request.path === '/v1/teams/list') return Response.json(teamPage);
            if (request.path === '/v1/teams/groups/list') return Response.json({ items: [], nextCursor: null });
            if (request.path === '/v1/user/search') return Response.json({ users: [], nextCursor: null });
            if (request.path === '/v1/account/entity-rows/connected-accounts/purposes' && request.method === 'GET') {
                return Response.json({ status: 'present', revision: 1,
                    content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } } });
            }
            if (request.path === '/v1/artifacts' && request.method === 'POST') {
                const input = request.body as import('@/sync/domains/artifacts/artifactTypes').ArtifactCreateRequest;
                const header = decodePlainArtifactStoredContent(input.header);
                if (!header || typeof header !== 'object' || !('kind' in header) || header.kind !== 'approval_request.v1') {
                    return Response.json({ error: 'unsupported_artifact_kind' }, { status: 400 });
                }
                const artifact = { ...input, ...projectArtifactStoredKind(input.kind), ownerAccountId: 'owner', access: 'owner' as const, encryptionMode: 'plain' as const,
                    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
                host.approvalArtifacts.set(input.id, artifact);
                return Response.json(artifact);
            }
            if (request.path === '/v1/artifacts' && request.method === 'GET') {
                // The widget catalog enumerates the Home's real inventory, even for inline definitions.
                const layout = WidgetAreaLayoutV1Schema.safeParse(host.document.header.kind === 'widget-area-layout.v1'
                    ? JSON.parse(host.document.body) : null);
                return Response.json(host.access === null || !layout.success ? []
                    : [storedArtifact(buildWidgetSurfaceArtifactIdV1(layout.data.surface))]);
            }
            if (request.path.startsWith('/v1/public-shares')) {
                host.publicRequests.push({ method: request.method, ...(request.body ? { body: request.body } : {}) });
                if (request.path.endsWith('/access-log')) return Response.json({ accessLog: [{ id: 'visit-1',
                    accessedAt: 1780000000000, ipAddress: '192.0.2.1', userAgent: 'Browser' }] });
                if (request.method === 'POST') {
                    if (host.document.header.kind === 'html') {
                        host.networkAtPublicCreate.push(JSON.parse(host.document.body).requestedCapabilities);
                    } else if (host.document.header.kind === 'widget-definition.v1') {
                        host.networkAtPublicCreate.push(JSON.parse(host.document.body).networkOverride);
                    }
                    if (host.publicCreateError) return Response.json({ error: host.publicCreateError }, { status: 503 });
                    const input = request.body as import('@happier-dev/protocol').StoredContentPublicShareCreateRequestV1;
                    host.publicShare = { id: 'share-1', subject: input.subject, expiresAt: input.expiresAt ?? null,
                        maxUses: input.maxUses ?? null, useCount: 0, isConsentRequired: input.isConsentRequired ?? false,
                        networkOff: input.networkOff ?? false, createdAt: 1, updatedAt: 1, keyDerivation: input.keyDerivation };
                    return Response.json({ publicShare: host.publicShare, viewerOrigin: 'https://document-share-sheet.test' });
                }
                if (request.method === 'DELETE') {
                    if (host.publicDeleteError) return Response.json({ error: host.publicDeleteError }, { status: 403 });
                    host.publicShare = null; return Response.json({ success: true });
                }
                return Response.json({ publicShares: host.publicShare ? [host.publicShare] : [] });
            }
            if (request.path.endsWith(`/blobs/${binaryBlobId()}`)) return host.blobUnavailable
                ? Response.json({ error: 'content_unavailable' }, { status: 404 }) : Response.json({
                blobId: binaryBlobId(), content: { t: 'plain', v: encodeBase64(new TextEncoder().encode(host.document.body)) },
            });
            const route = /^\/v1\/artifacts\/([^/]+)(\/access\/grants|\/content\/binary)?$/.exec(request.path);
            if (!route) return undefined;
            const artifactId = decodeURIComponent(route[1]!);
            if (host.approvalArtifacts.has(artifactId) && request.method === 'GET') {
                return Response.json(host.approvalArtifacts.get(artifactId));
            }
            if (host.approvalArtifacts.has(artifactId) && request.method === 'POST') {
                const stored = host.approvalArtifacts.get(artifactId)!;
                const update = request.body as import('@/sync/domains/artifacts/artifactTypes').ArtifactUpdateRequest;
                if (update.expectedHeaderVersion !== undefined && update.expectedHeaderVersion !== stored.headerVersion
                    || update.expectedBodyVersion !== undefined && update.expectedBodyVersion !== stored.bodyVersion) {
                    return Response.json({ error: 'version_conflict' }, { status: 409 });
                }
                const next = { ...stored, ...(update.header === undefined ? {} : { header: update.header }),
                    ...(update.body === undefined ? {} : { body: update.body }),
                    ...(update.provenance === undefined ? {} : { provenance: update.provenance }),
                    ...(update.provenanceDataEncryptionKey === undefined ? {} : { provenanceDataEncryptionKey: update.provenanceDataEncryptionKey }),
                    headerVersion: stored.headerVersion + (update.header === undefined ? 0 : 1),
                    bodyVersion: (stored.bodyVersion ?? 0) + (update.body === undefined ? 0 : 1) };
                host.approvalArtifacts.set(artifactId, next);
                host.approvalUpdateIds.push(artifactId);
                return Response.json({ success: true, headerVersion: next.headerVersion, bodyVersion: next.bodyVersion,
                    ...(update.header === undefined ? {} : { header: update.header }),
                    ...(update.body === undefined ? {} : { body: update.body }) });
            }
            if (route[2] !== '/access/grants') {
                if (host.access === null) return Response.json({ error: 'not_found' }, { status: 404 });
                if (request.method === 'POST') {
                    const update = request.body as import('@/sync/domains/artifacts/artifactTypes').ArtifactUpdateRequest;
                    host.documentUpdates.push(request.body as Record<string, unknown>);
                    if (host.documentUpdateError) return Response.json({ error: host.documentUpdateError }, { status: 403 });
                    if (host.documentUpdateGate) await host.documentUpdateGate;
                    const header = update.header === undefined ? host.document.header : decodePlainArtifactStoredContent(update.header);
                    const envelope = update.body === undefined ? { body: host.document.body } : decodePlainArtifactStoredContent(update.body);
                    if (!header || typeof header !== 'object' || Array.isArray(header)
                        || !envelope || typeof envelope !== 'object' || !('body' in envelope) || typeof envelope.body !== 'string') {
                        return Response.json({ error: 'invalid_content' }, { status: 400 });
                    }
                    // Opened HTTP fixture metadata is checked above; its extensible keys belong to the stored-content boundary.
                    host.document = { header: header as Record<string, unknown>, body: envelope.body };
                    host.binaryHtml = false;
                    host.documentVersion += 1;
                    const committedVersion = host.documentVersion;
                    if (host.rewidenAfterNetworkUpdate) {
                        host.document = { ...host.document, body: JSON.stringify({ ...JSON.parse(host.document.body),
                            requestedCapabilities: { network: 'open' } }) };
                        host.documentVersion += 1;
                    }
                    return Response.json({ success: true, headerVersion: committedVersion, bodyVersion: committedVersion,
                        ...(update.header === undefined ? {} : { header: update.header }),
                        ...(update.body === undefined ? {} : { body: update.body }) });
                }
                return Response.json(storedArtifact(artifactId));
            }
            const input = request.body as any;
            host.requests.push({ method: request.method, ...(input ? { body: input } : {}) });
            if (host.grantStatus !== 200) return Response.json({ error: 'not_found' }, { status: host.grantStatus });
            if (host.access === null) return Response.json({ error: 'not_found' }, { status: 404 });
            const same = (row: any) => JSON.stringify(row.principal) === JSON.stringify(input.principal);
            if (request.method === 'PUT') {
                const display = host.grants.find(same)?.display ?? (input.principal.kind === 'team' ? { name: 'Payments squad' } : { name: 'Someone' });
                host.grants = [...host.grants.filter((row) => !same(row)),
                    { principal: input.principal, accessLevel: input.accessLevel, createdByAccountId: 'owner', createdAt: 1, display }];
            }
            if (request.method === 'DELETE') host.grants = host.grants.filter((row) => !same(row));
            if (request.method === 'DELETE' && host.revokeOnRemove) host.access = null;
            return Response.json({ artifactId, ownerAccountId: host.ownerAccountId, access: host.access, grants: host.access === null ? [] : host.grants,
                ...(request.method === 'GET' ? {} : { changed: true }) });
        },
    });
    host.serverId = served.homes.home!.id;
    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'sharing.public', true)) throw new Error('Unable to enable public sharing');
    if (!tryWriteServerEnabledBitInPlace(features, 'teams', true)) throw new Error('Unable to enable Team directories');
    primeServerFeaturesSnapshot({ serverId: host.serverId, snapshot: { status: 'ready', features } });
    const sheetScope = { serverId: host.serverId, accountId: 'owner' };
    getStorage().setState({ profileScope: sheetScope, settingsScope: sheetScope });
    servedHome = served;
}

const ana = { principal: { kind: 'account', accountId: 'ana' }, accessLevel: 'edit', createdByAccountId: 'owner', createdAt: 1,
    display: { name: 'Ana Silva', username: 'ana' } };
const studio = { principal: { kind: 'team', teamId: 'studio' }, accessLevel: 'view', createdByAccountId: 'owner', createdAt: 2,
    display: { name: 'Studio' } };

function renderedTestIds(screen: Awaited<ReturnType<typeof renderScreen>>, prefix: string): string[] {
    // A pressable renders more than one host node carrying its testID; keep each id once, in render order.
    return [...new Set(screen.findAll((node) => typeof node.props.testID === 'string' && node.props.testID.startsWith(prefix)
        && typeof node.type === 'string').map((node) => node.props.testID as string))];
}

async function settle() {
    await flushHookEffects({ advanceTimersMs: SELECTION_LIST_DEFAULT_DYNAMIC_DEBOUNCE_MS });
    await flushHookEffects();
}

async function activateWidgetHome(inputApproval: 'default' | 'waived' = 'default') {
    vi.useRealTimers();
    if (inputApproval === 'waived') {
        // These mutation cases exercise a person's persisted UI policy waiver, not an executor bypass.
        host.settings.actionsSettingsV1 = { v: 1, actions: {}, approvalWaivedSurfaces: {
            'widgets.item.inputs.reset': ['ui'],
            'widgets.item.inputs.set': ['ui'],
        } };
    }
    if (!servedHome) throw new Error('Expected the served Home fixture');
    servedHome.replaceAccountSettings('home', { settings: host.settings, version: 2 });
    await loadSyncSingletonForTests();
    const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await setActiveServer({ serverId: host.serverId });
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://document-share-sheet.test');
    if (!credentials) throw new Error('Expected the widget Home credential fixture');
    await restoreConnectionToActiveServer(credentials);
    widgetHomeActive = true;
    const scope = { serverId: host.serverId, accountId: 'owner' };
    getStorage().setState({ profile: AccountProfileSchema.parse({ id: 'owner' }), profileScope: scope, settingsScope: scope });
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    getStorage().getState().applySettingsForScope(scope, settingsParse(host.settings), 1);
    vi.useFakeTimers();
}

async function readStoredApproval(artifactId: string) {
    const stored = host.approvalArtifacts.get(artifactId);
    const content = stored?.body ? decodePlainArtifactStoredContent(stored.body) : null;
    if (!content || typeof content !== 'object' || !('body' in content) || typeof content.body !== 'string') {
        throw new Error('Expected the persisted approval request content');
    }
    const { ApprovalRequestV2Schema } = await import('@happier-dev/protocol');
    return ApprovalRequestV2Schema.parse(JSON.parse(content.body));
}

async function createGenericArtifactApproval(updateApproval = false) {
    host.settings.actionsSettingsV1 = { v: 1, actions: {
        ...(updateApproval ? { 'artifact.update': { approvalRequiredSurfaces: ['ui'] } } : {}),
    } };
    await activateWidgetHome();
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { ActionApprovalRequestCreatedResultSchema } = await import('@happier-dev/protocol/actions/actionExecutionResult');
    const result = await createDefaultActionExecutor().execute('artifact.public_link.create', {
        artifactId: 'visual', isConsentRequired: true,
    }, {
        surface: 'agent', serverId: host.serverId, expectedAccountId: 'owner', actionRequestId: 'original-agent-artifact-share',
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error(result.error);
    return ActionApprovalRequestCreatedResultSchema.parse(result.result).artifactId;
}

async function startGenericArtifactDecision(artifactId: string) {
    const approval = await readStoredApproval(artifactId);
    const hook = await renderHook(() => useApprovalDecisionHandler({ id: artifactId, header: null }, approval, '', host.serverId));
    let decision: Promise<boolean> | undefined;
    let failure: unknown;
    let settled: boolean | undefined;
    await act(async () => {
        decision = hook.getCurrent()('approve');
        void decision.then(value => { settled = value; }, error => { failure = error; });
    });
    await waitForHomeGovernance(() => expect(showNetworkConfirmation.mock.calls.length > 0 || failure !== undefined || settled !== undefined).toBe(true));
    if (failure !== undefined) throw failure;
    expect(showNetworkConfirmation.mock.calls.length, JSON.stringify({ approval, settled })).toBeGreaterThan(0);
    const { PublicLinkNetworkConfirmation } = await import('@/components/sharing/PublicLinkNetworkConfirmation');
    type ConfirmationProps = React.ComponentProps<typeof PublicLinkNetworkConfirmation>;
    // The modal host is the external rendering boundary; mount its real component and props.
    const configuration = showNetworkConfirmation.mock.lastCall![0] as {
        component: typeof PublicLinkNetworkConfirmation; props: Omit<ConfirmationProps, 'onClose'>; onRequestClose?: () => void;
    };
    const screen = await renderScreen(React.createElement(configuration.component, { ...configuration.props,
        onClose: () => configuration.onRequestClose?.() }));
    return { hook, screen, decision: decision! };
}

/** Suggestions list once someone starts adding: focus the sheet's search field, then let the list resolve. */
async function startAdding(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const input = screen.find(node => node.props?.testID === 'document-share-search' && typeof node.props.onFocus === 'function');
    await act(async () => { input.props.onFocus(); });
    await settle();
}

describe('DocumentShareSheet', () => {
    beforeEach(async () => {
        host.requests = [];
        host.access = 'owner';
        host.ownerAccountId = 'owner';
        host.revokeOnRemove = false;
        host.grants = [ana, studio];
        host.grantStatus = 200;
        host.document = WORKFLOW_DOCUMENT;
        host.publicShare = null;
        host.publicRequests = [];
        host.publicCreateError = null;
        host.networkAtPublicCreate = [];
        host.publicDeleteError = null;
        modal.alert.mockClear();
        confirmAction.mockClear();
        modal.show.mockClear();
        showNetworkConfirmation.mockClear();
        modal.hide.mockClear();
        host.documentUpdates = [];
        host.documentUpdateGate = null;
        host.documentUpdateError = null;
        host.rewidenAfterNetworkUpdate = false;
        host.approvalUpdateIds = [];
        host.artifactRequests = [];
        host.approvalArtifacts.clear();
        host.documentVersion = 1;
        host.binaryHtml = false;
        host.blobUnavailable = false;
        host.settings = {};
        await serveHome();
        vi.useFakeTimers();
    });
    afterEach(async () => {
        vi.useRealTimers();
        if (widgetHomeActive) {
            const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
            await disconnectActiveServerConnection();
            widgetHomeActive = false;
        }
        await servedHome?.dispose();
        servedHome = null;
        retireActiveServerAccountScopeLifetime();
        invalidateAccountEncryptionModeCache();
        resetServerFeaturesClientForTests();
        resetScopedHomeActionExecutorsForTests();
        vi.restoreAllMocks();
    });

    it.each(['owner', 'admin', 'edit', 'view'] as const)('reads attached dashboard grants through the sharing reader as %s, with no idle or unrelated reads', async access => {
        await activateWidgetHome();
        const dashboard = dashboardDocument();
        host.document = dashboard.document;
        host.access = access;
        const reference = { artifactId: dashboard.artifactId };
        const hook = await renderHook(() => useProjectDashboardDocument(reference, host.serverId, true));
        await settle();
        await vi.waitFor(() => expect(hook.getCurrent().loaded).toBe(true));
        expect(hook.getCurrent().document?.name).toBe('Dashboard');
        expect(hook.getCurrent().grants).toEqual([ana, studio]);
        expect(host.requests).toEqual([{ method: 'GET' }]);

        await act(async () => {
            publishHomeAccountChange(host.serverId, ['another-dashboard'], { changeKinds: ['artifact'] });
            await vi.advanceTimersByTimeAsync(60_000);
        });
        await hook.rerender();
        expect(host.requests).toEqual([{ method: 'GET' }]);

        host.grants = [studio];
        await act(async () => publishHomeAccountChange(host.serverId, [dashboard.artifactId], { changeKinds: ['artifact'] }));
        await settle();
        expect(hook.getCurrent().grants).toEqual([studio]);
        expect(host.requests).toEqual([{ method: 'GET' }, { method: 'GET' }]);

        host.access = null;
        await act(async () => publishHomeAccountChange(host.serverId, [dashboard.artifactId], { changeKinds: ['artifact'] }));
        await settle();
        expect(hook.getCurrent().document).toBeNull();
        expect(hook.getCurrent().grants).toBeNull();
        await hook.unmount();
    });

    it('does not read grants for an unrequested dashboard, and keeps a readable document when roster admission fails', async () => {
        await activateWidgetHome();
        const dashboard = dashboardDocument();
        host.document = dashboard.document;
        host.access = 'view';
        const reference = { artifactId: dashboard.artifactId };
        const hook = await renderHook(({ grants }) => useProjectDashboardDocument(reference, host.serverId, grants),
            { initialProps: { grants: false } });
        await settle();
        await vi.waitFor(() => expect(hook.getCurrent().loaded).toBe(true));
        expect(hook.getCurrent().document?.name).toBe('Dashboard');
        expect(host.requests).toEqual([]);
        host.grantStatus = 403;
        await hook.rerender({ grants: true });
        await settle();
        expect(hook.getCurrent().document?.name).toBe('Dashboard');
        expect(hook.getCurrent().grants).toBeNull();
        expect(host.requests).toEqual([{ method: 'GET' }]);
        await hook.unmount();
    });

    it('exposes the same admitted dashboard roster to an Agent through the existing grants Action', async () => {
        await activateWidgetHome();
        const dashboard = dashboardDocument();
        host.document = dashboard.document;
        const result = await createFrontDoorActionExecute()('artifact.access.grants.list', { artifactId: dashboard.artifactId },
            { surface: 'mcp', serverId: host.serverId, expectedAccountId: 'owner' });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.errorCode);
        expect(ArtifactAccessGrantsListResponseV1Schema.parse(result.result).grants).toEqual([ana, studio]);
        expect(host.requests).toEqual([{ method: 'GET' }]);
    });

    it('keeps people sharing available for a widget layout without offering or loading public links', async () => {
        const dashboard = dashboardDocument();
        host.document = dashboard.document;
        const screen = await renderScreen(<DocumentShareSheet artifactId={dashboard.artifactId} kind="widget-area-layout.v1"
            linkPath={`/artifacts/${dashboard.artifactId}`} />);
        await settle();
        expect(screen.findByTestId('document-share-grant-account:ana')).not.toBeNull();
        expect(renderedTestIds(screen, 'document-share-public-link')).toEqual([]);
        expect(host.publicRequests).toEqual([]);
        expect(screen.findByTestId('document-share-copy-link')).toBeNull();
        await screen.pressByTestIdAsync('document-share-grant-team:studio');
        await screen.pressByTestIdAsync('document-share-remove:team:studio');
        await settle();
        expect(host.grants).toEqual([ana, studio]);
        expect(host.requests.filter(request => request.method !== 'GET')).toEqual([]);
        expect(screen.findByTestId('document-share-remove-confirm:team:studio')).not.toBeNull();
        await screen.pressByTestIdAsync('document-share-remove-cancel:team:studio');
        expect(screen.findByTestId('document-share-remove-confirm:team:studio')).toBeNull();
        expect(host.grants).toEqual([ana, studio]);
        await screen.pressByTestIdAsync('document-share-remove:team:studio');
        await screen.pressByTestIdAsync('document-share-remove-confirm:team:studio');
        await settle();
        expect(host.grants).toEqual([ana]);
        expect(host.documentUpdates).toEqual([]);
    });

    it('retains the dashboard roster and failed grant draft when a nested private choice refuses sharing', async () => {
        const dashboard = dashboardDocument({ connection: { kind: 'value', value: {
            nested: [{ service: { pluginId: 'com.acme.cloud', localId: 'cloud' }, accountId: 'private-choice' }],
        } } });
        host.document = dashboard.document;
        const hook = await renderHook(() => useDocumentShareController({ artifactId: dashboard.artifactId,
            kind: 'widget-area-layout.v1', scope: { serverId: host.serverId, accountId: 'owner' } }));
        await settle();
        expect({ loading: hook.getCurrent().loading, issue: hook.getCurrent().issue }).toEqual({
            loading: false, issue: undefined,
        });
        expect(hook.getCurrent().privateChoices).toHaveLength(1);
        expect(hook.getCurrent().privateChoices[0]?.letViewersPick).toBeUndefined();
        await React.act(async () => { hook.getCurrent().actions.setAccessLevel({ kind: 'account', accountId: 'ana' }, 'view'); });
        await settle();
        expect(hook.getCurrent().model.grants.find(row => row.principal.key === 'account:ana')).toMatchObject({
            level: { value: 'edit' }, operation: { kind: 'error' },
        });
        expect(host.requests.every(request => request.method === 'GET')).toBe(true);
        expect(host.grants).toEqual([ana, studio]);
        await hook.unmount();
    });

    it('reviews grouped children and additive private group fields before sharing', async () => {
        const dashboard = dashboardDocument({ connection: { kind: 'value', value: {
            service: { pluginId: 'com.acme.cloud', localId: 'cloud' }, accountId: 'child-private',
        } } });
        const layout = WidgetAreaLayoutV1Schema.parse(JSON.parse(dashboard.document.body));
        host.document = { ...dashboard.document, body: JSON.stringify({ ...layout, items: [{
            kind: 'group', id: 'metrics', title: 'Metrics', width: 'full', children: layout.items,
            additive: { service: { pluginId: 'com.acme.cloud', localId: 'cloud' }, accountId: 'group-private' },
        }] }) };
        const hook = await renderHook(() => useDocumentShareController({ artifactId: dashboard.artifactId,
            kind: 'widget-area-layout.v1', scope: { serverId: host.serverId, accountId: 'owner' } }));
        await settle();
        expect(hook.getCurrent().privateChoices).toHaveLength(2);
        expect(hook.getCurrent().privateChoices.map(choice => choice.widget).sort()).toEqual(['Metric', 'Metrics']);
        expect(hook.getCurrent().privateChoices.filter(choice => choice.removeChoice)).toHaveLength(1);
        expect(host.documentUpdates).toEqual([]);
        await hook.unmount();
    });

    it('removes only the reviewed private choice through widget input admission before sharing', async () => {
        await activateWidgetHome('waived');
        const dashboard = dashboardDocument({
            connection: { kind: 'value', value: { nested: [{
                service: { pluginId: 'com.acme.cloud', localId: 'cloud' }, accountId: 'private-choice',
            }] } },
            label: { kind: 'value', value: 'Keep this' },
        });
        host.document = dashboard.document;
        const screen = await renderScreen(<DocumentShareSheet artifactId={dashboard.artifactId} kind="widget-area-layout.v1" />);
        await settle();
        const choices = renderedTestIds(screen, 'document-share-private-choice-');
        expect(choices).toHaveLength(1);
        await screen.pressByTestIdAsync(choices[0]!);
        expect(renderedTestIds(screen, 'document-share-private-viewer:')).toEqual([]);
        const remove = renderedTestIds(screen, 'document-share-private-remove:');
        expect(remove).toHaveLength(1);
        await screen.pressByTestIdAsync(remove[0]!);
        await settle();
        expect([...host.approvalArtifacts.values()]).toEqual([]);
        expect(renderedTestIds(screen, 'document-share-private-choice-')).toEqual([]);
        expect(JSON.parse(host.document.body).items[0].instance.bindings).toEqual({ label: { kind: 'value', value: 'Keep this' } });
        expect(host.documentUpdates).toHaveLength(1);
        await screen.pressByTestIdAsync('document-share-level:account:ana');
        await screen.pressByTestIdAsync('document-share-level:account:ana:view');
        await settle();
        expect(host.grants.find(grant => grant.principal.kind === 'account' && grant.principal.accountId === 'ana')?.accessLevel).toBe('view');
        expect(host.grants.find(grant => grant.principal.kind === 'team' && grant.principal.teamId === 'studio')).toEqual(studio);
        await screen.unmount();
    });

    it('keeps the private choice unchanged while the user Ask-first Action policy awaits approval', async () => {
        host.settings.actionsSettingsV1 = { v: 1, actions: {
            'widgets.item.inputs.reset': { approvalRequiredSurfaces: ['ui'] },
        } };
        await activateWidgetHome();
        const dashboard = dashboardDocument({ connection: { kind: 'value', value: {
            service: { pluginId: 'com.acme.cloud', localId: 'cloud' }, accountId: 'private-choice',
        } } });
        host.document = dashboard.document;
        const hook = await renderHook(() => useDocumentShareController({ artifactId: dashboard.artifactId,
            kind: 'widget-area-layout.v1', scope: { serverId: host.serverId, accountId: 'owner' } }));
        await settle();
        await React.act(async () => { hook.getCurrent().privateChoices[0]?.removeChoice?.(); });
        await settle();
        expect(hook.getCurrent().privateChoices).toHaveLength(1);
        expect(host.documentUpdates).toEqual([]);
        expect(host.document).toEqual(dashboard.document);
        expect(host.approvalArtifacts.size).toBe(1);
        const stored = [...host.approvalArtifacts.values()][0]!;
        const content = decodePlainArtifactStoredContent(stored.body!);
        if (!content || typeof content !== 'object' || !('body' in content) || typeof content.body !== 'string') {
            throw new Error('Expected the persisted approval request content');
        }
        expect(JSON.parse(content.body)).toMatchObject({ v: 2, status: 'open', actionId: 'widgets.item.inputs.reset',
            approval: { flow: 'deferred', result: 'required' },
            actionArgs: { ref: { surface: { ...JSON.parse(host.document.body).surface, artifactId: dashboard.artifactId },
                instanceId: 'metric' }, paths: ['connection'] } });
        await hook.unmount();
    });

    it('keeps a changed private choice instead of removing it through a stale review action', async () => {
        const selection = (accountId: string): WidgetInputBindingsV1 => ({ connection: { kind: 'value', value: {
            service: { pluginId: 'com.acme.cloud', localId: 'cloud' }, accountId,
        } } });
        const dashboard = dashboardDocument(selection('first-choice'));
        host.document = dashboard.document;
        const hook = await renderHook(() => useDocumentShareController({ artifactId: dashboard.artifactId,
            kind: 'widget-area-layout.v1', scope: { serverId: host.serverId, accountId: 'owner' } }));
        await settle();
        const remove = hook.getCurrent().privateChoices[0]?.removeChoice;
        expect(remove).toEqual(expect.any(Function));
        host.document = dashboardDocument(selection('new-choice')).document;
        await React.act(async () => { remove?.(); });
        await settle();
        expect(host.documentUpdates).toEqual([]);
        expect(JSON.parse(host.document.body).items[0].instance.bindings).toEqual(selection('new-choice'));
        expect(hook.getCurrent().privateChoices[0]?.issue).toMatchObject({ code: 'widget_instance_changed' });
        await hook.unmount();
    });

    it('lets viewers pick only a current declared Resource purpose without sharing the author account', async () => {
        const surface = { pluginId: 'com.acme.cloud', localId: 'metric' };
        const consumer = { pluginId: surface.pluginId, localId: 'metrics' };
        const service = { pluginId: surface.pluginId, localId: 'cloud' };
        const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'metric', name: 'Metric',
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, body: { kind: 'installed', surface },
            inputs: { fields: [{ path: 'connection', title: 'Cloud account', widget: 'select', connectedAccountOptions: true },
                { path: 'label', title: 'Label', widget: 'text' }] },
            inputSchema: { type: 'object', properties: { connection: { type: 'object', required: ['service', 'accountId'],
                properties: { service: { type: 'object', properties: { pluginId: { type: 'string' }, localId: { type: 'string' } },
                    required: ['pluginId', 'localId'], additionalProperties: false }, accountId: { type: 'string' } }, additionalProperties: false },
                    label: { type: 'string' } }, additionalProperties: false },
            connectedAccountPurposeBindings: [{ path: 'connection', purpose: 'read', consumer }], provenance: { source: { kind: 'authored' } },
        });
        const dashboard = dashboardDocument({ connection: { kind: 'value', value: { service, accountId: 'private-choice' } },
            label: { kind: 'value', value: 'Keep this' } }, definition);
        host.document = dashboard.document;
        host.grants = [];
        const entry = { ...widgetProjectionEntry({ ...surface, target: 'app', inputs: definition.inputs,
            inputSchema: definition.inputSchema, resources: [consumer], occurrenceId: 'current' }),
            connectedAccountPurposeBindings: definition.connectedAccountPurposeBindings };
        const projection = normalizePluginUiProjection(PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { [surface.pluginId]: { ...widgetInstalledPackage(surface.pluginId, 'Cloud'), occurrenceId: 'current',
                source: { kind: 'local', locator: `/plugins/${surface.pluginId}` } } },
            familiesById: { pluginUi: { family: 'pluginUi', entriesById: { metric: entry } } },
            resourcesById: { metrics: { id: consumer.localId, pluginId: consumer.pluginId, resourceKind: 'config', scope: 'global',
                connectedAccountPurposes: [{ purpose: 'read', serviceRefs: [service] }] } },
        }));
        const storage = getStorage();
        // Declaration metadata is active-Account owned, unlike captured-Home grant reads.
        await activateWidgetHome('waived');
        storage.setState({ profile: AccountProfileSchema.parse({ id: 'owner' }),
            profileScope: { serverId: host.serverId, accountId: 'owner' }, settingsScope: { serverId: host.serverId, accountId: 'owner' } });
        // Purpose selection is an authenticated Account row, not a Settings field.
        const { readConnectedAccountCatalog } = await import('@/sync/api/account/apiConnectedAccountCatalog');
        const purposeScope = { serverId: host.serverId, accountId: 'owner' };
        const purposeCatalog = await readConnectedAccountCatalog(purposeScope, 'purposes');
        expect(purposeCatalog).toMatchObject({ status: 'ready', record: { key: 'purposes', value: { v: 1, bindings: [] } } });
        const hook = await renderHook(() => useDocumentShareController({ artifactId: dashboard.artifactId,
            kind: 'widget-area-layout.v1', scope: { serverId: host.serverId, accountId: 'owner' } }), {
            wrapper: ({ children }) => <AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: projection,
                pluginBrowserProjection: null, phase: 'current', interactionEnabled: true, machineId: null, serverId: host.serverId,
                platform: 'web', accountLifetime: captureActiveServerAccountScopeLifetime(), clientExecutableActivation: { status: 'ready' }, reloadClientExecutables() {}, reloadConnectedAccountProjection() {} }}>
                {children}
            </AppShellPluginUiProjectionValueProvider>,
        });
        await settle();
        expect(hook.getCurrent().privateChoices[0]?.letViewersPick).toEqual(expect.any(Function));
        await React.act(async () => { hook.getCurrent().privateChoices[0]?.letViewersPick?.(); });
        await settle();
        expect(hook.getCurrent().privateChoices).toEqual([]);
        expect(JSON.parse(host.document.body).items[0].instance.bindings).toEqual({ connection: { kind: 'viewer', purpose: 'read' },
            label: { kind: 'value', value: 'Keep this' } });
        expect(host.documentUpdates).toHaveLength(1);
        expect(await readConnectedAccountCatalog(purposeScope, 'purposes')).toEqual(purposeCatalog);
        await React.act(async () => { hook.getCurrent().actions.addPrincipal({ kind: 'account', accountId: 'ana' }); });
        await settle();
        expect(host.grants).toHaveLength(1);
        expect(host.grants[0]?.principal).toEqual({ kind: 'account', accountId: 'ana' });
        await hook.unmount();
    });

    it('never changes a dashboard when a reader invokes a private-choice repair', async () => {
        const dashboard = dashboardDocument({ connection: { kind: 'value', value: {
            service: { pluginId: 'com.acme.cloud', localId: 'cloud' }, accountId: 'private-choice',
        } } });
        host.document = dashboard.document;
        host.access = 'view';
        const hook = await renderHook(() => useDocumentShareController({ artifactId: dashboard.artifactId,
            kind: 'widget-area-layout.v1', scope: { serverId: host.serverId, accountId: 'owner' } }));
        await settle();
        expect(hook.getCurrent().model.editable).toBe(false);
        expect(hook.getCurrent().privateChoices).toHaveLength(1);
        await React.act(async () => { hook.getCurrent().privateChoices[0]?.removeChoice?.(); });
        await settle();
        expect(host.documentUpdates).toEqual([]);
        expect(host.document).toEqual(dashboard.document);
        await hook.unmount();
    });

    it.each(['work-board.v1', 'prompt_doc.v2'])('refuses malformed opened %s content through the Action owner', async kind => {
        host.document = { header: { v: 1, kind, title: 'Unreadable document' }, body: '{' };
        const hook = await renderHook(() => useDocumentShareController({ artifactId: 'invalid-document',
            scope: { serverId: host.serverId, accountId: 'owner' } }));
        await settle();
        // Retained grants remain inspectable/revocable; only new sharing requires content admission.
        expect(hook.getCurrent().grants).toHaveLength(2);
        await React.act(async () => { hook.getCurrent().actions.setAccessLevel({ kind: 'account', accountId: 'ana' }, 'view'); });
        await settle();
        const anaRow = hook.getCurrent().model.grants.find(row => row.principal.ref.kind === 'account'
            && row.principal.ref.accountId === 'ana');
        expect(anaRow?.operation).toMatchObject({ kind: 'error' });
        expect(anaRow?.level).toMatchObject({ value: 'edit' });
        expect(host.requests.every(request => request.method === 'GET')).toBe(true);
        expect(host.documentUpdates).toEqual([]);
        await hook.unmount();
    });

    it('lists a workflow\'s grants with the document labels and the Team-run rule', async () => {
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();

        expect(host.requests[0]).toEqual({ method: 'GET' });
        expect(screen.findByTestId('document-share-grant-account:ana')).not.toBeNull();
        expect(screen.findByTestId('document-share-grant-team:studio')).not.toBeNull();
        const text = screen.getTextContent();
        expect(text).toContain('Can edit');
        expect(text).toContain('Can use');
        expect(text).not.toContain('Can steer');
        expect(text).toContain('The team sees every run');
    });

    it('changes, adds and removes access only through the Artifact grant Actions', async () => {
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();

        await screen.pressByTestIdAsync('document-share-level:account:ana');
        // Levels keep one order whatever the adapter or the grant says.
        expect(renderedTestIds(screen, 'document-share-level:account:ana:')).toEqual([
            'document-share-level:account:ana:view', 'document-share-level:account:ana:edit', 'document-share-level:account:ana:admin',
        ]);
        await screen.pressByTestIdAsync('document-share-level:account:ana:admin');
        await settle();
        expect(host.requests.at(-1)).toEqual({ method: 'PUT',
            body: { artifactId: 'wf-1', principal: { kind: 'account', accountId: 'ana' }, accessLevel: 'admin' } });

        await startAdding(screen);
        await screen.pressByTestIdAsync('document-share-candidate-team:payments');
        await settle();
        expect(host.requests.at(-1)).toEqual({ method: 'PUT',
            body: { artifactId: 'wf-1', principal: { kind: 'team', teamId: 'payments' }, accessLevel: 'view' } });
        expect(screen.findByTestId('document-share-grant-team:payments')).not.toBeNull();

        await screen.pressByTestIdAsync('document-share-grant-team:studio');
        await screen.pressByTestIdAsync('document-share-remove:team:studio');
        await screen.pressByTestIdAsync('document-share-remove-confirm:team:studio');
        await settle();
        expect(host.requests.at(-1)).toEqual({ method: 'DELETE',
            body: { artifactId: 'wf-1', principal: { kind: 'team', teamId: 'studio' } } });
        expect(screen.findByTestId('document-share-grant-team:studio')).toBeNull();
    });

    it('lets an administrator edit, add and remove grants without assigning admin', async () => {
        host.access = 'admin';
        host.ownerAccountId = 'document-owner';
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();

        await startAdding(screen);
        expect(screen.findByTestId('document-share-candidate-team:payments')).not.toBeNull();
        expect(screen.findByTestId('document-share-public-link')).toBeNull();
        expect(host.publicRequests).toEqual([]);
        await screen.pressByTestIdAsync('document-share-level:account:ana');
        expect(renderedTestIds(screen, 'document-share-level:account:ana:')).toEqual([
            'document-share-level:account:ana:view', 'document-share-level:account:ana:edit',
        ]);
        await screen.pressByTestIdAsync('document-share-level:account:ana:view');
        await settle();
        expect(host.requests.at(-1)).toEqual({ method: 'PUT',
            body: { artifactId: 'wf-1', principal: { kind: 'account', accountId: 'ana' }, accessLevel: 'view' } });

        await screen.pressByTestIdAsync('document-share-candidate-team:payments');
        await settle();
        expect(screen.findByTestId('document-share-grant-team:payments')).not.toBeNull();
        await screen.pressByTestIdAsync('document-share-grant-team:studio');
        await screen.pressByTestIdAsync('document-share-remove:team:studio');
        await screen.pressByTestIdAsync('document-share-remove-confirm:team:studio');
        await settle();
        expect(screen.findByTestId('document-share-grant-team:studio')).toBeNull();
        expect(screen.findByTestId('document-share-grant-account:ana')).not.toBeNull();
    });

    it('clears the controller roster after acknowledged self-revocation', async () => {
        host.access = 'admin';
        host.ownerAccountId = 'document-owner';
        host.revokeOnRemove = true;
        const self = { kind: 'account' as const, accountId: 'owner' };
        host.grants = [{ ...ana, principal: self, accessLevel: 'admin' }, studio];
        const hook = await renderHook(() => useDocumentShareController({ artifactId: 'wf-1',
            scope: { serverId: host.serverId, accountId: 'owner' } }));
        await settle();
        expect(hook.getCurrent().grants).toHaveLength(2);

        await act(async () => { hook.getCurrent().actions.confirmRemove(self); });
        expect(host.requests.filter(request => request.method === 'DELETE')).toEqual([]);
        await act(async () => { hook.getCurrent().actions.requestRemove(self); });
        await act(async () => { hook.getCurrent().actions.confirmRemove({ kind: 'team', teamId: 'studio' }); });
        expect(host.requests.filter(request => request.method === 'DELETE')).toEqual([]);
        await act(async () => { hook.getCurrent().actions.cancelRemove(self); });
        await act(async () => { hook.getCurrent().actions.confirmRemove(self); });
        expect(host.requests.filter(request => request.method === 'DELETE')).toEqual([]);
        await act(async () => { hook.getCurrent().actions.requestRemove(self); });
        await act(async () => { hook.getCurrent().actions.confirmRemove(self); });
        await settle();
        expect(host.access).toBeNull();
        expect(hook.getCurrent().grants).toEqual([]);
        expect(hook.getCurrent().model).toMatchObject({ editable: false, stale: false, owner: null, grants: [], directory: { sections: [] } });
        expect(hook.getCurrent().issue).toMatchObject({ code: 'artifact_access_revoked', retryable: false });
        expect(hook.getCurrent().loading).toBe(false);
    });

    it('replaces the sheet controls with an access-lost state after self-revocation', async () => {
        host.access = 'admin';
        host.ownerAccountId = 'document-owner';
        host.revokeOnRemove = true;
        host.grants = [{ ...ana, principal: { kind: 'account', accountId: 'owner' }, accessLevel: 'admin' }, studio];
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();
        await screen.pressByTestIdAsync('document-share-grant-account:owner');
        await screen.pressByTestIdAsync('document-share-remove:account:owner');
        await screen.pressByTestIdAsync('document-share-remove-confirm:account:owner');
        await settle();

        expect(renderedTestIds(screen, 'document-share-grant-')).toEqual([]);
        expect(renderedTestIds(screen, 'document-share-candidate-')).toEqual([]);
        expect(screen.findByTestId('document-share-public-link')).toBeNull();
        expect(screen.findByTestId('document-share-editor:list:document-share:option:issue')).not.toBeNull();
        expect(screen.findByTestId('document-share-editor:list:document-share:option:read-only')).toBeNull();
    });

    it('shows a recipient the roster without any way to change it', async () => {
        host.access = 'edit';
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();

        expect(screen.findByTestId('document-share-grant-account:ana')).not.toBeNull();
        expect(screen.findByTestId('document-share-candidate-team:payments')).toBeNull();
        await screen.pressByTestIdAsync('document-share-grant-account:ana');
        expect(screen.findByTestId('document-share-remove:account:ana')).toBeNull();
        expect(screen.findByTestId('document-share-level:account:ana:admin')).toBeNull();
        expect(screen.findByTestId('document-share-public-link')).toBeNull();
        expect(host.publicRequests).toEqual([]);
    });

    it('offers the owner a public-link row inside the existing share sheet', async () => {
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();

        expect(screen.findByTestId('document-share-public-link')?.props.accessibilityLabel).toContain('Off');
        expect(host.publicRequests).toEqual([{ method: 'GET' }]);
        await screen.pressByTestIdAsync('document-share-public-link');
        await settle();
        expect(screen.findByTestId('document-share-public-link-controls')).not.toBeNull();
    });

    it('shows an existing public link as on before the owner opens its controls', async () => {
        host.publicShare = { id: 'existing-share', subject: { kind: 'artifact', id: 'wf-1' },
            expiresAt: null, maxUses: null, useCount: 0, isConsentRequired: false, networkOff: false,
            createdAt: 1, updatedAt: 1, keyDerivation: 'fragment_v1' };
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();
        expect(screen.findByTestId('document-share-public-link')?.props.accessibilityLabel).toContain('On');
        expect(screen.findByTestId('document-share-public-link-controls')).toBeNull();
    });

    it('keeps publication off and reports missing Home isolation without suggesting a blind retry', async () => {
        host.publicCreateError = 'public_share_isolation_unavailable';
        const hook = await renderHook(() => useDocumentPublicLinkController({ artifactId: 'wf-1',
            scope: { serverId: host.serverId, accountId: 'owner' }, enabled: true, canManage: true }));
        await settle();
        await expect(hook.getCurrent().create({ isConsentRequired: true })).rejects.toMatchObject({
            code: 'public_share_isolation_unavailable', canTryAgain: false,
        });
        expect(hook.getCurrent().publication).toBeNull();
        expect(hook.getCurrent().shareUrl).toBeNull();
        expect(host.publicShare).toBeNull();

        expect(host.publicRequests.filter(request => request.method === 'POST')).toHaveLength(1);
    });

    it('withdraws the options after a setup refusal and offers Create again when the row is reopened on a repaired Home', async () => {
        host.publicCreateError = 'public_share_isolation_unavailable';
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();
        await screen.pressByTestIdAsync('document-share-public-link');
        await screen.pressByTestIdAsync('session-public-link-create');
        // A workflow carries no visuals, so there is no network access to switch off.
        expect(screen.findByTestId('session-public-link-network-off')).toBeNull();
        await screen.pressByTestIdAsync('session-public-link-expiry:30');
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await settle();

        expect(screen.findByTestId('session-public-link-mutation-error')).not.toBeNull();
        expect(screen.findByTestId('session-public-link-options')).toBeNull();
        expect(screen.findByTestId('session-public-link-options-create')).toBeNull();
        expect(screen.findByTestId('session-public-link-create')).toBeNull();
        expect(screen.findByTestId('document-share-public-link')?.props.accessibilityLabel).toContain('Off');
        expect(host.publicShare).toBeNull();
        expect(modal.alert).not.toHaveBeenCalled();
        expect(screen.getTextContent()).toContain(t('session.collaboration.pane.linkUnavailable'));

        // A fresh open owns no remembered refusal: once the Home is set up, Create works again.
        host.publicCreateError = null;
        const reopened = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();
        await reopened.pressByTestIdAsync('document-share-public-link');
        expect(reopened.findByTestId('session-public-link-mutation-error')).toBeNull();
        await reopened.pressByTestIdAsync('session-public-link-create');
        await reopened.pressByTestIdAsync('session-public-link-expiry:30');
        await reopened.pressByTestIdAsync('session-public-link-options-create');
        await settle();
        expect(reopened.findByTestId('session-public-link-url')).not.toBeNull();
        expect(host.publicShare?.expiresAt).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
    });

    it('creates a local fragment link, reads the owner audit and revokes through the canonical Actions', async () => {
        confirmAction.mockClear();
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();
        await screen.pressByTestIdAsync('document-share-public-link');
        await settle();
        await screen.pressByTestIdAsync('session-public-link-create');
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await settle();
        expect(confirmAction).not.toHaveBeenCalled();

        const issuedUrl = screen.findByTestId('session-public-link-url')?.props.children as string;
        const url = new URL(issuedUrl);
        expect(url.origin).toBe('https://document-share-sheet.test');
        expect(url.pathname).toMatch(/^\/s\/[A-Za-z0-9_-]+$/);
        expect(url.hash).toMatch(/^#k=[A-Za-z0-9_-]{43}$/);
        const created = host.publicRequests.find((request) => request.method === 'POST')!;
        expect(created.body).toMatchObject({ subject: { kind: 'artifact', id: 'wf-1' }, keyDerivation: 'fragment_v1' });
        expect(JSON.stringify(host.publicRequests)).not.toContain(url.hash.slice(3));
        expect(created.body).not.toHaveProperty('encryptedDataKey');
        await screen.pressByTestIdAsync('document-share-grant-account:ana');
        await screen.pressByTestIdAsync('document-share-public-link');
        await settle();
        expect(screen.findByTestId('session-public-link-url')?.props.children).toBe(issuedUrl);
        await screen.pressByTestIdAsync('document-share-public-link-audit');
        await settle();
        expect(screen.findByTestId('document-share-public-link-visit:visit-1')).not.toBeNull();

        confirmAction.mockClear();
        await screen.pressByTestIdAsync('session-public-link-turn-off');
        await settle();
        await waitForHomeGovernance(() => expect(confirmAction).toHaveBeenCalledTimes(1));
        await waitForHomeGovernance(() => expect(host.publicShare).toBeNull());
        await settle();
        expect(screen.findByTestId('document-share-public-link')?.props.accessibilityLabel).toContain('Off');
        expect(screen.findByTestId('session-public-link-url')).toBeNull();
        expect(host.publicRequests.some(request => request.method === 'DELETE')).toBe(true);
    });

    it.each(['text', 'binary'] as const)('narrows the saved %s HTML copy before confirmed public issuance and retains the copy when issuance fails', async (storage) => {
        host.document = { header: { kind: 'html', title: 'Saved visual', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 },
            body: JSON.stringify({ ...artifactHtmlBundleFromBodyV1('<p>Saved visual</p>'), requestedCapabilities: { network: 'open' } }) };
        host.publicCreateError = 'public_share_failed';
        host.binaryHtml = storage === 'binary';
        const screen = await renderScreen(<DocumentShareSheet artifactId="visual" kind="html" />);
        await settle();
        await screen.pressByTestIdAsync('document-share-public-link');
        await settle();
        await screen.pressByTestIdAsync('session-public-link-create');
        expect(host.publicRequests.some(request => request.method === 'POST')).toBe(false);
        await act(async () => { screen.findByTestId('session-public-link-network-off')!.props.onValueChange(true); });
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await vi.waitFor(() => expect(host.documentUpdates).toHaveLength(1));
        await settle();
        expect(JSON.parse(host.document.body).requestedCapabilities, JSON.stringify(host.documentUpdates)).toEqual({ network: 'none' });
        expect(host.documentUpdates).toHaveLength(1);
        expect(host.networkAtPublicCreate).toEqual([{ network: 'none' }]);
        expect(host.publicShare).toBeNull();
        expect(screen.findByTestId('session-public-link-mutation-error')).not.toBeNull();
        expect(JSON.parse(host.document.body).files['index.html']).toBeDefined();
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await settle();
        expect(host.networkAtPublicCreate).toEqual([{ network: 'none' }, { network: 'none' }]);
        expect(host.documentUpdates).toHaveLength(1);
    });

    it('refreshes a changed saved network consequence and requires another user confirmation before issuance', async () => {
        host.document = { header: { kind: 'html', title: 'Saved visual', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 },
            body: JSON.stringify(artifactHtmlBundleFromBodyV1('<p>Saved visual</p>')) };
        const screen = await renderScreen(<DocumentShareSheet artifactId="visual" kind="html" />);
        await settle();
        await screen.pressByTestIdAsync('document-share-public-link');
        await screen.pressByTestIdAsync('session-public-link-create');
        host.document = { ...host.document, body: JSON.stringify({ ...JSON.parse(host.document.body), requestedCapabilities: { network: 'open' } }) };
        host.documentVersion += 1;
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await settle();
        expect(host.publicRequests.some(request => request.method === 'POST')).toBe(false);
        expect(screen.findByTestId('session-public-link-mutation-error')).not.toBeNull();
        expect(screen.getTextContent()).toContain(t('session.collaboration.pane.linkNetworkCount', { count: 1, total: 1 }));
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await settle();
        expect(host.publicShare).not.toBeNull();
        expect(host.networkAtPublicCreate).toEqual([{ network: 'open' }]);
    });

    it('keeps confirmation current across content edits and reordered equivalent network origins', async () => {
        host.document = { header: { kind: 'html', title: 'Saved visual', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 },
            body: JSON.stringify({ ...artifactHtmlBundleFromBodyV1('<p>Saved visual</p>'),
                requestedCapabilities: { networkOrigins: ['https://one.example.test', 'https://two.example.test'] } }) };
        const screen = await renderScreen(<DocumentShareSheet artifactId="visual" kind="html" />);
        await settle();
        await screen.pressByTestIdAsync('document-share-public-link');
        await screen.pressByTestIdAsync('session-public-link-create');
        host.document = { ...host.document, body: JSON.stringify({ ...artifactHtmlBundleFromBodyV1('<p>Edited visual</p>'),
            requestedCapabilities: { networkOrigins: ['https://two.example.test', 'https://one.example.test'] } }) };
        host.documentVersion += 1;
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await settle();
        expect(host.publicShare).not.toBeNull();
        expect(host.documentUpdates).toEqual([]);
        expect(host.networkAtPublicCreate).toEqual([{ networkOrigins: ['https://two.example.test', 'https://one.example.test'] }]);
    });

    it('refuses network-off issuance if another writer widens the saved copy after the off update', async () => {
        host.document = { header: { kind: 'html', title: 'Saved visual', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 },
            body: JSON.stringify({ ...artifactHtmlBundleFromBodyV1('<p>Saved visual</p>'), requestedCapabilities: { network: 'open' } }) };
        host.rewidenAfterNetworkUpdate = true;
        const screen = await renderScreen(<DocumentShareSheet artifactId="visual" kind="html" />);
        await settle();
        await screen.pressByTestIdAsync('document-share-public-link');
        await screen.pressByTestIdAsync('session-public-link-create');
        await act(async () => { screen.findByTestId('session-public-link-network-off')!.props.onValueChange(true); });
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await settle();
        expect(host.documentUpdates).toHaveLength(1);
        expect(host.publicRequests.some(request => request.method === 'POST')).toBe(false);
        expect(screen.findByTestId('session-public-link-mutation-error')).not.toBeNull();
    });

    it('does not offer issuance as no-network when the saved binary HTML bytes are unavailable', async () => {
        host.document = { header: { kind: 'html', title: 'Saved visual', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 },
            body: JSON.stringify({ ...artifactHtmlBundleFromBodyV1('<p>Saved visual</p>'), requestedCapabilities: { network: 'open' } }) };
        host.binaryHtml = true;
        host.blobUnavailable = true;
        const screen = await renderScreen(<DocumentShareSheet artifactId="visual" kind="html" />);
        await vi.waitFor(() => expect(screen.findByTestId('document-share-public-link')?.props.accessibilityLabel).toContain(t('common.error')));
        await screen.pressByTestIdAsync('document-share-public-link');
        expect(screen.findByTestId('session-public-link-create')).toBeNull();
        expect(host.publicRequests.some(request => request.method === 'POST')).toBe(false);
        expect(host.documentUpdates).toEqual([]);
    });

    it('does not issue a public link while saved-copy network narrowing awaits its write receipt', async () => {
        host.document = { header: { kind: 'html', title: 'Saved visual', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 },
            body: JSON.stringify({ ...artifactHtmlBundleFromBodyV1('<p>Saved visual</p>'), requestedCapabilities: { network: 'open' } }) };
        let acknowledge: (() => void) | undefined;
        host.documentUpdateGate = new Promise<void>(resolve => { acknowledge = resolve; });
        const screen = await renderScreen(<DocumentShareSheet artifactId="visual" kind="html" />);
        try {
            await settle();
            await screen.pressByTestIdAsync('document-share-public-link');
            await screen.pressByTestIdAsync('session-public-link-create');
            await act(async () => { screen.findByTestId('session-public-link-network-off')!.props.onValueChange(true); });
            await screen.pressByTestIdAsync('session-public-link-options-create');
            await vi.waitFor(() => expect(host.documentUpdates).toHaveLength(1));
            expect(host.publicRequests.some(request => request.method === 'POST')).toBe(false);
            expect(JSON.parse(host.document.body).requestedCapabilities).toEqual({ network: 'open' });
            await act(async () => { acknowledge?.(); });
            await vi.waitFor(() => expect(host.publicShare).not.toBeNull());
            expect(host.networkAtPublicCreate).toEqual([{ network: 'none' }]);
        } finally { acknowledge?.(); await screen.unmount(); }
    });

    it('retains the saved policy and does not issue when network narrowing is refused', async () => {
        host.document = { header: { kind: 'html', title: 'Saved visual', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 },
            body: JSON.stringify({ ...artifactHtmlBundleFromBodyV1('<p>Saved visual</p>'), requestedCapabilities: { network: 'open' } }) };
        host.documentUpdateError = 'artifact_access_denied';
        const screen = await renderScreen(<DocumentShareSheet artifactId="visual" kind="html" />);
        await settle();
        await screen.pressByTestIdAsync('document-share-public-link');
        await screen.pressByTestIdAsync('session-public-link-create');
        await act(async () => { screen.findByTestId('session-public-link-network-off')!.props.onValueChange(true); });
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await vi.waitFor(() => expect(screen.findByTestId('session-public-link-mutation-error')).not.toBeNull());
        expect(host.documentUpdates).toHaveLength(1);
        expect(JSON.parse(host.document.body).requestedCapabilities).toEqual({ network: 'open' });
        expect(host.publicRequests.some(request => request.method === 'POST')).toBe(false);
    });

    it('blocks network-on confirmation after saved binary networking becomes unavailable and cannot fake an off preparation', async () => {
        host.document = { header: { kind: 'html', title: 'Saved visual', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 },
            body: JSON.stringify({ ...artifactHtmlBundleFromBodyV1('<p>Saved visual</p>'), requestedCapabilities: { network: 'open' } }) };
        host.binaryHtml = true;
        const { DocumentPublicLinkSection } = await import('./DocumentPublicLinkSection');
        let link: ReturnType<typeof useDocumentPublicLinkController> | undefined;
        function PublicLink() {
            link = useDocumentPublicLinkController({ artifactId: 'visual', kind: 'html',
                scope: { serverId: host.serverId, accountId: 'owner' }, enabled: true, canManage: true });
            return <DocumentPublicLinkSection link={link} idPrefix="" kind="html" />;
        }
        const screen = await renderScreen(<PublicLink />);
        await vi.waitFor(() => expect(screen.findByTestId('session-public-link-create')).not.toBeNull());
        await screen.pressByTestIdAsync('session-public-link-create');
        host.documentVersion += 1;
        host.document = { ...host.document,
            body: JSON.stringify({ ...artifactHtmlBundleFromBodyV1('<p>Changed saved visual</p>'), requestedCapabilities: { network: 'open' } }) };
        host.blobUnavailable = true;
        await act(async () => { await link!.reload(); });
        await vi.waitFor(() => expect(screen.findHostByTestId('session-public-link-options-create')?.props.accessibilityState).toMatchObject({ disabled: true }));
        expect(host.publicRequests.some(request => request.method === 'POST')).toBe(false);
        await act(async () => { screen.findByTestId('session-public-link-network-off')!.props.onValueChange(true); });
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await vi.waitFor(() => expect(screen.findByTestId('session-public-link-mutation-error')).not.toBeNull());
        expect(host.publicRequests.some(request => request.method === 'POST')).toBe(false);
        expect(host.documentUpdates).toEqual([]);
        expect(JSON.parse(host.document.body).requestedCapabilities).toEqual({ network: 'open' });
    });

    it('generic Artifact approval narrows the saved binary copy before the one original replay and retains it after link refusal', async () => {
        host.document = { header: { kind: 'html', title: 'Saved visual', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 },
            body: JSON.stringify({ ...artifactHtmlBundleFromBodyV1('<p>Saved visual</p>'), requestedCapabilities: { networkOrigins: ['https://api.example.test'] } }) };
        host.binaryHtml = true;
        host.publicCreateError = 'public_share_failed';
        const artifactId = await createGenericArtifactApproval();
        expect(host.publicRequests.some(request => request.method === 'POST')).toBe(false);
        const decision = await startGenericArtifactDecision(artifactId);
        let acknowledge: (() => void) | undefined;
        host.documentUpdateGate = new Promise<void>(resolve => { acknowledge = resolve; });
        try {
            expect(decision.screen.getTextContent()).toContain('https://api.example.test');
            expect(host.publicRequests.some(request => request.method === 'POST')).toBe(false);
            await act(async () => { decision.screen.findByTestId('session-public-link-network-off')!.props.onValueChange(true); });
            await decision.screen.pressByTestIdAsync('public-link-network-confirm');
            await vi.waitFor(() => expect(host.documentUpdates).toHaveLength(1));
            expect((await readStoredApproval(artifactId)).status).toBe('open');
            expect(host.publicRequests.some(request => request.method === 'POST')).toBe(false);
            await act(async () => { acknowledge?.(); });
            await expect(decision.decision).rejects.toMatchObject({ code: 'public_share_request_failed' });
            expect(host.networkAtPublicCreate).toEqual([{ network: 'none' }]);
            expect(host.publicRequests.filter(request => request.method === 'POST')).toHaveLength(1);
            expect(host.publicShare).toBeNull();
            expect((await readStoredApproval(artifactId)).status).not.toBe('open');
            expect([...host.approvalArtifacts.values()]).toHaveLength(1);
            expect(host.approvalUpdateIds.every(id => id === artifactId)).toBe(true);
            expect(host.artifactRequests.filter(request => request.method === 'POST')
                .every(request => request.home === 'home' && request.accountId === 'owner')).toBe(true);
            host.publicCreateError = null;
            modal.show.mockClear();
            showNetworkConfirmation.mockClear();
            const retry = await startGenericArtifactDecision(artifactId);
            try {
                await act(async () => { retry.screen.findByTestId('session-public-link-network-off')!.props.onValueChange(true); });
                await retry.screen.pressByTestIdAsync('public-link-network-confirm');
                await expect(retry.decision).rejects.toMatchObject({ code: 'public_share_request_failed' });
                expect(host.documentUpdates).toHaveLength(1);
                expect([...host.approvalArtifacts.values()]).toHaveLength(1);
                // A failed original approval retains its recorded outcome; another human press
                // cannot reissue its outward effect or repeat the already committed off write.
                expect(host.publicRequests.filter(request => request.method === 'POST')).toHaveLength(1);
                expect(host.networkAtPublicCreate).toEqual([{ network: 'none' }]);
            } finally { await retry.screen.unmount(); await retry.hook.unmount(); }
        } finally { acknowledge?.(); await decision.screen.unmount(); await decision.hook.unmount(); }
    });

    it.each(['changed', 'off-update'] as const)('generic Artifact approval refuses a stale network consequence at %s', async window => {
        host.document = { header: { kind: 'html', title: 'Saved visual', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 },
            body: JSON.stringify({ ...artifactHtmlBundleFromBodyV1('<p>Saved visual</p>'),
                requestedCapabilities: { network: window === 'changed' ? 'none' : 'open' } }) };
        const artifactId = await createGenericArtifactApproval();
        const decision = await startGenericArtifactDecision(artifactId);
        try {
            if (window === 'changed') {
                host.document = { ...host.document, body: JSON.stringify({ ...JSON.parse(host.document.body), requestedCapabilities: { network: 'open' } }) };
                host.documentVersion += 1;
            } else {
                host.rewidenAfterNetworkUpdate = true;
                await act(async () => { decision.screen.findByTestId('session-public-link-network-off')!.props.onValueChange(true); });
            }
            await decision.screen.pressByTestIdAsync('public-link-network-confirm');
            await expect(decision.decision).rejects.toMatchObject({ code: 'approval_stale' });
            expect((await readStoredApproval(artifactId)).status).toBe('open');
            expect(host.publicRequests.some(request => request.method === 'POST')).toBe(false);
            expect(JSON.parse(host.document.body).requestedCapabilities).toEqual({ network: 'open' });
        } finally { await decision.screen.unmount(); await decision.hook.unmount(); }
    });

    it('generic Artifact approval remains open without issuance while the ordinary network update awaits approval', async () => {
        host.document = { header: { kind: 'html', title: 'Saved visual', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 },
            body: JSON.stringify({ ...artifactHtmlBundleFromBodyV1('<p>Saved visual</p>'), requestedCapabilities: { network: 'open' } }) };
        const artifactId = await createGenericArtifactApproval(true);
        const decision = await startGenericArtifactDecision(artifactId);
        try {
            await act(async () => { decision.screen.findByTestId('session-public-link-network-off')!.props.onValueChange(true); });
            await decision.screen.pressByTestIdAsync('public-link-network-confirm');
            await expect(decision.decision).resolves.toBe(true);
            expect((await readStoredApproval(artifactId)).status).toBe('open');
            expect(host.documentUpdates).toEqual([]);
            expect(host.publicRequests.some(request => request.method === 'POST')).toBe(false);
            expect(JSON.parse(host.document.body).requestedCapabilities).toEqual({ network: 'open' });
            expect(host.approvalArtifacts.size).toBe(2);
            const updateId = [...host.approvalArtifacts.keys()].find(id => id !== artifactId)!;
            expect(await readStoredApproval(updateId)).toMatchObject({ status: 'open', actionId: 'artifact.update' });
            expect(host.approvalUpdateIds).toEqual([]);
        } finally { await decision.screen.unmount(); await decision.hook.unmount(); }
    });

    it.each(['cancel', 'refused'] as const)('generic Artifact approval preserves the saved policy and original request when network preparation is %s', async (outcome) => {
        host.document = { header: { kind: 'html', title: 'Saved visual', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 },
            body: JSON.stringify({ ...artifactHtmlBundleFromBodyV1('<p>Saved visual</p>'), requestedCapabilities: { network: 'open' } }) };
        const artifactId = await createGenericArtifactApproval();
        const decision = await startGenericArtifactDecision(artifactId);
        try {
            if (outcome === 'cancel') {
                const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
                const cancel = decision.screen.findAllByType(RoundButton).find(button => button.props.title === t('common.cancel'))!;
                await act(async () => { cancel.props.onPress(); });
                await expect(decision.decision).resolves.toBe(true);
                expect(host.documentUpdates).toEqual([]);
            } else {
                host.documentUpdateError = 'artifact_access_denied';
                await act(async () => { decision.screen.findByTestId('session-public-link-network-off')!.props.onValueChange(true); });
                await decision.screen.pressByTestIdAsync('public-link-network-confirm');
                await expect(decision.decision).rejects.toBeInstanceOf(Error);
                expect(host.documentUpdates).toHaveLength(1);
            }
            expect((await readStoredApproval(artifactId)).status).toBe('open');
            expect(host.approvalUpdateIds).toEqual([]);
            expect(host.publicRequests.some(request => request.method === 'POST')).toBe(false);
            expect(JSON.parse(host.document.body).requestedCapabilities).toEqual({ network: 'open' });
            expect(host.approvalArtifacts.size).toBe(1);
        } finally { await decision.screen.unmount(); await decision.hook.unmount(); }
    });

    it.each([false, true])('narrows a saved typed visual copy (additive fields: %s) before confirmed public issuance without losing its definition', async additive => {
        const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'visual', name: 'Metric',
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, networkOverride: { network: 'open' },
            body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Metric' } } },
            inputs: { fields: [] }, inputSchema: { type: 'object' }, provenance: { source: { kind: 'authored' } } });
        host.document = { header: buildWidgetDefinitionArtifactHeaderV1(definition), body: JSON.stringify(additive
            ? { ...definition, futureDisplayField: 1, provenance: { ...definition.provenance, futureDisplayField: 1 },
                sizeDeclaration: { ...definition.sizeDeclaration, futureDisplayField: 1 } }
            : definition) };
        const screen = await renderScreen(<DocumentShareSheet artifactId="visual" kind="widget-definition.v1" />);
        await settle();
        await screen.pressByTestIdAsync('document-share-public-link');
        await screen.pressByTestIdAsync('session-public-link-create');
        await act(async () => { screen.findByTestId('session-public-link-network-off')!.props.onValueChange(true); });
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await vi.waitFor(() => expect(host.documentUpdates, screen.getTextContent()).toHaveLength(1));
        await settle();
        expect(JSON.parse(host.document.body)).toEqual({ ...definition, networkOverride: { network: 'none' } });
        expect(host.networkAtPublicCreate).toEqual([{ network: 'none' }]);
        expect(host.documentUpdates).toHaveLength(1);
        expect(host.publicShare).not.toBeNull();
    });

    it.each(['root', 'body'] as const)('refuses network-off preparation before washing a private saved definition selection at %s', async position => {
        const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'visual', name: 'Private metric',
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, networkOverride: { network: 'open' },
            body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Metric' } } },
            inputs: { fields: [] }, inputSchema: { type: 'object' }, provenance: { source: { kind: 'authored' } } });
        const privateInput = { service: { pluginId: 'com.acme.cloud', localId: 'cloud' }, accountId: 'private-selection' };
        const stored = position === 'root' ? { ...definition, futureInput: privateInput }
            : { ...definition, body: { ...definition.body, futureInput: privateInput } };
        host.document = { header: buildWidgetDefinitionArtifactHeaderV1(definition), body: JSON.stringify(stored) };
        const screen = await renderScreen(<DocumentShareSheet artifactId="visual" kind="widget-definition.v1" />);
        await settle();
        await screen.pressByTestIdAsync('document-share-public-link');
        await screen.pressByTestIdAsync('session-public-link-create');
        await act(async () => { screen.findByTestId('session-public-link-network-off')!.props.onValueChange(true); });
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await vi.waitFor(() => expect(screen.findByTestId('session-public-link-mutation-error')).not.toBeNull());
        expect(host.documentUpdates).toEqual([]);
        expect(host.publicShare).toBeNull();
        expect(JSON.parse(host.document.body)).toEqual(stored);
    });

    it('preserves the saved HTML effective policy when the confirmed link keeps network access', async () => {
        const bundle = { ...artifactHtmlBundleFromBodyV1('<p>Saved visual</p>'),
            requestedCapabilities: { networkOrigins: ['https://api.example.com'] } };
        host.document = { header: { kind: 'html', title: 'Saved visual', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 }, body: JSON.stringify(bundle) };
        const screen = await renderScreen(<DocumentShareSheet artifactId="visual" kind="html" />);
        await settle();
        await screen.pressByTestIdAsync('document-share-public-link');
        await settle();
        await screen.pressByTestIdAsync('session-public-link-create');
        expect(screen.getTextContent()).toContain(t('session.collaboration.pane.linkNetworkCount', { count: 1, total: 1 }));
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await settle();
        expect(JSON.parse(host.document.body)).toEqual(bundle);
        expect(host.documentUpdates).toEqual([]);
        expect(host.publicShare).not.toBeNull();
    });

    it.each(['ask-first', 'allowed'] as const)('honors explicit %s revoke policy without another confirmation', async policy => {
        host.settings.actionsSettingsV1 = policy === 'ask-first' ? { v: 1, actions: {
            'artifact.public_link.revoke': { approvalRequiredSurfaces: ['ui'] },
        } } : { v: 1, actions: {}, approvalWaivedSurfaces: { 'artifact.public_link.revoke': ['ui'] } };
        await activateWidgetHome();
        host.publicShare = { id: 'existing-share', subject: { kind: 'artifact', id: 'wf-1' },
            expiresAt: null, maxUses: null, useCount: 0, isConsentRequired: false,
            createdAt: 1, updatedAt: 1, keyDerivation: 'fragment_v1', networkOff: false };
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();
        await screen.pressByTestIdAsync('document-share-public-link');
        confirmAction.mockClear();
        await screen.pressByTestIdAsync('session-public-link-turn-off');
        await settle();
        expect(confirmAction).not.toHaveBeenCalled();
        expect(host.publicShare?.id ?? null).toBe(policy === 'ask-first' ? 'existing-share' : null);
        expect(host.publicRequests.some(request => request.method === 'DELETE')).toBe(policy === 'allowed');
        expect(host.approvalArtifacts.size).toBe(policy === 'ask-first' ? 1 : 0);
        if (policy === 'ask-first') {
            const approvalId = [...host.approvalArtifacts.keys()][0]!;
            expect(await readStoredApproval(approvalId)).toMatchObject({ actionId: 'artifact.public_link.revoke', status: 'open' });
        }
    });

    it('retains a refused revoke in the shared card and clears it when the next revoke succeeds', async () => {
        host.publicShare = { id: 'existing-share', subject: { kind: 'artifact', id: 'wf-1' },
            expiresAt: null, maxUses: null, useCount: 0, isConsentRequired: false,
            createdAt: 1, updatedAt: 1, keyDerivation: 'fragment_v1', networkOff: false };
        host.publicDeleteError = 'public_share_forbidden';
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();
        await screen.pressByTestIdAsync('document-share-public-link');
        await screen.pressByTestIdAsync('session-public-link-turn-off');
        await settle();
        expect(screen.findByTestId('session-public-link-mutation-error')).not.toBeNull();
        expect(host.publicShare?.id).toBe('existing-share');
        expect(modal.alert).not.toHaveBeenCalled();
        host.publicDeleteError = null;
        await screen.pressByTestIdAsync('session-public-link-turn-off');
        await settle();
        expect(screen.findByTestId('session-public-link-mutation-error')).toBeNull();
        expect(host.publicShare).toBeNull();
    });

    it('tells a profile owner that secret values never travel', async () => {
        host.grants = [];
        host.document = PROFILE_DOCUMENT;
        const screen = await renderScreen(<DocumentShareSheet artifactId="profile-1" kind="launch-profile.v1" />);
        await settle();

        expect(host.requests[0]).toEqual({ method: 'GET' });
        expect(screen.getTextContent()).toContain('Profiles refer to Saved Secrets; their values never travel.');
    });

    it('keeps the sheet explaining itself when this device cannot reach document sharing', async () => {
        // An older Home without the grant routes.
        host.grantStatus = 404;
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();

        expect(screen.findByTestId('document-share-grant-account:ana')).toBeNull();
        expect(screen.findByTestId('document-share-candidate-team:payments')).toBeNull();
        expect(screen.findByTestId('document-share-editor:list:document-share:option:issue')).not.toBeNull();
    });
    it('stages a signed-in template link until the reviewed Share is submitted', async () => {
        const submit = vi.fn(async () => {});
        const screen = await renderScreen(<DocumentShareSheet artifactId="released-template" kind="bot_template.v1"
            reviewedSelection={{ onSubmit: submit }} />);
        await settle();
        expect(host.requests).toEqual([]);
        expect(host.publicRequests).toEqual([]);
        await screen.pressByTestIdAsync('document-share-public-link');
        const toggle = screen.find(node => node.props.testID === 'document-share-signed-in-link' && typeof node.props.onValueChange === 'function');
        await act(async () => { toggle.props.onValueChange(true); });
        expect(submit).not.toHaveBeenCalled();
        expect(host.publicRequests).toEqual([]);
        await screen.pressByTestIdAsync('document-share-submit');
        expect(submit).toHaveBeenCalledWith({ recipients: [], signedInLink: true });
        expect(host.requests).toEqual([]);
        expect(host.publicRequests).toEqual([]);
    });


});
