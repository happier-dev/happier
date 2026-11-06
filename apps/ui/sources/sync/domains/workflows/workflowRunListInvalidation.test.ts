import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storageStore';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

import { subscribeVisibleWorkflowRunListInvalidation } from './workflowRunListInvalidation';

function buildLifetime(params: Readonly<{
    serverId?: string;
    current?: boolean;
}> = {}): ActiveServerAccountScopeLifetime {
    const serverId = params.serverId ?? 'server-a';
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://workflow-invalidation.test', generation: 1 });
    storage.setState({ profileScope: { serverId, accountId: 'account-a' } });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected a real applied Account lifetime');
    if (params.current === false) retireActiveServerAccountScopeLifetime();
    return lifetime;
}

let previous = storage.getState();
let applied = getAppliedActiveServerSnapshot();
let available = isAppliedActiveServerRuntimeAvailable();
beforeEach(() => {
    previous = storage.getState(); applied = getAppliedActiveServerSnapshot(); available = isAppliedActiveServerRuntimeAvailable();
});
afterEach(() => {
    retireActiveServerAccountScopeLifetime(); storage.setState(previous); publishAppliedActiveServerSnapshot(applied, available);
});

describe('subscribeVisibleWorkflowRunListInvalidation', () => {
    it.each([{ runId: 'run-a' }, { runIds: ['run-a'] }])('refreshes demanded source grants and Team membership even when other Runs were already materialized (%#)', selection => {
        const invalidate = vi.fn();
        const sources = { sourceArtifactIds: () => ['source-a'] };
        const unsubscribe = subscribeVisibleWorkflowRunListInvalidation({ lifetime: buildLifetime(), ...selection, ...sources,
            ...('runId' in selection ? { sourceArtifactId: 'source-a' } : {}), isVisibleWindowLoaded: () => true, invalidate });
        try {
            // Both exact selections observe their demanded source, never other Artifacts.
            publishHomeAccountChange('server-a', ['source-b'], { changeKinds: ['artifact'] });
            publishHomeAccountChange('server-a', ['workflow-run:run-b'], { changeKinds: ['account'] });
            expect(invalidate).not.toHaveBeenCalled();
            publishHomeAccountChange('server-a', ['source-a'], { changeKinds: ['artifact'], workflowRunsMaterialized: true });
            publishHomeAccountChange('server-a', ['teams'], { changeKinds: ['account'], workflowRunsMaterialized: true });
            expect(invalidate.mock.calls).toEqual([[{ summaryCurrent: false, sourceArtifactIds: ['source-a'] }], [{ summaryCurrent: false }]]);
        } finally { unsubscribe(); }
    });
    it('uses Account Automation changes for the Automation attention window only', () => {
        const invalidate = vi.fn();
        const unsubscribe = subscribeVisibleWorkflowRunListInvalidation({
            lifetime: buildLifetime(), source: 'automation',
            isVisibleWindowLoaded: () => true, invalidate,
        });
        publishHomeAccountChange('server-a', ['workflow-run:run-a']);
        publishHomeAccountChange('server-b', ['automation:definition-a']);
        expect(invalidate).not.toHaveBeenCalled();
        publishHomeAccountChange('server-a', ['automation:definition-a']);
        expect(invalidate).toHaveBeenCalledTimes(1);
        unsubscribe();
    });
    it('refreshes demanded Run detail on a scoped wake without relying on a parent revision', () => {
        const invalidate = vi.fn();
        let demanded = true;
        const unsubscribe = subscribeVisibleWorkflowRunListInvalidation({
            lifetime: buildLifetime(),
            runId: 'run-a',
            isVisibleWindowLoaded: () => demanded,
            invalidate,
        });

        publishHomeAccountChange('server-a', ['workflow-run:run-b']);
        publishHomeAccountChange('server-b', ['workflow-run:run-a']);
        expect(invalidate).not.toHaveBeenCalled();
        publishHomeAccountChange('server-a', ['workflow-run:run-a']);
        publishHomeAccountChange('server-a');
        expect(invalidate).toHaveBeenCalledTimes(2);
        demanded = false;
        publishHomeAccountChange('server-a', ['workflow-run:run-a']);
        expect(invalidate).toHaveBeenCalledTimes(2);
        unsubscribe();
        publishHomeAccountChange('server-a', ['workflow-run:run-a']);
        expect(invalidate).toHaveBeenCalledTimes(2);
    });

    it('invalidates a loaded visible window for an exact workflow Run change', () => {
        const invalidate = vi.fn();
        const unsubscribe = subscribeVisibleWorkflowRunListInvalidation({
            lifetime: buildLifetime(),
            isVisibleWindowLoaded: () => true,
            invalidate,
        });

        publishHomeAccountChange('server-a', ['workflow-run:run-a']);

        expect(invalidate).toHaveBeenCalledTimes(1);
        unsubscribe();
    });

    it('ignores unrelated, unloaded, and retired Account wakes', () => {
        const invalidate = vi.fn();
        const retired = buildLifetime({ current: false });
        const current = buildLifetime();
        const subscriptions = [
            subscribeVisibleWorkflowRunListInvalidation({
                lifetime: current,
                isVisibleWindowLoaded: () => true,
                invalidate,
            }),
            subscribeVisibleWorkflowRunListInvalidation({
                lifetime: current,
                isVisibleWindowLoaded: () => false,
                invalidate,
            }),
            subscribeVisibleWorkflowRunListInvalidation({
                lifetime: retired,
                isVisibleWindowLoaded: () => true,
                invalidate,
            }),
        ];

        publishHomeAccountChange('server-a', ['self']);
        publishHomeAccountChange('server-b', ['workflow-run:run-a']);
        publishHomeAccountChange('server-a', ['workflow-run:run-a']);

        expect(invalidate).toHaveBeenCalledTimes(1);
        subscriptions.forEach((unsubscribe) => unsubscribe());
    });

    it('conservatively invalidates a loaded visible window for a content-free wake', () => {
        const invalidate = vi.fn();
        const unsubscribe = subscribeVisibleWorkflowRunListInvalidation({
            lifetime: buildLifetime(),
            isVisibleWindowLoaded: () => true,
            invalidate,
        });

        publishHomeAccountChange('server-a');

        expect(invalidate).toHaveBeenCalledTimes(1);
        unsubscribe();
    });
});
