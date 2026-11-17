import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, flushHookEffects, renderHook, renderScreen } from '@/dev/testkit';
import { AccountProfileSchema} from '@happier-dev/protocol/account/profile';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import { PluginProjectionV2Schema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storage';
import { DocumentShareSheet } from './DocumentShareSheet';
import { showDocumentShareSheet } from './showDocumentShareSheet';
import { artifactHtmlBundleFromBodyV1, ARTIFACT_HTML_BUNDLE_MIME_V1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { hashArtifactBinaryContent } from '@/sync/domains/artifacts/artifactBinaryContent';
import { encodeBase64 } from '@/encryption/base64';
import { useDocumentShareController } from './useDocumentShareController';
import { useApprovalProfileDefault } from '@/hooks/approvals/useApprovalProfileDefault';
import { useProjectDashboardDocument } from '@/components/widgets/area/useProjectDashboardDocument';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { ArtifactAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { ArtifactSignedInLinkCreateRequestV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { StoredContentPublicShareCreateRequestV1Schema } from '@happier-dev/protocol/sharing/storedContentPublicShareV1';
import { projectBotTemplateArtifactHeaderV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { useDocumentPublicLinkController } from './useDocumentPublicLinkController';
import { buildWidgetDefinitionArtifactHeaderV1, buildWidgetSurfaceArtifactHeaderV1, buildWidgetSurfaceArtifactIdV1, WidgetAreaLayoutV1Schema, WidgetAreaLayoutV1StoredSchema, WidgetDefinitionV1Schema, type WidgetDefinitionV1, type WidgetInputBindingsV1 } from '@happier-dev/protocol/widgets';
import { widgetInstalledPackage, widgetProjectionEntry } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { NO_TEAM_CAPABILITIES_V1, resolveTeamAdmissionProjectionV1, TeamsPageV1Schema } from '@happier-dev/protocol/teams';
import { resetScopedHomeActionExecutorsForTests } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { t } from '@/text';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createArtifactListHttpResponse, createArtifactReadBatchHttpResponse, projectArtifactStoredKind } from '@/dev/testkit/harness/artifactStoreBoundary';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';

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
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return createLegendListModuleMock({ renderItems: true, renderItemLimit: 40 });
});
vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({ announceAccessibilityMessage: vi.fn() }));
const modal = vi.hoisted(() => ({ alert: vi.fn(), confirm: vi.fn(async () => true) }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ renderCustomModals: true, spies: modal }).module;
});

// Load the genuine generic approval presentation after platform boundaries are installed,
// before the sheet harness replaces timers for its debounced controls.
const { useApprovalDecisionHandler } = await import('@/components/tools/shell/approvals/useApprovalDecisionHandler');
await import('@/components/sharing/publicLinkApprovalPreparation');
const { Modal: renderedModalHost, ModalProvider } = await import('@/modal');
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
    access: 'owner' as import('@happier-dev/protocol/artifacts/artifactAccessV1').ArtifactCallerAccessV1 | null,
    ownerAccountId: 'owner',
    revokeOnRemove: false,
    grants: [] as any[],
    grantStatus: 200,
    grantError: 'not_found',
    reviewedMissingAudience: undefined as readonly import('@happier-dev/protocol/teams/principal').PrincipalRefV1[] | undefined,
    rejectedReviewAccountId: null as string | null,
    grantGate: null as Promise<void> | null,
    document: { header: {} as Record<string, unknown>, body: '' },
    publicShare: null as import('@happier-dev/protocol/sharing/storedContentPublicShareV1').StoredContentPublicShareV1 | null,
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
    attachedWorkflows: [] as import('@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1').WorkflowAttachedTriggerV1[],
    automationQueries: [] as unknown[],
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
        ownerAccountId: host.ownerAccountId, access: host.access, encryptionMode: 'plain' as const,
        publicAudience: host.publicShare ? 'retained' as const : 'none' as const };
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
            if (request.path === '/v3/automations/query' && request.method === 'POST') {
                host.automationQueries.push(request.body);
                return Response.json({ automations: [], attached: host.attachedWorkflows,
                    nextCursor: null, skippedNotSharedCount: 0 });
            }
            if (request.path === '/v1/artifacts/read' && request.method === 'POST') {
                return createArtifactReadBatchHttpResponse(request.body, artifactId => {
                    const approval = host.approvalArtifacts.get(artifactId);
                    if (approval) return { artifactId, ok: true, artifact: approval, recipientCensus: null };
                    if (host.access !== null && host.document.header.kind === 'approval-profile.v1' && artifactId === 'profile-artifact') {
                        return { artifactId, ok: true, artifact: storedArtifact(artifactId), recipientCensus: null };
                    }
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
                if (host.document.header.kind === 'approval-profile.v1') {
                    return createArtifactListHttpResponse(request.url, host.access === null ? [] : [{
                        ...storedArtifact('profile-artifact'), access: host.access,
                        ...projectArtifactStoredKind(deriveArtifactStoredKindV1(host.document.header)),
                    }]);
                }
                // The widget catalog enumerates the Home's real inventory, even for inline definitions.
                const layout = WidgetAreaLayoutV1Schema.safeParse(host.document.header.kind === 'widget-area-layout.v1'
                    ? JSON.parse(host.document.body) : null);
                return Response.json(host.access === null || !layout.success ? []
                    : [storedArtifact(buildWidgetSurfaceArtifactIdV1(layout.data.surface))]);
            }
            if (request.path.startsWith('/v1/public-shares') || request.path.startsWith('/v1/artifact-signed-in-links')) {
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
                    const signed = request.path.startsWith('/v1/artifact-signed-in-links');
                    const signedInput = signed ? ArtifactSignedInLinkCreateRequestV1Schema.parse(request.body) : null;
                    const input = StoredContentPublicShareCreateRequestV1Schema.parse(signedInput ? {
                        subject: { kind: 'artifact', id: signedInput.artifactId }, lookupId: signedInput.lookupId,
                        keyDerivation: 'fragment_v1',
                    } : request.body);
                    host.publicShare = { id: 'share-1', subject: input.subject, expiresAt: input.expiresAt ?? null,
                        maxUses: input.maxUses ?? null, useCount: 0, isConsentRequired: input.isConsentRequired ?? false,
                        networkOff: input.networkOff ?? false, createdAt: 1, updatedAt: 1, keyDerivation: input.keyDerivation,
                        ...(signed ? { audience: 'signed_in' as const } : {}) };
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
            // Only the named document fixtures exist before an approval is created. In particular,
            // the real approval owner must observe a miss for its fresh exact-id existence read.
            // Stored layouts may contain additive fields; retain the raw response for private-choice review.
            const layout = host.document.header.kind === 'widget-area-layout.v1'
                ? WidgetAreaLayoutV1StoredSchema.safeParse(JSON.parse(host.document.body)) : null;
            const documentIds = layout?.success ? [buildWidgetSurfaceArtifactIdV1(layout.data.surface)]
                : ['wf-1', 'visual', 'profile-1', 'invalid-document'];
            if (!documentIds.includes(artifactId)) return Response.json({ error: 'not_found' }, { status: 404 });
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
            if (host.grantStatus !== 200) return Response.json({ error: host.grantError }, { status: host.grantStatus });
            if (host.access === null) return Response.json({ error: 'not_found' }, { status: 404 });
            if (request.method === 'PUT' && input.principal.kind === 'account' && input.principal.accountId === host.rejectedReviewAccountId) {
                return Response.json({ error: 'artifact_subject_ineligible' }, { status: 403 });
            }
            if (request.method === 'PUT' && host.grantGate) await host.grantGate;
            const same = (row: any) => JSON.stringify(row.principal) === JSON.stringify(input.principal);
            if (request.method === 'PUT') {
                const display = host.grants.find(same)?.display ?? (input.principal.kind === 'team' ? { name: 'Payments squad' } : { name: 'Someone' });
                host.grants = [...host.grants.filter((row) => !same(row)),
                    { principal: input.principal, accessLevel: input.accessLevel, createdByAccountId: 'owner', createdAt: 1, display }];
                // The HTTP fixture models the server's next audience review after its acknowledged Account grant.
                host.reviewedMissingAudience = host.reviewedMissingAudience?.filter(principal => JSON.stringify(principal) !== JSON.stringify(input.principal));
            }
            if (request.method === 'DELETE') host.grants = host.grants.filter((row) => !same(row));
            if (request.method === 'DELETE' && host.revokeOnRemove) host.access = null;
            return Response.json({ artifactId, ownerAccountId: host.ownerAccountId, access: host.access, grants: host.access === null ? [] : host.grants,
                ...(request.method === 'GET' && request.url.searchParams.has('requestedAudience') && host.reviewedMissingAudience !== undefined
                    ? { missingAudience: host.reviewedMissingAudience } : {}),
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
    await flushHookEffects({ runOnlyPendingTimers: true });
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
    const { ApprovalRequestV2Schema} = await import('@happier-dev/protocol/approvals/approvalRequestV1');
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

// Render the real confirmation owner and answer its public controls at the presentation boundary.
async function answerNativeReview(decision: 'approve' | 'reject' = 'approve') {
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    const control = `actions.confirmation-review.decision-${decision}`;
    await waitForHomeGovernance(() => expect(screen.findByTestId(control)).not.toBeNull());
    await screen.pressByTestIdAsync(control);
    await settle();
    await screen.unmount();
}

/** Suggestions list once someone starts adding: focus the sheet's search field, then let the list resolve. */
async function startAdding(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const input = screen.find(node => node.props?.testID === 'document-share-search' && typeof node.props.onFocus === 'function');
    await act(async () => { input.props.onFocus(); });
    await settle();
}

describe('DocumentShareSheet', () => {
    it('keeps default saves independent of sharing refusal and preserves None versus inheritance', async () => {
        const group = { kind: 'group' as const, teamId: 'payments', groupId: 'release' };
        host.document = { header: { kind: 'approval-profile.v1', name: 'Release' },
            body: JSON.stringify({ kind: 'approval-profile.v1', profile: { name: 'Release' } }) };
        host.grantStatus = 403;
        host.grantError = 'artifact_access_forbidden';
        await activateWidgetHome();
        const saved: (string | null | undefined)[] = [];
        const hook = await renderHook(() => useApprovalProfileDefault({
            scope: { serverId: host.serverId, accountId: 'owner' }, value: 'previous-profile', audience: [group],
            save: async value => { saved.push(value); },
        }));
        await act(async () => { hook.getCurrent().choose('profile-1'); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().review.issue).toBeDefined());
        let result: Awaited<ReturnType<ReturnType<typeof hook.getCurrent>['submit']>> | undefined;
        await act(async () => { result = await hook.getCurrent().submit('share'); });
        expect(result).toMatchObject({ ok: false, phase: 'sharing', shared: [] });
        expect(saved).toEqual([]);
        await act(async () => { result = await hook.getCurrent().submit('save_only'); });
        expect(result).toEqual({ ok: true, shared: [] });
        expect(saved).toEqual(['profile-1']);
        await act(async () => { hook.getCurrent().choose(null); });
        await act(async () => { await hook.getCurrent().submit('cancel'); });
        expect(saved).toEqual(['profile-1']);
        await act(async () => { hook.getCurrent().choose(null); });
        await act(async () => { await hook.getCurrent().submit('save_only'); });
        await act(async () => { hook.getCurrent().choose(undefined); });
        await act(async () => { await hook.getCurrent().submit('save_only'); });
        expect(saved).toEqual(['profile-1', null, undefined]);
        expect(host.requests.filter(request => request.method === 'PUT')).toEqual([]);
        await hook.unmount();
    });

    it('shares a picked default profile with the reviewed Group before saving, and can instead save without sharing', async () => {
        const group = { kind: 'group' as const, teamId: 'payments', groupId: 'release' };
        host.document = { header: { kind: 'approval-profile.v1', name: 'Release' },
            body: JSON.stringify({ kind: 'approval-profile.v1', profile: { name: 'Release' } }) };
        host.reviewedMissingAudience = [group];
        await activateWidgetHome();
        const saved: (string | null | undefined)[] = [];
        const hook = await renderHook(() => useApprovalProfileDefault({
            scope: { serverId: host.serverId, accountId: 'owner' }, value: undefined, audience: [group],
            save: async value => {
                expect(host.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
                saved.push(value);
            },
        }));
        await settle();
        expect(host.requests).toEqual([]);
        await act(async () => { hook.getCurrent().choose('profile-1'); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().review.missingAudience).toEqual([group]));
        expect(saved).toEqual([]);
        let result: Awaited<ReturnType<ReturnType<typeof hook.getCurrent>['submit']>> | undefined;
        await act(async () => { result = await hook.getCurrent().submit('share'); });
        expect(result).toEqual({ ok: true, shared: [group] });
        expect(saved).toEqual(['profile-1']);
        expect(host.requests.filter(request => request.method === 'PUT')[0]?.body).toMatchObject({ principal: group, accessLevel: 'view' });
        await act(async () => { hook.getCurrent().choose('another-profile'); });
        await settle();
        await act(async () => { result = await hook.getCurrent().submit('save_only'); });
        expect(result).toEqual({ ok: true, shared: [] });
        expect(saved).toEqual(['profile-1', 'another-profile']);
        await hook.unmount();
    });

    it('returns an admitted grant acknowledgement after selection changes without publishing it into the new review', async () => {
        const reader = { kind: 'account' as const, accountId: 'new-reader' };
        const gate = createDeferred<void>();
        host.grantGate = gate.promise;
        host.reviewedMissingAudience = [reader];
        const hook = await renderHook(({ artifactId }: { artifactId: string }) => useDocumentShareController({ artifactId,
            scope: { serverId: host.serverId, accountId: 'owner' }, requestedAudience: [reader] }),
            { initialProps: { artifactId: 'wf-1' } });
        await settle();
        let pending!: ReturnType<ReturnType<typeof useDocumentShareController>['shareMissingAudience']>;
        await act(async () => { pending = hook.getCurrent().shareMissingAudience(); });
        await waitForHomeGovernance(() => expect(host.requests.filter(request => request.method === 'PUT')).toHaveLength(1));
        await hook.rerender({ artifactId: 'another-workflow' });
        await settle();
        expect(hook.getCurrent().model.grants).not.toContainEqual(expect.objectContaining({ grant: reader }));
        await act(async () => { gate.resolve(); await pending; });
        expect(await pending).toEqual({ ok: true, shared: [reader] });
        expect(hook.getCurrent().model.grants).not.toContainEqual(expect.objectContaining({ grant: reader }));
        await hook.unmount();
    });
    it('refuses a retained Workflow audience review before writes after selection changes', async () => {
        const reader = { kind: 'account' as const, accountId: 'new-reader' };
        host.reviewedMissingAudience = [reader];
        const hook = await renderHook(({ artifactId }: { artifactId: string }) => useDocumentShareController({ artifactId,
            scope: { serverId: host.serverId, accountId: 'owner' }, requestedAudience: [reader] }),
            { initialProps: { artifactId: 'wf-1' } });
        await settle();
        expect(hook.getCurrent().missingAudience).toEqual([reader]);
        const submitOldReview = hook.getCurrent().shareMissingAudience;
        await hook.rerender({ artifactId: 'another-workflow' });
        let outcome: Awaited<ReturnType<typeof submitOldReview>> | undefined;
        await act(async () => { outcome = await submitOldReview(); });
        expect(outcome).toMatchObject({ ok: false, shared: [], error: { code: 'action_account_scope_changed' } });
        expect(host.requests.filter(request => request.method !== 'GET')).toEqual([]);
        await hook.unmount();
    });
    it('keeps a closed Workflow audience review idle and refuses a retained review after the selection changes', async () => {
        const reader = { kind: 'account' as const, accountId: 'new-reader' };
        host.reviewedMissingAudience = [reader];
        type Review = Readonly<{ artifactId: string; scope: { serverId: string; accountId: string };
            requestedAudience: readonly typeof reader[] }>;
        const hook = await renderHook(({ review }: { review: Review | null }) => useDocumentShareController(review),
            { initialProps: { review: null as Review | null } });
        await settle();
        expect(host.requests).toEqual([]);
        await hook.rerender({ review: { artifactId: 'wf-1', scope: { serverId: host.serverId, accountId: 'owner' },
            requestedAudience: [reader] } });
        await settle();
        expect(hook.getCurrent().missingAudience).toEqual([reader]);
        const submitOldReview = hook.getCurrent().shareMissingAudience;
        await hook.rerender({ review: null });
        await settle();
        let outcome: Awaited<ReturnType<typeof submitOldReview>> | undefined;
        await act(async () => { outcome = await submitOldReview(); });
        expect(outcome).toMatchObject({ ok: false, shared: [], error: { code: 'action_account_scope_changed' } });
        expect(host.requests.filter(request => request.method !== 'GET')).toEqual([]);
        await hook.unmount();
    });
    it('keeps declined sharing read-only and returns the acknowledged partial audience when a reviewed grant fails', async () => {
        const first = { kind: 'account' as const, accountId: 'new-reader' };
        const second = { kind: 'account' as const, accountId: 'declined-reader' };
        host.reviewedMissingAudience = [first, second];
        host.rejectedReviewAccountId = second.accountId;
        const hook = await renderHook(() => useDocumentShareController({ artifactId: 'wf-1',
            scope: { serverId: host.serverId, accountId: 'owner' }, requestedAudience: [{ kind: 'account', accountId: 'ana' }, first, second] }));
        await settle();
        expect(hook.getCurrent().missingAudience).toEqual([first, second]);
        expect(host.requests.filter(request => request.method !== 'GET')).toEqual([]);
        let outcome: Awaited<ReturnType<ReturnType<typeof useDocumentShareController>['shareMissingAudience']>> | undefined;
        await act(async () => { outcome = await hook.getCurrent().shareMissingAudience(); });
        await settle();
        expect(outcome).toMatchObject({ ok: false, shared: [first], error: { code: 'artifact_subject_ineligible' } });
        expect(host.requests.filter(request => request.method === 'PUT').map(request => request.body?.principal)).toEqual([first, second]);
        expect(host.grants.some(row => row.principal.accountId === first.accountId)).toBe(true);
        expect(host.grants.some(row => row.principal.accountId === second.accountId)).toBe(false);
        host.reviewedMissingAudience = [second];
        host.rejectedReviewAccountId = null;
        await act(async () => { hook.getCurrent().retryContent(); });
        await settle();
        await act(async () => { outcome = await hook.getCurrent().shareMissingAudience(); });
        expect(outcome).toEqual({ ok: true, shared: [second] });
        expect(hook.getCurrent().missingAudience).toEqual([]);
        expect(host.requests.filter(request => request.method === 'PUT').map(request => request.body?.principal)).toEqual([first, second, second]);
        await hook.unmount();
    });
    it.each(['database_transaction_conflict_exhausted', 'database_transaction_timeout'])('keeps %s visible and retries an idempotent grant change', async code => {
        const hook = await renderHook(() => useDocumentShareController({ artifactId: 'wf-1', scope: { serverId: host.serverId, accountId: 'owner' } }));
        await settle();
        host.grantStatus = 503;
        host.grantError = code;
        const principal = { kind: 'account' as const, accountId: 'ana' };
        await React.act(async () => { hook.getCurrent().actions.setAccessLevel(principal, 'view'); });
        await settle();
        const row = () => hook.getCurrent().model.grants.find(row => row.principal.ref.kind === 'account' && row.principal.ref.accountId === 'ana');
        expect(row()?.operation).toMatchObject({ kind: 'error', error: { code, message: t('approvals.transientFailureTitle'), retryable: true } });
        host.grantStatus = 200;
        await React.act(async () => { hook.getCurrent().actions.retryMutation(principal); });
        await settle();
        expect(row()?.level).toMatchObject({ value: 'view' });
        expect(row()?.operation.kind).toBe('idle');
        await hook.unmount();
    });
    beforeEach(async () => {
        host.requests = [];
        host.access = 'owner';
        host.ownerAccountId = 'owner';
        host.revokeOnRemove = false;
        host.grantGate = null;
        host.grants = [ana, studio];
        host.grantStatus = 200;
        host.grantError = 'not_found';
        host.reviewedMissingAudience = undefined;
        host.rejectedReviewAccountId = null;
        host.document = WORKFLOW_DOCUMENT;
        host.publicShare = null;
        host.publicRequests = [];
        host.publicCreateError = null;
        host.networkAtPublicCreate = [];
        host.publicDeleteError = null;
        modal.alert.mockClear();
        confirmAction.mockClear();
        showNetworkConfirmation.mockClear();
        renderedModalHost.hideAll();
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
        host.attachedWorkflows = [];
        host.automationQueries = [];
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

    it('reads opened approval-profile Artifacts through the public Action without exposing Account settings profiles', async () => {
        host.document = { header: { kind: 'approval-profile.v1', name: 'Reviewed deployment', title: 'Reviewed deployment' },
            body: JSON.stringify({ kind: 'approval-profile.v1', profile: { name: 'Reviewed deployment', actions: {
                'deployments.deploy': { approvalRequiredSurfaces: ['agent'] },
            } } }) };
        host.settings = { actionsSettingsV1: { v: 1, actions: {}, approvalProfiles: [
            { id: 'custom:legacy', name: 'Legacy settings profile' },
        ] } };
        await activateWidgetHome();
        vi.useRealTimers();
        const { ActionPolicyOutputSchemas } = await import('@happier-dev/protocol/actions/actionPolicyActionFamily');
        const execute = createFrontDoorActionExecute();
        const read = await execute('actions.policy.get', { profiles: true },
            { serverId: host.serverId, surface: 'ui', authority: 'present_user' });
        if (!read.ok) throw new Error(read.errorCode);
        expect(read).toMatchObject({ ok: true });
        const result = ActionPolicyOutputSchemas['actions.policy.get'].parse(read.result);
        expect(result).toMatchObject({ profiles: [{ id: 'profile-artifact', access: 'owner',
            profile: { id: 'profile-artifact', name: 'Reviewed deployment' },
            revision: { headerVersion: 1, bodyVersion: 1 } }] });
        expect('profiles' in result && result.profiles).toHaveLength(1);
        const reads = host.artifactRequests.length;
        const warm = await execute('actions.policy.get', { profiles: true },
            { serverId: host.serverId, surface: 'ui', authority: 'present_user' });
        expect(warm).toMatchObject({ ok: true, result });
        expect(host.artifactRequests).toHaveLength(reads);
    });

    it('offers the sharer’s own shareable linked Workflows only in the opened profile sheet, after a profile grant acknowledgement', async () => {
        host.document = { header: { kind: 'approval-profile.v1', name: 'Release' },
            body: JSON.stringify({ kind: 'approval-profile.v1', profile: { name: 'Release' } }) };
        host.grants = [];
        await activateWidgetHome();
        vi.useRealTimers();
        const { WorkflowAttachedTriggerV1Schema } = await import('@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1');
        const workflow = '11111111-1111-4111-8111-111111111111';
        const other = '22222222-2222-4222-8222-222222222222';
        const row = (triggerId: string, ref: string, author: string, access: 'owner' | 'view') => WorkflowAttachedTriggerV1Schema.parse({
            automationId: `linked-${triggerId}`, triggerId, workflowDefinitionId: ref,
            workflowAccess: { ownerAccountId: 'owner', access }, relation: 'direct', enabled: true, revision: 1,
            summary: { kind: 'action', phase: 'before', actionIds: ['deployments.deploy'] },
            setUpBy: { accountId: author, displayName: null },
        });
        host.attachedWorkflows = [row('own', workflow, 'owner', 'owner'), row('duplicate', workflow, 'owner', 'owner'),
            row('someone-else', other, 'another', 'owner'), row('cannot-share', other, 'owner', 'view')];
        const hook = await renderHook(({ opened }) => useDocumentShareController({ artifactId: 'profile-1', kind: 'approval-profile.v1',
            scope: { serverId: host.serverId, accountId: 'owner' }, reviewLinkedWorkflows: opened }), { initialProps: { opened: false } });
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(host.automationQueries).toEqual([]);
        await hook.rerender({ opened: true });
        await waitForHomeGovernance(() => expect(hook.getCurrent().linkedWorkflows?.status).toBe('ready'));
        expect(host.automationQueries).toEqual([expect.objectContaining({ subject: {
            kind: 'approvalProfile', serverId: host.serverId, profileId: 'profile-1',
        } })]);
        expect(hook.getCurrent().linkedWorkflows?.rows.map(row => row.ref)).toEqual([workflow]);
        expect(hook.getCurrent().linkedWorkflows?.audience).toEqual([]);
        const principal = { kind: 'team' as const, teamId: 'studio' };
        await act(async () => hook.getCurrent().actions.addPrincipal(principal));
        await waitForHomeGovernance(() => expect(hook.getCurrent().linkedWorkflows?.audience,
            JSON.stringify({ issue: hook.getCurrent().issue, grants: hook.getCurrent().model.grants, requests: host.requests })).toEqual([principal]));
        await act(async () => hook.getCurrent().linkedWorkflows?.dismiss());
        expect(hook.getCurrent().linkedWorkflows?.audience).toEqual([]);
        expect(host.requests.filter(request => request.method !== 'GET')).toEqual([
            { method: 'PUT', body: { artifactId: 'profile-1', principal, accessLevel: 'view' } },
        ]);
        expect(host.automationQueries).toHaveLength(1);
        await hook.unmount();
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
        // The confirmation says what the removal takes away, from the roster it holds (lab p-overview SHARED):
        // Ana's own grant may still cover Studio members, so it never claims everyone loses the dashboard.
        expect(screen.findAllHostsByTestId('document-share-remove-consequence:team:studio').map(node => node.props.children)).toEqual([
            t('shareSheet.removeLosesMembers', { name: 'Studio' }), t('shareSheet.removeKeepsOtherAccess'), t('shareSheet.removeKeepsTheirWork'),
        ]);
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
        expect({ loading: hook.getCurrent().loading, issue: hook.getCurrent().issue }).toEqual({ loading: false, issue: undefined });
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
        await waitForHomeGovernance(async () => {
            await settle();
            expect(renderedTestIds(screen, 'document-share-private-choice-')).toEqual([]);
        });
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

    it('keeps the private choice unchanged when native Ask is rejected and removes it only after approval', async () => {
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
        expect(host.approvalArtifacts.size).toBe(0);
        await answerNativeReview('reject');
        expect(hook.getCurrent().privateChoices).toHaveLength(1);
        expect(host.documentUpdates).toEqual([]);
        expect(host.document).toEqual(dashboard.document);
        await React.act(async () => { hook.getCurrent().privateChoices[0]?.removeChoice?.(); });
        await answerNativeReview();
        await waitForHomeGovernance(() => expect(hook.getCurrent().privateChoices).toHaveLength(0));
        expect(host.documentUpdates).toHaveLength(1);
        expect(host.approvalArtifacts.size).toBe(0);
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
        await waitForHomeGovernance(async () => {
            await settle();
            expect(hook.getCurrent().privateChoices).toEqual([]);
        });
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

    it.each([
        { kind: 'bot_template.v1', kindLabel: 'Owner-defined template', expected: 'Owner-defined template' },
        { kind: null, expected: 'Document' },
        { kind: 'prompt_doc.v2', expected: 'Prompt' },
        { kind: 'workflow-definition.v1', expected: 'Workflow' },
    ])('uses the item owner label when opening $kind sharing', ({ kind, expected, ...identity }) => {
        showDocumentShareSheet({ artifactId: 'item', kind, name: 'Item', subtitle: 'v1.2', ...identity });
        const chrome = vi.mocked(renderedModalHost.show).mock.calls.at(-1)?.[0].chrome;
        expect(chrome?.kind === 'card' ? chrome.subtitle : undefined).toBe(`${expected} · v1.2`);
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

    it('manages a released template link through signed-in create and revoke without anonymous options', async () => {
        const release = { v: 1 as const, state: 'released' as const, release: { v: 1 as const, version: '1.0.0', releasedAtMs: 1,
            changelog: '', content: { v: 1 as const, identity: { name: 'Garden', description: 'Garden advice' },
                instructions: { markdown: 'Grow herbs' }, skills: [], memoryRules: [],
                needs: { software: [], connectedAccounts: [], mcpServers: [] } } } };
        host.document = { header: projectBotTemplateArtifactHeaderV1(release), body: JSON.stringify(release) };
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="bot_template.v1" />);
        await settle();
        await screen.pressByTestIdAsync('document-share-public-link');
        const toggle = () => screen.find(node => node.props.testID === 'document-share-signed-in-link' && typeof node.props.onValueChange === 'function');
        await act(async () => { await toggle().props.onValueChange(true); });
        await settle();
        const creates = host.publicRequests.filter(request => request.method === 'POST');
        expect(creates).toHaveLength(1);
        expect(creates[0]?.body).toEqual({ artifactId: 'wf-1', lookupId: expect.any(String) });
        expect(screen.getTextContent()).toContain('/share/artifact/');
        await act(async () => { await toggle().props.onValueChange(false); });
        await settle();
        expect(host.publicRequests.filter(request => request.method === 'DELETE')).toHaveLength(0);
        await answerNativeReview();
        expect(host.publicRequests.filter(request => request.method === 'DELETE')).toHaveLength(1);
        expect(host.publicShare).toBeNull();
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
        // The sharing rules sit behind the sheet's Details row, never as a legend trailing the list.
        expect(text).not.toContain('The team sees every run');
        await screen.pressByTestIdAsync('document-share-help');
        expect(screen.getTextContent()).toContain('The team sees every run');
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

        await waitForHomeGovernance(async () => {
            await settle();
            expect(screen.findByTestId('document-share-candidate-team:payments')).not.toBeNull();
        });
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
        expect(host.publicShare).not.toBeNull();
        await answerNativeReview();
        await waitForHomeGovernance(async () => {
            await settle();
            expect(host.publicShare).toBeNull();
        });
        expect(confirmAction).not.toHaveBeenCalled();
        await waitForHomeGovernance(() => expect(host.publicShare).toBeNull());
        await settle();
        expect(screen.findByTestId('document-share-public-link')?.props.accessibilityLabel).toContain('Off');
        expect(screen.findByTestId('session-public-link-url')).toBeNull();
        expect(host.publicRequests.some(request => request.method === 'DELETE')).toBe(true);
    });

    it.each(['text', 'binary'] as const)('restricts the public link for saved %s HTML without changing the document when issuance fails', async (storage) => {
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
        await vi.waitFor(() => expect(host.publicRequests.some(request => request.method === 'POST')).toBe(true));
        await settle();
        expect(JSON.parse(host.document.body).requestedCapabilities).toEqual({ network: 'open' });
        expect(host.documentUpdates).toEqual([]);
        expect(host.publicRequests.find(request => request.method === 'POST')?.body).toMatchObject({ networkOff: true });
        expect(host.publicShare).toBeNull();
        expect(screen.findByTestId('session-public-link-mutation-error')).not.toBeNull();
        expect(JSON.parse(host.document.body).files['index.html']).toBeDefined();
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await settle();
        expect(host.publicRequests.filter(request => request.method === 'POST')).toHaveLength(2);
        expect(host.documentUpdates).toEqual([]);
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

    it('the Share confirmation restricts the link without invoking the saved-copy update Action', async () => {
        host.settings.actionsSettingsV1 = { v: 1, actions: {
            'artifact.update': { approvalRequiredSurfaces: ['ui'] },
        } };
        await activateWidgetHome();
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
            await vi.waitFor(() => expect(host.publicShare).not.toBeNull());
            expect(host.publicShare?.networkOff).toBe(true);
            expect(host.documentUpdates).toEqual([]);
            expect(JSON.parse(host.document.body).requestedCapabilities).toEqual({ network: 'open' });
            expect(host.approvalArtifacts.size).toBe(0);
            expect(confirmAction).not.toHaveBeenCalled();
        } finally { acknowledge?.(); await screen.unmount(); }
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

    it('generic Artifact approval issues the restricted link once and preserves binary content after refusal', async () => {
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
            await expect(decision.decision).rejects.toMatchObject({ code: 'public_share_failed' });
            expect(host.publicRequests.find(request => request.method === 'POST')?.body).toMatchObject({ networkOff: true });
            expect(host.documentUpdates).toEqual([]);
            expect(host.publicRequests.filter(request => request.method === 'POST')).toHaveLength(1);
            expect(host.publicShare).toBeNull();
            expect((await readStoredApproval(artifactId)).status).not.toBe('open');
            expect([...host.approvalArtifacts.values()]).toHaveLength(1);
            expect(host.approvalUpdateIds.every(id => id === artifactId)).toBe(true);
            expect(host.artifactRequests.filter(request => request.method === 'POST')
                .every(request => request.home === 'home' && request.accountId === 'owner')).toBe(true);
            host.publicCreateError = null;
            showNetworkConfirmation.mockClear();
            const retry = await startGenericArtifactDecision(artifactId);
            try {
                await act(async () => { retry.screen.findByTestId('session-public-link-network-off')!.props.onValueChange(true); });
                await retry.screen.pressByTestIdAsync('public-link-network-confirm');
                await expect(retry.decision).rejects.toMatchObject({ code: 'public_share_failed' });
                expect(host.documentUpdates).toEqual([]);
                expect([...host.approvalArtifacts.values()]).toHaveLength(1);
                // A failed original approval retains its outcome; another human press cannot reissue it.
                expect(host.publicRequests.filter(request => request.method === 'POST')).toHaveLength(1);
                expect(host.networkAtPublicCreate).toEqual([{ networkOrigins: ['https://api.example.test'] }]);
            } finally { await retry.screen.unmount(); await retry.hook.unmount(); }
        } finally { acknowledge?.(); await decision.screen.unmount(); await decision.hook.unmount(); }
    });

    it('generic Artifact approval refuses an unreviewed widening of the network consequence', async () => {
        host.document = { header: { kind: 'html', title: 'Saved visual', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 },
            body: JSON.stringify({ ...artifactHtmlBundleFromBodyV1('<p>Saved visual</p>'),
                requestedCapabilities: { network: 'none' } }) };
        const artifactId = await createGenericArtifactApproval();
        const decision = await startGenericArtifactDecision(artifactId);
        try {
            host.document = { ...host.document, body: JSON.stringify({ ...JSON.parse(host.document.body), requestedCapabilities: { network: 'open' } }) };
            host.documentVersion += 1;
            await decision.screen.pressByTestIdAsync('public-link-network-confirm');
            await expect(decision.decision).rejects.toMatchObject({ code: 'approval_stale' });
            expect((await readStoredApproval(artifactId)).status).toBe('open');
            expect(host.publicRequests.some(request => request.method === 'POST')).toBe(false);
            expect(JSON.parse(host.document.body).requestedCapabilities).toEqual({ network: 'open' });
        } finally { await decision.screen.unmount(); await decision.hook.unmount(); }
    });

    it('a waived public-link Action does not acquire an unrelated document-update approval', async () => {
        host.document = { header: { kind: 'html', title: 'Saved visual', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 },
            body: JSON.stringify({ ...artifactHtmlBundleFromBodyV1('<p>Saved visual</p>'), requestedCapabilities: { network: 'open' } }) };
        host.settings.actionsSettingsV1 = { v: 1, actions: {
            'artifact.update': { approvalRequiredSurfaces: ['agent'] },
        }, approvalWaivedSurfaces: { 'artifact.public_link.create': ['agent'] } };
        await activateWidgetHome();
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const result = await createDefaultActionExecutor().execute('artifact.public_link.create', {
            artifactId: 'visual', networkOff: true,
        }, { surface: 'agent', serverId: host.serverId, expectedAccountId: 'owner', actionRequestId: 'waived-agent-share' });
        expect(host.approvalArtifacts.size).toBe(0);
        expect(result).toMatchObject({ ok: true, result: { publicShare: { networkOff: true } } });
        expect(host.documentUpdates).toEqual([]);
        expect(host.publicRequests.filter(request => request.method === 'POST')).toHaveLength(1);
        expect(JSON.parse(host.document.body).requestedCapabilities).toEqual({ network: 'open' });
    });

    it('generic Artifact approval restricts the public link and publishes once without a document update', async () => {
        host.document = { header: { kind: 'html', title: 'Saved visual', mime: ARTIFACT_HTML_BUNDLE_MIME_V1 },
            body: JSON.stringify({ ...artifactHtmlBundleFromBodyV1('<p>Saved visual</p>'), requestedCapabilities: { network: 'open' } }) };
        const artifactId = await createGenericArtifactApproval(true);
        const decision = await startGenericArtifactDecision(artifactId);
        try {
            await act(async () => { decision.screen.findByTestId('session-public-link-network-off')!.props.onValueChange(true); });
            await decision.screen.pressByTestIdAsync('public-link-network-confirm');
            await expect(decision.decision).resolves.toBe(true);
            expect(host.approvalArtifacts.size).toBe(1);
            expect((await readStoredApproval(artifactId)).status).not.toBe('open');
            expect(host.documentUpdates).toEqual([]);
            expect(host.publicRequests.filter(request => request.method === 'POST')).toHaveLength(1);
            expect(JSON.parse(host.document.body).requestedCapabilities).toEqual({ network: 'open' });
            expect(host.publicShare?.networkOff).toBe(true);
            expect(host.publicShare).not.toBeNull();
            expect(host.approvalUpdateIds.every(id => id === artifactId)).toBe(true);
            expect(confirmAction).not.toHaveBeenCalled();
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
                host.publicCreateError = 'public_share_failed';
                await act(async () => { decision.screen.findByTestId('session-public-link-network-off')!.props.onValueChange(true); });
                await decision.screen.pressByTestIdAsync('public-link-network-confirm');
                await expect(decision.decision).rejects.toBeInstanceOf(Error);
                expect(host.documentUpdates).toEqual([]);
            }
            if (outcome === 'cancel') {
                expect((await readStoredApproval(artifactId)).status).toBe('open');
                expect(host.approvalUpdateIds).toEqual([]);
            } else {
                expect((await readStoredApproval(artifactId)).status).not.toBe('open');
                expect(host.approvalUpdateIds.every(id => id === artifactId)).toBe(true);
            }
            expect(host.publicRequests.filter(request => request.method === 'POST')).toHaveLength(outcome === 'cancel' ? 0 : 1);
            expect(JSON.parse(host.document.body).requestedCapabilities).toEqual({ network: 'open' });
            expect(host.approvalArtifacts.size).toBe(1);
        } finally { await decision.screen.unmount(); await decision.hook.unmount(); }
    });

    it.each([false, true])('restricts a saved typed visual public link (additive fields: %s) without changing its definition', async additive => {
        const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'visual', name: 'Metric',
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, networkOverride: { network: 'open' },
            body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Metric' } } },
            inputs: { fields: [] }, inputSchema: { type: 'object' }, provenance: { source: { kind: 'authored' } } });
        host.document = { header: buildWidgetDefinitionArtifactHeaderV1(definition), body: JSON.stringify(additive
            ? { ...definition, futureDisplayField: 1, provenance: { ...definition.provenance, futureDisplayField: 1 },
                sizeDeclaration: { ...definition.sizeDeclaration, futureDisplayField: 1 } }
            : definition) };
        const originalBody = host.document.body;
        const screen = await renderScreen(<DocumentShareSheet artifactId="visual" kind="widget-definition.v1" />);
        await settle();
        await screen.pressByTestIdAsync('document-share-public-link');
        await screen.pressByTestIdAsync('session-public-link-create');
        await act(async () => { screen.findByTestId('session-public-link-network-off')!.props.onValueChange(true); });
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await vi.waitFor(() => expect(host.publicShare).not.toBeNull());
        await settle();
        expect(host.document.body).toBe(originalBody);
        expect(host.documentUpdates).toEqual([]);
        expect(host.publicShare?.networkOff).toBe(true);
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

    it.each(['ask-first', 'allowed'] as const)('honors explicit %s revoke policy through the current native confirmation owner', async policy => {
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
        expect(host.approvalArtifacts.size).toBe(0);
        if (policy === 'ask-first') await answerNativeReview();
        await waitForHomeGovernance(() => expect(host.publicShare).toBeNull());
        expect(host.publicRequests.filter(request => request.method === 'DELETE')).toHaveLength(1);
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
        await answerNativeReview();
        await settle();
        expect(screen.findByTestId('session-public-link-mutation-error')).not.toBeNull();
        expect(host.publicShare?.id).toBe('existing-share');
        expect(modal.alert).not.toHaveBeenCalled();
        host.publicDeleteError = null;
        await screen.pressByTestIdAsync('session-public-link-turn-off');
        await answerNativeReview();
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
        await screen.pressByTestIdAsync('document-share-help');
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
});
