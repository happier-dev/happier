import { expect, it } from 'vitest';
import { buildBrowserAdapterCapabilities } from '../adapters/capabilities';
import { applyBrowserControlEvent, createBrowserControlState } from './reducer';
import { dispatchBrowserControlCommand } from './commands';

it('routes daemon controller commands and refuses client commands without their controller', () => {
    const view = { browserSessionId: 'browser', viewId: 'view' };
    const state = applyBrowserControlEvent(createBrowserControlState(), { ...view, kind: 'viewOpened', eventId: 'open', occurredAt: 1,
        target: { kind: 'externalUrl', targetId: 'target', url: 'https://example.test/' }, platform: 'web',
        adapterKind: 'chromiumSidecar', engineKind: 'streamedSurface', adapterCapabilities: buildBrowserAdapterCapabilities({
            adapterKind: 'chromiumSidecar', supportedTargetKinds: ['externalUrl'], supportedRenderEngines: ['streamedSurface'],
        }) });
    for (const kind of ['takeControl', 'handBack'] as const) {
        const command = { ...view, kind, commandId: kind };
        expect(dispatchBrowserControlCommand(state, command)).toEqual({ state, effects: [{ kind: 'daemonCommand', command }] });
        const local = { ...state, viewsById: { view: { ...state.viewsById.view, adapterKind: 'localPreview' as const } } };
        expect(dispatchBrowserControlCommand(local, command)).toEqual({ state: local,
            effects: [{ kind: 'commandRejected', command, reasonCode: 'adapter_unavailable' }] });
    }
});
