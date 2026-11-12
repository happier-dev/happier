import { describe, expect, it, vi } from 'vitest';
import { createPluginUiActionControlTestHost } from './actionControlHost.js';

describe('Action control test host slot', () => {
    it('publishes stable immutable snapshots for binding, changed presentation and withdrawal', async () => {
        const host = createPluginUiActionControlTestHost(async () => ({ ok: true, result: null }));
        const changed = vi.fn();
        const unsubscribe = host.subscribe(changed);
        const empty = host.getSnapshot();
        expect(Object.isFrozen(empty)).toBe(true);
        expect(host.getSnapshot()).toBe(empty);
        const presentation = { title: 'Save' };
        const control = await host.handler({ request: { kind: 'bind', subscriptionId: 'slot-save',
            action: 'projects.compute.exec', presentation }, signal: new AbortController().signal, publish() {} });
        const bound = host.getSnapshot();
        expect(bound).toEqual([{ id: 'slot-save', presentation: { title: 'Save' } }]);
        expect(Object.isFrozen(bound)).toBe(true);
        expect(Object.isFrozen(bound[0])).toBe(true);
        expect(Object.isFrozen(bound[0]?.presentation)).toBe(true);
        presentation.title = 'Mutated outside the host';
        expect(bound[0]?.presentation.title).toBe('Save');
        expect(changed).toHaveBeenCalledTimes(1);
        await host.handler({ request: { kind: 'update', subscriptionId: 'slot-save', presentation: { title: 'Save' } },
            signal: new AbortController().signal, publish() {} });
        expect(host.getSnapshot()).toBe(bound);
        expect(changed).toHaveBeenCalledTimes(1);
        await host.handler({ request: { kind: 'update', subscriptionId: 'slot-save', presentation: { title: 'Saving', disabled: true } },
            signal: new AbortController().signal, publish() {} });
        expect(host.getSnapshot()).toEqual([{ id: 'slot-save', presentation: { title: 'Saving', disabled: true } }]);
        expect(bound[0]?.presentation).toEqual({ title: 'Save' });
        expect(changed).toHaveBeenCalledTimes(2);
        if (!control || !('dispose' in control)) throw new Error('Missing binding disposer');
        await control.dispose();
        expect(host.getSnapshot()).toEqual([]);
        expect(changed).toHaveBeenCalledTimes(3);
        unsubscribe();
        await control.dispose();
        await host.handler({ request: { kind: 'bind', subscriptionId: 'slot-next',
            action: 'projects.compute.exec', presentation: { title: 'Next' } },
            signal: new AbortController().signal, publish() {} });
        expect(changed).toHaveBeenCalledTimes(3);
    });

    it('presses by subscription identity when titles repeat and refuses disabled or withdrawn controls', async () => {
        const host = createPluginUiActionControlTestHost(async () => ({ ok: true, result: null }));
        const first = vi.fn();
        const second = vi.fn();
        const signal = new AbortController().signal;
        await host.handler({ request: { kind: 'bind', subscriptionId: 'first', action: 'projects.compute.exec',
            presentation: { title: 'Save' } }, signal, publish: first });
        const control = await host.handler({ request: { kind: 'bind', subscriptionId: 'second', action: 'projects.compute.exec',
            presentation: { title: 'Save' } }, signal, publish: second });
        const press = host.pressById('second');
        const event = second.mock.calls[0]?.[0];
        expect(event).toMatchObject({ kind: 'prepare' });
        expect(first).not.toHaveBeenCalled();
        await host.handler({ request: { kind: 'prepared', subscriptionId: 'second', requestId: event.requestId,
            preparation: { input: {} } }, signal, publish: second });
        await press;
        await host.handler({ request: { kind: 'update', subscriptionId: 'second', presentation: { title: 'Save', disabled: true } }, signal, publish: second });
        await expect(host.pressById('second')).rejects.toThrow('Disabled');
        expect(second.mock.calls.filter(([value]) => value.kind === 'prepare')).toHaveLength(1);
        if (!control || !('dispose' in control)) throw new Error('Missing binding disposer');
        await control.dispose();
        await expect(host.pressById('second')).rejects.toThrow('Missing');
    });
});
