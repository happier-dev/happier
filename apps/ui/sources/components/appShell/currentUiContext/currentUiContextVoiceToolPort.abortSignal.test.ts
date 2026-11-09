import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { setRuntimeFetch, resetRuntimeFetch } from '@/utils/system/runtimeFetch';

import type { PluginProjectedActionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginUiActionProjection, PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY } from '@/sync/domains/plugins/ui/projectionUnion';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
const daemonRequests = installSessionActionRpcBoundary(() => ({ ok: true, result: { shouldNotIssue: true } }));
let homes: ReturnType<typeof createHomeGovernanceHarness>;
let serverId: string;
let credential: Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>>;
beforeEach(async () => {
    daemonRequests.length = 0;
    homes = createHomeGovernanceHarness();
    setRuntimeFetch(homes.request);
    serverId = await homes.addHome({ name: 'Current UI abort Home', serverUrl: 'https://current-ui-abort.test',
        serverIdentityId: 'srv_current_ui', accountId: 'abort-account', currentAccount: true });
    credential = await TokenStorage.setCredentialsForServerUrlWithRollback('https://current-ui-abort.test', { serverId },
        { token: createAccountTokenForTests('abort-account', { currentAccount: true }) });
    if (!credential) throw new Error('Abort fixture credentials were not persisted');
    homes.answer(serverId, '/v1/auth/ping', { body: { ok: true } });
    homes.answer(serverId, '/health', { body: { status: 'ok' } });
    homes.answer(serverId, '/v1/machines/machine-current-ui', {
        body: { machine: createPlainMachineRowFixture({ id: 'machine-current-ui', accountId: 'abort-account' }) },
    });
});
afterEach(async () => {
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
    await credential?.rollback();
    await homes.reset();
    resetRuntimeFetch();
});

import type { CurrentUiContextResolvedCommand } from './CurrentUiContextProvider';
import { createCurrentUiContextVoiceToolPort } from './currentUiContextVoiceToolPort';

const COMMAND_ID = 'current-ui-command:native-abort';
const ACTION_ID = Object.freeze({ pluginId: 'acme.current-ui', localId: 'retiring-action' });
const ACTION_ORIGIN = Object.freeze({
    machineId: 'machine-current-ui',
    get serverId() { return serverId; },
    interactionEnabled: true,
    phase: 'current' as const,
    executionOrigin: {
        serverIdentityId: 'srv_current_ui',
        materializationRef: {
            pluginId: ACTION_ID.pluginId,
            machineId: 'machine-current-ui',
            materializationId: 'current-ui-materialization',
        },
    },
});

function createDaemonActionProjection(): PluginUiProjectionModel {
    const action: PluginUiActionProjection = Object.freeze({
        id: ACTION_ID.localId,
        pluginId: ACTION_ID.pluginId,
        occurrenceId: 'acme-current-ui-occurrence-41',
        title: 'Retiring action',
        scopes: ['global'],
        surfaces: ['voice'],
        execution: { target: 'daemon' },
        dangerLevel: 'safe',
        available: true,
        [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]: ACTION_ORIGIN,
    } satisfies PluginProjectedActionV2 & Record<typeof PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY, typeof ACTION_ORIGIN>);
    return Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: 41,
        actionsById: Object.freeze({
            [`${ACTION_ID.pluginId}/${ACTION_ID.localId}`]: action,
        }),
    });
}

function withoutAbortSignalAny(): () => void {
    const original = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Object.defineProperty(AbortSignal, 'any', {
        configurable: true,
        writable: true,
        value: undefined,
    });
    return () => {
        if (original) {
            Object.defineProperty(AbortSignal, 'any', original);
        } else {
            Reflect.deleteProperty(AbortSignal, 'any');
        }
    };
}

describe('current UI context Voice command retirement signal', () => {
    it('does not issue a daemon Action when an exact current command is already retired without AbortSignal.any', async () => {
        const retirement = new AbortController();
        const attempt = new AbortController();
        const current: CurrentUiContextResolvedCommand = {
            id: COMMAND_ID,
            command: {
                kind: 'executeAction',
                action: ACTION_ID,
            },
            retirementSignal: retirement.signal,
        };
        const port = createCurrentUiContextVoiceToolPort({
            reader: {
                readCurrentUiContext: () => null,
                resolveCurrentUiCommand: (id) => id === COMMAND_ID ? current : null,
                subscribe: () => () => {},
            },
            readProjection: createDaemonActionProjection,
            readNavigationBinding: () => null,
        });
        if (!port.invokeCurrentUiCommand) throw new Error('missing current UI command invoker');

        retirement.abort(new Error('the exact command was retired before dispatch'));
        const restoreAbortSignalAny = withoutAbortSignalAny();
        try {
            await expect(port.invokeCurrentUiCommand({
                commandId: COMMAND_ID,
                signal: attempt.signal,
            })).resolves.toEqual({ ok: false, code: 'unavailable' });
        } finally {
            restoreAbortSignalAny();
        }
        expect(daemonRequests).toEqual([]);
        expect(homes.requests.filter(request => request.path === '/v1/machines/machine-current-ui')).toEqual([]);
    });
});
