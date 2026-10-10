import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderHook, renderScreen } from '@/dev/testkit';
import { SELECTION_LIST_DEFAULT_DYNAMIC_DEBOUNCE_MS } from '@/components/ui/selectionList/_constants';
import { AccountProfileSchema, ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent, PluginProjectionV2Schema, tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storage';
import { DocumentShareSheet } from './DocumentShareSheet';
import { useDocumentShareController } from './useDocumentShareController';
import { useDocumentPublicLinkController } from './useDocumentPublicLinkController';
import { buildWidgetSurfaceArtifactHeaderV1, buildWidgetSurfaceArtifactIdV1, WidgetAreaLayoutV1Schema, WidgetDefinitionV1Schema, type WidgetDefinitionV1, type WidgetInputBindingsV1 } from '@happier-dev/protocol/widgets';
import { widgetInstalledPackage, widgetProjectionEntry } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { AppShellPluginUiProjectionValueProvider } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { normalizePluginUiProjection } from '@/sync/domains/plugins/ui/projection';
import { NO_TEAM_CAPABILITIES_V1, resolveTeamAdmissionProjectionV1, TeamsPageV1Schema } from '@happier-dev/protocol/teams';
import { resetScopedHomeActionExecutorsForTests } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { t } from '@/text';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// The virtualized list is a third-party rendering boundary; the testkit owns it.
vi.mock('@legendapp/list/react-native', async () => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit');
    return { LegendList: createCapturingLegendListMock({ renderItems: true, renderItemLimit: 40 }).module.LegendList };
});
vi.mock('@/components/ui/accessibility/announceAccessibilityMessage', () => ({ announceAccessibilityMessage: vi.fn() }));
const modal = vi.hoisted(() => ({ alert: vi.fn(), confirm: vi.fn(async () => true) }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: modal }).module;
});

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
    publicDeleteError: null as string | null,
    documentUpdates: [] as Array<Readonly<Record<string, unknown>>>,
    documentVersion: 1,
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
    const layout = WidgetAreaLayoutV1Schema.parse({ v: 1, surface, name: 'Dashboard', instances: [{ area: 'main', instance: {
            v: 1, id: 'metric', definition: { kind: 'inline', definition }, bindings,
        } }] });
    return { artifactId: buildWidgetSurfaceArtifactIdV1(surface), document: {
        header: buildWidgetSurfaceArtifactHeaderV1(layout),
        body: JSON.stringify(layout),
    } };
}

let disposeHome: (() => void) | null = null;
async function serveHome(): Promise<void> {
    const served = await serveActionHomes({
        homes: [
            { key: 'home', serverUrl: 'https://document-share-sheet.test', accountId: 'owner' },
            { key: 'focused', serverUrl: 'https://document-share-focused.test', accountId: 'another-owner' },
        ],
        route: (request) => {
            // The sheet targets its captured profile scope, not the focused Home's transport.
            if (request.home !== 'home') return undefined;
            if (request.path === '/v1/teams/list') return Response.json(TeamsPageV1Schema.parse({
                items: [{ id: 'payments', name: 'Payments squad', description: null, logo: null, archivedAt: null,
                    recovery: null, viewerRole: 'member', capabilities: { ...NO_TEAM_CAPABILITIES_V1, viewTeam: true },
                    admission: resolveTeamAdmissionProjectionV1(), policy: { v: 1, sessionCreationPolicy: 'private_default',
                        externalSharingPolicy: 'allowed', defaultSessionHistoryAccess: 'from_membership',
                        admissionMode: 'invite_only', authenticationPolicy: null } }], nextCursor: null,
            }));
            if (request.path === '/v1/teams/groups/list') return Response.json({ items: [], nextCursor: null });
            if (request.path === '/v1/user/search') return Response.json({ users: [], nextCursor: null });
            if (request.path.startsWith('/v1/public-shares')) {
                host.publicRequests.push({ method: request.method, ...(request.body ? { body: request.body } : {}) });
                if (request.path.endsWith('/access-log')) return Response.json({ accessLog: [{ id: 'visit-1',
                    accessedAt: 1780000000000, ipAddress: '192.0.2.1', userAgent: 'Browser' }] });
                if (request.method === 'POST') {
                    if (host.publicCreateError) return Response.json({ error: host.publicCreateError }, { status: 503 });
                    const input = request.body as import('@happier-dev/protocol').StoredContentPublicShareCreateRequestV1;
                    host.publicShare = { id: 'share-1', subject: input.subject, expiresAt: input.expiresAt ?? null,
                        maxUses: input.maxUses ?? null, useCount: 0, isConsentRequired: input.isConsentRequired ?? false,
                        createdAt: 1, updatedAt: 1, keyDerivation: input.keyDerivation };
                    return Response.json({ publicShare: host.publicShare, isolatedOrigin: 'https://isolated.test' });
                }
                if (request.method === 'DELETE') {
                    if (host.publicDeleteError) return Response.json({ error: host.publicDeleteError }, { status: 403 });
                    host.publicShare = null; return Response.json({ success: true });
                }
                return Response.json({ publicShares: host.publicShare ? [host.publicShare] : [] });
            }
            const route = /^\/v1\/artifacts\/([^/]+)(\/access\/grants)?$/.exec(request.path);
            if (!route) return undefined;
            const artifactId = decodeURIComponent(route[1]!);
            if (!route[2]) {
                if (host.access === null) return Response.json({ error: 'not_found' }, { status: 404 });
                if (request.method === 'POST') {
                    const update = request.body as import('@/sync/domains/artifacts/artifactTypes').ArtifactUpdateRequest;
                    host.documentUpdates.push(request.body as Record<string, unknown>);
                    const header = update.header === undefined ? host.document.header : decodePlainArtifactStoredContent(update.header);
                    const envelope = update.body === undefined ? { body: host.document.body } : decodePlainArtifactStoredContent(update.body);
                    if (!header || typeof header !== 'object' || Array.isArray(header)
                        || !envelope || typeof envelope !== 'object' || !('body' in envelope) || typeof envelope.body !== 'string') {
                        return Response.json({ error: 'invalid_content' }, { status: 400 });
                    }
                    // Opened HTTP fixture metadata is checked above; its extensible keys belong to the stored-content boundary.
                    host.document = { header: header as Record<string, unknown>, body: envelope.body };
                    host.documentVersion += 1;
                    return Response.json({ success: true, headerVersion: host.documentVersion, bodyVersion: host.documentVersion,
                        ...(update.header === undefined ? {} : { header: update.header }),
                        ...(update.body === undefined ? {} : { body: update.body }) });
                }
                return Response.json({ id: artifactId, header: encodePlainArtifactStoredContent(host.document.header),
                    body: encodePlainArtifactStoredContent({ body: host.document.body }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    headerVersion: host.documentVersion, bodyVersion: host.documentVersion, seq: 1, createdAt: 1, updatedAt: 1, ownerAccountId: host.ownerAccountId, access: host.access, encryptionMode: 'plain' });
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
    disposeHome = served.dispose;
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
        host.publicDeleteError = null;
        modal.alert.mockClear();
        host.documentUpdates = [];
        host.documentVersion = 1;
        await serveHome();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
        disposeHome?.();
        disposeHome = null;
        retireActiveServerAccountScopeLifetime();
        invalidateAccountEncryptionModeCache();
        resetServerFeaturesClientForTests();
        resetScopedHomeActionExecutorsForTests();
        vi.restoreAllMocks();
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

    it('removes only the reviewed private choice through widget input admission before sharing', async () => {
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
        expect(renderedTestIds(screen, 'document-share-private-choice-')).toEqual([]);
        expect(JSON.parse(host.document.body).instances[0].instance.bindings).toEqual({ label: { kind: 'value', value: 'Keep this' } });
        expect(host.documentUpdates).toHaveLength(1);
        await screen.pressByTestIdAsync('document-share-level:account:ana');
        await screen.pressByTestIdAsync('document-share-level:account:ana:view');
        await settle();
        expect(host.grants.find(grant => grant.principal.kind === 'account' && grant.principal.accountId === 'ana')?.accessLevel).toBe('view');
        expect(host.grants.find(grant => grant.principal.kind === 'team' && grant.principal.teamId === 'studio')).toEqual(studio);
        await screen.unmount();
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
        expect(JSON.parse(host.document.body).instances[0].instance.bindings).toEqual(selection('new-choice'));
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
        vi.useRealTimers();
        const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
        await setActiveServer({ serverId: host.serverId });
        vi.useFakeTimers();
        storage.setState({ profile: AccountProfileSchema.parse({ id: 'owner' }), settings: { ...storage.getState().settings,
            connectedAccountPurposeBindingsV1: { v: 1, bindings: [] } },
            profileScope: { serverId: host.serverId, accountId: 'owner' }, settingsScope: { serverId: host.serverId, accountId: 'owner' } });
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
        expect(JSON.parse(host.document.body).instances[0].instance.bindings).toEqual({ connection: { kind: 'viewer', purpose: 'read' },
            label: { kind: 'value', value: 'Keep this' } });
        expect(host.documentUpdates).toHaveLength(1);
        expect(storage.getState().settings.connectedAccountPurposeBindingsV1).toEqual({ v: 1, bindings: [] });
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

        await screen.pressByTestIdAsync('document-share-candidate-team:payments');
        await settle();
        expect(host.requests.at(-1)).toEqual({ method: 'PUT',
            body: { artifactId: 'wf-1', principal: { kind: 'team', teamId: 'payments' }, accessLevel: 'view' } });
        expect(screen.findByTestId('document-share-grant-team:payments')).not.toBeNull();

        await screen.pressByTestIdAsync('document-share-grant-team:studio');
        await screen.pressByTestIdAsync('document-share-remove:team:studio');
        expect(host.requests.at(-1)?.method).not.toBe('DELETE');
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

        hook.getCurrent().actions.confirmRemove(self);
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
            expiresAt: null, maxUses: null, useCount: 0, isConsentRequired: false,
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

    it('keeps a refused public link inline with its options intact until a deliberate retry succeeds', async () => {
        host.publicCreateError = 'public_share_isolation_unavailable';
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();
        await screen.pressByTestIdAsync('document-share-public-link');
        await screen.pressByTestIdAsync('session-public-link-create');
        await screen.pressByTestIdAsync('session-public-link-expiry:30');
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await settle();

        expect(screen.findByTestId('session-public-link-mutation-error')).not.toBeNull();
        expect(screen.findByTestId('session-public-link-options-create')).not.toBeNull();
        expect(screen.findByTestId('document-share-public-link')?.props.accessibilityLabel).toContain('Off');
        expect(host.publicShare).toBeNull();
        expect(modal.alert).not.toHaveBeenCalled();
        expect(screen.getTextContent()).toContain(t('session.collaboration.pane.linkUnavailable'));

        host.publicCreateError = null;
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await settle();
        expect(screen.findByTestId('session-public-link-mutation-error')).toBeNull();
        expect(screen.findByTestId('session-public-link-url')).not.toBeNull();
        expect(host.publicShare?.expiresAt).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
    });

    it('creates a local fragment link, reads the owner audit and revokes through the canonical Actions', async () => {
        const screen = await renderScreen(<DocumentShareSheet artifactId="wf-1" kind="workflow-definition.v1" />);
        await settle();
        await screen.pressByTestIdAsync('document-share-public-link');
        await settle();
        await screen.pressByTestIdAsync('session-public-link-create');
        await screen.pressByTestIdAsync('session-public-link-options-create');
        await settle();

        const issuedUrl = screen.findByTestId('session-public-link-url')?.props.children as string;
        const url = new URL(issuedUrl);
        expect(url.origin).toBe('https://isolated.test');
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

        await screen.pressByTestIdAsync('session-public-link-turn-off');
        await settle();
        expect(host.publicShare).toBeNull();
        expect(screen.findByTestId('document-share-public-link')?.props.accessibilityLabel).toContain('Off');
        expect(screen.findByTestId('session-public-link-url')).toBeNull();
        expect(host.publicRequests.some(request => request.method === 'DELETE')).toBe(true);
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
});
