import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { PluginUiResourceSnapshot } from '@happier-dev/plugin-ui/hostApi';

const machineResourceRpc = vi.hoisted(() => ({
    read: vi.fn(),
    open: vi.fn(),
    next: vi.fn(),
    close: vi.fn(),
}));

// Resource RPC is the process boundary. Keep the provider, contextual clients,
// Resource store, and watch pump real so lifecycle assertions cannot pass by
// bypassing the owner under test.
vi.mock('@/sync/ops/machineContributionRegistryProjection', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/ops/machineContributionRegistryProjection')>()),
    machinePluginUiResourceRead: (...args: never[]) => (
        machineResourceRpc.read as (...values: unknown[]) => unknown
    )(...args),
    machinePluginUiResourceWatchOpen: (...args: never[]) => (
        machineResourceRpc.open as (...values: unknown[]) => unknown
    )(...args),
    machinePluginUiResourceWatchNext: (...args: never[]) => (
        machineResourceRpc.next as (...values: unknown[]) => unknown
    )(...args),
    machinePluginUiResourceWatchClose: (...args: never[]) => (
        machineResourceRpc.close as (...values: unknown[]) => unknown
    )(...args),
}));

import {
    PluginContextualResourceState,
    PluginContextualResourceStoreProvider,
    type PluginContextualResourceBinding,
    usePluginContextualResourceStoreOwner,
    type PluginContextualResourceStoreOwner,
} from './PluginContextualResourceStoreProvider';

type AccountLifetime = PluginContextualResourceBinding['accountLifetime'];

const RESOURCE_ID = 'control-state';

function resourceResponse(marker: string) {
    return {
        supported: true as const,
        result: {
            ok: true as const,
            resource: { pluginId: 'acme.composer', localId: RESOURCE_ID },
            kind: 'config' as const,
            contentType: 'application/json',
            digest: `sha256:${marker.repeat(64)}`,
            bytesBase64: 'MQ==',
        },
    };
}

function watchOpenResponse(subscriptionId: string, marker: string) {
    return {
        supported: true as const,
        result: {
            ok: true as const,
            subscriptionId,
            digest: `sha256:${marker.repeat(64)}`,
        },
    };
}

function invalidatedResponse(subscriptionId: string, marker: string) {
    return {
        supported: true as const,
        result: {
            ok: true as const,
            status: 'event' as const,
            event: {
                version: 1 as const,
                subscriptionId,
                kind: 'invalidated' as const,
                digest: `sha256:${marker.repeat(64)}`,
            },
        },
    };
}

function createAccountLifetime(input: Readonly<{
    accountId: string;
    retireDuringRegistration?: boolean;
}>): Readonly<{
    lifetime: AccountLifetime;
    retire(): void;
}> {
    let current = true;
    let retireDuringRegistration = input.retireDuringRegistration === true;
    const retirements = new Set<() => void>();
    return Object.freeze({
        lifetime: Object.freeze({
            scope: Object.freeze({ serverId: 'server-1', accountId: input.accountId }),
            isCurrent: () => current,
            onRetire(cancel: () => void) {
                if (retireDuringRegistration) {
                    retireDuringRegistration = false;
                    current = false;
                    cancel();
                    return Object.freeze({ dispose: () => undefined });
                }
                if (!current) {
                    cancel();
                    return Object.freeze({ dispose: () => undefined });
                }
                retirements.add(cancel);
                let disposed = false;
                return Object.freeze({
                    dispose: () => {
                        if (disposed) return;
                        disposed = true;
                        retirements.delete(cancel);
                    },
                });
            },
        }),
        retire(): void {
            if (!current) return;
            current = false;
            for (const cancel of [...retirements]) cancel();
        },
    });
}

function binding(
    accountLifetime: AccountLifetime,
    expectedGeneration = '42',
): PluginContextualResourceBinding {
    return Object.freeze({
        accountLifetime,
        pluginId: 'acme.composer',
        machineId: 'machine-1',
        serverId: 'server-1',
        expectedGeneration,
        context: Object.freeze({ kind: 'session' as const, sessionId: 'session-1' }),
    });
}

function installLiveResourceRpc(input?: Readonly<{
    read?: (call: number) => ReturnType<typeof resourceResponse>;
    openMarker?: (options: Readonly<{ subscriptionId: string; expectedGeneration: string }>) => string;
    onNext?: (options: Readonly<{ subscriptionId: string; signal: AbortSignal }>) => Promise<unknown>;
}>) {
    const nextSignals: AbortSignal[] = [];
    let reads = 0;
    machineResourceRpc.read.mockReset();
    machineResourceRpc.open.mockReset();
    machineResourceRpc.next.mockReset();
    machineResourceRpc.close.mockReset();
    machineResourceRpc.read.mockImplementation(async () => (
        input?.read?.(++reads) ?? resourceResponse('a')
    ));
    machineResourceRpc.open.mockImplementation(async (
        _machineId: string,
        options: Readonly<{ subscriptionId: string; expectedGeneration: string }>,
    ) => watchOpenResponse(options.subscriptionId, input?.openMarker?.(options) ?? 'a'));
    machineResourceRpc.next.mockImplementation(async (
        _machineId: string,
        options: Readonly<{ subscriptionId: string; signal: AbortSignal }>,
    ) => {
        nextSignals.push(options.signal);
        if (input?.onNext) return await input.onNext(options);
        return await new Promise((resolve) => {
            options.signal.addEventListener('abort', () => {
                resolve({ supported: false as const, reason: 'aborted' as const });
            }, { once: true });
        });
    });
    machineResourceRpc.close.mockResolvedValue(undefined);
    return { nextSignals };
}

function ResourceProbe(props: Readonly<{
    binding: PluginContextualResourceBinding;
    onSnapshot(snapshot: PluginUiResourceSnapshot | null): void;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
}>): React.ReactElement {
    return (
        <PluginContextualResourceState
            binding={props.binding}
            resource={RESOURCE_ID}
            {...(props.signal === undefined ? {} : { signal: props.signal })}
            {...(props.isCurrent === undefined ? {} : { isCurrent: props.isCurrent })}
        >
            {(snapshot) => {
                props.onSnapshot(snapshot);
                return null;
            }}
        </PluginContextualResourceState>
    );
}

describe('PluginContextualResourceStoreProvider', () => {
    it('reuses its nearest contextual owner instead of creating a nested Resource store owner', async () => {
        let outerOwner: PluginContextualResourceStoreOwner | null = null;
        let innerOwner: PluginContextualResourceStoreOwner | null = null;

        function OwnerProbe(props: Readonly<{ location: 'outer' | 'inner' }>) {
            const owner = usePluginContextualResourceStoreOwner();
            if (props.location === 'outer') outerOwner = owner;
            else innerOwner = owner;
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <PluginContextualResourceStoreProvider>
                    <OwnerProbe location="outer" />
                    <PluginContextualResourceStoreProvider>
                        <OwnerProbe location="inner" />
                    </PluginContextualResourceStoreProvider>
                </PluginContextualResourceStoreProvider>,
            );
        });

        expect(outerOwner).not.toBeNull();
        expect(innerOwner).toBe(outerOwner);

        await act(async () => { tree?.unmount(); });
    });

    it('shares one exact mounted context and disposes its real watch only after the final release', async () => {
        const rpc = installLiveResourceRpc();
        const account = createAccountLifetime({ accountId: 'account-a' });
        const exactBinding = binding(account.lifetime);
        let first: PluginUiResourceSnapshot | null = null;
        let second: PluginUiResourceSnapshot | null = null;

        function App(props: Readonly<{ showFirst: boolean; showSecond: boolean }>) {
            return (
                <PluginContextualResourceStoreProvider>
                    {props.showFirst ? <ResourceProbe binding={exactBinding} onSnapshot={(snapshot) => { first = snapshot; }} /> : null}
                    {props.showSecond ? <ResourceProbe binding={exactBinding} onSnapshot={(snapshot) => { second = snapshot; }} /> : null}
                </PluginContextualResourceStoreProvider>
            );
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<App showFirst showSecond />);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(first?.digest).toBe(`sha256:${'a'.repeat(64)}`);
            expect(second?.digest).toBe(`sha256:${'a'.repeat(64)}`);
        });
        await vi.waitFor(() => { expect(rpc.nextSignals).toHaveLength(1); });
        expect(machineResourceRpc.read).toHaveBeenCalledTimes(1);
        expect(machineResourceRpc.open).toHaveBeenCalledTimes(1);

        await act(async () => {
            tree?.update(<App showFirst showSecond={false} />);
            await Promise.resolve();
        });
        expect(machineResourceRpc.close).not.toHaveBeenCalled();
        expect(rpc.nextSignals[0]?.aborted).toBe(false);

        await act(async () => {
            tree?.update(<App showFirst={false} showSecond={false} />);
            await Promise.resolve();
        });
        expect(rpc.nextSignals[0]?.aborted).toBe(true);
        await vi.waitFor(() => { expect(machineResourceRpc.close).toHaveBeenCalledTimes(1); });

        await act(async () => { tree?.unmount(); });
    });

    it('keeps Account A and B isolated and fences a late A watch event after synchronous retirement', async () => {
        let resolveLateA: ((value: ReturnType<typeof invalidatedResponse>) => void) | null = null;
        const rpc = installLiveResourceRpc({
            read: (call) => call === 1 ? resourceResponse('a') : resourceResponse('b'),
            openMarker: (options) => options.subscriptionId.includes('account-a') ? 'a' : 'b',
            onNext: async (options) => {
                if (options.subscriptionId.includes('account-a')) {
                    return await new Promise<ReturnType<typeof invalidatedResponse>>((resolve) => {
                        resolveLateA = resolve;
                    });
                }
                return await new Promise((resolve) => {
                    options.signal.addEventListener('abort', () => {
                        resolve({ supported: false as const, reason: 'aborted' as const });
                    }, { once: true });
                });
            },
        });
        const accountA = createAccountLifetime({ accountId: 'account-a' });
        const accountB = createAccountLifetime({ accountId: 'account-b' });
        let a: PluginUiResourceSnapshot | null = null;
        const b = { current: null as PluginUiResourceSnapshot | null };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <PluginContextualResourceStoreProvider>
                    <ResourceProbe binding={binding(accountA.lifetime)} onSnapshot={(snapshot) => { a = snapshot; }} />
                    <ResourceProbe binding={binding(accountB.lifetime)} onSnapshot={(snapshot) => { b.current = snapshot; }} />
                </PluginContextualResourceStoreProvider>,
            );
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => {
            expect(a?.digest).toBe(`sha256:${'a'.repeat(64)}`);
            expect(b.current?.digest).toBe(`sha256:${'b'.repeat(64)}`);
        });
        await vi.waitFor(() => { expect(rpc.nextSignals).toHaveLength(2); });
        expect(machineResourceRpc.read).toHaveBeenCalledTimes(2);
        expect(machineResourceRpc.open).toHaveBeenCalledTimes(2);

        await act(async () => {
            accountA.retire();
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(a).toBeNull(); });
        expect(machineResourceRpc.close).toHaveBeenCalledTimes(1);
        const readsBeforeLateA = machineResourceRpc.read.mock.calls.length;

        await act(async () => {
            resolveLateA!(invalidatedResponse('late-account-a', 'c'));
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(a).toBeNull();
        expect(b.current?.digest).toBe(`sha256:${'b'.repeat(64)}`);
        expect(machineResourceRpc.read).toHaveBeenCalledTimes(readsBeforeLateA);

        await act(async () => { tree?.unmount(); });
    });

    it('replaces an observed generation family before an old consumer releases its read and watch', async () => {
        const rpc = installLiveResourceRpc({
            read: (call) => call === 1 ? resourceResponse('a') : resourceResponse('b'),
            openMarker: (options) => options.expectedGeneration === '7' ? 'a' : 'b',
        });
        const account = createAccountLifetime({ accountId: 'account-a' });
        const generationSeven = binding(account.lifetime, '7');
        const generationEight = binding(account.lifetime, '8');
        let oldSnapshot: PluginUiResourceSnapshot | null = null;
        let newSnapshot: PluginUiResourceSnapshot | null = null;

        function App(props: Readonly<{ showNew: boolean }>) {
            return (
                <PluginContextualResourceStoreProvider>
                    <ResourceProbe binding={generationSeven} onSnapshot={(snapshot) => { oldSnapshot = snapshot; }} />
                    {props.showNew ? <ResourceProbe binding={generationEight} onSnapshot={(snapshot) => { newSnapshot = snapshot; }} /> : null}
                </PluginContextualResourceStoreProvider>
            );
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<App showNew={false} />);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(oldSnapshot?.digest).toBe(`sha256:${'a'.repeat(64)}`); });
        await vi.waitFor(() => { expect(rpc.nextSignals).toHaveLength(1); });
        const oldWatchSignal = rpc.nextSignals[0]!;

        await act(async () => {
            tree?.update(<App showNew />);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(newSnapshot?.digest).toBe(`sha256:${'b'.repeat(64)}`); });
        expect(oldWatchSignal.aborted).toBe(true);
        await vi.waitFor(() => { expect(machineResourceRpc.close).toHaveBeenCalledTimes(1); });
        expect(machineResourceRpc.read).toHaveBeenCalledTimes(2);
        expect(machineResourceRpc.open).toHaveBeenCalledTimes(2);

        await act(async () => { tree?.unmount(); });
    });

    it('returns no lease when synchronous Account retirement races registration', async () => {
        installLiveResourceRpc();
        const account = createAccountLifetime({ accountId: 'account-a', retireDuringRegistration: true });
        const ownerRef = { current: null as PluginContextualResourceStoreOwner | null };

        function OwnerProbe() {
            ownerRef.current = usePluginContextualResourceStoreOwner();
            return null;
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <PluginContextualResourceStoreProvider>
                    <OwnerProbe />
                </PluginContextualResourceStoreProvider>,
            );
        });

        expect(ownerRef.current).not.toBeNull();
        if (ownerRef.current === null) throw new Error('expected contextual Resource store owner');
        expect(ownerRef.current.acquire(binding(account.lifetime))).toBeNull();
        expect(machineResourceRpc.read).not.toHaveBeenCalled();
        expect(machineResourceRpc.open).not.toHaveBeenCalled();
        expect(machineResourceRpc.next).not.toHaveBeenCalled();
        expect(machineResourceRpc.close).not.toHaveBeenCalled();

        await act(async () => { tree?.unmount(); });
    });

    it('aborts the real mounted read/watch client when its caller aborts', async () => {
        const rpc = installLiveResourceRpc();
        const account = createAccountLifetime({ accountId: 'account-a' });
        const controller = new AbortController();
        let observed: PluginUiResourceSnapshot | null = null;

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <PluginContextualResourceStoreProvider>
                    <ResourceProbe
                        binding={binding(account.lifetime)}
                        signal={controller.signal}
                        onSnapshot={(snapshot) => { observed = snapshot; }}
                    />
                </PluginContextualResourceStoreProvider>,
            );
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(observed?.value).toBeDefined(); });
        await vi.waitFor(() => { expect(rpc.nextSignals).toHaveLength(1); });

        await act(async () => {
            controller.abort();
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(observed).toBeNull(); });
        expect(rpc.nextSignals[0]?.aborted).toBe(true);
        await vi.waitFor(() => { expect(machineResourceRpc.close).toHaveBeenCalledTimes(1); });

        await act(async () => { tree?.unmount(); });
    });

    it('withholds a snapshot and releases the real lease when caller currentness turns false', async () => {
        const rpc = installLiveResourceRpc();
        const account = createAccountLifetime({ accountId: 'account-a' });
        const exactBinding = binding(account.lifetime);
        let current = true;
        let observed: PluginUiResourceSnapshot | null = null;

        function App() {
            return (
                <PluginContextualResourceStoreProvider>
                    <ResourceProbe
                        binding={exactBinding}
                        isCurrent={() => current}
                        onSnapshot={(snapshot) => { observed = snapshot; }}
                    />
                </PluginContextualResourceStoreProvider>
            );
        }

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<App />);
            await Promise.resolve();
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(observed?.value).toBeDefined(); });
        await vi.waitFor(() => { expect(rpc.nextSignals).toHaveLength(1); });

        current = false;
        await act(async () => {
            tree?.update(<App />);
            await Promise.resolve();
        });
        await vi.waitFor(() => { expect(observed).toBeNull(); });
        expect(rpc.nextSignals[0]?.aborted).toBe(true);
        await vi.waitFor(() => { expect(machineResourceRpc.close).toHaveBeenCalledTimes(1); });

        await act(async () => { tree?.unmount(); });
    });
});
