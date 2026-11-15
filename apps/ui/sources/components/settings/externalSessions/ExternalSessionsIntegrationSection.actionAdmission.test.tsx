import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { Modal } from '@/modal';

const rpc = vi.hoisted(() => ({ installed: false, writes: 0, blockNextStatus: false,
    statusSignals: [] as (AbortSignal | undefined)[] }));
const agent = { pluginId: 'example.agent', localId: 'assistant' };
const preview = { previewId: `hook-install-preview:v1:${'a'.repeat(64)}`, targets: [{ targetId: 'settings',
    absolutePath: '/tmp/agent-settings.json', changes: [{ kind: 'append_json_array_entry', collectionId: 'hooks',
        eventId: 'start', nativeEventName: 'SessionStart', entry: { matcher: null,
            hooks: [{ type: 'command', command: 'happier hook', timeout: 500 }] } }] }] };
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const nativeReview = vi.hoisted(() => ({ hold: false, answer: undefined as undefined | ((value: boolean) => void) }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: {
    show: config => {
        if (config.chrome?.testID === 'actions.confirmation-review.modal' && typeof config.props?.onAnswer === 'function') {
            nativeReview.answer = config.props.onAnswer;
            if (!nativeReview.hold) queueMicrotask(() => nativeReview.answer?.(false));
        }
        return 'hook-review';
    },
} }).module);
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
// The Machine RPC transport is the process boundary; catalog admission, policy,
// controller lifecycle and the native hook response schemas remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async ({ method, machineId, signal }: { method: string; machineId: string; signal?: AbortSignal }) => {
        const status = () => rpc.installed
            ? { state: 'installed_enabled', installationId: 'installation-one' }
            : { state: 'not_installed', installPreview: preview };
        if (method === RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_STATUS_GET) {
            rpc.statusSignals.push(signal);
            if (rpc.blockNextStatus) {
                rpc.blockNextStatus = false;
                await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
            }
            return { ok: true, rows: [{ agent, status: status() }], nextCursor: null, diagnostics: [] };
        }
        if (method === RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_INSTALL) {
            expect(machineId).toBe('machine-one');
            rpc.installed = true;
            rpc.writes += 1;
            return { ok: true, status: status() };
        }
        if (method === RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_UNINSTALL) {
            expect(machineId).toBe('machine-one');
            rpc.installed = false;
            rpc.writes += 1;
            return { ok: true, status: { state: 'not_installed' } };
        }
        throw new Error(`Unexpected Machine RPC: ${method}`);
    },
}));
installDisconnectedServerSocketBoundary();

const { ExternalSessionsIntegrationSection } = await import('./ExternalSessionsIntegrationSection');
const { useExternalSessionsIntegrationController } = await import('./externalSessionsIntegrationController');

afterEach(() => { standardCleanup(); vi.restoreAllMocks(); rpc.installed = false; rpc.writes = 0;
    rpc.blockNextStatus = false; rpc.statusSignals.length = 0; nativeReview.hold = false; nativeReview.answer = undefined; });

describe('external hook Actions from the rendered integration controls', () => {
    it('retires an unanswered inventory on Machine change and can load the original Machine again', async () => {
        const account = await createSecretSettingsTestHarness();
        rpc.blockNextStatus = true;
        function Screen({ machineId }: { machineId: string }) {
            const controller = useExternalSessionsIntegrationController({ machineId, serverId: account.scope.serverId,
                projectionGeneration: 1, agent: { agent, agentTitle: 'Assistant' } });
            return <ExternalSessionsIntegrationSection integrations={controller.integrations} machineId={machineId}
                agent={null} operations={controller.operations} inventoryState={controller.inventoryState} />;
        }
        try {
            const screen = await renderScreen(<Screen machineId="machine-one" />);
            await vi.waitFor(() => expect(rpc.statusSignals.length).toBeGreaterThan(0));
            await screen.update(<Screen machineId="machine-two" />);
            expect(rpc.statusSignals[0]?.aborted).toBe(true);
            await screen.update(<Screen machineId="machine-one" />);
            await vi.waitFor(() => expect(screen.findAll(node => typeof node.props.testID === 'string'
                && node.props.testID.endsWith('-review_install')).length).toBeGreaterThan(0));
            await screen.unmount();
            expect(rpc.statusSignals.every(signal => signal?.aborted === true)).toBe(true);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('retires an install intent when its selected Machine changes during confirmation', async () => {
        const account = await createSecretSettingsTestHarness();
        nativeReview.hold = true;
        const confirm = vi.spyOn(Modal, 'show');
        function Screen({ machineId }: { machineId: string }) {
            const controller = useExternalSessionsIntegrationController({ machineId, serverId: account.scope.serverId,
                projectionGeneration: 1, agent: { agent, agentTitle: 'Assistant' } });
            return <ExternalSessionsIntegrationSection integrations={controller.integrations} machineId={machineId}
                agent={null} operations={controller.operations} inventoryState={controller.inventoryState} />;
        }
        try {
            const screen = await renderScreen(<Screen machineId="machine-one" />);
            const findInstall = () => screen.findAll(node => typeof node.props.testID === 'string'
                && node.props.testID.endsWith('-review_install'))[0];
            await vi.waitFor(() => expect(findInstall()).toBeDefined());
            let installing: Promise<void> | undefined;
            act(() => { installing = findInstall()!.props.onPress(); });
            await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
            await screen.update(<Screen machineId="machine-two" />);
            nativeReview.answer?.(true);
            await act(async () => { await installing; });
            expect(rpc.writes).toBe(0);
            expect(rpc.installed).toBe(false);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('honors disabled Actions, waivers and explicit Ask at the shared owner without a local prompt', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: {
            v: 1, actions: { 'plugins.sessionHooks.install': { disabledSurfaces: ['ui'] } },
        } }) });
        const confirm = vi.spyOn(Modal, 'show');
        function Screen() {
            const controller = useExternalSessionsIntegrationController({ machineId: 'machine-one', serverId: account.scope.serverId,
                projectionGeneration: 1, agent: { agent, agentTitle: 'Assistant' } });
            return <ExternalSessionsIntegrationSection integrations={controller.integrations} machineId="machine-one"
                agent={null} operations={controller.operations} inventoryState={controller.inventoryState} />;
        }
        try {
            const screen = await renderScreen(<Screen />);
            const click = async (suffix: string) => {
                await vi.waitFor(() => expect(screen.findAll(node => typeof node.props.testID === 'string'
                    && node.props.testID.endsWith(suffix)).length).toBeGreaterThan(0));
                const button = screen.findAll(node => typeof node.props.testID === 'string' && node.props.testID.endsWith(suffix))[0]!;
                await act(async () => { await button.props.onPress(); });
            };
            await click('-review_install');
            expect(rpc.installed).toBe(false);
            expect(rpc.writes).toBe(0);
            expect(confirm).not.toHaveBeenCalled();
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1 },
            })); });
            await click('-review_install');
            expect(rpc.writes).toBe(0);
            expect(confirm).toHaveBeenCalledTimes(1);
            const reviewChrome = confirm.mock.calls[0]?.[0].chrome;
            if (reviewChrome?.kind !== 'card') throw new Error('Expected a card confirmation');
            expect(reviewChrome.subtitle).toContain('/tmp/agent-settings.json');
            expect(reviewChrome.subtitle).toContain('happier hook');
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: {
                v: 1, approvalWaivedSurfaces: { 'plugins.sessionHooks.install': ['ui'] },
            } })); });
            await click('-review_install');
            expect(rpc.installed).toBe(true);
            expect(rpc.writes).toBe(1);
            expect(confirm).toHaveBeenCalledTimes(1);
            await click('-uninstall');
            expect(rpc.installed).toBe(true);
            expect(confirm).toHaveBeenCalledTimes(2);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: {
                v: 1, actions: { 'plugins.sessionHooks.uninstall': { approvalRequiredSurfaces: ['ui'] } },
            } })); });
            await click('-uninstall');
            expect(rpc.installed).toBe(true);
            expect(account.artifacts.list()).toHaveLength(0);
            expect(confirm).toHaveBeenCalledTimes(3);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: {
                v: 1, approvalWaivedSurfaces: { 'plugins.sessionHooks.uninstall': ['ui'] },
            } })); });
            await click('-uninstall');
            expect(rpc.installed).toBe(false);
            expect(rpc.writes).toBe(2);
            expect(confirm).toHaveBeenCalledTimes(3);
        } finally { standardCleanup(); await account.dispose(); }
    });
});
