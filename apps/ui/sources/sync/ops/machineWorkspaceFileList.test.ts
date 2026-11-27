import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { FILESYSTEM_BROWSER_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { storage } from '@/sync/domains/state/storage';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
// The chooser imports Socket through the real Sync graph during collection.
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@legendapp/list/react-native', async importOriginal => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<typeof import('@legendapp/list/react-native')>(), renderItems: true }).module;
});
const outgoing: Array<Readonly<{ actionId: string; input: unknown; surface: string; authority: string }>> = [];
let respond: (request: Readonly<{ actionId: string; input: unknown }>, signal?: AbortSignal | null) => Promise<unknown>;
const rawRpcRequests = installSessionActionRpcBoundary(() => { throw new Error('Unexpected raw filename RPC'); });
const initialState = storage.getState();
let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

describe('machineWorkspaceFileList', () => {
    it.each([
        ['MACHINE_RPC_FAILED', 'errors.searchFailed'],
        [RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, 'errors.daemonUnavailableBody'],
    ] as const)('presents %s in the targeted folder chooser', async (errorCode, messageKey) => {
        const { renderScreen } = await import('@/dev/testkit');
        const { t } = await import('@/text');
        const { MachinePathBrowserView } = await import('@/components/ui/pathBrowser/MachinePathBrowserModal');
        respond = async (request) => request.actionId === FILESYSTEM_BROWSER_ACTION_IDS_V1.listFiles
            ? { ok: false, errorCode: 'MACHINE_RPC_FAILED', error: 'relay failed' }
            : { ok: true, path: '/repo', entries: [], truncated: false };
        const screen = await renderScreen(React.createElement(MachinePathBrowserView, {
            machineId: 'm1', serverId, rootDirectoryPath: '/repo', variant: 'popover',
            onPickPath: () => {},
        }));
        try {
            await act(async () => { screen.changeTextByTestId('path-browser-search', 'src'); });
            await vi.waitFor(() => expect(outgoing.some(request => request.actionId === FILESYSTEM_BROWSER_ACTION_IDS_V1.listFiles)).toBe(true));
            await vi.waitFor(() => {
                expect(screen.getTextContent()).toContain(t(messageKey));
            });
        } finally { await screen.unmount(); }
    });
    it('preserves missing-method, transport/admission and invalid-response outcomes through filename search', async () => {
        const { searchWorkspaceFiles, WorkspaceFileSearchUnavailableError } = await import('@/sync/domains/workspaces/files/workspaceFileSearch');
        const cases = [
            { ack: { ok: false, errorCode: 'root_not_found' }, code: 'root_not_found' },
            { ack: { ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, error: 'missing listener' }, code: 'target_unavailable' },
            { ack: { ok: false, errorCode: 'method_unavailable' }, code: 'target_unavailable' },
            { ack: { ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'missing method' }, code: 'update_required' },
            { ack: { ok: false, errorCode: 'MACHINE_RPC_FAILED', error: 'transport' }, code: 'MACHINE_RPC_FAILED' },
            { ack: { ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN, error: 'admission' }, code: RPC_ERROR_CODES.FORBIDDEN },
            // Unknown fields violate the producer's strict response contract.
            { ack: { ok: true, paths: [], truncated: false, unexpected: true }, code: 'invalid_action_output' },
        ];
        for (const testCase of cases) {
            respond = async () => testCase.ack;
            const failure = await searchWorkspaceFiles({
                scope: { serverId, machineId: 'm1', rootPath: '/repo' }, query: 'src', mode: 'glob',
            }).catch((error: unknown) => error);
            expect.soft(failure).toBeInstanceOf(WorkspaceFileSearchUnavailableError);
            expect.soft(failure).toMatchObject({ errorCode: testCase.code });
        }
    });
    beforeEach(async () => {
        const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
        await loadSyncSingletonForTests();
        serverId = await homes.addHome({ name: 'Workspace', serverUrl: 'https://workspace-files.test', serverIdentityId: 'srv_workspace_files', accountId: 'account-a', currentAccount: true });
        for (const actionId of Object.values(FILESYSTEM_BROWSER_ACTION_IDS_V1)) {
            const boundary = await createExternalActionAccountHttpBoundary({ serverUrl: 'https://workspace-files.test',
                serverIdentityId: 'srv_workspace_files', accountId: 'account-a', machineId: 'm1', actionId, tokenEpoch: 0,
                requesterInvocation: 'required', execute: async (input, context) => {
                    const request = { actionId, input, surface: context.invocation.surface, authority: context.invocation.authority };
                    outgoing.push(request);
                    return await respond(request, context.signal);
                }, failure: result => {
                    if (!result || typeof result !== 'object' || !('error' in result) || !('errorCode' in result)
                        || typeof result.error !== 'string' || typeof result.errorCode !== 'string') return null;
                    return { error: result.error, errorCode: result.errorCode };
                },
            });
            homes.answer(serverId, '/v1/machines/m1', { body: { machine: boundary.machine } });
            homes.answer(serverId, '/v1/machines', { body: [boundary.machine] });
            for (const path of [`/v1/actions/${actionId}/execution-authorization`, `/v1/actions/${actionId}`]) {
                homes.answer(serverId, path, { select: async (_body, request) => {
                    const response = await boundary.handle(new URL(request.url), request.init);
                    if (!response) throw new Error('Unexpected filename Action endpoint');
                    return { status: response.status, body: await response.json() };
                } });
            }
        }
        const settings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            approvalWaivedSurfaces: Object.fromEntries(Object.values(FILESYSTEM_BROWSER_ACTION_IDS_V1).map(id => [id, ['ui', 'agent']])),
        }) };
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://workspace-files.test');
        if (!credentials) throw new Error('Filename Home credentials are missing');
        connection = await restoreServerAccountForTest({ serverUrl: 'https://workspace-files.test', serverIdentityId: 'srv_workspace_files', accountId: 'account-a', credentials, request: homes.request });
        const { sync } = await import('@/sync/sync');
        await sync.awaitBootstrapForegroundAcquisition();
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const scope = getActiveServerAccountScope();
        if (!scope || scope.accountId !== 'account-a') throw new Error('Filename Account was not restored');
        serverId = scope.serverId;
        await storage.getState().activateSettingsScope(scope);
        storage.getState().applySettingsForScope({ serverId, accountId: 'account-a' }, settings, 1);
        installHomeGovernanceBoundaries(homes);
        outgoing.length = 0;
        rawRpcRequests.length = 0;
        respond = async () => ({ ok: true, paths: ['src/a.ts'], truncated: false });
    });
    afterEach(async () => {
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
        await connection?.dispose(); connection = undefined;
        await homes.reset();
        storage.setState(initialState, true);
        vi.restoreAllMocks();
    });

    it('sends only a typed exact-workspace request and forwards cancellation', async () => {
        const controller = new AbortController();
        const { machineWorkspaceFileList } = await import('./machineWorkspaceFileList');
        await expect(machineWorkspaceFileList('m1', { rootPath: '/repo', query: 'a', limit: 50 }, {
            serverId, accountId: 'account-a', signal: controller.signal, timeoutMs: 1200,
        })).resolves.toEqual({ ok: true, paths: ['src/a.ts'], truncated: false });
        expect(outgoing).toMatchObject([{ actionId: FILESYSTEM_BROWSER_ACTION_IDS_V1.listFiles,
            input: { rootPath: '/repo', query: 'a', limit: 50, budgetMs: 1200 } }]);
        expect(rawRpcRequests).toEqual([]);
        // The exact Machine row is read through the Machine read batch (a532f4a1e0).
        const { areServerProfileIdentifiersEquivalent } = await import('@/sync/domains/server/serverProfiles');
        expect(areServerProfileIdentifiersEquivalent(homes.requestsFor('/v1/machines/read-batch')[0]?.serverId, serverId)).toBe(true);

        respond = async () => ({ ok: true, paths: ['src/partial.ts'], truncated: true });
        await expect(machineWorkspaceFileList('m1', { rootPath: '/repo', budgetMs: 1 }, {
            serverId, accountId: 'account-a', signal: controller.signal, timeoutMs: 1200,
        })).resolves.toEqual({ ok: true, paths: ['src/partial.ts'], truncated: true });
        expect(outgoing[1]?.input).toMatchObject({ budgetMs: 1 });

        // Abort while the genuine network acknowledgement is outstanding. The
        // same scoped RPC owner must surface cancellation rather than an empty
        // successful inventory or the old-daemon unavailability projection.
        let release: (() => void) | undefined;
        respond = async (_request, signal) => await new Promise((resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
            release = () => resolve({ ok: true, paths: [], truncated: false });
        });
        const pending = machineWorkspaceFileList('m1', { rootPath: '/repo' }, { serverId, accountId: 'account-a', signal: controller.signal });
        await vi.waitFor(() => expect(outgoing).toHaveLength(3));
        const rejected = expect(pending).rejects.toBeInstanceOf(Error);
        controller.abort();
        await rejected;
        release?.();
    });

    it('distinguishes a successful empty result from an unavailable old daemon', async () => {
        const { machineWorkspaceFileList } = await import('./machineWorkspaceFileList');
        respond = async () => ({ ok: true, paths: [], truncated: false });
        await expect(machineWorkspaceFileList('m1', { rootPath: '/repo' }, { serverId, accountId: 'account-a' }))
            .resolves.toEqual({ ok: true, paths: [], truncated: false });
        respond = async () => ({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, error: 'method unavailable' });
        await expect(machineWorkspaceFileList('m1', { rootPath: '/repo' }, { serverId, accountId: 'account-a' }))
            .resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    });

    it('retains directory fallback for an admitted native filename capability failure', async () => {
        const { searchWorkspaceFiles } = await import('@/sync/domains/workspaces/files/workspaceFileSearch');
        respond = async request => request.actionId === FILESYSTEM_BROWSER_ACTION_IDS_V1.listFiles
            ? { ok: false, errorCode: 'ripgrep_unavailable' }
            : { ok: true, path: '/native-capability', entries: [
                { name: 'secret.ts', path: '/native-capability/secret.ts', type: 'file' },
            ], truncated: false };
        await expect(searchWorkspaceFiles({ scope: { serverId, machineId: 'm1', rootPath: '/native-capability' },
            query: 'secret' })).resolves.toEqual([expect.objectContaining({ fullPath: 'secret.ts' })]);
        expect(outgoing.map(request => request.actionId)).toEqual([
            FILESYSTEM_BROWSER_ACTION_IDS_V1.listFiles, FILESYSTEM_BROWSER_ACTION_IDS_V1.browseDirectory,
        ]);
        expect(rawRpcRequests).toEqual([]);
    });

    it('does not replace an agent-refused filename Action with directory fallback reads', async () => {
        const { searchWorkspaceFiles, WorkspaceFileSearchUnavailableError } = await import('@/sync/domains/workspaces/files/workspaceFileSearch');
        const { machineFilesystemListDirectory } = await import('./machineFileBrowser');
        const settings = { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
            actions: { [FILESYSTEM_BROWSER_ACTION_IDS_V1.listFiles]: { disabledSurfaces: ['agent'] } },
            approvalWaivedSurfaces: Object.fromEntries(Object.values(FILESYSTEM_BROWSER_ACTION_IDS_V1).map(id => [id, ['ui', 'agent']])),
        }) };
        const version = (storage.getState().settingsVersion ?? 0) + 1;
        storage.getState().applySettingsForScope({ serverId, accountId: 'account-a' }, settings, version);
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version } });
        respond = async request => request.actionId === FILESYSTEM_BROWSER_ACTION_IDS_V1.browseDirectory
            ? { ok: true, path: '/read-policy', entries: [{ name: 'secret.ts', path: '/read-policy/secret.ts', type: 'file' }], truncated: false }
            : { ok: true, paths: ['secret.ts'], truncated: false };
        // The alternative route genuinely works for this actor, so a transport
        // or fixture failure cannot masquerade as refusal of the filename Action.
        await expect(machineFilesystemListDirectory('m1', { path: '/read-policy', includeFiles: true }, {
            serverId, accountId: 'account-a', callerContext: { surface: 'agent', authority: 'account_automation',
                expectedAccountId: 'account-a', actionRequestId: 'filename-policy-allowed-directory' },
        })).resolves.toMatchObject({ ok: true, entries: [{ name: 'secret.ts' }] });
        expect(outgoing).toHaveLength(1);
        outgoing.length = 0;
        const { machineWorkspaceFileList } = await import('./machineWorkspaceFileList');
        await expect(machineWorkspaceFileList('m1', { rootPath: '/read-policy' }, {
            serverId, accountId: 'account-a', callerContext: { surface: 'agent', authority: 'account_automation',
                expectedAccountId: 'account-a', actionRequestId: 'filename-policy-refusal-baseline' },
        })).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
        expect(outgoing).toEqual([]);
        const result = await searchWorkspaceFiles({ scope: { serverId, machineId: 'm1', rootPath: '/read-policy' },
            query: 'secret', callerContext: { surface: 'agent', authority: 'account_automation',
                expectedAccountId: 'account-a', actionRequestId: 'filename-refused-agent-read' } }).catch((error: unknown) => error);
        expect(result, JSON.stringify(outgoing)).toBeInstanceOf(WorkspaceFileSearchUnavailableError);
        expect(result).toMatchObject({ errorCode: 'action_disabled' });
        expect(outgoing).toEqual([]);
        expect(rawRpcRequests).toEqual([]);
    });
});
