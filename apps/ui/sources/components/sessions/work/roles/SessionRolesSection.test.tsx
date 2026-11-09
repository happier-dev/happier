import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILT_IN_ROLES_V1} from '@happier-dev/protocol/prompts/roles/builtInRolesV1';
import { RoleActionInputSchemasV1, RoleActionOutputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { resolveRolesSnapshotV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { readSessionRolesV1, SessionRolesV1Schema, snapshotSessionRolesAtSpawnV1, writeSessionRoleConfigurationV1ToMetadata } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { isRoleActionIdV1 } from '@happier-dev/protocol/prompts/roles/roleActionIdsV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { Metadata } from '@happier-dev/session-core/state';
import { applyModelIntentSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';

import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { serveSessionActionHome } from '@/dev/testkit/harness/sessionActionHome';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createArtifactListHttpResponse } from '@/dev/testkit/harness/artifactStoreBoundary';
import { parseDecryptedSessionMetadata } from '@/sync/engine/sessions/parsePlainSessionPayload';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Observe remote Session RPC effects beneath the real Action, catalog and policy owners. */
const shared = vi.hoisted(() => ({
    rpc: vi.fn(),
    calls: [] as Array<{ method: string; payload: unknown; serverId: string; sessionId: string }>,
    /** Writes the host refuses (a typed `{ ok: false }`), for the keep-the-draft contract. */
    refused: new Set<string>(),
    alerts: [] as unknown[][],
    platformOS: 'node',
    /** Session metadata writes reaching the socket transport (the Approval reviewer's write path). */
    metadataUpdates: [] as unknown[],
}));

// The platform is a host boundary: keyboard-only reveal is a web contract.
vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('@/dev/reactNativeStub')>('@/dev/reactNativeStub');
    return { ...actual, Platform: { ...actual.Platform, get OS() { return shared.platformOS; } } };
});

// The modal host is the presentation boundary: a refused write is reported there.
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alertAsync: async (...args) => { shared.alerts.push(args); } } }).module;
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', async importOriginal => {
    const { createServerScopedSessionRpcModuleMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    shared.rpc.mockImplementation(async ({ method, payload, serverId, sessionId }: Parameters<typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc')['sessionRpcWithServerScope']>[0]) => {
            if (!serverId) throw new Error('Session RPC requires its exact Home');
            if (!isRoleActionIdV1(method)) throw new Error(`Unexpected Session RPC: ${method}`);
            const input = RoleActionInputSchemasV1[method].parse(payload);
            shared.calls.push({ method, payload: input, serverId, sessionId });
            if (shared.refused.has(method)) return { ok: false, errorCode: 'action_failed', error: 'refused' };
            return RoleActionOutputSchemasV1[method].parse({ updated: true });
    });
    return createServerScopedSessionRpcModuleMock({ importOriginal, overrides: { sessionRpcWithServerScope: shared.rpc } });
});

// The Session metadata socket emit is the transport boundary under the real Action and metadata writer.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/emitSessionMetadataUpdateWithServerScope', () => ({
    emitSessionMetadataUpdateWithServerScope: async (params: any) => {
        shared.metadataUpdates.push(params);
        const session = Object.values((await import('@/sync/domains/state/storageStore')).storage.getState().sessions).find((candidate: any) => candidate.id === params.sessionId) as any;
        return { result: 'success', metadataLayoutVersion: 1, version: (session?.metadataVersion ?? 0) + 1, agentStateVersion: (session?.agentStateVersion ?? 0) + 1 };
    },
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    // Counted copy keeps its count so a summary can be read back ("roles.session.countChanged:2").
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (
            params && 'count' in params ? `${key}:${String(params.count)}` : key
        ),
    });
});

installDisconnectedServerSocketBoundary();
const { SessionRolesSection } = await import('./SessionRolesSection');
const { RoleEnginePicker } = await import('@/components/roles/engine/RoleEngineField');
const { roleActions } = await import('@/sync/ops/roles/roleActions');
const { SessionNotesSection } = await import('./SessionNotesSection');
const { useSessionWorkMenuActions } = await import('../sessionWorkMenuActions');
const { SessionHandsOffRow } = await import('@/components/roles/session/sessionRole');
const { invalidateRoleCatalog, useRoleCatalog } = await import('@/components/roles/catalog/useRoleCatalog');
const { storage } = await import('@/sync/domains/state/storageStore');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
let previousState = storage.getState();
let previousSnapshot = getAppliedActiveServerSnapshot();
let previousAvailable = isAppliedActiveServerRuntimeAvailable();
let connection: Awaited<ReturnType<typeof serveSessionActionHome>> | undefined;
const enabledBuiltInCount = Object.values(BUILT_IN_ROLES_V1).filter(role => role.enabled).length;

function setMetadata(metadata: Partial<Metadata> | null, metadataLayoutVersion = 1) {
    const sessionMetadata = metadata ? { path: '/repo', host: 'test-machine', ...metadata } : null;
    const sharedMetadata = sessionMetadata ? parseDecryptedSessionMetadata(projectSessionSharedMetadataV1({ metadata: sessionMetadata }), 1) : null;
    storage.setState({ sessions: {
        lead: createSessionFixture({ id: 'lead', serverId: connection!.serverId, metadataLayoutVersion,
            metadata: metadataLayoutVersion === 0 ? sessionMetadata : sharedMetadata,
            ...(metadataLayoutVersion === 1 ? { ownerMetadataView: sessionMetadata } : {}) }),
        worker: createSessionFixture({ id: 'worker', serverId: connection!.serverId, metadataLayoutVersion,
            metadata: metadataLayoutVersion === 0 ? sessionMetadata : sharedMetadata,
            ...(metadataLayoutVersion === 1 ? { ownerMetadataView: sessionMetadata } : {}) }),
    } });
}

/** The composite that declared a testID (not the host it painted), for reading its declared props. */
function declared(screen: { findAll: (predicate: (node: any) => boolean) => any[] }, testID: string, prop: string) {
    return screen.findAll((node: any) => node.props?.testID === testID && node.props?.[prop] !== undefined)[0] ?? null;
}

function writes() {
    return shared.calls.map(({ method, payload }) => ({ actionId: method, input: payload }));
}

const researchRole = {
    roleId: 'session:research',
    name: 'Research',
    instructions: 'Read and report.',
    runsAs: { kind: 'background_run', intent: 'task' },
    workspaceWrites: 'deny',
    secondOpinion: 'off',
    enabled: true,
};

async function prepareRolesHome() {
    shared.platformOS = 'node';
    previousState = storage.getState();
    previousSnapshot = getAppliedActiveServerSnapshot();
    previousAvailable = isAppliedActiveServerRuntimeAvailable();
    const promptCatalog = createPromptLibraryCatalogBoundary();
    // Session reads (the Approval reviewer's metadata write reads its latest tuple) take the batch wire.
    const sessionReads = createSessionReadBatchHttpBoundary(async request => {
        const path = request.path;
        if (path === '/v1/artifacts') return createArtifactListHttpResponse(request.url, []);
        // List and exact reads must describe the same Home. An empty list
        // authoritatively withdraws these seeded Sessions during Action catch-up.
        if (path === '/v2/sessions' || path === '/v2/sessions/active') {
            return Response.json({ sessions: Object.values(storage.getState().sessions)
                .map(session => createPlainSessionByIdResponseFixture(session).session),
                nextCursor: null, hasNext: false });
        }
        if (path.startsWith('/v2/sessions/')) {
            const session = storage.getState().sessions[decodeURIComponent(path.slice('/v2/sessions/'.length))];
            if (session) return Response.json(createPlainSessionByIdResponseFixture(session));
        }
        return await promptCatalog.handle(path, { method: request.method,
            body: request.body === undefined ? undefined : JSON.stringify(request.body) }) ?? undefined;
    });
    const activeConnection = await serveSessionActionHome({
        homes: [{ key: 'roles', serverUrl: 'https://session-roles.test', accountId: 'account-1', currentAccount: true }],
        route: request => sessionReads.handle(request),
    });
    connection = activeConnection;
    await activeConnection.restoreActiveConnection();
    await act(async () => {
        shared.calls = [];
        shared.refused = new Set();
        shared.alerts = [];
        setMetadata({ work: { sessionRolesV1: {
            roleId: 'orchestrator',
            overrides: {
                builder: { roleId: 'builder', engine: { agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }), modelId: 'session-model' } },
                orchestrator: { roleId: 'orchestrator', workspaceWrites: 'deny' },
            },
            sessionRoles: { 'session:research': researchRole },
            notes: 'Keep the ledger backfill inside the API session.',
        } } });
        invalidateRoleCatalog();
    });
}

async function disposeRolesHome() {
    standardCleanup();
    if (connection) await disconnectActiveServerConnection();
    await connection?.dispose();
    connection = undefined;
    await act(async () => {
        retireActiveServerAccountScopeLifetime();
        storage.setState(previousState);
        publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
    });
}

describe('Work › Roles and Notes', () => {
    it('does not mark default engine pins as changes in a fresh Session owner view', async () => {
        const agentTargetKey = 'agent:happier.agent.codex/codex';
        const defaultEngine = { agentTargetKey, modelId: 'session-model' };
        setMetadata(applyModelIntentSessionMetadata(writeSessionRoleConfigurationV1ToMetadata({ flavor: 'codex' }, {
            overrides: {}, sessionRoles: resolveRolesSnapshotV1({ defaultEngine }), notes: '',
        }), { v: 1, selection: { ...defaultEngine, providerConnectionId: null }, updatedAt: 1 }));
        const screen = await renderScreen(<SessionRolesSection sessionId="lead" />);
        expect(screen.findAll(node => typeof node.props.testID === 'string'
            && /^session-work-roles\.row\.[^.]+$/u.test(node.props.testID))).toHaveLength(0);
        expect(declared(screen, 'session-work-roles.all', 'detail')!.props.detail).toBe(`roles.session.inUse:${enabledBuiltInCount}`);
    });

    it.each(['override', 'snapshot'] as const)('renders one inherited difference and resets only its %s layer', async layer => {
        const inherited = snapshotSessionRolesAtSpawnV1({ leadSessionId: 'lead', roles: resolveRolesSnapshotV1({
            ...(layer === 'snapshot' ? { settingsOverrides: { builder: { roleId: 'builder', instructionsOverride: 'Inherited build instructions.' } } } : {}),
        }) });
        const produced = writeSessionRoleConfigurationV1ToMetadata({ path: '/repo', host: 'test-machine' }, { ...inherited,
            overrides: layer === 'override' ? { builder: { roleId: 'builder', workspaceWrites: 'deny' } } : {},
        });
        setMetadata(produced);
        // The real configuration writer's output satisfies the exact strict consumer; public metadata carries no role facts.
        expect(SessionRolesV1Schema.parse(readSessionRolesV1(storage.getState().sessions.worker.ownerMetadataView))).toEqual({ ...inherited,
            overrides: layer === 'override' ? { builder: { roleId: 'builder', workspaceWrites: 'deny' } } : {},
        });
        expect(readSessionRolesV1(storage.getState().sessions.worker.metadata)).toBeNull();
        const screen = await renderScreen(<SessionRolesSection sessionId="worker" />);
        const rows = screen.findAll(node => node.props.testID === 'session-work-roles.row.builder' && node.props.title !== undefined);
        expect(rows).toHaveLength(1);
        expect(declared(screen, 'session-work-roles.all', 'detail')!.props.detail).toBe(`roles.session.inUse:${enabledBuiltInCount}`);
        expect(screen.findByTestId('session-agents-section-count:session-work-roles')!.props.children).toBe('roles.session.countChanged:1');
        await screen.pressByTestIdAsync('session-work-roles.row.builder.reset');
        expect(writes()).toEqual([{ actionId: layer === 'override' ? 'session.roles.override.clear' : 'session.roles.remove',
            input: { sessionId: 'worker', roleId: 'builder' } }]);
        expect(storage.getState().sessions.worker.ownerMetadataView).toMatchObject({ work: { sessionRolesV1: { sessionRoles: inherited.sessionRoles } } });
    });

    beforeEach(async () => {
        await prepareRolesHome();
        const catalog = await renderHook(() => useRoleCatalog());
        await vi.waitFor(() => expect(catalog.getCurrent().status).toBe('ready'));
    });

    afterEach(disposeRolesHome);

    it('shows only this session\'s differences on the flat page section, then All roles', async () => {
        const screen = await renderScreen(<SessionRolesSection sessionId="lead" />);
        const rowIds = screen.findAll((node: any) => typeof node.type === 'string'
            && typeof node.props?.testID === 'string'
            && /^session-work-roles\.row\.[^.]+$/u.test(node.props.testID))
            .map((node: any) => node.props.testID);
        expect([...new Set(rowIds)]).toEqual([
            'session-work-roles.row.builder',
            'session-work-roles.row.session:research',
        ]);
        // Lab csinfo I2: the header summarises the differences; the scope reads above the rows.
        const count = screen.findByTestId('session-agents-section-count:session-work-roles')!;
        expect(count.props.children).toBe('roles.session.countChanged:1 · roles.session.countAdded:1');
        expect(screen.findByTestId('session-work-roles.description')!.props.children).toBe('roles.session.info');
        // Each difference is two lines: the name, then where it differs, its engine and how it runs.
        const facts = (roleId: string) => declared(screen, `session-work-roles.row.${roleId}`, 'subtitle')!.props.subtitle as string;
        expect(facts('builder').startsWith('roles.session.changedHere · ')).toBe(true);
        expect(facts('session:research')).toMatch(/^roles\.session\.addedHere · .* · roles\.session\.runsInBackground$|^roles\.session\.addedHere · roles\.session\.runsInBackground$/u);
        // Only a changed role offers Reset, always visible beside the row (never nested in its press target).
        expect(screen.findByTestId('session-work-roles.row.builder.reset')).toBeTruthy();
        expect(screen.findByTestId('session-work-roles.row.session:research.reset')).toBeNull();
        // "All roles" is the trailing row: the enabled catalog roles plus the session-only ones.
        expect(declared(screen, 'session-work-roles.all', 'detail')!.props.detail).toBe(`roles.session.inUse:${enabledBuiltInCount + 1}`);
        // The inline add form and the bulk actions are no longer in the section.
        expect(screen.findByTestId('session-work-roles.addForm')).toBeNull();
        expect(screen.findByTestId('session-work-roles.useDefaults')).toBeNull();
    });

    it.each([0, 1])('summarises only what exists in layout %s: no changes means no count and just All roles', async layout => {
        setMetadata({ work: { sessionRolesV1: { roleId: 'orchestrator', overrides: {}, sessionRoles: {}, notes: '' } } }, layout);
        const screen = await renderScreen(<SessionRolesSection sessionId="lead" />);
        expect(screen.findByTestId('session-agents-section-count:session-work-roles')).toBeNull();
        expect(screen.findByTestId('session-work-roles.row.builder')).toBeNull();
        expect(declared(screen, 'session-work-roles.all', 'detail')!.props.detail).toBe(`roles.session.inUse:${enabledBuiltInCount}`);
    });

    it('offers session-only roles and the session override engine in All roles', async () => {
        const screen = await renderScreen(<SessionRolesSection sessionId="lead" />);
        await act(async () => { screen.findByTestId('session-work-roles.all')!.props.onPress(); });
        expect(screen.findByTestId('roles-rail-option:session:research')).toBeTruthy();
        const builder = screen.findByTestId('roles-rail-option:builder')!;
        expect(builder.findAll((node) => node.children.some((child) => typeof child === 'string' && child.includes('session-model'))).length).toBeGreaterThan(0);
        await act(async () => { screen.findByTestId('roles-rail-option:session:research')!.props.onPress(); });
        expect(writes()).toEqual([{ actionId: 'session.role.set', input: { sessionId: 'lead', roleId: 'session:research' } }]);
    });

    it('offers Use defaults and Apply to sessions under it from the Work ⋯ menu', async () => {
        const hook = await renderHook(() => useSessionWorkMenuActions({ sessionId: 'lead', hasReports: true }));
        expect(hook.getCurrent().map((item) => item.id)).toEqual(['roles.useDefaults', 'roles.applyToReports']);
        await act(async () => { hook.getCurrent()[0]!.onPress?.(); });
        await vi.waitFor(() => expect(writes()).toHaveLength(3));
        expect(writes()).toEqual([
            { actionId: 'session.roles.override.clear', input: { sessionId: 'lead', roleId: 'builder' } },
            { actionId: 'session.roles.override.clear', input: { sessionId: 'lead', roleId: 'orchestrator' } },
            { actionId: 'session.roles.remove', input: { sessionId: 'lead', roleId: 'session:research' } },
        ]);
    });

    it('has no ⋯ menu when there is nothing to reset and no sessions under it', async () => {
        setMetadata({ work: { sessionRolesV1: { roleId: 'orchestrator', overrides: {}, sessionRoles: {}, notes: '' } } });
        const hook = await renderHook(() => useSessionWorkMenuActions({ sessionId: 'lead', hasReports: false }));
        expect(hook.getCurrent()).toEqual([]);
    });

    it('resets a changed role back to its Settings default', async () => {
        const screen = await renderScreen(<SessionRolesSection sessionId="lead" />);
        await act(async () => { screen.findByTestId('session-work-roles.row.builder.reset')!.props.onPress(); });
        await vi.waitFor(() => expect(writes()).toEqual([{ actionId: 'session.roles.override.clear', input: { sessionId: 'lead', roleId: 'builder' } }]));
    });

    it('lets the user relax hands-off from the Role popover through the override Action', async () => {
        const screen = await renderScreen(<SessionHandsOffRow sessionId="lead" roleId="orchestrator" />);
        const toggle = screen.findByTestId('session-role.handsOff')!
            .findAll((node: any) => typeof node.props?.onValueChange === 'function')[0]!;
        expect(toggle.props.value).toBe(true);
        await act(async () => { await toggle.props.onValueChange(false); });
        expect(writes()).toEqual([{
            actionId: 'session.roles.override.set',
            input: { sessionId: 'lead', roleId: 'orchestrator', workspaceWrites: 'allow' },
        }]);
    });

    it('clamps the notes to three lines and offers More only when they overflow', async () => {
        const screen = await renderScreen(<SessionNotesSection sessionId="lead" />);
        const layout = (testID: string, height: number) => screen.findByTestId(testID)!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height } } });
        expect(screen.findByTestId('session-work-notes.text')!.props.numberOfLines).toBe(3);
        await act(async () => { layout('session-work-notes.text', 60); layout('session-work-notes.measure', 60); });
        expect(screen.findByTestId('session-work-notes.more')).toBeNull();
        await act(async () => { layout('session-work-notes.measure', 100); });
        await act(async () => { screen.findByTestId('session-work-notes.more')!.props.onPress(); });
        expect(screen.findByTestId('session-work-notes.text')!.props.numberOfLines).toBeUndefined();
        expect(screen.findByTestId('session-work-notes.more')).toBeNull();
    });

    it('edits the notes with ✎ and saves them through session.notes.set', async () => {
        const screen = await renderScreen(<SessionNotesSection sessionId="lead" />);
        await act(async () => { screen.findByTestId('session-work-notes.edit')!.props.onPress(); });
        await act(async () => { screen.findByTestId('session-work-notes.field')!.props.onChangeText('Run searches as background runs.'); });
        await act(async () => { screen.findByTestId('session-work-notes.save')!.props.onPress(); });
        expect(writes()).toEqual([{
            actionId: 'session.notes.set',
            input: { sessionId: 'lead', notes: 'Run searches as background runs.' },
        }]);
    });

    it('shows one row that starts the notes when there are none', async () => {
        setMetadata({ work: { sessionRolesV1: { roleId: 'orchestrator', overrides: {}, sessionRoles: {}, notes: '' } } });
        const screen = await renderScreen(<SessionNotesSection sessionId="lead" />);
        expect(screen.findByTestId('session-work-notes.text')).toBeNull();
        await act(async () => { screen.findByTestId('session-work-notes.add')!.props.onPress(); });
        expect(screen.findByTestId('session-work-notes.field')).toBeTruthy();
    });

    it.each(['fresh', 'no-op override'] as const)('opens the first inherited Role edit (%s) before writing, preserves cancel, and shows a changed engine', async state => {
        setMetadata({ work: { sessionRolesV1: { overrides: state === 'fresh' ? {} : { builder: { roleId: 'builder' } }, sessionRoles: {}, notes: '' } } });
        const screen = await renderScreen(<SessionRolesSection sessionId="lead" serverId={connection!.serverId} />);
        expect(screen.tree.findAllByType(RoleEnginePicker)).toHaveLength(0);
        await screen.pressByTestIdAsync('session-work-roles.add');
        await screen.pressByTestIdAsync('session-work-roles.add.change.builder');
        const picker = () => screen.tree.findAllByType(RoleEnginePicker)[0]!;
        expect(picker()).toBeTruthy();
        expect(writes()).toEqual([]);
        await act(async () => picker().props.onRequestClose());
        expect(screen.findByTestId('session-work-roles.row.builder')).toBeNull();
        await screen.pressByTestIdAsync('session-work-roles.add');
        await screen.pressByTestIdAsync('session-work-roles.add.change.builder');
        const engine = { agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }), modelId: 'changed-model' };
        // The real picker publishes a choice to the section; its Action and strict RPC remain real.
        await act(async () => picker().props.onChange(engine));
        await vi.waitFor(() => expect(writes()).toEqual([{
            actionId: 'session.roles.override.set', input: { sessionId: 'lead', roleId: 'builder', engine },
        }]));
        const { sessionId: _sessionId, ...override } = RoleActionInputSchemasV1['session.roles.override.set'].parse(shared.calls[0]!.payload);
        // Feed the transport's accepted tuple back through the real metadata producer, like a server echo.
        await act(async () => setMetadata(writeSessionRoleConfigurationV1ToMetadata({}, {
            overrides: { builder: override }, sessionRoles: {}, notes: '',
        })));
        expect(declared(screen, 'session-work-roles.row.builder', 'subtitle')!.props.subtitle).toContain('changed-model');
        expect(screen.findByTestId('session-agents-section-count:session-work-roles')!.props.children).toBe('roles.session.countChanged:1');
    });

    it('opens the role\'s engine from its row', async () => {
        const screen = await renderScreen(<SessionRolesSection sessionId="lead" />);
        expect(screen.findByTestId('role-engine-catalog-state')).toBeNull();
        await act(async () => { declared(screen, 'session-work-roles.row.builder', 'onPress')!.props.onPress(); });
        // The engine popover (the composer's picker) mounts only once the row asks for it.
        await vi.waitFor(() => expect(
            screen.findByTestId('role-engine-catalog-state') ?? screen.findAll((node: any) => node.props?.selectedOptionId !== undefined)[0],
        ).toBeTruthy());
    });

    describe('Approval reviewer for this session', () => {
        const reviewerState = (screen: Awaited<ReturnType<typeof renderScreen>>) => ({
            subtitle: declared(screen, 'session-work-roles.approvalReviewer', 'subtitle')!.props.subtitle,
            value: declared(screen, 'session-work-roles.approvalReviewer', 'value')!.props.value,
        });
        const choose = async (screen: Awaited<ReturnType<typeof renderScreen>>, choice: 'default' | 'on' | 'off') => {
            await screen.pressByTestIdAsync(`session-work-roles.approvalReviewer:${choice}`);
            await vi.waitFor(() => expect(shared.metadataUpdates).toHaveLength(1));
            // What the write stores (not its compare-and-set precondition).
            return (shared.metadataUpdates[0] as { patch: { ownerMetadata: { v: { runtime?: Record<string, unknown> } } } }).patch.ownerMetadata.v.runtime ?? {};
        };

        it.each([false, true])('follows the Account default (%s) until it is set here', async (accountDefault) => {
            await act(async () => { storage.setState({ settings: { ...storage.getState().settings, approvalReviewerEnabled: accountDefault } }); });
            const screen = await renderScreen(<SessionRolesSection sessionId="lead" />);
            expect(reviewerState(screen)).toEqual({ subtitle: 'roles.session.approvalReviewerFollowsDefault', value: 'default' });
        });

        it('reads the session\'s own choice over the Account default', async () => {
            await act(async () => {
                storage.setState({ settings: { ...storage.getState().settings, approvalReviewerEnabled: false } });
                setMetadata({ approvalReviewerEnabled: true, work: { sessionRolesV1: { roleId: 'orchestrator', overrides: {}, sessionRoles: {}, notes: '' } } });
            });
            const screen = await renderScreen(<SessionRolesSection sessionId="lead" />);
            expect(reviewerState(screen)).toEqual({ subtitle: 'roles.session.approvalReviewerOverride', value: 'on' });
        });

        it('sets it for this session through session.approval_reviewer.set', async () => {
            shared.metadataUpdates = [];
            const screen = await renderScreen(<SessionRolesSection sessionId="lead" />);
            expect(await choose(screen, 'on')).toMatchObject({ approvalReviewerEnabled: true });
            await vi.waitFor(() => {
                expect(Object.hasOwn(storage.getState().sessions, 'lead')).toBe(true);
                expect(storage.getState().sessions.lead.ownerMetadataView).toMatchObject({ approvalReviewerEnabled: true });
            });
            await vi.waitFor(() => expect(reviewerState(screen).value).toBe('on'));
        });

        it('returns a session to the Account default by clearing its own choice', async () => {
            await act(async () => {
                setMetadata({ approvalReviewerEnabled: true, work: { sessionRolesV1: { roleId: 'orchestrator', overrides: {}, sessionRoles: {}, notes: '' } } });
            });
            shared.metadataUpdates = [];
            const screen = await renderScreen(<SessionRolesSection sessionId="lead" />);
            // The session stops carrying a value (never a copy of today's default), so later default changes apply.
            expect(await choose(screen, 'default')).not.toHaveProperty('approvalReviewerEnabled');
            await vi.waitFor(() => {
                const metadata = storage.getState().sessions.lead?.ownerMetadataView;
                expect(metadata).toBeTruthy();
                expect(metadata).not.toHaveProperty('approvalReviewerEnabled');
            });
            await vi.waitFor(() => expect(reviewerState(screen)).toEqual({ subtitle: 'roles.session.approvalReviewerFollowsDefault', value: 'default' }));
        });
    });

    it('keeps the notes editor and the draft open when the save is refused', async () => {
        shared.refused.add('session.notes.set');
        const screen = await renderScreen(<SessionNotesSection sessionId="lead" />);
        await act(async () => { screen.findByTestId('session-work-notes.edit')!.props.onPress(); });
        await act(async () => { screen.findByTestId('session-work-notes.field')!.props.onChangeText('Draft the user typed.'); });
        await act(async () => { await screen.findByTestId('session-work-notes.save')!.props.onPress(); });
        await vi.waitFor(() => expect(shared.alerts).toHaveLength(1));
        expect(screen.findByTestId('session-work-notes.field')!.props.value).toBe('Draft the user typed.');
        // Retrying after the host accepts closes the editor.
        shared.refused.clear();
        await act(async () => { await screen.findByTestId('session-work-notes.save')!.props.onPress(); });
        await vi.waitFor(() => expect(screen.findByTestId('session-work-notes.field')).toBeNull());
    });

});

// Session-only role authoring consumes its own snapshot, including while the Account catalog is unavailable.
describe('Session-only role identity', () => {
    beforeEach(prepareRolesHome);
    afterEach(disposeRolesHome);

    it.each([
        ['Review!', 'Review?'],
        ['審査', '確認'],
    ])('creates distinct session roles for %s and %s', async (firstName, secondName) => {
        const screen = await renderScreen(<SessionRolesSection sessionId="lead" />);
        for (const name of [firstName, secondName]) {
            await screen.pressByTestIdAsync('session-work-roles.add');
            await screen.pressByTestIdAsync('session-work-roles.add.new');
            await act(async () => { screen.changeTextByTestId('session-work-roles.addForm.name', name); });
            await screen.pressByTestIdAsync('session-work-roles.addForm.submit');
            await vi.waitFor(() => expect(screen.findByTestId('session-work-roles.addForm')).toBeNull());
        }
        const roles = shared.calls.filter(call => call.method === 'session.roles.add')
            .map(call => RoleActionInputSchemasV1['session.roles.add'].parse(call.payload));
        expect(roles.map(input => input.role.name)).toEqual([firstName, secondName]);
        expect(new Set(roles.map(input => input.roleId)).size).toBe(2);
    });

    it('updates an existing session role engine through session.roles.add with its existing identity', async () => {
        const engine = { agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' }), modelId: 'updated-model' };
        const { roleId, ...role } = researchRole;
        const input = RoleActionInputSchemasV1['session.roles.add'].parse({ sessionId: 'lead', roleId, role: { ...role, engine } });
        await act(async () => {
            expect(await roleActions.addSessionRole('lead', input.roleId, input.role)).toMatchObject({ ok: true });
        });
        await vi.waitFor(() => expect(writes()).toHaveLength(1));
        expect(writes()).toEqual([{
            actionId: 'session.roles.add',
            input: { sessionId: 'lead', roleId: researchRole.roleId, role: expect.objectContaining({
                name: researchRole.name, instructions: researchRole.instructions, engine,
            }) },
        }]);
    });

    it('keeps the new-role draft identity when a refused write is retried after renaming', async () => {
        shared.refused.add('session.roles.add');
        const screen = await renderScreen(<SessionRolesSection sessionId="lead" />);
        await act(async () => { screen.findByTestId('session-work-roles.add')!.props.onPress(); });
        await act(async () => { screen.findByTestId('session-work-roles.add.new')!.props.onPress(); });
        await act(async () => { screen.findByTestId('session-work-roles.addForm.name')!.props.onChangeText('Reviewer'); });
        await act(async () => { await screen.findByTestId('session-work-roles.addForm.submit')!.props.onPress(); });
        await vi.waitFor(() => expect(shared.alerts).toHaveLength(1));
        expect(writes().map((call) => call.actionId)).toEqual(['session.roles.add']);
        expect(screen.findByTestId('session-work-roles.addForm.name')!.props.value).toBe('Reviewer');
        const first = RoleActionInputSchemasV1['session.roles.add'].parse(shared.calls[0]!.payload);
        shared.refused.clear();
        await act(async () => { screen.changeTextByTestId('session-work-roles.addForm.name', 'Revised reviewer'); });
        await screen.pressByTestIdAsync('session-work-roles.addForm.submit');
        await vi.waitFor(() => expect(screen.findByTestId('session-work-roles.addForm')).toBeNull());
        const retried = RoleActionInputSchemasV1['session.roles.add'].parse(shared.calls[1]!.payload);
        expect(retried.roleId).toBe(first.roleId);
        expect(retried.role.name).toBe('Revised reviewer');
    });

});

describe('Work › Roles and Notes session scope', () => {
    beforeEach(async () => {
        await prepareRolesHome();
        const catalog = await renderHook(() => useRoleCatalog());
        await vi.waitFor(() => expect(catalog.getCurrent().status).toBe('ready'));
    });
    afterEach(disposeRolesHome);

    it('allows changing a worker\'s own copied roles and notes', async () => {
        const roles = await renderScreen(<SessionRolesSection sessionId="worker" serverId={connection!.serverId} copiedAtSpawn />);
        expect(declared(roles, 'session-work-roles.all', 'onPress')).toBeTruthy();
        expect(roles.findByTestId('session-work-roles.add')).toBeTruthy();
        const notes = await renderScreen(<SessionNotesSection sessionId="worker" serverId={connection!.serverId} />);
        expect(notes.findByTestId('session-work-notes.edit')).toBeTruthy();
        await act(async () => { roles.findByTestId('session-work-roles.row.builder.reset')!.props.onPress(); });
        await act(async () => { notes.findByTestId('session-work-notes.edit')!.props.onPress(); });
        await act(async () => { notes.findByTestId('session-work-notes.field')!.props.onChangeText('Worker notes'); });
        await act(async () => { notes.findByTestId('session-work-notes.save')!.props.onPress(); });
        await vi.waitFor(() => expect(shared.calls.map(({ method, serverId, sessionId }) => ({ method, serverId, sessionId }))).toEqual([
            { method: 'session.roles.override.clear', serverId: connection!.serverId, sessionId: 'worker' },
            { method: 'session.notes.set', serverId: connection!.serverId, sessionId: 'worker' },
        ]));
    });

    it('does not offer an empty notes form for an unavailable exact-Home Session', async () => {
        const notes = await renderScreen(<SessionNotesSection sessionId="worker" serverId="other-home" />);
        expect(Boolean(notes.findByTestId('session-work-notes.add'))).toBe(false);
        expect(Boolean(notes.findByTestId('session-work-notes.edit'))).toBe(false);
        expect(writes()).toEqual([]);
    });

    it.each(['owner', 'view'] as const)('does not borrow role differences or notes from the public carrier for %s access while the owner view is unavailable', async level => {
        const session = storage.getState().sessions.worker;
        await act(async () => { storage.setState({ sessions: { worker: {
            ...session, access: createSessionAccessFixture(level), metadata: session.ownerMetadataView ?? null, ownerMetadataView: null,
        } } }); });
        const roles = await renderScreen(<SessionRolesSection sessionId="worker" serverId={connection!.serverId} />);
        expect(roles.findByTestId('session-work-roles.row.builder')).toBeNull();
        const notes = await renderScreen(<SessionNotesSection sessionId="worker" serverId={connection!.serverId} />);
        expect(notes.findByTestId('session-work-notes.add')).toBeNull();
        expect(notes.findByTestId('session-work-notes.edit')).toBeNull();
        expect(notes.findByTestId('session-work-notes.text')).toBeNull();
    });

    it('withdraws an open notes editor when its Home changes', async () => {
        const notes = await renderScreen(<SessionNotesSection sessionId="worker" serverId={connection!.serverId} />);
        await act(async () => { notes.findByTestId('session-work-notes.edit')!.props.onPress(); });
        expect(notes.findByTestId('session-work-notes.field')).toBeTruthy();
        await act(async () => { notes.update(<SessionNotesSection sessionId="worker" serverId="home-b" />); });
        expect(notes.findByTestId('session-work-notes.field')).toBeNull();
        expect(notes.findByTestId('session-work-notes.save')).toBeNull();
        expect(writes()).toEqual([]);
    });
});
