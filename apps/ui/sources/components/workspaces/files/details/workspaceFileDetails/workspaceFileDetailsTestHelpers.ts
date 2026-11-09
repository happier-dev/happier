import { vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

type WorkspaceFileDetailsModuleFactory = () => unknown | Promise<unknown>;

type InstallWorkspaceFileDetailsCommonModuleMocksOptions = Readonly<{
    modal?: WorkspaceFileDetailsModuleFactory;
    reactNative?: WorkspaceFileDetailsModuleFactory;
    text?: WorkspaceFileDetailsModuleFactory;
}>;

const workspaceFileDetailsModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as WorkspaceFileDetailsModuleFactory | undefined,
        reactNative: undefined as WorkspaceFileDetailsModuleFactory | undefined,
        text: undefined as WorkspaceFileDetailsModuleFactory | undefined,
    },
}));

const workspaceFileDetailsActionBoundary = vi.hoisted(() => ({
    read: vi.fn(),
    replace: vi.fn(),
    calls: [] as unknown[],
}));

export function getWorkspaceFileDetailsActionBoundary() {
    return workspaceFileDetailsActionBoundary;
}

const workspaceFileDetailsHomes = createHomeGovernanceHarness();

export function installWorkspaceFileDetailsActionBoundary() {
    installHomeGovernanceBoundaries(workspaceFileDetailsHomes);
    installDisconnectedServerSocketBoundary();
}

export async function answerWorkspaceFileDetailsAccountActions(
    serverId: string, accountId: string, machineId = 'm1',
): Promise<void> {
    for (const actionId of ['daemon.filesystem.readFile', 'daemon.filesystem.writeFile', 'workspace.files.replace'] as const) {
        const boundary = await createExternalActionAccountHttpBoundary({
            serverUrl: 'https://workspace-file-details.test', serverIdentityId: 'srv_workspace_file_details',
            accountId, machineId, actionId, tokenEpoch: 0,
            execute: async (input, context) => {
                const method = getActionSpec(actionId).bindings?.rpcMethod;
                if (!method) throw new Error('Expected filesystem Action RPC binding');
                const request = { machineId, serverId, accountId, method, payload: input,
                    requestId: context.requestId, signal: context.signal };
                workspaceFileDetailsActionBoundary.calls.push(request);
                if (actionId === 'workspace.files.replace') return await workspaceFileDetailsActionBoundary.replace(request);
                return await workspaceFileDetailsActionBoundary.read(request);
            },
        });
        workspaceFileDetailsHomes.answer(serverId, '/v1/machines', { body: [boundary.machine] });
        workspaceFileDetailsHomes.answer(serverId, `/v1/machines/${machineId}`, { body: { machine: boundary.machine } });
        for (const path of [`/v1/actions/${actionId}/execution-authorization`, `/v1/actions/${actionId}`]) {
            workspaceFileDetailsHomes.answer(serverId, path, { select: async (_input, request) => {
                const response = await boundary.handle(new URL(request.url), request.init);
                if (!response) throw new Error(`Unhandled file details HTTP boundary: ${request.url}`);
                return { status: response.status, body: await response.json() };
            } });
        }
    }
}

export async function prepareWorkspaceFileDetailsActionBoundary(machineId = 'm1', accountId = 'account-a'): Promise<string> {
    await workspaceFileDetailsHomes.reset();
    await loadSyncSingletonForTests();
    const serverId = await workspaceFileDetailsHomes.addHome({
        name: 'File details Home',
        serverUrl: 'https://workspace-file-details.test',
        accountId,
        serverIdentityId: 'srv_workspace_file_details',
        currentAccount: true,
    });
    await answerWorkspaceFileDetailsAccountActions(serverId, accountId, machineId);
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    await restoreConnectionToActiveServer({
        token: workspaceFileDetailsHomes.findByServerUrl('https://workspace-file-details.test')!.token!,
    });
    const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
    const scope = getActiveServerAccountScope();
    if (!scope) throw new Error('Expected restored file details Account');
    workspaceFileDetailsActionBoundary.calls.length = 0;
    return scope.serverId;
}

export async function cleanupWorkspaceFileDetailsActionBoundary(): Promise<void> {
    const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
    await disconnectActiveServerConnection();
    await workspaceFileDetailsHomes.reset();
}

export function installWorkspaceFileDetailsCommonModuleMocks(
    options: InstallWorkspaceFileDetailsCommonModuleMocksOptions = {},
) {
    workspaceFileDetailsModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        text: options.text,
    };

    vi.mock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = workspaceFileDetailsModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    });

    vi.mock('@/modal', async () => {
        const activeOptions = workspaceFileDetailsModuleState.options;
        if (activeOptions.modal) {
            return await activeOptions.modal();
        }

        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    });
}
