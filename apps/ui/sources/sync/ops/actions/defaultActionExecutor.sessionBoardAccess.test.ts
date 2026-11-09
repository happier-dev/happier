import {
    createPlainSessionOwnerMetadataEnvelopeV1,
    projectSessionSharedMetadataV1,
    SessionOwnerMetadataV1Schema} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import {
    projectLegacySessionAccessCapabilitiesV1} from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import {
    tryWriteServerEnabledBitInPlace,
} from '@happier-dev/protocol/features/serverEnabledBit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, renderHook, renderScreen } from '@/dev/testkit';
import type { AppRailBadgeSignal } from '@/components/navigation/shell/appRail/AppRailBadge';
import { SessionReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import type { PublicActionInputById } from '@happier-dev/protocol/actions/actionSpecs';

// The person's dialog is a system boundary; an unexpected second question is declined, never left waiting.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: false }).module);

// Imported from their owning testkit modules, never the `@/dev/testkit` barrel:
// the harness installs its network boundaries with `vi.doMock`, which only
// reaches modules imported afterwards (see `installHomeGovernanceBoundaries`).
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createUiApprovalRequest, decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';

/**
 * The Session Board Action gate reads its capabilities from the exact Session row the
 * store holds, and a Board mutation — live or replayed from the Inbox — reaches its
 * Home through the one Session system-record runtime.
 *
 * Only genuine boundaries are replaced: the Home's network answers and the device
 * credential store (the Home governance harness). The captured Account context, the
 * exact Home's `sessions.board` decision, the Session hydration that produces the
 * store row and its normalized `access` projection, the system-record runtime, the
 * Board adapter and the approval Artifact lifecycle all run for real.
 */

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// The app entry owns engine registration; this source-only suite supplies the
// same real singleton after its transport boundaries have been installed.
await loadSyncSingletonForTests();
// Loading the executable graph is collection setup, not the reviewed command's behavior deadline.
await import('./defaultActionExecutor');

const ACCOUNT_ID = 'account-a';
const SESSION_ID = 'session-one';
const BOARD_PATH = `/v2/sessions/${SESSION_ID}/board`;
const REVISION = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';

/**
 * A Plain Session row exactly as the Home's current detail route serves it
 * (`accessProjectionVersion=1`): the owner's own row, or a direct view-only share.
 */
function homeSessionRow(viewer: 'owner' | 'view_recipient') {
    const owner = viewer === 'owner';
    return {
        session: {
            id: SESSION_ID, createdAt: 1, updatedAt: 2, seq: 3, active: true, activeAt: 2,
            encryptionMode: 'plain', dataEncryptionKey: null,
            metadataLayoutVersion: 1, metadataVersion: 4,
            metadata: JSON.stringify(projectSessionSharedMetadataV1({
                metadata: { path: '/work/project', machineId: 'machine-1', summary: { text: 'Release', updatedAt: 1 } },
                agentState: null,
            })),
            ...(owner ? {
                ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(SessionOwnerMetadataV1Schema.parse({
                    v: 1,
                    workspace: { path: '/work/project', machineId: 'machine-1' },
                })),
            } : {}),
            agentStateVersion: 5, agentState: null,
            share: owner ? null : { accessLevel: 'view', canApprovePermissions: false },
            effectiveAccess: owner
                ? {
                    v: 1, level: 'owner', sources: [{ kind: 'owner' }],
                    capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner', canApprovePermissions: true }),
                }
                : {
                    v: 1, level: 'view', sources: [{ kind: 'direct', shareId: 'share-1' }],
                    capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }),
                },
            responsibleAccountId: null, responsibleAccount: null,
        },
    };
}

const LAYOUT_READ_PATH = `/v2/sessions/${SESSION_ID}/system-records/record?owner=host&namespace=surface&kind=layout.v1&localId=layout`;

/** The Board layout record exactly as the Home stores it for a Plain Session. */
const storedLayout = {
    record: {
        id: 'layout-row',
        address: { owner: 'host', namespace: 'surface', kind: 'layout.v1', localId: 'layout' },
        content: { t: 'plain', v: { v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [] }] } },
        revision: REVISION,
        createdAt: '2026-09-05T00:00:00.000Z',
        updatedAt: '2026-09-05T00:00:00.000Z',
    },
};

/**
 * One Home holding `account-a` that publishes the Session Board gate and serves
 * the Session, its empty Board and the Board write route.
 */
async function addBoardHome(options: Readonly<{
    serverUrl?: string;
    serverIdentityId?: string;
    viewer?: Parameters<typeof homeSessionRow>[0];
    /** The Actions this Account's settings send through approval on the UI (Settings → Actions). */
    uiApproval?: readonly string[];
}> = {}): Promise<string> {
    const serverId = await harness.addHome({
        name: 'Home A',
        serverUrl: options.serverUrl ?? 'https://board-home.example',
        accountId: ACCOUNT_ID,
        ...(options.serverIdentityId ? { serverIdentityId: options.serverIdentityId } : {}),
    });
    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'sessions.board', true)) {
        throw new Error('The sessions.board feature bit could not be written by its own writer');
    }
    harness.answer(serverId, '/v1/features', { body: features });
    harness.answer(serverId, '/v1/features/authenticated', { body: features });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    harness.answer(serverId, '/v1/auth/ping', { body: { success: true } });
    // The owner's row is admitted against its Plain Account's current encryption facts.
    harness.answer(serverId, '/v1/account/encryption/currentness', {
        body: { mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 },
    });
    const sessionDetail = homeSessionRow(options.viewer ?? 'owner');
    harness.answer(serverId, `/v2/sessions/${SESSION_ID}?accessProjectionVersion=1`, { body: sessionDetail });
    // Approval replay reads the same Session through the current context-only
    // batch transport; both HTTP paths serve the one canonical fixture.
    harness.answer(serverId, 'POST /v2/sessions/read-batch', { body: SessionReadBatchResponseV1Schema.parse({
        results: [{ sessionId: SESSION_ID, detail: { status: 200, body: sessionDetail } }],
    }) });
    harness.answer(serverId, LAYOUT_READ_PATH, { body: storedLayout });
    harness.answer(serverId, `PUT ${BOARD_PATH}`, {
        body: { operation: 'update_layout', outcome: 'updated', layoutRevision: REVISION },
    });
    await harness.requireUiApproval(serverId, options.uiApproval ?? [
        'session.board.layout.update', 'session.board.item.upsert', 'widgets.snapshot.post',
    ]);
    return serverId;
}

function boardWrites() {
    return harness.requestsFor(BOARD_PATH);
}

/** What was asked of the Home, for a failure message. */
function observed(result: unknown): string {
    return JSON.stringify({ result, requests: harness.requests.map((request) => request.path) });
}

/** Renaming a Board view: a write against the Board's current layout revision. */
const intent = {
    sessionId: SESSION_ID,
    expectedLayoutRevision: REVISION,
    operation: { op: 'tab.rename', tabId: 'overview', title: 'Release' },
} as const;

describe('Session Board Action access gate', () => {
    let restoreSessionState: (() => void) | undefined;
    beforeEach(async () => {
        await harness.reset();
        const { storage } = await import('@/sync/domains/state/storage');
        const previous = storage.getState();
        restoreSessionState = () => storage.setState({ sessions: previous.sessions,
            sessionListRowsByServerId: previous.sessionListRowsByServerId });
        // These independent Homes intentionally reuse a fixed Session fixture id.
        // Undo each case's hydrated Session rows as well as its network answers.
        storage.setState({ sessions: {}, sessionListRowsByServerId: {} });
    });

    afterEach(() => {
        standardCleanup();
        restoreSessionState?.();
        restoreSessionState = undefined;
    });

    it('shares unopened Board scalar demand through the real Session runtime and keeps positive layout facts stable', async () => {
        const serverId = await addBoardHome();
        const address = { serverId, sessionId: SESSION_ID };
        let count = 2;
        const countPath = `/v2/sessions/${SESSION_ID}/system-records?owner=host&namespace=surface&kind=item.v1&projection=count`;
        harness.answer(serverId, countPath, { select: () => ({ body: { count } }) });
        const { useSessionBoardHasItems, useSessionBoardItemCount } = await import('@/sync/domains/sessionSystemRecords/useSessionSystemRecordBinding');
        const { SessionBoardRailBadge } = await import('@/components/sessions/panes/SessionResourceRailBadge');
        const { TabBadge } = await import('@/components/ui/navigation/tabBadge/TabBadge');
        const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
        const options = { ...address, enabled: true };
        const first = await renderHook(() => useSessionBoardHasItems(options));
        const second = await renderHook(() => useSessionBoardItemCount(options));
        let overflowSignal: AppRailBadgeSignal | null = null;
        let signalComputations = 0;
        const badges = await renderScreen(React.createElement(React.Fragment, null,
            React.createElement(SessionBoardRailBadge, options),
            React.createElement(SessionBoardRailBadge, { ...options, renderSignal: signal => {
                signalComputations++;
                overflowSignal = signal;
                return null;
            } }),
        ));
        await vi.waitFor(() => expect([first.getCurrent(), second.getCurrent()]).toEqual([true, 2]));
        expect(badges.findAllByType(TabBadge).map(badge => badge.props.value)).toEqual([2]);
        expect(overflowSignal).toEqual({ kind: 'count', value: 2, tone: 'neutral' });
        const requests = () => harness.requests.filter(request => request.path.includes('projection=count'));
        expect(requests()).toHaveLength(1);
        let commits = 0;
        const stop = first.subscribe(() => { commits++; });
        let countCommits = 0;
        const stopCount = second.subscribe(() => { countCommits++; });
        count = 9;
        await act(async () => {
            await getSyncSingleton().withSessionSystemRecordRuntime(address, runtime => runtime.repository.fetchBoardItemCount(address));
        });
        expect(first.getCurrent()).toBe(true);
        expect(commits).toBe(0);
        expect(second.getCurrent()).toBe(9);
        expect(countCommits).toBe(1);
        expect(badges.findAllByType(TabBadge).map(badge => badge.props.value)).toEqual([9]);
        expect(overflowSignal).toEqual({ kind: 'count', value: 9, tone: 'neutral' });
        const computationsBeforeEqualCount = signalComputations;
        await act(async () => {
            await getSyncSingleton().withSessionSystemRecordRuntime(address, runtime => runtime.repository.fetchBoardItemCount(address));
        });
        expect(commits).toBe(0);
        expect(countCommits).toBe(1);
        expect(signalComputations).toBe(computationsBeforeEqualCount);
        count = 0;
        await act(async () => {
            await getSyncSingleton().withSessionSystemRecordRuntime(address, runtime => runtime.repository.fetchBoardItemCount(address));
        });
        expect(first.getCurrent()).toBe(false);
        expect(commits).toBe(1);
        expect(second.getCurrent()).toBe(0);
        expect(countCommits).toBe(2);
        expect(badges.findAllByType(TabBadge)).toHaveLength(0);
        expect(overflowSignal).toBeNull();
        await badges.unmount();
        stopCount(); stop(); await first.unmount(); await second.unmount();
        const remounted = await renderHook(() => useSessionBoardItemCount(options));
        expect(remounted.getCurrent()).toBe(0);
        expect(requests()).toHaveLength(4); // Initial acquisition plus three explicit owner reads, including the unchanged reply.
        await remounted.unmount();
    });

    it('rejects an explicit UI proposal without writing shared layout', async () => {
        const serverId = await addBoardHome();
        const artifactId = await createUiApprovalRequest({
            serverId,
            actionId: 'session.board.layout.update',
            actionInput: intent,
            actionRequestId: 'board-default-reject-request',
        });
        expect(boardWrites()).toHaveLength(0);
        const result = await decideApprovalAsInbox(serverId, artifactId, 'reject');
        expect(result, observed(result)).toMatchObject({ ok: true });
        expect(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId) ?? 'null')).toMatchObject({ status: 'rejected' });
        expect(boardWrites()).toHaveLength(0);
    });

    it('does not let approval elevate a view-only recipient into a shared Board writer', async () => {
        // Its own Home: a Session row the store already holds for another case's
        // Home must not stand in for this Home's answer.
        const serverId = await addBoardHome({ serverUrl: 'https://recipient-board-home.example', viewer: 'view_recipient' });
        const artifactId = await createUiApprovalRequest({ serverId,
            actionId: 'session.board.layout.update', actionInput: intent,
            actionRequestId: 'view-only-board-request' });
        const result = await decideApprovalAsInbox(serverId, artifactId, 'approve');
        expect(result, observed(result)).toMatchObject({ ok: true, result: { status: 'failed' } });
        expect(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId) ?? 'null'))
            .toMatchObject({ status: 'failed', execution: { ok: false, errorCode: 'session_board_forbidden' } });
        expect(boardWrites()).toHaveLength(0);
    });

    it('replays an approved Board mutation from the Inbox on a Home that publishes a portable identity', async () => {
        // The Board surface and the Inbox address the Home by its device-local profile
        // id; the captured Account scope names it by its published identity. Both name
        // the same Home, so the replay must reach it exactly once.
        const serverId = await addBoardHome({
            serverUrl: 'https://identity-board-home.example',
            serverIdentityId: 'srv_board_home',
        });

        const artifactId = await createUiApprovalRequest({
            serverId,
            actionId: 'session.board.layout.update',
            actionInput: intent,
            actionRequestId: 'board-rename-request-1',
        });
        expect(boardWrites()).toHaveLength(0);

        const decided = await decideApprovalAsInbox(serverId, artifactId, 'approve');

        const stored = JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId) ?? 'null');
        expect(decided, `${JSON.stringify(stored?.execution)} ${observed(decided)}`).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(stored).toMatchObject({ status: 'executed', execution: { ok: true } });
        expect(boardWrites()).toHaveLength(1);
    });

    it('approves deferred Board creation without making a successful approval stale on duplicate delivery', async () => {
        // `expectedItemRevision: null` is how the Action requests creation. It is present
        // context the schema admits, not missing context, so the Inbox can approve it.
        const serverId = await addBoardHome({ serverUrl: 'https://create-board-home.example' });
        // The item does not exist yet: the Home's strict record read answers an empty record.
        harness.answer(serverId, `/v2/sessions/${SESSION_ID}/system-records/record?owner=host&namespace=surface&kind=item.v1&localId=release-checklist`, {
            body: { record: null },
        });
        harness.answer(serverId, `PUT ${BOARD_PATH}`, {
            body: {
                operation: 'upsert_item',
                itemId: 'release-checklist',
                outcome: 'created',
                itemRevision: REVISION,
                layoutRevision: REVISION,
            },
        });

        const artifactId = await createUiApprovalRequest({
            serverId,
            actionId: 'session.board.item.upsert',
            actionInput: {
                sessionId: SESSION_ID,
                itemId: 'release-checklist',
                expectedItemRevision: null,
                item: {
                    v: 1,
                    title: 'Release checklist',
                    frame: 'card',
                    height: { mode: 'auto', fallback: 'regular' },
                    source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: '# Release checklist' } } },
                },
                placement: { tabId: 'overview', width: 'wide' },
            },
            actionRequestId: 'board-create-request-1',
        });
        expect(boardWrites()).toHaveLength(0);

        const decided = await decideApprovalAsInbox(serverId, artifactId, 'approve');

        const stored = JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId) ?? 'null');
        expect(decided, `${JSON.stringify(stored?.execution)} ${observed(decided)}`).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(stored).toMatchObject({ status: 'executed', execution: { ok: true } });
        expect(boardWrites()).toHaveLength(1);
        expect(boardWrites()[0]?.input).toMatchObject({ operation: 'upsert_item', expectedItemRevision: null });

        // If a duplicate re-executes after creation, the real Board transport
        // refuses its now-stale null revision. A terminal approval must instead
        // return its durable success, without replacing it with approval_stale.
        harness.answer(serverId, `PUT ${BOARD_PATH}`, { status: 409, body: { error: 'approval_stale' } });
        const repeated = await decideApprovalAsInbox(serverId, artifactId, 'approve');
        expect(repeated, observed(repeated)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
        expect(JSON.parse(harness.artifacts(serverId).readPlainBody(artifactId) ?? 'null')).toEqual(stored);
    });

    it('commits the reviewed snapshot before command loading without asking for default confirmation again', async () => {
        const serverId = await addBoardHome({ serverUrl: 'https://snapshot-command-confirmed.example', uiApproval: [] });
        const itemId = 'confirmed-snapshot';
        harness.answer(serverId, `/v2/sessions/${SESSION_ID}/system-records/record?owner=host&namespace=surface&kind=item.v1&localId=${itemId}`, {
            body: { record: null },
        });
        harness.answer(serverId, `PUT ${BOARD_PATH}`, { body: { operation: 'upsert_item', itemId, outcome: 'created',
            itemRevision: REVISION, layoutRevision: REVISION } });
        const { runWidgetDefinitionCommand } = await import('@/components/widgets/definitions/widgetDefinitionCommands');
        const preview = { v: 1 as const, document: { version: 1 as const, root: { kind: 'text' as const, text: 'Reviewed snapshot' } },
            asOf: '2026-10-05T01:00:00.000Z', provenance: [{ label: 'Checks summary' }] };
        const input: PublicActionInputById['widgets.snapshot.post'] = {
            surface: { serverId, accountId: ACCOUNT_ID, owner: { kind: 'sessionBoard', sessionId: SESSION_ID } },
            itemId, title: 'Checks', preview, placement: { tabId: 'overview', width: 'wide' },
        };
        const pending = runWidgetDefinitionCommand('widgets.snapshot.post', input, { serverId, accountId: ACCOUNT_ID },
            undefined, undefined, { confirmed: true });
        preview.document.root.text = 'Changed after confirmation';
        const result = await pending;
        expect(result, JSON.stringify(result)).toMatchObject({ kind: 'applied' });
        expect(boardWrites()).toHaveLength(1);
        expect(boardWrites()[0]?.input).toMatchObject({ itemContent: { t: 'plain', v: {
            source: { kind: 'declarative', document: { root: { kind: 'text', text: 'Reviewed snapshot' } } },
        } } });
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
    });

    it('publishes only the approved frozen snapshot through the real sealed Board writer', async () => {
        const serverId = await addBoardHome({ serverUrl: 'https://snapshot-board-home.example' });
        const itemId = 'checks-snapshot';
        harness.answer(serverId, `/v2/sessions/${SESSION_ID}/system-records/record?owner=host&namespace=surface&kind=item.v1&localId=${itemId}`, {
            body: { record: null },
        });
        harness.answer(serverId, `PUT ${BOARD_PATH}`, { body: { operation: 'upsert_item', itemId, outcome: 'created',
            itemRevision: REVISION, layoutRevision: REVISION } });
        const preview = { v: 1, document: { version: 1, root: { kind: 'metric', label: 'Checks',
            data: { kind: 'value', value: 7 }, value: { path: [], type: 'number' } } },
            asOf: '2026-10-05T01:00:00.000Z', provenance: [{ label: 'Checks summary', digest: 'source-version-1' }] };
        const approvedPreview = structuredClone(preview);
        const artifactId = await createUiApprovalRequest({ serverId, actionId: 'widgets.snapshot.post',
            actionInput: { surface: { serverId, accountId: ACCOUNT_ID, owner: { kind: 'sessionBoard', sessionId: SESSION_ID } },
                itemId, title: 'Checks', preview, placement: { tabId: 'overview', width: 'wide' } },
            actionRequestId: 'checks-snapshot-request' });
        expect(boardWrites()).toHaveLength(0);
        // The caller's source/preview can change while approval is pending;
        // publication must replay admitted bytes, never consult that live source.
        preview.document.root.data.value = 99;
        const decided = await decideApprovalAsInbox(serverId, artifactId, 'approve');
        expect(decided, observed(decided)).toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(boardWrites()).toHaveLength(1);
        expect(boardWrites()[0]?.input).toMatchObject({ operation: 'upsert_item', itemId, expectedItemRevision: null,
            itemContent: { t: 'plain', v: { source: { kind: 'declarative', document: approvedPreview.document },
                snapshot: { asOf: approvedPreview.asOf, provenance: approvedPreview.provenance } } } });
    });

    it('posts from the confirm panel without a second dialog when only the default confirmation applies', async () => {
        // No Settings → Actions requirement for snapshots: the preview the person confirmed is the
        // policy's UI confirmation, so Post publishes at once instead of asking again.
        const serverId = await addBoardHome({ serverUrl: 'https://snapshot-default-home.example',
            uiApproval: ['session.board.layout.update'] });
        const { createElement } = await import('react');
        const { act } = await import('react-test-renderer');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { WidgetSnapshotConfirmPanel } = await import('@/components/widgets/definitions/WidgetSnapshotConfirmPanel');
        const { PluginDeclarativeDocumentV1Schema} = await import('@happier-dev/protocol/plugins/contributions/ui/declarative-document-authoring');
        const document = PluginDeclarativeDocumentV1Schema.parse({ version: 1, root: { kind: 'metric', label: 'Checks',
            data: { kind: 'value', value: 7 }, value: { path: [], type: 'number' } } });
        const capture = () => ({ document, current: true, readIdentity: 'checks', readAuthorized: true, digests: [], refresh: async () => {}, frozenByPath: new Map() });
        // The new item's record read (its id is the confirm's own); the layout keeps its exact answer.
        harness.answer(serverId, `GET /v2/sessions/${SESSION_ID}/system-records/record`, { body: { record: null } });
        // The Board acknowledges the item the confirm created, by its own id.
        harness.answer(serverId, `PUT ${BOARD_PATH}`, { select: (input) => ({ body: { operation: 'upsert_item',
            itemId: (input as { itemId: string }).itemId, outcome: 'created', itemRevision: REVISION, layoutRevision: REVISION } }) });
        let done = 0;
        const screen = await renderScreen(createElement(WidgetSnapshotConfirmPanel, {
            surface: { serverId, accountId: ACCOUNT_ID, owner: { kind: 'sessionBoard', sessionId: SESSION_ID } },
            title: 'Checks', sourceLabel: 'Checks summary', capture, onDone: () => { done += 1; }, onCancel: () => {}, testID: 'snap',
        }));
        await act(async () => { await screen.pressByTestIdAsync('snap.primary'); });
        for (let i = 0; i < 100 && done === 0; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
        expect(done, screen.getTextContent()).toBe(1);
        expect(boardWrites()).toHaveLength(1);
        expect(JSON.stringify(boardWrites()[0]?.input)).toContain('"value":7');
        // Nothing was parked for the Inbox: the one confirm was the panel.
        expect(harness.artifacts(serverId).list().some(row => (harness.artifacts(serverId).readPlainBody(row.id) ?? '').includes('widgets.snapshot.post'))).toBe(false);
        await act(async () => { screen.tree.unmount(); });
    });

    it('posts exactly the numbers the confirm previewed when Account policy requires confirmation', async () => {
        const serverId = await addBoardHome({ serverUrl: 'https://snapshot-confirm-home.example' });
        const { createElement } = await import('react');
        const { act } = await import('react-test-renderer');
        const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
        const { WidgetSnapshotConfirmPanel } = await import('@/components/widgets/definitions/WidgetSnapshotConfirmPanel');
        const [{ PluginDeclarativeDocumentV1Schema}, { freezePluginDeclarativeDataNodeV1}] = await Promise.all([import('@happier-dev/protocol/plugins/contributions/ui/declarative-document-authoring'), import('@happier-dev/protocol/plugins/contributions/ui/declarativeDataV1')]);
        const document = PluginDeclarativeDocumentV1Schema.parse({ version: 1, root: { kind: 'metric', label: 'Checks',
            data: { kind: 'resource', resource: { pluginId: 'acme.checks', localId: 'summary' },
                inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object', properties: { passed: { type: 'number' } } } },
            value: { path: ['passed'], type: 'number' } } });
        // What the card shows now, and what it would show later: the confirm must freeze the first.
        if (document.root.kind !== 'metric') throw new Error('expected a metric document');
        const root = document.root;
        let shown = 7;
        const capture = () => ({ document, current: true, readIdentity: 'checks', readAuthorized: true, digests: ['source-version-1'], refresh: async () => {},
            frozenByPath: new Map([['root', freezePluginDeclarativeDataNodeV1(root, { passed: shown, secret: 'never' })]]) });
        harness.answer(serverId, `GET /v2/sessions/${SESSION_ID}/system-records/record`, { body: { record: null } });
        harness.answer(serverId, `PUT ${BOARD_PATH}`, { select: input => ({ body: { operation: 'upsert_item',
            itemId: (input as { itemId: string }).itemId, outcome: 'created', itemRevision: REVISION, layoutRevision: REVISION } }) });
        let done = 0;
        const screen = await renderScreen(createElement(WidgetSnapshotConfirmPanel, {
            surface: { serverId, accountId: ACCOUNT_ID, owner: { kind: 'sessionBoard', sessionId: SESSION_ID } },
            title: 'Checks', sourceLabel: 'Checks summary', capture, onDone: () => { done += 1; }, onCancel: () => {}, testID: 'snap',
        }));
        shown = 99;
        await act(async () => { await screen.pressByTestIdAsync('snap.primary'); });
        // The panel is the person's completed review, including an explicit
        // Account Ask. Publication still uses its original frozen payload.
        await vi.waitFor(() => expect(done, screen.getTextContent()).toBe(1));
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
        expect(boardWrites()).toHaveLength(1);
        const written = JSON.stringify(boardWrites()[0]?.input);
        expect(written).toContain('"value":7');
        expect(written).not.toContain('"value":99');
        expect(written).not.toContain('never');
        expect(written).not.toContain('acme.checks');
        await act(async () => { screen.tree.unmount(); });
    });
});
