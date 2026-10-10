import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createUsageSourceActionPort } from '@happier-dev/protocol/actions/executor/usageSourceActions';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import type { UsageSourceV1 } from '@happier-dev/protocol/usage/usageSources';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createDeferred, renderHook } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { createUsageSourcesController } from './usageSourcesController';
import { useUsageSourcesController, type UsageSourcesHookOptions } from './useUsageSources';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

const source: UsageSourceV1 = {
    serverId: 'home', machineId: 'machine', sourceId: 'source',
    agent: { pluginId: 'happier.agent.codex', localId: 'codex' },
    root: { kind: 'default', path: '/private/root' }, consent: 'disabled', status: 'found',
    coverage: 'unknown', pendingCount: 0, asOfMs: null,
};

function lifetimeHarness() {
    let current = true;
    const listeners = new Set<() => void>();
    const lifetime: ServerAccountScopeLifetime = {
        scope: { serverId: 'home', accountId: 'account' }, isCurrent: () => current,
        onRetire: listener => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    };
    return { lifetime, retire: () => { current = false; for (const listener of listeners) listener(); } };
}

function harness(rpc: Parameters<typeof createUsageSourceActionPort>[0]['rpc'], options: Readonly<{
    approve?: boolean;
    dismiss?: Parameters<typeof createUsageSourceActionPort>[0]['dismiss'];
}> = {}) {
    const scope = lifetimeHarness();
    const settings = ActionsSettingsV1Schema.parse({ v: 1, ...(options.approve === false ? {} : {
        approvalWaivedSurfaces: {
            'usage.sources.consent.set': ['ui'], 'usage.sources.stop': ['ui'],
            'usage.sources.root.set': ['ui'], 'usage.sources.history.delete': ['ui'],
        },
    }) });
    // Only Machine/approval boundary ports are needed by this Action slice; the
    // executor's unrelated required legacy ports are deliberately unconfigured.
    const deps = {
        usageSourceAction: createUsageSourceActionPort({
            serverId: 'home',
            assertCurrent: context => {
                context.signal?.throwIfAborted();
                if (!scope.lifetime.isCurrent()) throw new Error('retired');
            }, rpc, ...(options.dismiss ? { dismiss: options.dismiss } : {}),
        }),
        isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context),
    } satisfies Partial<ActionExecutorDeps>;
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    const controller = createUsageSourcesController({ machineId: 'machine', lifetime: scope.lifetime, executor });
    return { ...scope, controller, executor };
}

describe('Usage Sources consent controller', () => {
    it('keeps unchanged browse and root identities stable when only capture progress changes', async () => {
        let currentSource: UsageSourceV1 = { ...source, externalSessionSource: { kind: 'codexHome', home: 'user' } };
        const { controller } = harness(async () => ({ sources: [currentSource] }));
        await controller.discover();
        const before = controller.getSnapshot().sources[0];
        currentSource = { ...currentSource, pendingCount: 4, consent: 'enabled', status: 'reading' };
        await controller.refresh();
        const after = controller.getSnapshot().sources[0];
        expect(after.pendingCount).toBe(4);
        expect(after.agent).toBe(before.agent);
        expect(after.externalSessionSource).toBe(before.externalSessionSource);
        expect(after.root).toBe(before.root);
        controller.dispose();
    });
    it('refreshes background progress on the existing Home wake and retires that demand with its Account', async () => {
        let currentSource: UsageSourceV1 = { ...source, consent: 'enabled', status: 'reading', pendingCount: 7 };
        const settled = createDeferred<void>();
        const { controller, retire } = harness(async request => {
            if (request.actionId === 'usage.sources.get') settled.resolve();
            return { sources: [currentSource] };
        });
        await controller.discover();
        currentSource = { ...currentSource, status: 'ready', pendingCount: 0, asOfMs: 500 };
        publishHomeAccountChange('other-home');
        expect(controller.getSnapshot().sources[0]?.status).toBe('reading');
        publishHomeAccountChange('home');
        await settled.promise;
        await vi.waitFor(() => expect(controller.getSnapshot().sources).toEqual([currentSource]));
        retire();
        publishHomeAccountChange('home');
        expect(controller.getSnapshot()).toMatchObject({ sources: [], retired: true, pending: [] });
    });
    it('discovers metadata lazily through the admitted Action without granting consent', async () => {
        const { lifetime } = lifetimeHarness();
        // The Machine RPC is the boundary; Action admission and Source validation remain real.
        const executor = createActionExecutor({ usageSourceAction: createUsageSourceActionPort({
            serverId: 'home',
            assertCurrent: () => { if (!lifetime.isCurrent()) throw new Error('retired'); },
            rpc: async () => ({ sources: [source] }),
        }) } as ActionExecutorDeps);
        const controller = createUsageSourcesController({ machineId: 'machine', lifetime, executor });
        expect(controller.getSnapshot()).toMatchObject({ sources: [], loaded: false });
        await controller.discover();
        expect(controller.getSnapshot()).toMatchObject({ loaded: true, sources: [source] });
        controller.dispose();
    });

    it('retains the current source while pending, then reports real reading, stop and separate deletion outcomes', async () => {
        const consent = createDeferred<unknown>();
        const entered = createDeferred<void>();
        const reading: UsageSourceV1 = { ...source, consent: 'enabled', status: 'reading', coverage: 'partial', pendingCount: 7 };
        const stopped: UsageSourceV1 = { ...reading, consent: 'disabled', status: 'stopped' };
        const history: string[] = ['retained'];
        const { controller } = harness(async request => {
            if (request.actionId === 'usage.sources.consent.set') { entered.resolve(); return consent.promise; }
            if (request.actionId === 'usage.sources.stop') return { source: stopped };
            if (request.actionId === 'usage.sources.history.delete') { history.splice(0); return { success: true, deletedEventCount: 4 }; }
            return { sources: [source] };
        });
        await controller.discover();
        const enable = controller.setConsent('source', true);
        await entered.promise;
        expect(controller.getSnapshot()).toMatchObject({ sources: [source], pending: [{ actionId: 'usage.sources.consent.set', sourceId: 'source' }] });
        consent.resolve({ source: reading });
        await enable;
        expect(controller.getSnapshot()).toMatchObject({ sources: [reading], pending: [], error: null });
        await controller.stop('source');
        expect(controller.getSnapshot()).toMatchObject({ sources: [stopped], historyDeletion: null });
        expect(history).toEqual(['retained']);
        await controller.deleteHistory('source', { startMs: 10, endMs: 20 });
        expect(history).toEqual([]);
        expect(controller.getSnapshot()).toMatchObject({ sources: [stopped], historyDeletion: {
            sourceId: 'source', deletedEventCount: 4, dateRange: { startMs: 10, endMs: 20 },
        } });
        controller.dispose();
    });

    it('honors ordinary dangerous Action approval rather than optimistically granting consent', async () => {
        let applied = false;
        const { controller } = harness(async request => {
            if (request.actionId === 'usage.sources.consent.set') { applied = true; return { source: { ...source, consent: 'enabled' } }; }
            return { sources: [source] };
        }, { approve: false });
        await controller.discover();
        expect(await controller.setConsent('source', true)).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
        expect(applied).toBe(false);
        expect(controller.getSnapshot()).toMatchObject({ sources: [source], error: { errorCode: 'approvals_not_supported' }, pending: [] });
        controller.dispose();
    });

    it('keeps authorized metadata and stable row identities on failed or unchanged refreshes', async () => {
        let offline = false;
        const { controller } = harness(async () => {
            if (offline) throw new Error('offline');
            return { sources: [{ ...source }] };
        });
        await controller.discover();
        const rows = controller.getSnapshot().sources;
        await controller.refresh();
        expect(controller.getSnapshot().sources).toBe(rows);
        offline = true;
        await controller.refresh();
        expect(controller.getSnapshot()).toMatchObject({ loaded: true, error: { errorCode: 'usage_source_unavailable' }, pending: [] });
        expect(controller.getSnapshot().sources).toBe(rows);
        offline = false;
        await controller.refresh();
        expect(controller.getSnapshot()).toMatchObject({ error: null, sources: [source] });
        controller.dispose();
    });

    it.each(['serverId', 'machineId', 'sourceId'] as const)('rejects a foreign %s source response', async field => {
        let foreign = false;
        const { controller } = harness(async () => ({ sources: [foreign ? { ...source, [field]: 'other' } : source] }));
        await controller.discover();
        foreign = true;
        await controller.refresh('source');
        expect(controller.getSnapshot()).toMatchObject({ sources: [source], error: { errorCode: 'usage_source_response_invalid' } });
        controller.dispose();
    });

    it('refreshes one source without reordering or replacing unchanged neighboring rows', async () => {
        const other: UsageSourceV1 = { ...source, sourceId: 'other-source' };
        const { controller } = harness(async request => ({ sources: request.actionId === 'usage.sources.get' ? [source] : [source, other] }));
        expect(await controller.discover()).toMatchObject({ ok: true });
        expect(controller.getSnapshot().sources).toEqual([source, other]);
        const rows = controller.getSnapshot().sources;
        await controller.refresh('source');
        expect(controller.getSnapshot().sources).toBe(rows);
        controller.dispose();
    });

    it('replaces a root identity and refuses late old-root metadata without introducing a second source', async () => {
        const held = createDeferred<unknown>();
        const entered = createDeferred<void>();
        const replacement: UsageSourceV1 = { ...source, sourceId: 'replacement', root: { kind: 'override', path: '/new/root' } };
        const { controller } = harness(async request => {
            if (request.actionId === 'usage.sources.get') { entered.resolve(); return held.promise; }
            if (request.actionId === 'usage.sources.root.set') return { source: replacement };
            return { sources: [source] };
        });
        await controller.discover();
        expect(controller.getSnapshot().sources).toEqual([source]);
        const oldRead = controller.refresh('source');
        await entered.promise;
        await controller.setRoot('source', '/new/root');
        expect(controller.getSnapshot()).toMatchObject({ sources: [replacement], pending: [] });
        held.resolve({ sources: [source] });
        await oldRead;
        expect(controller.getSnapshot()).toMatchObject({ sources: [replacement], error: null });
        controller.dispose();
    });

    it('retires private root metadata and pending reads synchronously, and rejects their late completion', async () => {
        const held = createDeferred<unknown>();
        const entered = createDeferred<void>();
        const { controller, retire } = harness(async request => {
            if (request.actionId === 'usage.sources.get') { entered.resolve(); return held.promise; }
            return { sources: [source] };
        });
        await controller.discover();
        expect(controller.getSnapshot().sources).toEqual([source]);
        const read = controller.refresh();
        await entered.promise;
        retire();
        expect(controller.getSnapshot()).toMatchObject({ sources: [], loaded: false, retired: true, pending: [], error: null });
        held.resolve({ sources: [source] });
        expect(await read).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(await controller.discover()).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(controller.getSnapshot().sources).toEqual([]);
    });

    it('records Not now only after the client-local Action acknowledges it, without changing consent', async () => {
        let available = false;
        const { controller } = harness(async () => ({ sources: [source] }), {
            dismiss: async () => ({ status: available ? 'dismissed' : 'unavailable' }),
        });
        await controller.discover();
        await controller.notNow('source');
        expect(controller.getSnapshot()).toMatchObject({ sources: [source], dismissedSourceIds: [], error: { errorCode: 'usage_source_dismiss_unavailable' } });
        available = true;
        await controller.notNow('source');
        await controller.refresh();
        expect(controller.getSnapshot()).toMatchObject({ sources: [source], dismissedSourceIds: ['source'], error: null });
        controller.dispose();
    });

    it('mounts a lazy controller and retires the previous machine and Account presentation in the React consumer', async () => {
        const { controller: unused, executor, lifetime, retire } = harness(async request => ({ sources: [{
            ...source, machineId: request.input.machineId,
        }] }));
        unused.dispose();
        const hook = await renderHook((props: UsageSourcesHookOptions) => useUsageSourcesController(props), {
            initialProps: { machineId: 'machine', lifetime, executor },
        });
        expect(hook.getCurrent().controller).not.toBeNull();
        expect(hook.getCurrent().snapshot).toMatchObject({ sources: [], loaded: false, retired: false });
        const first = hook.getCurrent().controller!;
        await act(async () => { await first.discover(); });
        expect(hook.getCurrent().snapshot.sources).toEqual([source]);
        await hook.rerender({ machineId: 'other-machine', lifetime, executor });
        expect(first.getSnapshot()).toMatchObject({ sources: [], retired: true });
        expect(hook.getCurrent().snapshot).toMatchObject({ sources: [], loaded: false });
        const second = hook.getCurrent().controller!;
        await act(async () => { await second.discover(); });
        expect(hook.getCurrent().snapshot.sources[0]?.machineId).toBe('other-machine');
        await act(async () => { retire(); });
        expect(hook.getCurrent().snapshot).toMatchObject({ sources: [], retired: true });
        await hook.unmount();
    });
});
