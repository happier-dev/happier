import { describe, expect, it } from 'vitest';
import type { PluginUiJsonValueV1, PluginUiEntityDragDropStateV1 } from '@happier-dev/protocol/plugins/ui';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { createPluginEntityDragDropBinding } from '../surfaces/entityDragDrop/pluginEntityDragDropBinding';
import { createHostedEntityDragDropHandlers } from './hostedEntityDragDrop';
import { createPluginSurfaceHostApi } from '../surfaces/createPluginSurfaceHostApi';

describe('hosted entity coordinates and mount retirement', () => {
    it('projects mounted source admission, pending settlement and retirement through the existing watch', async () => {
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'account' };
        let refused = false;
        let finish: (() => void) | undefined;
        const pending = new Promise<void>(resolve => { finish = resolve; });
        let markStarted: (() => void) | undefined;
        const started = new Promise<void>(resolve => { markStarted = resolve; });
        const descriptor = { id: 'board', title: 'Board', client: { artifactId: 'ui', exportName: 'activate' }, platforms: ['web' as const],
            acceptedKinds: ['plugin:acme.board/issue' as const], actions: [{ kind: 'plugin' as const, action: 'add' }] };
        const source = { descriptor: { id: 'issue', title: 'Issue', client: descriptor.client, platforms: descriptor.platforms,
            referenceSchema: { type: 'string' as const } }, describe: () => ({ title: 'Issue' }), isCurrent: () => true };
        const target = { descriptor, isCurrent: () => true, resolve: () => refused
            ? { status: 'refused' as const, reason: { code: 'read_only', message: 'Read only' } }
            : { status: 'allowed' as const, effect: { actionId: 'plugin:acme.board/add', input: {}, preview: { verb: 'Add', target: 'Board' } } } };
        const binding = createPluginEntityDragDropBinding({ runtime, pluginId: 'acme.board', mountKey: 'iframe', scope, isCurrent: () => true,
            readSource: () => source, readTarget: () => target,
            executeAction: async () => { markStarted?.(); await pending; return { status: 'applied' }; } });
        const hosted = createHostedEntityDragDropHandlers({ binding, isCurrent: () => true, readSessionItem: () => null });
        const surface = { pluginId: 'acme.board', contributionId: 'board', surfaceId: 'iframe', placement: 'sessionPane' as const,
            platform: 'web' as const, channel: 'internal' as const, resourceScope: [], diagnostics: [] };
        const api = createPluginSurfaceHostApi({ surfaceContext: surface, handlers: hosted.handlers });
        const request = (method: 'updateEntityDragDrop' | 'watchEntityDragDrop', payload: PluginUiJsonValueV1) => ({ version: 1 as const, requestId: 'target-feedback', surface, method, payload });
        await api.handleRequest(request('updateEntityDragDrop', { kind: 'mountTarget', mountId: 'target', targetId: 'board',
            bounds: { x: 0, y: 0, width: 100, height: 100 }, viewport: { width: 100, height: 100 } }), { getHostedFrameBounds: async () => ({ x: 0, y: 0, width: 100, height: 100 }) });
        expect(await api.handleRequest(request('updateEntityDragDrop', { kind: 'mountSource', mountId: 'source', sourceId: 'issue', reference: 'Issue 42' }))).toEqual({ accepted: true });
        const states: PluginUiEntityDragDropStateV1[] = [];
        let unsubscribe: (() => void) | undefined;
        expect(await api.handleRequest(request('watchEntityDragDrop', { mountId: 'source' }), { entityDragDropSubscription: {
            publish: state => { states.push(state); }, retain: value => { unsubscribe = value; },
        } })).toEqual({});
        expect(states.at(-1)).toMatchObject({ current: true, phase: 'idle', admission: null });
        const carry = runtime.begin(binding.runtimeMountId('source'))!; carry.move({ x: 20, y: 20 });
        expect(states.at(-1)).toMatchObject({ current: true, phase: 'carrying', admission: { status: 'allowed' } });
        refused = true; binding.refresh();
        expect(states.at(-1)).toMatchObject({ phase: 'carrying', admission: { status: 'refused', reason: { code: 'read_only' } } });
        refused = false; binding.refresh();
        const settling = carry.release();
        await started;
        expect(states.at(-1)).toMatchObject({ phase: 'pending', admission: { status: 'allowed' } });
        finish?.(); await settling;
        expect(states.at(-1)).toMatchObject({ phase: 'settled', outcome: { status: 'applied' } });
        await api.handleRequest(request('updateEntityDragDrop', { kind: 'unmount', mountId: 'target' }));
        expect(states.at(-1)?.destinations).toEqual([]);
        await api.handleRequest(request('updateEntityDragDrop', { kind: 'unmount', mountId: 'source' }));
        expect(states.at(-1)).toMatchObject({ current: false, phase: 'idle', admission: null, destinations: [] });
        unsubscribe?.(); hosted.dispose(); binding.dispose();
    });

    it('registers a retained hidden mount, resumes on focus and cancels uncommitted hidden carries without writes', async () => {
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'account' };
        let eligible = false;
        const writes: unknown[] = [];
        const sourceDefinition = { id: 'issue', title: 'Issue', client: { artifactId: 'ui', exportName: 'activate' }, platforms: ['web' as const], referenceSchema: { type: 'string' as const } };
        const source = { descriptor: sourceDefinition, describe: () => ({ title: 'Issue' }), isCurrent: () => true };
        const target = { descriptor: { id: 'board', title: 'Board', client: sourceDefinition.client, platforms: sourceDefinition.platforms, acceptedKinds: ['plugin:acme.board/issue' as const], actions: [{ kind: 'plugin' as const, action: 'add' }] }, resolve: () => ({ status: 'allowed' as const, effect: { actionId: 'plugin:acme.board/add', input: {}, preview: { verb: 'Add', target: 'Board' } } }), isCurrent: () => true };
        const binding = createPluginEntityDragDropBinding({ runtime, pluginId: 'acme.board', mountKey: 'hidden', scope, isCurrent: () => true, isInteractionEnabled: () => eligible, readSource: () => source, readTarget: () => target, executeAction: async (_action, input) => { writes.push(input); return { status: 'applied' }; } });
        const hosted = createHostedEntityDragDropHandlers({ binding, isCurrent: () => true, readSessionItem: () => null });
        const surface = { pluginId: 'acme.board', contributionId: 'board', surfaceId: 'hidden', placement: 'sessionPane' as const, platform: 'web' as const, channel: 'internal' as const, resourceScope: [], diagnostics: [] };
        const api = createPluginSurfaceHostApi({ surfaceContext: surface, handlers: hosted.handlers });
        const send = (payload: PluginUiJsonValueV1) => api.handleRequest({ version: 1, requestId: 'focus', surface, method: 'updateEntityDragDrop', payload });
        expect(await send({ kind: 'mountSource', mountId: 'issue', sourceId: 'issue', reference: 'Issue 42' })).toEqual({ accepted: true });
        const targetMount = binding.mountTarget({ mountId: 'board', targetId: 'board', getBounds: () => null })!;
        const begin = () => send({ kind: 'begin', mountId: 'issue', input: 'keyboard', pointer: { x: 0, y: 0 }, viewport: { width: 100, height: 100 } });
        expect(await begin()).toEqual({ accepted: false });
        eligible = true; binding.refresh();
        expect(await begin()).toEqual({ accepted: true });
        await send({ kind: 'choose', mountId: 'issue', targetId: targetMount.id });
        expect(runtime.getSnapshot().admission?.status).toBe('allowed');
        eligible = false; binding.refresh();
        expect(runtime.getSnapshot().phase).toBe('idle');
        expect(await send({ kind: 'commit', mountId: 'issue' })).toEqual({ accepted: false });
        expect(writes).toEqual([]);
        eligible = true; binding.refresh();
        expect(await send({ kind: 'perform', mountId: 'issue', targetId: targetMount.id })).toEqual({ accepted: true, outcome: { status: 'applied' } });
        expect(writes).toHaveLength(1);
        hosted.dispose(); binding.dispose();
    });
    it('joins host Session/file sources to nested hosted custom target and remeasures at release', async () => {
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'account' };
        const writes: unknown[] = [];
        let frame = { x: 100, y: 100, width: 200, height: 200 };
        let measurement: (() => Promise<void>) | undefined;
        let bridgeCurrent = true;
        const descriptor = { id: 'board', title: 'Board', client: { artifactId: 'ui', exportName: 'activate' }, platforms: ['web' as const], acceptedKinds: ['session' as const, 'repository-file' as const], actions: [{ kind: 'plugin' as const, action: 'add' }] };
        const resolve = () => ({ status: 'allowed' as const, effect: { actionId: 'plugin:acme.board/add', input: {}, preview: { verb: 'Add', target: 'Board' } } });
        const binding = createPluginEntityDragDropBinding({ runtime, pluginId: 'acme.board', mountKey: 'iframe', scope, isCurrent: () => true,
            readSource: () => null, readTarget: () => ({ descriptor, resolve, isCurrent: () => true }),
            executeAction: async (_action, input) => { writes.push(input); return { status: 'applied' }; } });
        const hosted = createHostedEntityDragDropHandlers({ binding, isCurrent: () => bridgeCurrent, readSessionItem: () => null });
        const surface = { pluginId: 'acme.board', contributionId: 'board', surfaceId: 'iframe', placement: 'sessionPane' as const, platform: 'web' as const, channel: 'internal' as const, resourceScope: [], diagnostics: [] };
        const api = createPluginSurfaceHostApi({ surfaceContext: surface, handlers: hosted.handlers });
        const send = (payload: PluginUiJsonValueV1) => api.handleRequest({ version: 1, requestId: 'drag', surface, method: 'updateEntityDragDrop', payload }, { getHostedFrameBounds: async () => { await measurement?.(); return frame; } });
        expect(await send({ kind: 'mountTarget', mountId: 'parent', targetId: 'board', bounds: { x: 0, y: 0, width: 100, height: 100 }, viewport: { width: 100, height: 100 } })).toEqual({ accepted: true });
        expect(await send({ kind: 'mountTarget', mountId: 'child', parentId: 'parent', targetId: 'board', bounds: { x: 10, y: 10, width: 20, height: 20 }, viewport: { width: 100, height: 100 } })).toEqual({ accepted: true });
        runtime.registerSource({ id: 'host-session', scope, isCurrent: () => true, getItem: () => ({ kind: 'session', scope, address: { serverId: 'home', sessionId: 's1' } }) });
        const carry = runtime.begin('host-session')!;
        await send({ kind: 'move', pointer: { x: 20, y: 20 }, viewport: { width: 100, height: 100 } });
        expect(runtime.getSnapshot().targetId).toBe('iframe\u0000child');
        frame = { ...frame, x: 400 };
        expect(await carry.release()).toBeNull();
        expect(writes).toEqual([]);
        runtime.registerSource({ id: 'host-file', scope, isCurrent: () => true, getItem: () => ({ kind: 'repository-file', scope, machineId: 'machine', path: '/repo/issue.ts' }) });
        runtime.begin('host-file')!;
        expect(await send({ kind: 'release', pointer: { x: 20, y: 20 }, viewport: { width: 100, height: 100 } })).toEqual({ accepted: true, outcome: { status: 'applied' } });
        expect(writes).toEqual([{}]);
        runtime.begin('host-session')!;
        let completeMeasurement: (() => void) | undefined;
        let startedMeasurement: (() => void) | undefined;
        const started = new Promise<void>(resolve => { startedMeasurement = resolve; });
        measurement = () => new Promise<void>(resolve => { completeMeasurement = resolve; startedMeasurement?.(); });
        const dropping = send({ kind: 'release', pointer: { x: 20, y: 20 }, viewport: { width: 100, height: 100 } });
        await started;
        expect(await send({ kind: 'cancel' })).toEqual({ accepted: true });
        completeMeasurement?.();
        expect(await dropping).toEqual({ accepted: false });
        expect(writes).toEqual([{}]);
        bridgeCurrent = false;
        runtime.begin('host-file')!;
        expect(await send({ kind: 'cancel' })).toMatchObject({ code: 'unavailable' });
        expect(runtime.getSnapshot().sourceId).toBe('host-file');
        hosted.dispose();
        expect(runtime.getDestinations('host-session')).toEqual([]);
    });
});
