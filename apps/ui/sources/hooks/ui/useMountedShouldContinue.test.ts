import { describe, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { useMountedShouldContinue } from './useMountedShouldContinue';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('useMountedShouldContinue', () => {
    it('returns true while mounted and false after unmount', async () => {
        const hook = await renderHook(() => useMountedShouldContinue());

        expect(hook.getCurrent()()).toBe(true);

        await hook.unmount();

        expect(hook.getCurrent()()).toBe(false);
    });
});
