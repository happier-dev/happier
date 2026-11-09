import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { useProfile } from './hooks';

describe('profile read scope', () => {
    it('muse.experience.scopedProfile skips selectors for unrelated profile changes and reads changed consumed keys', async () => {
        const before = storage.getState();
        let reads = 0;
        const select = (profile: typeof before.profile) => {
            reads += 1;
            return profile.id;
        };
        const hook = await renderHook(() => useProfile(select, ['id']));
        try {
            const initial = hook.getCurrent();
            reads = 0;
            for (let index = 0; index < 30; index += 1) {
                await act(async () => {
                    storage.setState(state => ({ profile: { ...state.profile, name: `Unrelated ${index}` } }));
                });
            }
            expect(reads).toBe(0);
            expect(hook.getCurrent()).toBe(initial);
            await act(async () => {
                storage.setState(state => ({ profile: { ...state.profile, id: `${initial}-changed` } }));
            });
            expect(reads).toBeGreaterThan(0);
            expect(hook.getCurrent()).toBe(`${initial}-changed`);
        } finally {
            await hook.unmount();
            storage.setState(before);
        }
    });
});
