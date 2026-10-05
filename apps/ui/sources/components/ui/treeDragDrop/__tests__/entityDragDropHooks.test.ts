import { useLayoutEffect } from 'react';
import { expect, it } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { createEntityDragDropRuntime } from '../entityDragDropRuntime';
import { useEntityDragSource, useEntityDropTarget } from '../entityDragDropHooks';

it('mounted descriptors read the latest source identity and optional semantic destinations', async () => {
    const runtime = createEntityDragDropRuntime();
    const scope = { serverId: 'home', accountId: 'account-a' };
    const hook = await renderHook(({ title, enumerate }: { title: string; enumerate: boolean }) => {
        useEntityDragSource(runtime, { id: 'source', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'session', scope, address: { serverId: 'home', sessionId: 'child' } }),
            describe: () => ({ title }) });
        useEntityDropTarget(runtime, { id: 'target', scope, acceptedKinds: ['session'], getBounds: () => null,
            listDestinations: enumerate ? () => [{ destination: { title }, label: title }] : undefined,
            resolve: ({ destination }) => ({ status: 'allowed', effect: { actionId: 'session.reports_to.set',
                input: { destination }, preview: { verb: 'Put under', target: title } } }),
            execute: async () => ({ status: 'applied' }) });
    }, { initialProps: { title: 'First', enumerate: true } });
    expect(runtime.describeSource('source')).toEqual({ title: 'First' });
    expect(runtime.getDestinations('source')[0]).toMatchObject({ destination: { title: 'First' }, label: 'First' });
    await hook.rerender({ title: 'Latest', enumerate: true });
    expect(runtime.describeSource('source')).toEqual({ title: 'Latest' });
    expect(runtime.getDestinations('source')[0]).toMatchObject({ destination: { title: 'Latest' }, label: 'Latest' });
    await hook.rerender({ title: 'Latest', enumerate: false });
    expect(runtime.getDestinations('source')[0]).toEqual({ targetId: 'target', admission: {
        status: 'allowed', effect: { actionId: 'session.reports_to.set', input: { destination: null },
            preview: { verb: 'Put under', target: 'Latest' } },
    } });
});

it('a target retargeted to another Account cannot execute before passive registration cleanup', async () => {
    const runtime = createEntityDragDropRuntime();
    const scope = { serverId: 'home', accountId: 'account-a' };
    const effects: unknown[] = [];
    runtime.registerSource({ id: 'source', scope, isCurrent: () => true,
        getItem: () => ({ kind: 'session', scope, address: { serverId: 'home', sessionId: 'child' } }) });
    let released: ReturnType<typeof runtime.release> | undefined;
    const hook = await renderHook(({ accountId, releaseDuringLayout }: { accountId: string; releaseDuringLayout: boolean }) => {
        useEntityDropTarget(runtime, { id: 'target', scope: { ...scope, accountId }, acceptedKinds: ['session'],
            getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
            resolve: () => ({ status: 'allowed', effect: { actionId: 'session.reports_to.set', input: {}, preview: { verb: 'Put under', target: 'Lead' } } }),
            execute: async effect => { effects.push(effect); return { status: 'applied' }; } });
        useLayoutEffect(() => { if (releaseDuringLayout) released = runtime.release(); }, [releaseDuringLayout]);
    }, { initialProps: { accountId: scope.accountId, releaseDuringLayout: false } });
    const carry = runtime.begin('source')!;
    carry.move({ x: 25, y: 25 });
    await hook.rerender({ accountId: 'account-b', releaseDuringLayout: true });
    expect(await released).toBeNull();
    expect(effects).toEqual([]);
});
