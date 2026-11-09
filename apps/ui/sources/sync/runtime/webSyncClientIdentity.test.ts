import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWebSyncClientIdentity } from './webSyncClientIdentity';

afterEach(() => { vi.unstubAllGlobals(); });

describe('resolveWebSyncClientIdentity', () => {
    it('allocates a fresh in-memory cursor scope without reading or writing tab presence', () => {
        const getItem = vi.fn(() => 'copied-tab');
        const setItem = vi.fn();
        vi.stubGlobal('localStorage', { getItem, setItem });
        vi.stubGlobal('sessionStorage', { getItem, setItem });
        const identity = resolveWebSyncClientIdentity({ randomUUID: () => 'fresh-tab' });
        expect({ instanceId: identity.instanceId, reads: getItem.mock.calls.length, writes: setItem.mock.calls.length })
            .toEqual({ instanceId: 'fresh-tab', reads: 0, writes: 0 });
    });

    it('gives independently loaded tabs distinct cursor scopes even with copied storage', () => {
        const randomUUID = vi.fn().mockReturnValueOnce('tab-a').mockReturnValueOnce('tab-b');
        expect(resolveWebSyncClientIdentity({ randomUUID }).instanceId).toBe('tab-a');
        expect(resolveWebSyncClientIdentity({ randomUUID }).instanceId).toBe('tab-b');
    });
});
