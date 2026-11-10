import * as React from 'react';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

const account = createProviderSettingsAccountHarness();
let reads = 0;
// Only the daemon Socket transport is replaced; mounted credential resolution,
// Action admission, scoped Machine RPC and source parsing all remain real.
installDisconnectedServerSocketBoundary(socket => {
    configureConnectedServerSocketBoundary(socket);
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event: string, payload: unknown) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
        if (!payload || typeof payload !== 'object' || !('method' in payload)
            || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Invalid Socket request');
        if (!payload.method.endsWith(':usage.sources.discover')) throw new Error('Unexpected Machine RPC');
        reads++;
        return { ok: true, result: { sources: [] } };
    });
});
const { useUsageSourcesController } = await import('./useUsageSources');

afterEach(async () => {
    await standardCleanup();
    await account.reset();
});

it('starts each Sources revisit only after mounted Account binding, without a false machine failure or extra read', async () => {
    onTestFinished(await installRealActionExecutorModuleLoader());
    const rpc = createProviderSettingsHarness();
    await account.restore({ machines: rpc.state.machines, currentAccount: true });
    const lifetime = captureActiveServerAccountScopeLifetime();
    expect(lifetime).not.toBeNull();
    reads = 0;
    const failures: string[] = [];
    let attempts = 0;
    for (let visit = 0; visit < 2; visit++) {
        const hook = await renderHook(() => {
            const result = useUsageSourcesController({ machineId: 'machine-a', lifetime });
            React.useEffect(() => {
                const controller = result.controller;
                if (!controller || !result.ready) return;
                const unsubscribe = controller.subscribe(() => {
                    const snapshot = controller.getSnapshot();
                    if (snapshot.machineReadFailed) failures.push(snapshot.error?.errorCode ?? 'missing_code');
                });
                attempts++;
                void controller.discover();
                return unsubscribe;
            }, [result.controller, result.ready]);
            if (result.snapshot.machineReadFailed) failures.push(result.snapshot.error?.errorCode ?? 'missing_code');
            return result;
        });
        await act(async () => {
            await vi.waitFor(() => expect(hook.getCurrent().snapshot.loaded).toBe(true));
            await vi.waitFor(() => expect(reads).toBe(visit + 1));
        });
        expect(failures).toEqual([]);
        expect(attempts, 'One admitted source read per arrival, including before credential binding settles').toBe(visit + 1);
        expect(hook.getCurrent().snapshot.error).toBeNull();
        await hook.unmount();
    }
    expect(reads).toBe(2);
});
