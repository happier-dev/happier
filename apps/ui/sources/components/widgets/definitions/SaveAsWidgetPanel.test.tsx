import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionListSourceFixture, createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import * as uuidBoundary from '@/platform/randomUUID';
import { type JsonValue} from '@happier-dev/protocol/json/strictJsonValue';
import { createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1, SessionOwnerMetadataV1Schema} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { projectLegacySessionAccessCapabilitiesV1} from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import {
    SessionSystemRecordStoredSchema} from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';
import { tryWriteServerEnabledBitInPlace} from '@happier-dev/protocol/features/serverEnabledBit';
import { decodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { readBuiltinWidgetDescriptorV1, resolveConfiguredWidgetInputs, WidgetInstanceActionOutputSchemasV1, type WidgetInputBindingsV1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal'))
    .createModalModuleMock({ confirmResult: true }).module);

const harness = createHomeGovernanceHarness();
const readBatchRequest = createSessionReadBatchFetchBoundary(harness.request);
installHomeGovernanceBoundaries(harness);
// This Home serves writes: deliver the Socket boundary's real connected event
// so scoped Actions retain the connection owner's admitted HTTP authority.
installDisconnectedServerSocketBoundary(socket => {
    socket.connect = vi.fn<typeof socket.connect>(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
});
await loadSyncSingletonForTests();
const { SaveAsWidgetPanel } = await import('./SaveAsWidgetPanel');
const { SessionVisualCopyPanel } = await import('@/components/sessions/board/SessionVisualCopyPanel');
const { useWidgetDefinitionFlows } = await import('./useWidgetDefinitionFlows');
const { WidgetSetupStep } = await import('../add/WidgetSetupStep');
const { t } = await import('@/text');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
let restoreUuid: (() => void) | null = null;

/** Save as your widget's place chip ("Also add to"), by its place: its filter is what the person sees and changes. */
function placeChip(screen: Readonly<{ tree: { root: { findAll: (predicate: (node: { props: Record<string, unknown> }) => boolean) => readonly { props: Record<string, unknown> }[] } } }>, id: string) {
    return screen.tree.root.findAll(node => (node.props.filter as { id?: string } | undefined)?.id === id)[0] as
        { props: { filter: { selected?: boolean; options: readonly { id: string }[]; onChange: (id: string) => void } } } | undefined;
}

async function connectDefinitionHome(serverUrl: string) {
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl);
    if (!credentials) throw new Error('Expected signed-in test Home');
    await restoreConnectionToActiveServer(credentials);
    return { disconnect: disconnectActiveServerConnection, credentials };
}

describe('Save as widget placement', () => {
    beforeEach(async () => {
        await harness.reset();
        // Restoring a mounted Home also probes readiness through the raw fetch
        // boundary, below the scoped HTTP leaves installed by this harness.
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(readBatchRequest);
    });
    afterEach(async () => {
        standardCleanup(); restoreUuid?.(); restoreUuid = null;
        const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        resetRuntimeFetch();
    });

    it.each(['placed', 'savePending', 'placementPending', 'placementRefused', 'builtinPlaced', 'publicPlaced'] as const)(
        'promotes Session Add-to before setup placement and preserves %s outcomes', async outcome => {
        const accountId = 'owner';
        const sessionId = 'source';
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://session-add.example',
            publicServerUrl: 'https://session-add.example', serverIdentityId: 'srv_session_add', accountId });
        const { storage } = await import('@/sync/domains/state/storage');
        const { SessionSurfaceItemV1Schema } = await import('@happier-dev/protocol/sessions/board');
        const { WidgetDefinitionV1Schema } = await import('@happier-dev/protocol/widgets');
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
        const { View, Pressable } = await import('react-native');
        const { t } = await import('@/text');
        const account = { serverId, accountId };
        storage.setState({ profileScope: account, settingsScope: account });
        const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: 'srv_session_add' } } });
        if (!tryWriteServerEnabledBitInPlace(features, 'sessions.board', true)) throw new Error('Missing Board feature');
        harness.answer(serverId, '/v1/features', { body: features });
        harness.answer(serverId, '/v1/features/authenticated', { body: features });
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        const fixture = createSessionFixture({ id: sessionId, serverId, encryptionMode: 'plain' });
        storage.getState().applySessions([fixture]);
        const metadata = { path: '/work/project', machineId: 'machine' };
        harness.answer(serverId, `/v2/sessions/${sessionId}?accessProjectionVersion=1`, { body: { session: {
            id: sessionId, createdAt: 1, updatedAt: 1, seq: 1, active: false, activeAt: 1,
            encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 1, metadataVersion: 1,
            metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata, agentState: null })),
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(SessionOwnerMetadataV1Schema.parse({ v: 1, workspace: metadata })),
            agentStateVersion: 1, agentState: null, share: null, responsibleAccountId: null, responsibleAccount: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: fixture.access!.capabilities },
        } } });
        harness.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
        } });
        harness.answer(serverId, '/v1/auth/ping', { body: { success: true } });
        const { disconnect, credentials } = await connectDefinitionHome('https://session-add.example');
        const nativeDefinition = { kind: 'builtin', id: 'usage_daily' } as const;
        const native = readBuiltinWidgetDescriptorV1(nativeDefinition)!;
        const definition = WidgetDefinitionV1Schema.parse({ v: 1, id: 'session-definition', name: 'Copied checks',
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' }, inputs: { fields: [] },
            inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } },
            body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Original checks' } } },
            ...(outcome === 'publicPlaced' ? { publicPresentation: { kind: 'declarative',
                document: { version: 1, root: { kind: 'text', text: 'Shared edition' } } } } : {}),
            ...(outcome === 'placementPending' ? { networkOverride: { network: 'none' } } : {}),
            ...(outcome === 'builtinPlaced' ? { name: 'Copied daily usage', body: nativeDefinition,
                sizeDeclaration: native.sizeDeclaration, inputs: native.inputs, inputSchema: native.inputSchema } : {}) });
        const bindings: WidgetInputBindingsV1 = outcome === 'builtinPlaced' ? {
            period: { kind: 'value', value: { relative: 'today' } }, metric: { kind: 'value', value: 'tokens' },
            costBasis: { kind: 'value', value: 'auto' }, session: { kind: 'value', value: sessionId },
            agents: { kind: 'value', value: [] }, machines: { kind: 'value', value: [] },
            sources: { kind: 'value', value: [] }, projects: { kind: 'value', value: [] },
        } : {};
        const instance = { v: 1 as const, id: 'source-item', definition: outcome === 'builtinPlaced'
            ? nativeDefinition : { kind: 'inline' as const, definition }, bindings };
        const item = SessionSurfaceItemV1Schema.parse({ v: 1, title: definition.name, frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'widget', instance } });
        const record = SessionSystemRecordStoredSchema.parse({ id: 'source-item',
            address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'source-item' }, content: { t: 'plain', v: item },
            revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' });
        harness.answer(serverId, `/v2/sessions/${sessionId}/system-records/record?owner=host&namespace=surface&kind=layout.v1&localId=layout`, { body: { record: null } });
        harness.answer(serverId, `/v2/sessions/${sessionId}/system-records/record?owner=host&namespace=surface&kind=item.v1&localId=source-item`, { body: { record } });
        if (outcome === 'savePending') await harness.requireUiApproval(serverId, 'widgets.definition.saveFromSession');
        if (outcome === 'placementPending') await harness.requireUiApproval(serverId, 'widgets.item.add');
        const settings = { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({
            ...storage.getState().settings.actionsSettingsV1,
            approvalWaivedSurfaces: {},
            ...(outcome === 'placementRefused' ? { actions: { 'widgets.item.add': { enabled: false } } } : {}),
        }) };
        const settingsScope = storage.getState().settingsScope;
        if (settingsScope?.accountId !== accountId) throw new Error('Expected the restored owner Account settings scope');
        storage.getState().applySettingsForScope(settingsScope, settings, 2);
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 2 } });
        function Card() {
            const flows = useWidgetDefinitionFlows({ instance, scope: { ...account, owner: { kind: 'sessionBoard', sessionId } },
                sessionItem: { itemId: instance.id, title: definition.name, savable: true, canEdit: true, converted: [], sourceLabel: definition.name },
                anchorRef: React.useRef(null), testID: 'sessionAdd' });
            return <View><Pressable testID="openAdd" onPress={flows.addTo} />{flows.panel}</View>;
        }
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><Card /></InjectedAuthProvider>);
        try {
            await screen.pressByTestIdAsync('openAdd');
            await screen.pressByTestIdAsync('sessionAdd.addTo.destination.home');
            const publicSurface = { ...account, owner: { kind: 'corePage', pageId: 'public-profile', area: 'main', layoutId: 'minimal' } } as const;
            const setup = outcome === 'publicPlaced'
                ? (await import('./WidgetCopyPanel')).buildWidgetCopySetup({ instance,
                    candidate: (await import('../widgetCatalog')).describeAuthoredWidgetDefinitionV1(definition, { kind: 'inline', definition }),
                    destination: { key: 'public-profile', label: 'Public profile', surface: publicSurface },
                    current: { ...account, owner: { kind: 'sessionBoard', sessionId } }, providedContext: {}, promoted: { current: null }, testID: 'publicCopy' })
                : screen.tree.root.findByType(WidgetSetupStep).props.setup;
            let result: Awaited<ReturnType<typeof setup.submit>>;
            await act(async () => { result = await setup.submit(setup.initial); });
            const saved = harness.artifacts(serverId).list().filter(row => Reflect.get(decodePlainArtifactStoredContent(row.header) as object, 'kind') === 'widget-definition.v1');
            if (outcome === 'savePending') {
                expect(saved).toHaveLength(0);
                expect(result!).toEqual({ ok: true, approvalPending: true });
                const approvals = harness.artifacts(serverId).list().map(row => harness.artifacts(serverId).readPlainBody(row.id)).filter(Boolean).map(body => JSON.parse(body!));
                expect(approvals).toEqual(expect.arrayContaining([expect.objectContaining({ actionId: 'widgets.definition.saveFromSession' })]));
                expect(approvals.some(row => row.actionId === 'widgets.item.add')).toBe(false);
                return;
            }
            expect(saved).toHaveLength(1);
            expect(JSON.parse(harness.artifacts(serverId).readPlainBody(saved[0]!.id)!)).toMatchObject({
                body: definition.body, provenance: { source: { kind: 'session', serverId, sessionId, itemId: instance.id } },
            });
            if (outcome === 'publicPlaced') {
                const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                expect(result!).toEqual({ ok: true });
                const listed = await createDefaultActionExecutor().execute('widgets.item.list', { surface: publicSurface },
                    { serverId, surface: 'ui', authority: 'present_user', expectedAccountId: accountId });
                if (!listed.ok) throw new Error(listed.errorCode);
                const placed = WidgetInstanceActionOutputSchemasV1['widgets.item.list'].parse(listed.result).instances;
                expect(placed.some(copy => copy.instance.definition.kind === 'artifact' && copy.instance.definition.artifactId === saved[0]!.id)).toBe(true);
            } else if (outcome === 'placementRefused') {
                expect(result!).toEqual({ ok: false, message: t('widgetDefinition.savedButNotPlaced') });
                await act(async () => { await setup.submit(setup.initial); });
                expect(harness.artifacts(serverId).list().filter(row => Reflect.get(decodePlainArtifactStoredContent(row.header) as object, 'kind') === 'widget-definition.v1')).toHaveLength(1);
            } else if (outcome === 'placementPending') {
                expect(result!).toEqual({ ok: true, approvalPending: true });
                const approvals = harness.artifacts(serverId).list().map(row => harness.artifacts(serverId).readPlainBody(row.id)).filter(Boolean).map(body => JSON.parse(body!));
                expect(approvals).toEqual(expect.arrayContaining([expect.objectContaining({ actionId: 'widgets.item.add', actionArgs: expect.objectContaining({
                    instance: expect.objectContaining({ definition: { kind: 'artifact', artifactId: saved[0]!.id }, networkOverride: { network: 'none' } }),
                }) })]));
                const pendingResult = result!;
                if (!pendingResult.ok) throw new Error('Expected pending placement');
                await act(async () => { screen.tree.root.findByType(WidgetSetupStep).props.onDone(pendingResult); });
                expect(readPresentationNotice()?.message).toContain(t('widgetDefinition.savedButNotPlaced'));
            } else {
                const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
                expect(result!).toEqual({ ok: true });
                const listed = await createDefaultActionExecutor().execute('widgets.item.list', { surface: { ...account, owner: { kind: 'home' } } },
                    { serverId, surface: 'ui', authority: 'present_user' });
                expect(listed.ok).toBe(true);
                if (!listed.ok) throw new Error('Expected the placed Home widgets to be readable');
                const home = WidgetInstanceActionOutputSchemasV1['widgets.item.list'].parse(listed.result);
                const copies = home.instances.filter(({ instance: placed }) => placed.definition.kind === 'artifact'
                    && placed.definition.artifactId === saved[0]!.id);
                expect(copies).toHaveLength(1);
                expect(copies[0]!.instance.bindings).toEqual(bindings);
            }
        } finally { await screen.unmount(); await disconnect(); retirePresentationNotice(); }
    });
});

describe('Session widget placement through the destination setup', () => {
    beforeEach(async () => {
        await harness.reset();
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(readBatchRequest);
    });
    afterEach(async () => {
        standardCleanup(); restoreUuid?.(); restoreUuid = null;
        const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        resetRuntimeFetch();
    });

    /** A signed-in Home with one Session; default policy admits reversible save and placement. */
    async function openSessionHome(input: Readonly<{ key: string; builtinId: string; bindings: WidgetInputBindingsV1; placementDisabled?: boolean; placementNeedsApproval?: boolean; declarative?: boolean; visual?: 'typed' | 'html' }>) {
        const accountId = 'owner';
        const sessionId = 'source';
        const serverUrl = `https://${input.key}.example`;
        const serverId = await harness.addHome({ name: 'Home', serverUrl, publicServerUrl: serverUrl, serverIdentityId: `srv_${input.key}`, accountId });
        const { storage } = await import('@/sync/domains/state/storage');
        const { SessionSurfaceItemV1Schema } = await import('@happier-dev/protocol/sessions/board');
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        const account = { serverId, accountId };
        storage.setState({ profileScope: account, settingsScope: account });
        const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: `srv_${input.key}` } } });
        if (!tryWriteServerEnabledBitInPlace(features, 'sessions.board', true)) throw new Error('Missing Board feature');
        harness.answer(serverId, '/v1/features', { body: features });
        harness.answer(serverId, '/v1/features/authenticated', { body: features });
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        const fixture = createSessionFixture({ id: sessionId, serverId, encryptionMode: 'plain' });
        storage.getState().applySessions([fixture]);
        const metadata = { path: '/work/project', machineId: 'machine' };
        harness.answer(serverId, `/v2/sessions/${sessionId}?accessProjectionVersion=1`, { body: { session: {
            id: sessionId, createdAt: 1, updatedAt: 1, seq: 1, active: false, activeAt: 1,
            encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 1, metadataVersion: 1,
            metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata, agentState: null })),
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(SessionOwnerMetadataV1Schema.parse({ v: 1, workspace: metadata })),
            agentStateVersion: 1, agentState: null, share: null, responsibleAccountId: null, responsibleAccount: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: fixture.access!.capabilities },
        } } });
        harness.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
        } });
        harness.answer(serverId, '/v1/auth/ping', { body: { success: true } });
        // Widget input admission confirms the Session the copy reads is one this Account can read.
        harness.answer(serverId, '/v2/sessions/query', { body: createSessionListSourceFixture({ sessions: [{
            id: sessionId, seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1, archivedAt: null, encryptionMode: 'plain',
            metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1, summary: { text: 'Source Session', updatedAt: 1 } }), metadataVersion: 1,
            agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
            ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, workspace: metadata }), share: null,
            effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }) },
            viewer: { latestFailureSeq: null, readState: { state: 'not_started' }, relevance: { relevant: true, reasons: ['owned_by_me'] },
                attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
                follow: { follows: false, notificationLevel: 'none' }, notification: { level: 'none', source: 'preference' } },
            responsibleAccountId: null, responsibleAccount: null,
        }], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false }) });
        const connected = await connectDefinitionHome(serverUrl);
        const { applyProjectAccountRowsFixture } = await import('@/dev/testkit/fixtures/projectAccountRows');
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ id: 'destination-workspace', serverId, machineId: 'machine', rootPath: '/destination',
            label: 'Destination project', projectKey: 'destination-project', createdAtMs: 0 }] });
        const instance = { v: 1 as const, id: 'source-item', definition: { kind: 'builtin' as const, id: input.builtinId }, bindings: input.bindings };
        const { artifactHtmlBundleFromBodyV1 } = await import('@happier-dev/protocol/artifacts/artifactHtmlV1');
        const item = SessionSurfaceItemV1Schema.parse({ v: 1, title: 'Source widget', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: input.visual === 'html' ? { kind: 'hostedHtml', source: artifactHtmlBundleFromBodyV1('<p>Original</p>') }
                : input.declarative ? { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Original' } } } : { kind: 'widget', instance } });
        const record = SessionSystemRecordStoredSchema.parse({ id: 'source-item',
            address: { owner: 'host', namespace: 'surface', kind: 'item.v1', localId: 'source-item' }, content: { t: 'plain', v: item },
            revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z' });
        harness.answer(serverId, `/v2/sessions/${sessionId}/system-records/record?owner=host&namespace=surface&kind=layout.v1&localId=layout`, { body: { record: null } });
        harness.answer(serverId, `/v2/sessions/${sessionId}/system-records/record?owner=host&namespace=surface&kind=item.v1&localId=source-item`, { body: { record } });
        if (input.placementNeedsApproval) await harness.requireUiApproval(serverId, 'widgets.item.add');
        const settings = { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({
            ...storage.getState().settings.actionsSettingsV1,
            approvalWaivedSurfaces: {},
            ...(input.placementDisabled ? { actions: { 'widgets.item.add': { enabled: false } } } : {}),
        }) };
        const settingsScope = storage.getState().settingsScope;
        if (settingsScope?.accountId !== accountId) throw new Error('Expected the restored owner Account settings scope');
        storage.getState().applySettingsForScope(settingsScope, settings, 2);
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 2 } });
        const { View, Pressable } = await import('react-native');
        let showLibrary: (copy: WidgetInstanceV1) => void = () => { throw new Error('Expected a mounted source'); };
        function Card() {
            const [library, setLibrary] = React.useState<WidgetInstanceV1 | null>(null);
            showLibrary = setLibrary;
            const flows = useWidgetDefinitionFlows({ instance: library ?? (input.declarative ? null : instance),
                scope: library ? { ...storage.getState().profileScope!, owner: { kind: 'home' } }
                    : { ...account, owner: { kind: 'sessionBoard', sessionId } },
                providedContext: { session: [{ serverId, sessionId }], projects: [['source-project']] },
                sessionItem: { itemId: instance.id, title: 'Source widget', savable: true, canEdit: true, converted: [], sourceLabel: 'Source widget' },
                anchorRef: React.useRef(null), testID: 'placement' });
            if (input.visual) return <SessionVisualCopyPanel account={account} sessionId={sessionId} itemId={instance.id}
                item={item} share={false} onClose={() => {}} testID="visualCopy" />;
            return <View><Pressable testID="openAdd" onPress={flows.addTo} /><Pressable testID="openSave" onPress={flows.saveAsYours} />
                <Pressable testID="openAbout" onPress={flows.about} />{flows.panel}</View>;
        }
        const screen = await renderScreen(<InjectedAuthProvider credentials={connected.credentials}><Card /></InjectedAuthProvider>);
        const savedDefinitions = () => harness.artifacts(serverId).list().filter(row => Reflect.get(decodePlainArtifactStoredContent(row.header) as object, 'kind') === 'widget-definition.v1');
        const copies = async (destination: 'home' | 'project' = 'home') => {
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const owner = destination === 'home' ? { kind: 'home' as const } : { kind: 'project' as const, projectId: 'destination-project' };
            const listed = await createDefaultActionExecutor().execute('widgets.item.list', { surface: { ...account, owner } },
                { serverId, surface: 'ui', authority: 'present_user' });
            if (!listed.ok) throw new Error('Expected the placed Home widgets to be readable');
            return WidgetInstanceActionOutputSchemasV1['widgets.item.list'].parse(listed.result).instances.map(({ instance: placed }) => placed);
        };
        /** Save as your widget with exactly one place chosen: Home starts chosen; any other place is in "Another place…". */
        const saveWithPlace = async (destination: 'home' | 'project') => {
            await screen.pressByTestIdAsync('openSave');
            if (destination === 'project') {
                await screen.pressByTestIdAsync('placement.save.destination.home');
                const another = placeChip(screen, 'anotherPlace');
                if (!another) throw new Error('Every other place must be offered');
                await act(async () => { another.props.filter.onChange('project:destination-project'); });
            }
            await screen.pressByTestIdAsync('placement.save.primary');
        };
        /** Saves and places in the one step: the panel closes once the copy is saved and placed (or waiting). */
        const saveTo = async (destination: 'home' | 'project' = 'home') => {
            await saveWithPlace(destination);
            await vi.waitFor(() => expect(screen.findByTestId('placement.save.primary'), screen.getTextContent()).toBeNull(), { timeout: 8000 });
            expect(screen.tree.root.findAllByType(WidgetSetupStep)).toHaveLength(0);
        };
        /** Add to… (and a Save whose place still needs something) reach the destination's real input setup. */
        const placeAt = async (via: 'save' | 'addTo', destination: 'home' | 'project' = 'home') => {
            const destinationKey = destination === 'home' ? 'home' : 'project:destination-project';
            if (via === 'addTo') {
                await screen.pressByTestIdAsync('openAdd');
                await screen.pressByTestIdAsync(`placement.addTo.destination.${destinationKey}`);
            } else {
                await saveWithPlace(destination);
            }
            await vi.waitFor(() => expect(screen.tree.root.findAllByType(WidgetSetupStep), screen.getTextContent()).toHaveLength(1), { timeout: 8000 });
            return screen.tree.root.findByType(WidgetSetupStep).props.setup;
        };
        const openAbout = async (copy: WidgetInstanceV1) => {
            await act(async () => { showLibrary(copy); });
            await screen.pressByTestIdAsync('openAbout');
        };
        return { account, sessionId, screen, placeAt, saveTo, savedDefinitions, copies, openAbout, disconnect: connected.disconnect };
    }

    const sessionValue = (sessionId: string, serverId: string): WidgetInputBindingsV1 => ({ session: { kind: 'value', value: { serverId, sessionId } } });

    it.each(['typed', 'html'] as const)('visual %s Save reconciles commit then lost acknowledgement without another copy', async visual => {
        const home = await openSessionHome({ key: `visual-lost-${visual}`, builtinId: 'session_summary',
            bindings: { session: { kind: 'context', slot: 'session' } }, visual });
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        let readsUnavailable = false;
        setRuntimeFetch((input, init) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            const path = new URL(url).pathname;
            // HTML's Artifact API retries the same POST itself. Keep the transport down after
            // the lost acknowledgement until the person explicitly retries after recovery.
            if (readsUnavailable && (path.startsWith('/v1/artifacts/') || (path === '/v1/artifacts' && init?.method === 'POST')))
                return Promise.resolve(new Response('{}', { status: 503 }));
            return readBatchRequest(input, init);
        });
        harness.artifacts(home.account.serverId).afterNextCreate(async () => {
            readsUnavailable = true;
            throw new TypeError('Connection lost after commit');
        });
        const copies = () => harness.artifacts(home.account.serverId).list().filter(row =>
            Reflect.get(decodePlainArtifactStoredContent(row.header) as object, 'kind') === (visual === 'html' ? 'html' : 'widget-definition.v1'));
        try {
            await home.screen.pressByTestIdAsync('visualCopy.save');
            await waitForHomeGovernance(() => expect(home.screen.getTextContent()).toContain(t('widgetDefinition.visualSaveFailed')));
            expect(copies()).toHaveLength(1);
            const id = copies()[0]!.id;
            // An unavailable read never grants permission to create a fresh identity.
            await home.screen.pressByTestIdAsync('visualCopy.save');
            await waitForHomeGovernance(() => expect(home.screen.getTextContent()).toContain(t('widgetDefinition.visualSaveFailed')));
            expect(copies().map(row => row.id)).toEqual([id]);
            readsUnavailable = false;
            await home.screen.pressByTestIdAsync('visualCopy.save');
            await waitForHomeGovernance(() => expect(home.screen.getTextContent()).toContain(t('widgetDefinition.visualSavedCopy')));
            expect(copies().map(row => row.id)).toEqual([id]);
            // Once saved there is nothing left to cancel: Done is the one way out.
            expect(home.screen.findByTestId('visualCopy.cancel')).toBeNull();
            expect(home.screen.findByTestId('visualCopy.primary')).not.toBeNull();
        } finally { await home.screen.unmount(); await home.disconnect(); }
    });

    it.each(['save', 'addTo'] as const)('%s reconciles a committed definition after lost acknowledgement and failed readback before placing it', async via => {
        const home = await openSessionHome({ key: `lost-definition-${via}`, builtinId: 'session_summary',
            bindings: { session: { kind: 'context', slot: 'session' } } });
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        let readsUnavailable = false;
        setRuntimeFetch((input, init) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            if (readsUnavailable && new URL(url).pathname.startsWith('/v1/artifacts/'))
                return Promise.resolve(new Response('{}', { status: 503 }));
            return readBatchRequest(input, init);
        });
        harness.artifacts(home.account.serverId).afterNextCreate(async () => {
            readsUnavailable = true;
            throw new TypeError('Connection lost after commit');
        });
        try {
            let setup: React.ComponentProps<typeof WidgetSetupStep>['setup'] | undefined;
            if (via === 'save') {
                await home.screen.pressByTestIdAsync('openSave');
                await home.screen.pressByTestIdAsync('placement.save.primary');
                await waitForHomeGovernance(() => expect(home.screen.getTextContent()).toContain(t('widgetDefinition.saveFailed')));
            } else {
                setup = await home.placeAt('addTo');
                let first: unknown;
                await act(async () => { first = await setup!.submit(setup!.initial); });
                expect(first).toMatchObject({ ok: false });
            }
            expect(home.savedDefinitions()).toHaveLength(1);
            const originalId = home.savedDefinitions()[0]!.id;
            readsUnavailable = false;
            if (via === 'save') {
                await home.screen.pressByTestIdAsync('placement.save.primary');
                await vi.waitFor(() => expect(home.screen.findByTestId('placement.save.primary')).toBeNull(), { timeout: 8000 });
            } else {
                // A render between attempts must not allocate another create or placement.
                setup = home.screen.tree.root.findByType(WidgetSetupStep).props.setup;
                let retried: unknown;
                await act(async () => { retried = await setup!.submit(setup!.initial); });
                expect(retried).toEqual({ ok: true });
            }
            expect(home.savedDefinitions().map(row => row.id)).toEqual([originalId]);
            const placed = (await home.copies()).filter(copy => copy.definition.kind === 'artifact');
            expect(placed).toHaveLength(1);
            expect(placed[0]!.definition).toEqual({ kind: 'artifact', artifactId: originalId });
        } finally { await home.screen.unmount(); await home.disconnect(); }
    });

    it('Add-to reconciles an unknown committed placement without creating another copy', async () => {
        const home = await openSessionHome({ key: 'lost-placement', builtinId: 'session_summary',
            bindings: { session: { kind: 'context', slot: 'session' } } });
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        let readsUnavailable = false;
        setRuntimeFetch((input, init) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            if (readsUnavailable && new URL(url).pathname.startsWith('/v1/artifacts/'))
                return Promise.resolve(new Response('{}', { status: 503 }));
            return readBatchRequest(input, init);
        });
        harness.artifacts(home.account.serverId).afterNextCreate(async () => {
            // The first create is the definition; the next is its Home layout.
            harness.artifacts(home.account.serverId).afterNextCreate(async () => {
                readsUnavailable = true;
                throw new TypeError('Connection lost after placement commit');
            });
        });
        try {
            const setup = await home.placeAt('addTo');
            let first: unknown;
            await act(async () => { first = await setup.submit(setup.initial); });
            expect(first).toMatchObject({ ok: false });
            readsUnavailable = false;
            expect((await home.copies()).filter(copy => copy.definition.kind === 'artifact')).toHaveLength(1);
            let retried: unknown;
            await act(async () => { retried = await home.screen.tree.root.findByType(WidgetSetupStep).props.setup.submit(setup.initial); });
            expect(retried).toEqual({ ok: true });
            expect(home.savedDefinitions()).toHaveLength(1);
            expect((await home.copies()).filter(copy => copy.definition.kind === 'artifact')).toHaveLength(1);
        } finally { await home.screen.unmount(); await home.disconnect(); }
    });

    it('Duplicate resumes its unknown definition and allocates a new identity only for the next intentional copy', async () => {
        const home = await openSessionHome({ key: 'lost-duplicate', builtinId: 'session_summary',
            bindings: { session: { kind: 'context', slot: 'session' } } });
        try {
            await home.saveTo();
            const instance = (await home.copies()).find(copy => copy.definition.kind === 'artifact');
            if (!instance) throw new Error('Expected the saved placement');
            await home.openAbout(instance);
            await waitForHomeGovernance(() => expect(home.screen.findByTestId('placement.about.duplicate'), home.screen.getTextContent()).not.toBeNull());
            const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
            let readsUnavailable = false;
            setRuntimeFetch((input, init) => {
                const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
                if (readsUnavailable && new URL(url).pathname.startsWith('/v1/artifacts/'))
                    return Promise.resolve(new Response('{}', { status: 503 }));
                return readBatchRequest(input, init);
            });
            harness.artifacts(home.account.serverId).afterNextCreate(async () => {
                readsUnavailable = true;
                throw new TypeError('Connection lost after duplicate commit');
            });
            await home.screen.pressByTestIdAsync('placement.about.duplicate');
            await waitForHomeGovernance(() => expect(home.screen.getTextContent()).toContain(t('widgetDefinition.duplicateFailed')));
            expect(home.savedDefinitions()).toHaveLength(2);
            readsUnavailable = false;
            await home.screen.pressByTestIdAsync('placement.about.duplicate');
            await waitForHomeGovernance(() => expect(home.screen.getTextContent()).toContain(t('widgetDefinition.duplicated', { name: 'Source widget' })));
            expect(home.savedDefinitions()).toHaveLength(2);
            await home.screen.pressByTestIdAsync('placement.about.duplicate');
            await vi.waitFor(() => expect(home.savedDefinitions()).toHaveLength(3));
        } finally { await home.screen.unmount(); await home.disconnect(); }
    });

    it.each([
        ['save', 'home'], ['save', 'project'], ['addTo', 'home'], ['addTo', 'project'],
    ] as const)('%s resolves the Session a Session summary reads on %s and places one valid copy', async (via, destination) => {
        const home = await openSessionHome({ key: `summary-${via}`, builtinId: 'session_summary', bindings: { session: { kind: 'context', slot: 'session' } } });
        try {
            let result: unknown;
            if (via === 'save') {
                // Every value is known, so Save places it in the same step: no second inputs step (FA21 SB7).
                await home.saveTo(destination);
            } else {
                const setup = await home.placeAt(via, destination);
                // Home supplies no Session: the copy carries the Session it was copied from as a value, never the Session-only promise.
                expect(setup.resolve(setup.initial).status).toBe('ready');
                await act(async () => { result = await setup.submit(setup.initial); });
            }
            expect(home.savedDefinitions(), JSON.stringify(result)).toHaveLength(1);
            const placed = (await home.copies(destination)).filter(copy => copy.definition.kind === 'artifact');
            expect(placed, JSON.stringify(result)).toHaveLength(1);
            expect(placed[0]!.bindings).toEqual(sessionValue(home.sessionId, home.account.serverId));
        } finally { await home.screen.unmount(); await home.disconnect(); }
    });

    it.each([
        ['save', 'home'], ['save', 'project'], ['addTo', 'home'], ['addTo', 'project'],
    ] as const)('%s places a followed Usage field only as %s can resolve it', async (via, destination) => {
        // Usage on a Session follows the Projects the page offers; Home offers none.
        const home = await openSessionHome({ key: `usage-${via}`, builtinId: 'usage_daily',
            bindings: { period: { kind: 'value', value: { relative: 'today' } }, metric: { kind: 'value', value: 'tokens' },
                costBasis: { kind: 'value', value: 'auto' }, session: { kind: 'value', value: 'source' }, agents: { kind: 'value', value: [] },
                machines: { kind: 'value', value: [] }, sources: { kind: 'value', value: [] }, projects: { kind: 'context', slot: 'projects' } } });
        try {
            let result: unknown;
            if (via === 'save') {
                await home.saveTo(destination);
            } else {
                const setup = await home.placeAt(via, destination);
                expect(setup.resolve(setup.initial)).toMatchObject({ status: 'ready' });
                await act(async () => { result = await setup.submit(setup.initial); });
            }
            expect(home.savedDefinitions(), JSON.stringify(result)).toHaveLength(1);
            const placed = (await home.copies(destination)).filter(copy => copy.definition.kind === 'artifact');
            expect(placed, JSON.stringify(result)).toHaveLength(1);
            const providedContext: Readonly<Record<string, readonly JsonValue[]>> = destination === 'home' ? {} : { projects: [['destination-project']] };
            expect(placed[0]!.bindings.projects).toEqual(destination === 'home'
                ? { kind: 'value', value: ['source-project'] } : { kind: 'context', slot: 'projects' });
            expect(resolveConfiguredWidgetInputs({ instance: placed[0]!, descriptor: readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'usage_daily' })!,
                providedContext, viewerValues: {} })).toMatchObject({ status: 'ready', input: {
                    projects: [destination === 'home' ? 'source-project' : 'destination-project'],
                } });
        } finally { await home.screen.unmount(); await home.disconnect(); }
    });

    it.each(['save', 'addTo'] as const)('keeps exactly one saved definition when a %s placement is refused and retried', async via => {
        const home = await openSessionHome({ key: 'summary-refused', builtinId: 'session_summary',
            bindings: { session: { kind: 'context', slot: 'session' } }, placementDisabled: true });
        try {
            const setup = await home.placeAt(via);
            const draft = { ...setup.initial, bindings: sessionValue(home.sessionId, home.account.serverId) };
            let first: Awaited<ReturnType<typeof setup.submit>>;
            await act(async () => { first = await setup.submit(draft); });
            expect(first!).toEqual({ ok: false, message: t('widgetDefinition.savedButNotPlaced') });
            await act(async () => { await setup.submit(draft); });
            expect(home.savedDefinitions()).toHaveLength(1);
            expect((await home.copies()).filter(copy => copy.definition.kind === 'artifact')).toHaveLength(0);
        } finally { await home.screen.unmount(); await home.disconnect(); }
    });

    it.each(['save', 'addTo'] as const)('%s offers Home and Project for a checkout-backed widget', async via => {
        const home = await openSessionHome({ key: 'workspace-only', builtinId: 'project_about',
            bindings: { checkout: { kind: 'context', slot: 'checkout' } } });
        try {
            await home.screen.pressByTestIdAsync(via === 'save' ? 'openSave' : 'openAdd');
            expect(home.screen.findByTestId(`placement.${via}.destination.home`)).not.toBeNull();
            if (via === 'addTo') {
                expect(home.screen.findByTestId('placement.addTo.destination.project:destination-project')).not.toBeNull();
            } else {
                const another = placeChip(home.screen, 'anotherPlace');
                expect(another?.props.filter.options.map((option: { id: string }) => option.id)).toEqual(['project:destination-project']);
            }
        } finally { await home.screen.unmount(); await home.disconnect(); }
    });

    it.each(['save', 'addTo'] as const)('%s retains the saved copy and visibly waits when the chosen place needs approval', async via => {
        const home = await openSessionHome({ key: 'summary-approval', builtinId: 'session_summary',
            bindings: { session: { kind: 'context', slot: 'session' } }, placementNeedsApproval: true });
        try {
            if (via === 'save') {
                // Save places at once; the placement waits for approval and the saved copy stays.
                await home.saveTo();
                expect(home.savedDefinitions()).toHaveLength(1);
                expect((await home.copies()).filter(copy => copy.definition.kind === 'artifact')).toHaveLength(0);
                return;
            }
            const setup = await home.placeAt(via);
            let result: Awaited<ReturnType<typeof setup.submit>>;
            await act(async () => { result = await setup.submit(setup.initial); });
            expect(result!).toEqual({ ok: true, approvalPending: true });
            await act(async () => { await setup.submit(setup.initial); });
            expect(home.savedDefinitions()).toHaveLength(1);
            expect((await home.copies()).filter(copy => copy.definition.kind === 'artifact')).toHaveLength(0);
        } finally { await home.screen.unmount(); await home.disconnect(); }
    });

    it('places saved declarative content, which declares no inputs, in the save step', async () => {
        const home = await openSessionHome({ key: 'declarative', builtinId: 'session_summary', bindings: {}, declarative: true });
        try {
            await home.saveTo();
            expect(home.savedDefinitions()).toHaveLength(1);
            expect((await home.copies()).filter(copy => copy.definition.kind === 'artifact')).toHaveLength(1);
        } finally { await home.screen.unmount(); await home.disconnect(); }
    });

    it('keeps no saved copy and retries cleanly when saving itself fails', async () => {
        const home = await openSessionHome({ key: 'summary-save-fails', builtinId: 'session_summary',
            bindings: { session: { kind: 'context', slot: 'session' } } });
        try {
            await home.screen.pressByTestIdAsync('openSave');
            // Home starts chosen.
            expect(placeChip(home.screen, 'home')?.props.filter.selected).toBe(true);
            const uuid = vi.spyOn(uuidBoundary, 'randomUUID').mockImplementationOnce(() => { throw new Error('UUID unavailable'); });
            restoreUuid = () => uuid.mockRestore();
            await home.screen.pressByTestIdAsync('placement.save.primary');
            await vi.waitFor(() => expect(home.screen.getTextContent()).toContain(t('widgetDefinition.saveFailed')));
            expect(home.savedDefinitions()).toHaveLength(0);
            uuid.mockRestore();
            await home.screen.pressByTestIdAsync('placement.save.primary');
            await vi.waitFor(() => expect(home.screen.findByTestId('placement.save.primary')).toBeNull(), { timeout: 8000 });
            expect(home.savedDefinitions()).toHaveLength(1);
            expect((await home.copies()).filter(copy => copy.definition.kind === 'artifact')).toHaveLength(1);
        } finally { await home.screen.unmount(); await home.disconnect(); }
    });
});
