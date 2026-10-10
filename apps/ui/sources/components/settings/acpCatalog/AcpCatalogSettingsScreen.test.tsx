import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcpBackendDefinitionV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowMutationV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { createDeferred, standardCleanup } from '@/dev/testkit';
import { renderSettingsView, type SettingsViewHarness } from '@/dev/testkit/harness/settingsViewHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createArtifactStoreBoundary, type ArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { getStorage } from '@/sync/domains/state/storage';
import { applyAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';
import { refreshAcpCatalog, resetAcpCatalogEngineForTests } from '@/sync/engine/settings/acpCatalogEngine';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { installAcpCatalogSettingsCommonModuleMocks } from './acpCatalogSettingsTestHelpers';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const shared = vi.hoisted(() => ({
    routerPushSpy: vi.fn(),
    modalAlertSpy: vi.fn(),
    modalConfirmSpy: vi.fn<() => Promise<boolean>>(),
}));
installDisconnectedServerSocketBoundary();
// Substitute Metro's lazy loader only; the default Action executor and all admission remain real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
installAcpCatalogSettingsCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { alert: shared.modalAlertSpy, confirm: shared.modalConfirmSpy } }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ pathname: '/settings/acp-catalog', router: { push: shared.routerPushSpy } }).module;
    },
    storage: async (importOriginal) => importOriginal(),
});
beforeAll(loadSyncSingletonForTests);

const existingKiro: AcpBackendDefinitionV1 = {
    id: 'custom-kiro', name: 'custom-kiro', title: 'Custom Kiro', command: 'kiro-cli',
    args: ['acp', '--agent', 'spec'], env: {},
    capabilities: { supportsLoadSession: true, supportsModes: 'yes', supportsModels: 'yes', supportsConfigOptions: 'unknown', promptImageSupport: 'yes' },
    createdAt: 1, updatedAt: 1,
};
let scope: { serverId: string; accountId: string };
let disposeConnection: (() => Promise<void>) | undefined;
let artifacts: ArtifactStoreBoundary;
let definitions: AcpBackendDefinitionV1[];
let writes: AcpBackendDefinitionV1[][];
let revision: number;
let accountSettings: Record<string, unknown>;
let confirmation: ReturnType<typeof createDeferred<boolean>> | undefined;

function setPolicy(actions: Record<string, unknown>, waive = true) {
    const policy = ActionsSettingsV1Schema.parse({ v: 1, actions,
        ...(waive ? { approvalWaivedSurfaces: { 'agents.acp.backends.delete': ['ui'] } } : {}),
    });
    accountSettings = { actionsSettingsV1: policy };
    getStorage().setState({ settings: { ...getStorage().getState().settings, actionsSettingsV1: policy } });
}

beforeEach(async () => {
    shared.routerPushSpy.mockReset();
    shared.modalAlertSpy.mockReset();
    shared.modalConfirmSpy.mockReset().mockResolvedValue(true);
    definitions = [existingKiro];
    writes = [];
    revision = 1;
    confirmation = undefined;
    artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
    setPolicy({});
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://acp-list.test', request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/health') return Response.json({});
        if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v2/account/settings') {
            expect(init?.method).not.toBe('POST');
            return Response.json({ version: 1, content: { t: 'plain', v: accountSettings } });
        }
        const artifactResponse = artifacts.handle(path, init);
        if (artifactResponse) return artifactResponse;
        if (path === ACP_CATALOG_ROWS_ROUTE_V1) {
            if (init?.method === 'POST') {
                const mutation = AcpCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                if (mutation.expectedRevision !== revision) return Response.json({ status: 'conflict', revision });
                if (mutation.content.t !== 'plain') throw new Error('Unexpected encrypted list fixture');
                definitions = mutation.content.v.definitions;
                writes.push(definitions);
                revision += 1;
                return Response.json({ status: 'updated', revision, cursor: revision });
            }
            return Response.json({ status: 'present', revision, content: { t: 'plain', v: { v: 1, definitions } } });
        }
        return new Response(null, { status: 404 });
    } });
    disposeConnection = connection.dispose;
    scope = { serverId: connection.home.id, accountId: 'account-a' };
    getStorage().setState({ settingsScope: scope, machines: {} });
});

afterEach(async () => {
    confirmation?.resolve(false);
    await standardCleanup();
    retireActiveServerAccountScopeLifetime();
    resetAcpCatalogEngineForTests();
    resetAcpCatalogSnapshotsForTests();
    await disposeConnection?.();
    disposeConnection = undefined;
});

async function renderScreen() {
    applyAcpCatalogSnapshot(scope, { status: 'ready', revision, record: { v: 1, definitions } }, true);
    const { AcpCatalogSettingsScreen } = await import('./AcpCatalogSettingsScreen');
    return renderSettingsView(React.createElement(AcpCatalogSettingsScreen));
}

async function longPressBackend(screen: SettingsViewHarness) {
    const row = screen.findRow('settings.acpCatalog.backend.custom-kiro');
    expect(row).not.toBeNull();
    await act(async () => { row?.props.onLongPress(); });
}

describe('AcpCatalogSettingsScreen', () => {
    it('renders Account-row backends and routes backend actions to the editor', async () => {
        const screen = await renderScreen();
        expect(screen.findRowByTitle('Custom Kiro')).not.toBeNull();
        expect(screen.findRow('settings.acpCatalog.builtIn.kiro')).toBeNull();
        expect(screen.findRow('settings.acpCatalog.addPreset')).toBeNull();
        screen.pressRow('settings.acpCatalog.addBackend');
        screen.pressRow('settings.acpCatalog.backend.custom-kiro');
        expect(shared.routerPushSpy).toHaveBeenNthCalledWith(1, '/(app)/settings/agents/custom');
        expect(shared.routerPushSpy).toHaveBeenNthCalledWith(2, '/(app)/settings/agents/custom/custom-kiro');
    });

    it('shows only Add for an empty ready Account row', async () => {
        definitions = [];
        const screen = await renderScreen();
        expect(screen.findRow('settings.acpCatalog.addBackend')).not.toBeNull();
        expect(screen.listRows('settings.acpCatalog.backend.')).toHaveLength(0);
        expect(screen.findRow('settings.acpCatalog.backends.empty')).toBeNull();
    });

    it('refuses long-press Delete when the public Action is disabled on ui', async () => {
        setPolicy({ 'agents.acp.backends.delete': { disabledSurfaces: ['ui'] } });
        const screen = await renderScreen();
        await longPressBackend(screen);
        await vi.waitFor(() => expect(writes.length + shared.modalAlertSpy.mock.calls.length).toBeGreaterThan(0));
        expect(writes).toHaveLength(0);
        expect(definitions).toEqual([existingKiro]);
        expect(screen.findRow('settings.acpCatalog.backend.custom-kiro')).not.toBeNull();
    });

    it('keeps the original row CAS while confirmation is open', async () => {
        confirmation = createDeferred<boolean>();
        shared.modalConfirmSpy.mockImplementation(() => confirmation!.promise);
        const screen = await renderScreen();
        await longPressBackend(screen);
        expect(shared.modalConfirmSpy).toHaveBeenCalledOnce();
        definitions = [{ ...existingKiro, title: 'Changed by another client' }];
        revision = 2;
        await act(async () => { await refreshAcpCatalog(scope); });
        await act(async () => { confirmation!.resolve(true); });
        await vi.waitFor(() => expect(shared.modalAlertSpy).toHaveBeenCalled());
        expect(writes).toHaveLength(0);
        expect(definitions[0]?.title).toBe('Changed by another client');
    });

    it('leaves Delete pending for Inbox approval and removes the row only after its real execution', async () => {
        setPolicy({ 'agents.acp.backends.delete': { approvalRequiredSurfaces: ['ui'] } }, false);
        const screen = await renderScreen();
        await longPressBackend(screen);
        await vi.waitFor(() => expect(artifacts.list().length + writes.length).toBeGreaterThan(0));
        expect(writes).toHaveLength(0);
        expect(artifacts.list()).toHaveLength(1);
        const artifactId = artifacts.list()[0]!.id;
        expect(writes).toHaveLength(0);
        expect(screen.findRow('settings.acpCatalog.backend.custom-kiro')).not.toBeNull();
        expect(shared.modalAlertSpy).not.toHaveBeenCalled();
        expect(shared.routerPushSpy).toHaveBeenCalledWith('/inbox/approvals/' + encodeURIComponent(artifactId) + '?serverId=' + encodeURIComponent(scope.serverId));
        await expect(decideApprovalAsInbox(scope.serverId, artifactId, 'approve')).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
        await vi.waitFor(() => expect(screen.findRow('settings.acpCatalog.backend.custom-kiro')).toBeNull());
        expect(writes).toEqual([[]]);
        expect(shared.modalAlertSpy).not.toHaveBeenCalled();
    });
});
