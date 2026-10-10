import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcpCatalogSettingsV1 } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { AgentsAcpBackendsUpsertOutputV1Schema } from '@happier-dev/protocol/acp/catalog/catalogMutationsV1';
import { standardCleanup } from '@/dev/testkit';
import { renderSettingsView, type SettingsViewHarness } from '@/dev/testkit/harness/settingsViewHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { getStorage } from '@/sync/domains/state/storage';
import { applyAcpCatalogSnapshot, getAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';
import { refreshAcpCatalog, resetAcpCatalogEngineForTests } from '@/sync/engine/settings/acpCatalogEngine';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { AcpCatalogRowMutationV1Schema, ACP_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { createDeferred } from '@/dev/testkit';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

import { installAcpCatalogSettingsCommonModuleMocks } from './acpCatalogSettingsTestHelpers';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const shared = vi.hoisted(() => ({
    routerPushSpy: vi.fn(),
    routerReplaceSpy: vi.fn(),
    routerBackSpy: vi.fn(),
    modalAlertSpy: vi.fn(),
    settingsState: { value: { v: 2, backends: [] } as AcpCatalogSettingsV1 },
    writes: [] as AcpCatalogSettingsV1[],
    settingsVersion: 1 as number | null,
    refuse: false,
    holdReceipt: false,
    holdRowRead: false,
    failAcknowledgedRefresh: false,
    accountSettings: {} as Record<string, unknown>,
}));
installDisconnectedServerSocketBoundary();
// Metro's lazy module loader is the substituted platform boundary, not Action execution.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
beforeAll(loadSyncSingletonForTests);
let scope: { serverId: string; accountId: string };
let disposeConnection: (() => Promise<void>) | undefined;
let receipt: ReturnType<typeof createDeferred<void>>;
let rowRead: ReturnType<typeof createDeferred<void>>;
let revision = 1;
let artifacts: ReturnType<typeof createArtifactStoreBoundary>;
let interleaveBeforeTerminalArtifact: (() => Promise<void>) | null = null;

installAcpCatalogSettingsCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ confirmResult: true, spies: { alert: shared.modalAlertSpy } }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: '/settings/agents/custom',
            router: {
                push: shared.routerPushSpy,
                replace: shared.routerReplaceSpy,
                back: shared.routerBackSpy,
            },
        }).module;
    },
    storage: async (importOriginal) => importOriginal(),
});

const EDITOR = 'settings.acpCatalog.backendEditor';

function input(screen: SettingsViewHarness, testID: string) {
    const node = screen.findAll((candidate) => candidate.props?.testID === testID
        && typeof candidate.props?.onChangeText === 'function')[0];
    if (!node) throw new Error(`No field ${testID}`);
    return node;
}

async function type(screen: SettingsViewHarness, testID: string, text: string) {
    await act(async () => {
        input(screen, testID).props.onChangeText(text);
    });
}

async function press(screen: SettingsViewHarness, testID: string) {
    await act(async () => {
        await screen.pressByTestIdAsync(testID);
    });
}

function expectSaveEnabled(screen: SettingsViewHarness) {
    expect(screen.findAll((candidate) => candidate.props?.testID === `${EDITOR}.save`
        && typeof candidate.props?.onPress === 'function' && candidate.props.disabled !== true)).not.toHaveLength(0);
}

function expectSavePending(screen: SettingsViewHarness, pending: boolean) {
    const control = screen.findByTestId(`${EDITOR}.save`);
    expect(control?.props.accessibilityState?.busy).toBe(pending);
    if (pending) expect(control?.props.disabled).toBe(true);
}

function errorText(screen: SettingsViewHarness, testID: string): string | null {
    const node = screen.findAll((candidate) => candidate.props?.testID === `${testID}.error`)[0];
    if (!node) return null;
    const children = node.props.children;
    return Array.isArray(children) ? children.join('') : String(children);
}

async function renderEditor(backendId: string | null) {
    applyAcpCatalogSnapshot(scope, shared.settingsVersion === null ? { status: 'loading' } : {
        status: 'ready', revision, record: { v: 1, definitions: shared.settingsState.value.backends },
    }, true);
    const { AcpBackendEditorScreen } = await import('./AcpBackendEditorScreen');
    return renderSettingsView(React.createElement(AcpBackendEditorScreen, { backendId }));
}

const existingKiro = {
    id: 'kiro',
    name: 'kiro',
    title: 'Kiro',
    command: 'kiro-cli',
    args: ['acp'],
    env: {},
    capabilities: {
        supportsLoadSession: false,
        supportsModes: 'unknown' as const,
        supportsModels: 'unknown' as const,
        supportsConfigOptions: 'unknown' as const,
        promptImageSupport: 'unknown' as const,
    },
    createdAt: 1,
    updatedAt: 1,
};

beforeEach(async () => {
    shared.settingsState.value = { v: 2, backends: [] };
    shared.writes = [];
    shared.settingsVersion = 1;
    shared.refuse = false;
    shared.holdReceipt = false;
    shared.holdRowRead = false;
    shared.failAcknowledgedRefresh = false;
    const directActionPolicy = ActionsSettingsV1Schema.parse({ v: 1, actions: {}, approvalWaivedSurfaces: {
        'agents.acp.backends.upsert': ['ui'],
        'agents.acp.backends.delete': ['ui'],
    } });
    shared.accountSettings = { actionsSettingsV1: directActionPolicy };
    receipt = createDeferred<void>();
    rowRead = createDeferred<void>();
    revision = 1;
    interleaveBeforeTerminalArtifact = null;
    artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://acp-editor.test', request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/health') return Response.json({});
        if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v2/account/settings') {
            expect(init?.method).not.toBe('POST');
            return Response.json({ version: 1, content: { t: 'plain', v: shared.accountSettings } });
        }
        const artifactResponse = artifacts.handle(path, init);
        if (artifactResponse) return artifactResponse;
        if (path === ACP_CATALOG_ROWS_ROUTE_V1) {
            if (init?.method === 'POST') {
                const mutation = AcpCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                if (mutation.expectedRevision !== revision) return Response.json({ status: 'conflict', revision });
                if (shared.refuse) return Response.json({ status: 'conflict', revision });
                expect(mutation.content.t).toBe('plain');
                if (mutation.content.t !== 'plain') throw new Error('Unexpected encrypted editor fixture');
                shared.writes.push({ v: 2, backends: mutation.content.v.definitions });
                if (shared.holdReceipt) await receipt.promise;
                shared.settingsState.value = shared.writes.at(-1)!;
                revision += 1;
                if (interleaveBeforeTerminalArtifact) {
                    artifacts.beforeNextUpdate(interleaveBeforeTerminalArtifact);
                    interleaveBeforeTerminalArtifact = null;
                }
                return Response.json({ status: 'updated', revision, cursor: revision });
            }
            if (shared.failAcknowledgedRefresh && shared.writes.length > 0) return new Response(null, { status: 503 });
            if (shared.holdRowRead) await rowRead.promise;
            return Response.json({ status: 'present', revision, content: { t: 'plain', v: { v: 1, definitions: shared.settingsState.value.backends } } });
        }
        return new Response(null, { status: 404 });
    } });
    disposeConnection = connection.dispose;
    scope = { serverId: connection.home.id, accountId: 'account-a' };
    getStorage().setState({ settingsScope: scope, machines: {}, settings: {
        ...getStorage().getState().settings, actionsSettingsV1: directActionPolicy,
    } });
});

afterEach(async () => {
    receipt.resolve();
    rowRead.resolve();
    shared.routerPushSpy.mockReset();
    shared.routerReplaceSpy.mockReset();
    shared.routerBackSpy.mockReset();
    shared.modalAlertSpy.mockReset();
    await standardCleanup();
    await disposeConnection?.();
    resetAcpCatalogEngineForTests(); resetAcpCatalogSnapshotsForTests(); retireActiveServerAccountScopeLifetime();
});

describe('AcpBackendEditorScreen', () => {
    it('executes configured backend authoring through the canonical public UI front door', async () => {
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const execute = createFrontDoorActionExecute();
        await expect(execute('agents.acp.backends.upsert', { backend: existingKiro, expectedRevision: revision }, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            serverId: scope.serverId, expectedAccountId: scope.accountId,
        })).resolves.toMatchObject({ ok: true, result: { backend: { id: 'kiro' }, revision: 2 } });
        expect(shared.writes).toHaveLength(1);
    });
    it.each(['updated', 'conflict'] as const)('keeps the authored draft pending until its actual approval settles (%s)', async (outcome) => {
        const approvalPolicy = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'agents.acp.backends.upsert': { approvalRequiredSurfaces: ['ui'] },
        } });
        shared.accountSettings = { actionsSettingsV1: approvalPolicy };
        getStorage().setState({ settings: { ...getStorage().getState().settings, actionsSettingsV1: approvalPolicy } });
        const screen = await renderEditor(null);
        await type(screen, `${EDITOR}.title`, 'Approved agent');
        await type(screen, `${EDITOR}.command`, 'review');
        await press(screen, `${EDITOR}.save`);
        await waitForHomeGovernance(() => expect(artifacts.list()).toHaveLength(1));
        const artifactId = artifacts.list()[0]!.id;
        expect(shared.writes).toHaveLength(0);
        expectSavePending(screen, true);
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('Approved agent');
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
        expect(shared.routerPushSpy).toHaveBeenCalledWith(`/inbox/approvals/${encodeURIComponent(artifactId)}?serverId=${encodeURIComponent(scope.serverId)}`);
        if (outcome === 'conflict') {
            revision = 2;
            shared.settingsState.value = { v: 2, backends: [existingKiro] };
            await act(async () => { await refreshAcpCatalog(scope); });
        }
        await act(async () => { await decideApprovalAsInbox(scope.serverId, artifactId, 'approve'); });
        await waitForHomeGovernance(() => expectSavePending(screen, false));
        if (outcome === 'updated') {
            expect(shared.writes).toHaveLength(1);
            expect(shared.settingsState.value.backends[0]?.title).toBe('Approved agent');
            expect(shared.routerReplaceSpy).toHaveBeenCalledWith(expect.stringContaining('approved-agent'));
        } else {
            expect(shared.writes).toHaveLength(0);
            expect(shared.settingsState.value.backends[0]?.title).toBe('Kiro');
            expect(input(screen, `${EDITOR}.title`).props.value).toBe('Approved agent');
            expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
        }
    });
    it.each(['reject', 'cancel'] as const)('releases the pending editor without writing or losing its draft when approval is %s', async (decision) => {
        const approvalPolicy = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'agents.acp.backends.upsert': { approvalRequiredSurfaces: ['ui'] },
        } });
        shared.accountSettings = { actionsSettingsV1: approvalPolicy };
        getStorage().setState({ settings: { ...getStorage().getState().settings, actionsSettingsV1: approvalPolicy } });
        const screen = await renderEditor(null);
        await type(screen, `${EDITOR}.title`, 'Canceled approval draft');
        await type(screen, `${EDITOR}.command`, 'review');
        await press(screen, `${EDITOR}.save`);
        await waitForHomeGovernance(() => expect(artifacts.list()).toHaveLength(1));
        expectSavePending(screen, true);
        await act(async () => { await decideApprovalAsInbox(scope.serverId, artifacts.list()[0]!.id, decision); });
        await waitForHomeGovernance(() => expectSavePending(screen, false));
        expect(shared.writes).toHaveLength(0);
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('Canceled approval draft');
        expectSaveEnabled(screen);
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
    });
    it.each(['ordinary ACK', 'interleaved later writer'] as const)('preserves newer editable draft changes when the originally submitted approval is acknowledged (%s)', async (scenario) => {
        const approvalPolicy = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'agents.acp.backends.upsert': { approvalRequiredSurfaces: ['ui'] },
        } });
        shared.accountSettings = { actionsSettingsV1: approvalPolicy };
        getStorage().setState({ settings: { ...getStorage().getState().settings, actionsSettingsV1: approvalPolicy } });
        shared.settingsState.value = { v: 2, backends: [existingKiro] };
        const screen = await renderEditor('kiro');
        await type(screen, `${EDITOR}.title`, 'Originally submitted title');
        await press(screen, `${EDITOR}.save`);
        await waitForHomeGovernance(() => expect(artifacts.list()).toHaveLength(1));
        const artifactId = artifacts.list()[0]!.id;
        expectSavePending(screen, true);
        expect(shared.writes).toHaveLength(0);
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
        expect(input(screen, `${EDITOR}.title`).props.editable).not.toBe(false);
        await type(screen, `${EDITOR}.title`, 'Newer uncommitted title');
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('Newer uncommitted title');
        if (scenario === 'interleaved later writer') {
            // The original row ACK precedes its terminal Artifact. A separate real writer
            // publishes revision 3 while the Artifact's persistence boundary is still open.
            interleaveBeforeTerminalArtifact = async () => {
                expect(revision).toBe(2);
                const { writeAcpCatalogRecord } = await import('@/sync/api/account/apiAcpCatalog');
                const other = await writeAcpCatalogRecord(scope, { expectedRevision: 2,
                    record: { v: 1, definitions: [{ ...existingKiro, title: 'Other writer title' }] } });
                expect(other).toMatchObject({ status: 'updated', revision: 3 });
                expect(getAcpCatalogSnapshot(scope)?.catalog).toMatchObject({ status: 'ready', revision: 3 });
            };
        }
        await act(async () => { await decideApprovalAsInbox(scope.serverId, artifactId, 'approve'); });
        const terminalBody = artifacts.readPlainBody(artifactId);
        if (terminalBody === null) throw new Error('Missing durable approval body');
        const terminal = StoredApprovalRequestSchema.parse(JSON.parse(terminalBody));
        expect(terminal).toMatchObject({ status: 'executed', execution: { ok: true } });
        expect(AgentsAcpBackendsUpsertOutputV1Schema.parse(terminal.execution?.result)).toMatchObject({ revision: 2 });
        await waitForHomeGovernance(() => expectSavePending(screen, false));
        const interleaved = scenario === 'interleaved later writer';
        expect(shared.writes).toHaveLength(interleaved ? 2 : 1);
        expect(shared.writes[0]?.backends[0]?.title).toBe('Originally submitted title');
        expect(shared.settingsState.value.backends[0]?.title).toBe(interleaved ? 'Other writer title' : 'Originally submitted title');
        expect(revision).toBe(interleaved ? 3 : 2);
        expect(errorText(screen, EDITOR)).toBeNull();
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('Newer uncommitted title');
        expectSaveEnabled(screen);
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();

        // A preserved draft is usable only if the first ACK also advanced its CAS authority.
        await press(screen, `${EDITOR}.save`);
        await waitForHomeGovernance(() => expect(artifacts.list()).toHaveLength(2));
        expectSavePending(screen, true);
        expect(shared.writes).toHaveLength(interleaved ? 2 : 1);
        const newerArtifactId = artifacts.list()[1]!.id;
        const newerBody = artifacts.readPlainBody(newerArtifactId);
        if (newerBody === null) throw new Error('Missing second approval body');
        const newerApproval = StoredApprovalRequestSchema.parse(JSON.parse(newerBody));
        expect(newerApproval.actionArgs).toMatchObject({ expectedRevision: 2 });
        await act(async () => { await decideApprovalAsInbox(scope.serverId, newerArtifactId, 'approve'); });
        await waitForHomeGovernance(() => expectSavePending(screen, false));
        expect(shared.writes).toHaveLength(2);
        expect(revision).toBe(3);
        expect(shared.settingsState.value.backends[0]?.title).toBe(interleaved ? 'Other writer title' : 'Newer uncommitted title');
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('Newer uncommitted title');
        if (interleaved) {
            const failedBody = artifacts.readPlainBody(newerArtifactId);
            if (failedBody === null) throw new Error('Missing failed approval body');
            expect(StoredApprovalRequestSchema.parse(JSON.parse(failedBody))).toMatchObject({
                status: 'failed', execution: { ok: false, errorCode: 'acp_catalog_conflict' },
            });
            expectSaveEnabled(screen);
        } else {
            expect(errorText(screen, EDITOR)).toBeNull();
            expect(screen.findByTestId(`${EDITOR}.save`)?.props.disabled).toBe(true);
        }
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
    });
    it('keeps a dirty draft bound to its original row revision when a catalog refresh observes another writer', async () => {
        shared.settingsState.value = { v: 2, backends: [existingKiro] };
        const screen = await renderEditor('kiro');
        await type(screen, `${EDITOR}.title`, 'My uncommitted title');
        shared.settingsState.value = { v: 2, backends: [{ ...existingKiro, title: 'Other writer title' }] };
        revision = 2;
        await act(async () => { await refreshAcpCatalog(scope); });
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('My uncommitted title');
        expectSaveEnabled(screen);
        await press(screen, `${EDITOR}.save`);
        expect(shared.writes).toHaveLength(0);
        expect(shared.settingsState.value.backends[0]?.title).toBe('Other writer title');
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('My uncommitted title');
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
    });
    it.each(['published', 'refresh unavailable'] as const)('settles a new definition baseline without losing later edits and updates its acknowledged identity on the next save (%s)', async (publication) => {
        const approvalPolicy = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'agents.acp.backends.upsert': { approvalRequiredSurfaces: ['ui'] },
        } });
        shared.accountSettings = { actionsSettingsV1: approvalPolicy };
        getStorage().setState({ settings: { ...getStorage().getState().settings, actionsSettingsV1: approvalPolicy } });
        const screen = await renderEditor(null);
        shared.failAcknowledgedRefresh = publication === 'refresh unavailable';
        await type(screen, `${EDITOR}.title`, 'Submitted agent');
        await type(screen, `${EDITOR}.command`, 'review');
        await press(screen, `${EDITOR}.save`);
        await waitForHomeGovernance(() => expect(artifacts.list()).toHaveLength(1));
        await type(screen, `${EDITOR}.title`, 'Later agent title');
        await press(screen, `${EDITOR}.args.add`);
        await type(screen, `${EDITOR}.args.item.0`, ' later argument ');
        await press(screen, `${EDITOR}.args.add`);
        await act(async () => { await decideApprovalAsInbox(scope.serverId, artifacts.list()[0]!.id, 'approve'); });
        await waitForHomeGovernance(() => {
            const body = artifacts.readPlainBody(artifacts.list()[0]!.id);
            if (body === null) throw new Error('Missing first approval body');
            expect(StoredApprovalRequestSchema.parse(JSON.parse(body))).toMatchObject({ status: 'executed', execution: { ok: true } });
            // A hidden editor is the defect under test, so let the next field assertion expose it.
            if (screen.findByTestId(`${EDITOR}.save`)) expectSavePending(screen, false);
        });
        expect(shared.settingsState.value.backends).toEqual([expect.objectContaining({ id: 'submitted-agent', title: 'Submitted agent' })]);
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('Later agent title');
        expect(input(screen, `${EDITOR}.name`).props.value).toBe('submitted-agent');
        if (publication === 'refresh unavailable') expect(screen.findByTestId(`${EDITOR}.save`)?.props.disabled).toBe(true);
        shared.failAcknowledgedRefresh = false;
        await act(async () => { await refreshAcpCatalog(scope); });
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('Later agent title');
        expectSaveEnabled(screen);
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();

        await press(screen, `${EDITOR}.save`);
        await waitForHomeGovernance(() => expect(artifacts.list()).toHaveLength(2));
        const secondArtifact = artifacts.list()[1]!.id;
        const secondBody = artifacts.readPlainBody(secondArtifact);
        if (secondBody === null) throw new Error('Missing second approval body');
        expect(StoredApprovalRequestSchema.parse(JSON.parse(secondBody))).toMatchObject({
            actionArgs: { expectedRevision: 2, backend: { id: 'submitted-agent', title: 'Later agent title', args: [' later argument ', ''] } },
        });
        await act(async () => { await decideApprovalAsInbox(scope.serverId, secondArtifact, 'approve'); });
        await waitForHomeGovernance(() => expectSavePending(screen, false));
        expect(shared.settingsState.value.backends).toEqual([expect.objectContaining({ id: 'submitted-agent', title: 'Later agent title', args: [' later argument ', ''] })]);
        expect(revision).toBe(3);
        expect(screen.findByTestId(`${EDITOR}.save`)?.props.disabled).toBe(true);
        expect(shared.routerReplaceSpy).toHaveBeenCalledWith('/(app)/settings/agents/custom/submitted-agent');
    });

    it('preserves exact launch and login argv through a title-only edit and the public Action', async () => {
        const launchArgs = ['  x  ', '', 'two  words', '\t'];
        const loginArgs = ['', ' login ', 'two\twords', '  '];
        shared.settingsState.value = { v: 2, backends: [{ ...existingKiro, args: launchArgs,
            auth: { support: 'login_terminal', loginCommand: { command: 'kiro-cli', args: loginArgs } },
        }] };
        const screen = await renderEditor('kiro');
        await type(screen, `${EDITOR}.title`, 'Renamed agent');
        await press(screen, `${EDITOR}.save`);
        expect(shared.settingsState.value.backends).toEqual([expect.objectContaining({
            id: 'kiro', title: 'Renamed agent', args: launchArgs,
            auth: expect.objectContaining({ loginCommand: { command: 'kiro-cli', args: loginArgs } }),
        })]);
    });
    it('retains the authored draft and does not write when public UI Action policy disables upsert', async () => {
        shared.accountSettings = { actionsSettingsV1: { v: 1, actions: {
            'agents.acp.backends.upsert': { disabledSurfaces: ['ui'] },
        } } };
        getStorage().setState({ settings: { ...getStorage().getState().settings,
            actionsSettingsV1: ActionsSettingsV1Schema.parse(shared.accountSettings.actionsSettingsV1) } });
        const screen = await renderEditor(null);
        await type(screen, `${EDITOR}.title`, 'Policy retained draft');
        await type(screen, `${EDITOR}.command`, 'review');
        expectSaveEnabled(screen);
        await press(screen, `${EDITOR}.save`);
        expect(shared.writes).toHaveLength(0);
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('Policy retained draft');
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
    });
    it('releases original Home approval custody and retains its draft without enabling save after another Home becomes ready', async () => {
        const approvalPolicy = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'agents.acp.backends.upsert': { approvalRequiredSurfaces: ['ui'] },
        } });
        shared.accountSettings = { actionsSettingsV1: approvalPolicy };
        getStorage().setState({ settings: { ...getStorage().getState().settings, actionsSettingsV1: approvalPolicy } });
        const screen = await renderEditor(null);
        await type(screen, `${EDITOR}.title`, 'Old Account draft');
        await type(screen, `${EDITOR}.command`, 'review');
        await press(screen, `${EDITOR}.save`);
        await waitForHomeGovernance(() => expect(artifacts.list()).toHaveLength(1));
        expectSavePending(screen, true);
        const artifactId = artifacts.list()[0]!.id;
        const body = artifacts.readPlainBody(artifactId);
        if (body === null) throw new Error('Missing original Home approval body');
        expect(StoredApprovalRequestSchema.parse(JSON.parse(body))).toMatchObject({
            actionArgs: { expectedRevision: 1 },
            executionOriginV1: { serverId: scope.serverId, accountId: scope.accountId },
        });
        const replacementWrites: string[] = [];
        const other = await restoreServerAccountForTest({ serverUrl: 'https://other-acp-editor.test', accountId: 'account-b',
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                if (path === ACP_CATALOG_ROWS_ROUTE_V1 && init?.method === 'POST') replacementWrites.push(path);
                if (path === '/health') return Response.json({});
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {} } });
                if (path === '/v1/artifacts') return Response.json([]);
                if (path === ACP_CATALOG_ROWS_ROUTE_V1) return Response.json({ status: 'present', revision: 1,
                    content: { t: 'plain', v: { v: 1, definitions: [] } } });
                return new Response(null, { status: 404 });
            } });
        try {
            const nextScope = { serverId: other.home.id, accountId: 'account-b' };
            await act(async () => {
                getStorage().setState({ settingsScope: nextScope });
                applyAcpCatalogSnapshot(nextScope, { status: 'ready', revision: 1, record: { v: 1, definitions: [] } }, true);
            });
            await waitForHomeGovernance(() => expectSavePending(screen, false));
            expect(input(screen, `${EDITOR}.title`).props.value).toBe('Old Account draft');
            expect(screen.findByTestId(`${EDITOR}.save`)?.props.disabled).toBe(true);
            expect(shared.writes).toHaveLength(0);
            expect(replacementWrites).toHaveLength(0);
            expect(StoredApprovalRequestSchema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!))).toMatchObject({ status: 'open' });
            expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
        } finally { await other.dispose(); }
    });
    it('saves a new agent with an ID made from its name and its arguments in order, then opens it in the collection', async () => {
        const screen = await renderEditor(null);

        await type(screen, `${EDITOR}.title`, 'My Kiro');
        await type(screen, `${EDITOR}.command`, 'kiro-cli');
        await press(screen, `${EDITOR}.args.add`);
        await type(screen, `${EDITOR}.args.item.0`, 'acp');
        await press(screen, `${EDITOR}.args.add`);
        await type(screen, `${EDITOR}.args.item.1`, '--stdio');
        await press(screen, `${EDITOR}.save`);

        expect(shared.writes).toHaveLength(1);
        expect(shared.writes[0]?.backends).toEqual([expect.objectContaining({
            id: 'my-kiro',
            name: 'my-kiro',
            title: 'My Kiro',
            command: 'kiro-cli',
            args: ['acp', '--stdio'],
        })]);
        expect(shared.routerReplaceSpy).toHaveBeenCalledWith('/(app)/settings/agents/custom/my-kiro');
        expect(shared.modalAlertSpy).not.toHaveBeenCalled();
    });

    it('shows each refusal beside its field and writes nothing', async () => {
        const screen = await renderEditor(null);

        await press(screen, `${EDITOR}.save`);

        expect(shared.writes).toHaveLength(0);
        expect(errorText(screen, `${EDITOR}.title`)).toBe('settingsAgents.customAcp.errors.nameRequired');
        expect(errorText(screen, `${EDITOR}.command`)).toBe('settingsAgents.customAcp.errors.commandRequired');
        expect(shared.modalAlertSpy).not.toHaveBeenCalled();

        await type(screen, `${EDITOR}.command`, 'kiro-cli');
        expect(errorText(screen, `${EDITOR}.command`)).toBeNull();
    });

    it('refuses a new agent whose edited ID is already taken instead of replacing that agent', async () => {
        shared.settingsState.value = { v: 2, backends: [existingKiro] };
        const screen = await renderEditor(null);

        await type(screen, `${EDITOR}.title`, 'Kiro again');
        await type(screen, `${EDITOR}.command`, 'kiro-cli');
        await press(screen, `${EDITOR}.editId`);
        await type(screen, `${EDITOR}.id`, 'kiro');
        await press(screen, `${EDITOR}.save`);

        expect(shared.writes).toHaveLength(0);
        expect(errorText(screen, `${EDITOR}.id`)).toBe('settingsAgents.customAcp.errors.idTaken');
    });

    it('updates an existing agent in place and keeps its ID', async () => {
        shared.settingsState.value = { v: 2, backends: [existingKiro] };
        const screen = await renderEditor('kiro');

        await press(screen, `${EDITOR}.args.remove.0`);
        await type(screen, `${EDITOR}.title`, 'Kiro CLI');
        await press(screen, `${EDITOR}.save`);

        expect(shared.writes).toHaveLength(1);
        expect(shared.writes[0]?.backends).toEqual([expect.objectContaining({ id: 'kiro', title: 'Kiro CLI', args: [] })]);
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
    });

    it('says a missing agent is gone only once the Account settings have loaded', async () => {
        shared.settingsVersion = null;
        shared.holdRowRead = true;
        const loading = await renderEditor('kiro');
        expect(loading.findAll((node) => node.props?.description === 'settingsAgents.customAcp.notFound')).toHaveLength(0);

        await act(async () => { rowRead.resolve(); });
        await vi.waitFor(() => expect(loading.findAll((node) => node.props?.description === 'settingsAgents.customAcp.notFound').length).toBeGreaterThan(0));
    });

    it('deletes an existing agent from its menu after confirmation and leaves the page', async () => {
        shared.settingsState.value = { v: 2, backends: [existingKiro] };
        const screen = await renderEditor('kiro');

        const menu = screen.findAll((node) => node.props?.testID === `${EDITOR}.menu`
            && typeof node.props?.onSelect === 'function')[0];
        expect(menu?.props.items.map((item: { id: string }) => item.id)).toEqual(['delete']);
        await act(async () => {
            await menu?.props.onSelect('delete');
        });

        expect(shared.writes.at(-1)?.backends).toEqual([]);
        expect(shared.routerReplaceSpy).toHaveBeenCalledWith('/(app)/settings/agents');
    });
    it('keeps the authored draft on row refusal and navigates only after the durable receipt', async () => {
        const screen = await renderEditor(null);
        await type(screen, `${EDITOR}.title`, 'Retained draft');
        await type(screen, `${EDITOR}.command`, 'review');
        shared.refuse = true;
        await press(screen, `${EDITOR}.save`);
        expect(input(screen, `${EDITOR}.title`).props.value).toBe('Retained draft');
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
        expect(shared.writes).toHaveLength(0);
        shared.refuse = false;
        shared.holdReceipt = true;
        const saving = press(screen, `${EDITOR}.save`);
        await vi.waitFor(() => expect(shared.writes).toHaveLength(1));
        expect(shared.routerReplaceSpy).not.toHaveBeenCalled();
        receipt.resolve();
        await saving;
        await vi.waitFor(() => expect(shared.routerReplaceSpy).toHaveBeenCalledWith('/(app)/settings/agents/custom/retained-draft'));
    });
});
