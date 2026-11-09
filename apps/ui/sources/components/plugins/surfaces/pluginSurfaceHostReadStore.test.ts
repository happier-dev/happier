import { describe, expect, it, vi } from 'vitest';
import { createPluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import type { PluginUiResourceProjection } from '@happier-dev/plugin-ui/hostApi';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

import { createPluginSurfaceHostReadStore } from './pluginSurfaceHostReadStore';

describe('surface host read typed selection', () => {
    it('publishes live readiness when a cached Resource watch settles during mount admission', async () => {
        const reference = { hostRead: 'usage.query', input: { queries: [{}] } } as const;
        const content = { contentType: 'application/json', digest: 'cached', bytes: new TextEncoder().encode('7') };
        // Only the Resource transport and mounted permission RPC are boundaries;
        // the Account store, watch lifecycle and permission facade stay real.
        const account = createPluginUiResourceStore({ client: {
            readResource: async () => content,
            watchResource: async () => ({ admittedDigest: content.digest, dispose() {} }),
        } });
        const shared = account.getEntry(reference);
        await shared.refresh();
        const surface = createPluginSurfaceHostReadStore({ admit: async () => shared,
            isCurrent: () => true, lifetimeSignal: new AbortController().signal });
        const entry = surface.getEntry(reference);
        const observed: string[] = [];
        let release: (() => void) | undefined;
        try {
            await entry.refresh();
            release = entry.subscribe(() => { observed.push(entry.getSnapshot().subscription); }, true);
            await expect.poll(() => observed.includes('live')).toBe(true);
            expect(entry.getSnapshot()).toMatchObject({ value: content, subscription: 'live', pending: 'idle' });
        } finally { release?.(); surface.dispose(); account.dispose(); }
    });

    it.each(['denied', 'disposed', 'aborted', 'superseded'] as const)(
        'stops author decoding after the mount is %s while its healthy peer receives new bytes', async withdrawal => {
            const reference = { hostRead: 'usage.query', input: { queries: [{}] } } as const;
            let text = 'allowed-before-revocation';
            const account = createPluginUiResourceStore({ client: { readResource: async () => ({
                contentType: 'text/plain', digest: text, bytes: new TextEncoder().encode(text),
            }) } });
            const shared = account.getEntry(reference);
            const peer = shared.select({ decode: content => new TextDecoder().decode(content.bytes) }, snapshot => snapshot.value);
            let denied = false;
            let current = true;
            const lifetime = new AbortController();
            const surface = createPluginSurfaceHostReadStore({
                admit: async () => {
                    if (denied) throw Object.assign(new Error('Denied'), { code: 'denied' });
                    return shared;
                },
                isCurrent: () => current,
                lifetimeSignal: lifetime.signal,
            });
            const received: string[] = [];
            const selected = surface.getEntry(reference).select({ decode: content => {
                const value = new TextDecoder().decode(content.bytes);
                received.push(value);
                return value;
            } }, snapshot => snapshot.value);
            try {
                await selected.refresh();
                expect(selected.getSnapshot()).toBe(text);
                if (withdrawal === 'denied') { denied = true; await selected.refresh(); }
                else if (withdrawal === 'disposed') surface.dispose();
                else if (withdrawal === 'aborted') lifetime.abort();
                else current = false;
                expect(selected.getSnapshot()).toBeUndefined();
                const lateDecode = vi.fn(() => 'not admitted');
                const late = surface.getEntry(reference).select({ decode: lateDecode }, snapshot => snapshot.value);
                text = 'private-after-revocation';
                await shared.refresh();
                expect(peer.getSnapshot()).toBe(text);
                expect(selected.getSnapshot()).toBeUndefined();
                expect(late.getSnapshot()).toBeUndefined();
                expect(received).toEqual(['allowed-before-revocation']);
                expect(lateDecode).not.toHaveBeenCalled();
                if (withdrawal === 'denied') {
                    denied = false;
                    await selected.refresh();
                    expect(selected.getSnapshot()).toBe(text);
                    expect(received).toEqual(['allowed-before-revocation', text]);
                }
            } finally { surface.dispose(); account.dispose(); }
        },
    );

    it('keeps whole-snapshot selections stable until permission actually changes', async () => {
        const admission = createDeferred<never>();
        const surface = createPluginSurfaceHostReadStore({
            admit: () => admission.promise,
            isCurrent: () => true,
            lifetimeSignal: new AbortController().signal,
        });
        const decode = vi.fn(() => 0);
        const selected = surface.getEntry({ hostRead: 'usage.query', input: { queries: [{}] } })
            .select({ decode }, snapshot => snapshot);
        try {
            const unadmitted = selected.getSnapshot();
            expect(selected.getSnapshot()).toBe(unadmitted);
            const refresh = selected.refresh();
            const pending = selected.getSnapshot();
            expect(pending).not.toBe(unadmitted);
            expect(pending.pending).toBe('initial');
            expect(selected.getSnapshot()).toBe(pending);
            admission.reject(Object.assign(new Error('Denied'), { code: 'denied' }));
            await refresh;
            const denied = selected.getSnapshot();
            expect(denied).not.toBe(pending);
            expect(denied.error?.code).toBe('denied');
            expect(selected.getSnapshot()).toBe(denied);
            surface.dispose();
            const retired = selected.getSnapshot();
            expect(retired).not.toBe(denied);
            expect(retired.error?.code).toBe('plugin_surface_retired');
            expect(selected.getSnapshot()).toBe(retired);
            expect(decode).not.toHaveBeenCalled();
        } finally { surface.dispose(); }
    });

    it('uses the admitted Account projection and withdraws it when mount permission is refused', async () => {
        const reference = { hostRead: 'usage.query', input: { queries: [{}] } } as const;
        const content = { contentType: 'application/json', digest: 'usage', bytes: new TextEncoder().encode('7') };
        const account = createPluginUiResourceStore({ client: { readResource: async () => content } });
        const accountEntry = account.getEntry(reference);
        await accountEntry.refresh();
        const decode = vi.fn((value: typeof content) => Number(new TextDecoder().decode(value.bytes)));
        const projection: PluginUiResourceProjection<number> = { decode };
        const accountSelected = accountEntry.select(projection, snapshot => snapshot.value);
        expect(accountSelected.getSnapshot()).toBe(7);
        let refuse = false;
        // The mounted permission RPC is the boundary; both Resource stores and
        // all typed ingress/selection logic below it remain real.
        const surface = createPluginSurfaceHostReadStore({
            admit: async () => {
                if (refuse) throw Object.assign(new Error('Permission refused'), { code: 'denied' });
                return accountEntry;
            },
            isCurrent: () => true,
            lifetimeSignal: new AbortController().signal,
        });
        const entry = surface.getEntry(reference);
        const selected = entry.select(projection, snapshot => snapshot.value);
        expect(selected.getSnapshot()).toBeUndefined();
        await selected.refresh();
        expect(selected.getSnapshot()).toBe(7);
        expect(decode).toHaveBeenCalledTimes(1);
        refuse = true;
        await selected.refresh();
        expect(selected.getSnapshot()).toBeUndefined();
        expect(entry.getSnapshot().error?.code).toBe('denied');
        expect(accountSelected.getSnapshot()).toBe(7);
        expect(decode).toHaveBeenCalledTimes(1);
        surface.dispose();
        account.dispose();
    });
});
