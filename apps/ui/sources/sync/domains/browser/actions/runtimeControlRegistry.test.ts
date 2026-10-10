import { afterEach, describe, expect, it } from 'vitest';
import { dispatchBrowserControlCommand } from '../control/commands';
import { createBrowserControlState } from '../control/reducer';
import {
    clearBrowserRuntimeControlRegistryForTests,
    readRegisteredBrowserRuntimeControlAdapter,
    registerBrowserRuntimeControlAdapter,
} from './runtimeControlRegistry';

function mountedView(viewId: string) {
    let state = dispatchBrowserControlCommand(createBrowserControlState(), {
        kind: 'openView', commandId: `open:${viewId}`, browserSessionId: 'session', viewId,
        target: { kind: 'localServicePreview', targetId: viewId, sessionId: 'session', machineId: 'machine' },
        platform: 'web', currentUrl: `https://${viewId}.example.test/`, focus: true,
    }).state;
    return {
        readState: () => state,
        applyDispatchResult: (result: ReturnType<typeof dispatchBrowserControlCommand>) => { state = result.state; },
    };
}

describe('mounted Browser runtime control routing', () => {
    afterEach(clearBrowserRuntimeControlRegistryForTests);

    it('keeps two mounted views of one Session independently reachable through their owning adapters', () => {
        const first = mountedView('first');
        const second = mountedView('second');
        const closeFirst = registerBrowserRuntimeControlAdapter({ browserSessionId: 'session', control: first });
        const closeSecond = registerBrowserRuntimeControlAdapter({ browserSessionId: 'session', control: second });
        const command = { kind: 'reload', commandId: 'reload-first', browserSessionId: 'session', viewId: 'first' } as const;
        const owner = readRegisteredBrowserRuntimeControlAdapter('session', command.viewId);
        const state = owner?.readState();
        expect(state?.viewsById.first).toBeDefined();
        if (owner && state) owner.applyDispatchResult(dispatchBrowserControlCommand(state, command));
        expect(first.readState().viewsById.first?.navigationGeneration).toBe(1);
        expect(second.readState().viewsById.second?.navigationGeneration).toBe(0);
        closeFirst();
        expect(readRegisteredBrowserRuntimeControlAdapter('session', 'second')?.readState()?.viewsById.second).toBeDefined();
        closeSecond();
        expect(readRegisteredBrowserRuntimeControlAdapter('session', 'second')).toBeNull();
    });
});
