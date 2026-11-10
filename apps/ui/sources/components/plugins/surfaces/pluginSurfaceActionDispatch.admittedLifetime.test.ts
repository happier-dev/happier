import { describe, expect, it } from 'vitest';
import { PluginProjectedActionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { dispatchPluginSurfaceAction } from './pluginSurfaceActionDispatch';

const action = { pluginId: 'acme.preparation', localId: 'prepare' };
const projected = PluginProjectedActionV2Schema.parse({
    id: action.localId, pluginId: action.pluginId, occurrenceId: 'preparation-1',
    title: 'Prepare', scopes: ['global'], surfaces: ['ui'],
    execution: { target: 'daemon' }, dangerLevel: 'safe', available: true,
    operation: { version: 1, visibility: 'activity', progress: 'indeterminate',
        presentation: { onStart: 'activity' } },
});

describe('plugin finite admission lifetime', () => {
    it('keeps the admitted transport alive when its requesting view detaches', async () => {
        const caller = new AbortController();
        let current = true;
        const result = await dispatchPluginSurfaceAction({
            action, actionRequestId: 'prepared-request', signal: caller.signal,
            isCurrent: () => current,
            resolveContributedAction: () => projected,
            onDaemonActionOperationAdmitted: () => { current = false; caller.abort(); },
            contributedAction: { machineId: 'machine-a',
                // Machine RPC is the system boundary. Respect its actual
                // cancellation/currentness inputs rather than mocking dispatch.
                execute: async (_machineId, options) => options?.signal?.aborted || options?.isCurrent?.() === false
                    ? { supported: false, reason: 'error' }
                    : { supported: true, result: { ok: true, result: { kind: 'prepared', repositoryPath: '/review' } } },
            },
        });
        expect(result).toEqual({ ok: true, result: { kind: 'prepared', repositoryPath: '/review' } });
    });

    it('does not issue work when the requesting view aborts before admission', async () => {
        const caller = new AbortController();
        caller.abort();
        let effects = 0;
        const result = await dispatchPluginSurfaceAction({
            action, actionRequestId: 'unadmitted-request', signal: caller.signal,
            resolveContributedAction: () => projected,
            contributedAction: { machineId: 'machine-a', execute: async () => {
                effects++;
                return { supported: true, result: { ok: true, result: null } };
            } },
        });
        expect(result.ok).toBe(false);
        expect(effects).toBe(0);
    });

    it('keeps the view cancellation attached to transient requests', async () => {
        const caller = new AbortController();
        const { operation: _operation, ...transient } = projected;
        let effects = 0;
        const result = await dispatchPluginSurfaceAction({
            action, signal: caller.signal,
            resolveContributedAction: () => transient,
            contributedAction: { machineId: 'machine-a', execute: async (_machineId, options) => {
                effects++;
                caller.abort();
                return options.signal?.aborted
                    ? { supported: false, reason: 'error' }
                    : { supported: true, result: { ok: true, result: null } };
            } },
        });
        expect(effects).toBe(1);
        expect(result.ok).toBe(false);
    });

    it('honors a view abort while Machine admission is still being verified', async () => {
        const caller = new AbortController();
        let effects = 0;
        const result = await dispatchPluginSurfaceAction({
            action, actionRequestId: 'verifying-request', signal: caller.signal,
            resolveContributedAction: () => projected,
            hostAction: { execute: async () => ({ ok: true, result: null }), context: {
                verifyMachineAdmissionCurrent: async () => { caller.abort(); return true; },
            } },
            contributedAction: { machineId: 'machine-a', execute: async () => {
                effects++;
                return { supported: true, result: { ok: true, result: null } };
            } },
        });
        expect(result.ok).toBe(false);
        expect(effects).toBe(0);
    });
});
