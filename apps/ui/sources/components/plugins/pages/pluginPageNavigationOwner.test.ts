import { describe, expect, it, vi } from 'vitest';
import { createPluginPageNavigationOwner } from './pluginPageNavigationOwner';
import type { PluginUiPageNavigationV1 } from '@happier-dev/protocol/plugins/ui/pageNavigation';

const descriptor: PluginUiPageNavigationV1 = {
    pageKind: { pluginId: 'happier.triage', localId: 'entry' }, value: 'overview',
    items: ['overview', 'files'].map(value => ({ value, title: value, kind: 'page', phonePlacement: 'bar' })),
};

describe('mounted plugin page navigation owner', () => {
    it('settles accepted and rejected requests with the controlled descriptor and permits rejected repeats', () => {
        const owner = createPluginPageNavigationOwner();
        const changed = vi.fn();
        owner.subscribe(changed);
        owner.setPageNavigation({ navigation: descriptor });
        const published = owner.getSnapshot().navigation;
        owner.select('overview');
        expect(changed).toHaveBeenCalledTimes(1);
        owner.select('files');
        expect(owner.getSnapshot()).toMatchObject({ navigation: { value: 'overview' }, request: 'files' });
        owner.setPageNavigation({ navigation: descriptor });
        expect(owner.getSnapshot()).toEqual({ navigation: published, request: null });
        expect(owner.getSnapshot().navigation).toBe(published);
        owner.select('files');
        expect(owner.getSnapshot().request).toBe('files');
        owner.setPageNavigation({ navigation: { ...descriptor, value: 'files' } });
        expect(owner.getSnapshot()).toMatchObject({ navigation: { value: 'files' }, request: null });
        expect(owner.getSnapshot().navigation?.items).toBe(published?.items);
        owner.setPageNavigation({ navigation: null });
        expect(owner.getSnapshot()).toEqual({ navigation: null, request: null });
    });

    it('rejects malformed presentation at the transport boundary without losing the live declaration', () => {
        const owner = createPluginPageNavigationOwner();
        owner.setPageNavigation({ navigation: descriptor });
        const before = owner.getSnapshot();
        expect(owner.setPageNavigation({ navigation: { ...descriptor, body: 'unportable' } })).toMatchObject({ code: 'invalid_payload' });
        expect(owner.getSnapshot()).toBe(before);
    });
});
