import { createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { SESSION_PULL_REQUEST_RELATIONS_ACTION_ID_V1 } from '@happier-dev/channels-protocol/v1';
import type { PluginDynamicResourceInvocationOptionsV1 } from '@happier-dev/plugin-sdk/resources';

import { testkitEntryRef } from '../corpus/testkit/observations.test-support.js';
import { TriageReadSourceSessionLinksResultV1Schema } from '../actions/sessionLinksProtocol.js';
import { decodeTriageSessionLinksResource, TRIAGE_SESSION_LINKS_RESOURCE_RUNTIME } from './sessionLinksResource.js';

describe('the Session relation Resource', () => {
    it('reads the full composed owner result for only the host-stamped Session', async () => {
        const result = TriageReadSourceSessionLinksResultV1Schema.parse({ kind: 'partial', links: [{
            entryRef: testkitEntryRef({ kindId: 'issue' }), sessionId: 'session-a', linkedAtMs: 1, displayPath: 'Issue #17',
        }], lanes: [] });
        const readAction = vi.fn<PluginDynamicResourceInvocationOptionsV1['readAction']>(async action => ({ ok: true, result:
            action.localId === SESSION_PULL_REQUEST_RELATIONS_ACTION_ID_V1 ? { kind: 'relations', links: [] } : result }));
        const options = createTestResourceInvocationContext({ context: { kind: 'session' as const, sessionId: 'session-a' }, signal: new AbortController().signal,
            readAction,
        }) satisfies PluginDynamicResourceInvocationOptionsV1;
        const bytes = await TRIAGE_SESSION_LINKS_RESOURCE_RUNTIME.read(options);
        expect(TriageReadSourceSessionLinksResultV1Schema.parse(JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes))))
            .toEqual(result);
        expect(readAction).toHaveBeenCalledWith(
            { pluginId: 'happier.triage', localId: 'sessions/read-source-links-v1' },
            { v: 1, sessionId: 'session-a' }, { signal: options.signal },
        );
        expect(readAction).toHaveBeenCalledWith(
            { pluginId: 'happier.channels', localId: SESSION_PULL_REQUEST_RELATIONS_ACTION_ID_V1 },
            { kind: 'readRelations', credentialRef: null, sessionIds: ['session-a'] }, { signal: options.signal },
        );
        expect(readAction).toHaveBeenCalledTimes(2);
    });

    it('retains the request ID when Channels rejects the Session relation read', async () => {
        const refusal = { ok: false as const, errorCode: 'collection_update_required',
            error: 'Update required', requestId: 'channels-update-request' };
        const options = createTestResourceInvocationContext({ context: { kind: 'session', sessionId: 'session-a' },
            signal: new AbortController().signal,
            readAction: async action => action.localId === SESSION_PULL_REQUEST_RELATIONS_ACTION_ID_V1
                ? refusal : { ok: true, result: { kind: 'complete', links: [], lanes: [] } },
        });
        const value = await TRIAGE_SESSION_LINKS_RESOURCE_RUNTIME.read(options);
        const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
        expect(decodeTriageSessionLinksResource(bytes).channels?.failures)
            .toEqual([{ sessionId: 'session-a', code: refusal.errorCode, requestId: refusal.requestId }]);
    });

    it('refuses absent Session authority and unadmitted read answers instead of reporting an empty set', async () => {
        const readAction = vi.fn(async () => ({ ok: true as const, result: { kind: 'complete', links: [] } }));
        const options = createTestResourceInvocationContext({ context: { kind: 'global' as const }, signal: new AbortController().signal,
            readAction,
        }) satisfies PluginDynamicResourceInvocationOptionsV1;
        await expect(TRIAGE_SESSION_LINKS_RESOURCE_RUNTIME.read(options)).rejects.toThrow();
        expect(readAction).not.toHaveBeenCalled();
        await expect(TRIAGE_SESSION_LINKS_RESOURCE_RUNTIME.read(createTestResourceInvocationContext({ ...options, context: { kind: 'session', sessionId: 'session-a' },
            readAction: async () => ({ ok: false, errorCode: 'denied', error: 'Refused' }),
        }))).rejects.toThrow();
    });

    it('observes the same admitted relation without reacquiring it and disposes a late observer', async () => {
        const readAction = vi.fn(async () => ({ ok: true as const, result: { kind: 'complete', links: [] } }));
        const dispose = vi.fn();
        let attach: ((value: { dispose(): void }) => void) | undefined;
        const observeAction = vi.fn(async () => await new Promise<{ dispose(): void }>(resolve => { attach = resolve; }));
        const controller = new AbortController();
        const options = createTestResourceInvocationContext({ context: { kind: 'session' as const, sessionId: 'session-a' }, signal: controller.signal,
            readAction, observeAction,
        }) satisfies PluginDynamicResourceInvocationOptionsV1;
        const invalidate = vi.fn();
        const observation = TRIAGE_SESSION_LINKS_RESOURCE_RUNTIME.observe(invalidate, options);
        expect(observeAction).toHaveBeenCalledExactlyOnceWith(
            { pluginId: 'happier.triage', localId: 'sessions/read-source-links-v1' },
            { v: 1, sessionId: 'session-a' }, expect.any(Function), { signal: expect.any(AbortSignal) },
        );
        expect(readAction).not.toHaveBeenCalled();
        controller.abort();
        attach?.({ dispose });
        (await observation).dispose();
        expect(dispose).toHaveBeenCalledOnce();
        expect(invalidate).not.toHaveBeenCalled();
    });

    it('does not admit live observation before attachment or convert refusal into an invalidation', async () => {
        const failure = new PluginError({ code: 'plugin_action_read_observation_unavailable', message: 'Observer unavailable' });
        let rejectAttachment: ((reason: unknown) => void) | undefined;
        const options = createTestResourceInvocationContext({ context: { kind: 'session' as const, sessionId: 'session-a' }, signal: new AbortController().signal,
            readAction: vi.fn(async () => ({ ok: true as const, result: { kind: 'complete', links: [] } })),
            observeAction: async () => await new Promise<{ dispose(): void }>((_resolve, reject) => { rejectAttachment = reject; }),
        }) satisfies PluginDynamicResourceInvocationOptionsV1;
        const invalidate = vi.fn();
        let admitted = false;
        const pending = Promise.resolve(TRIAGE_SESSION_LINKS_RESOURCE_RUNTIME.observe(invalidate, options)).then(handle => {
            admitted = true;
            return handle;
        });
        await Promise.resolve();
        expect(admitted).toBe(false);
        rejectAttachment?.(failure);
        await expect(pending).rejects.toBe(failure);
        expect(invalidate).not.toHaveBeenCalled();
        expect(options.readAction).not.toHaveBeenCalled();
    });

    it('returns one actual cleanup promise and fences callbacks before cleanup settles', async () => {
        let settleCleanup: (() => void) | undefined;
        const cleanupGate = new Promise<void>(resolve => { settleCleanup = resolve; });
        const dispose = vi.fn(() => cleanupGate);
        const dependenciesChanged: Array<() => void> = [];
        const options = createTestResourceInvocationContext({ context: { kind: 'session' as const, sessionId: 'session-a' }, signal: new AbortController().signal,
            readAction: async () => ({ ok: true as const, result: { kind: 'complete', links: [] } }),
            observeAction: async (_ref: unknown, _input: unknown, invalidate: () => void) => {
                dependenciesChanged.push(invalidate);
                return { dispose };
            },
        }) satisfies PluginDynamicResourceInvocationOptionsV1;
        const invalidate = vi.fn();
        const observation = await TRIAGE_SESSION_LINKS_RESOURCE_RUNTIME.observe(invalidate, options);
        expect(dependenciesChanged).toHaveLength(2);
        dependenciesChanged[1]?.();
        expect(invalidate).toHaveBeenCalledOnce();
        invalidate.mockClear();
        const cleanup = observation.dispose();
        expect(cleanup).toBeInstanceOf(Promise);
        expect(observation.dispose()).toBe(cleanup);
        for (const dependencyChanged of dependenciesChanged) dependencyChanged();
        expect(invalidate).not.toHaveBeenCalled();
        let cleaned = false;
        const settled = Promise.resolve(cleanup).then(() => { cleaned = true; });
        await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(2));
        await Promise.resolve();
        expect(cleaned).toBe(false);
        settleCleanup?.();
        await settled;
        expect(cleaned).toBe(true);
        expect(dispose).toHaveBeenCalledTimes(2);
    });

    it('awaits rejected late cleanup after cancellation and retains an abort-started cleanup rejection', async () => {
        const failure = new Error('host observer cleanup failed');
        let rejectCleanup: ((reason: unknown) => void) | undefined;
        const cleanupGate = new Promise<void>((_resolve, reject) => { rejectCleanup = reject; });
        const dispose = vi.fn(() => cleanupGate);
        let attach: ((value: { dispose(): Promise<void> }) => void) | undefined;
        const controller = new AbortController();
        const options = createTestResourceInvocationContext({ context: { kind: 'session' as const, sessionId: 'session-a' }, signal: controller.signal,
            readAction: async () => ({ ok: true as const, result: { kind: 'complete', links: [] } }),
            observeAction: async () => await new Promise<{ dispose(): Promise<void> }>(resolve => { attach = resolve; }),
        }) satisfies PluginDynamicResourceInvocationOptionsV1;
        let established = false;
        const pending = Promise.resolve(TRIAGE_SESSION_LINKS_RESOURCE_RUNTIME.observe(vi.fn(), options)).then(handle => {
            established = true;
            return handle;
        });
        controller.abort();
        attach?.({ dispose });
        await Promise.resolve();
        await Promise.resolve();
        expect(established).toBe(false);
        const rejected = expect(pending).rejects.toBe(failure);
        rejectCleanup?.(failure);
        await rejected;
        expect(dispose).toHaveBeenCalledOnce();

        const activeController = new AbortController();
        const active = await TRIAGE_SESSION_LINKS_RESOURCE_RUNTIME.observe(vi.fn(), createTestResourceInvocationContext({ ...options,
            signal: activeController.signal, observeAction: async () => ({ dispose: () => Promise.reject(failure) }),
        }));
        activeController.abort();
        const cleanup = active.dispose();
        expect(active.dispose()).toBe(cleanup);
        await expect(cleanup).rejects.toBe(failure);
    });
});
