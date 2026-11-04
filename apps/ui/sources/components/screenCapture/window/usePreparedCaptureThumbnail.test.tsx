import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { usePreparedCaptureThumbnail } from './usePreparedCaptureThumbnail';

describe('prepared capture thumbnail lifetime', () => {
    afterEach(async () => { await standardCleanup(); vi.restoreAllMocks(); });

    it('retires replaced and unmounted URLs and creates none when pending preparation finishes after unmount', async () => {
        // Object URLs belong to the browser, outside the React lifetime owner.
        const createUrl = vi.spyOn(URL, 'createObjectURL')
            .mockReturnValueOnce('blob:prepared-first').mockReturnValueOnce('blob:prepared-second');
        const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
        const hook = await renderHook(usePreparedCaptureThumbnail);
        expect(hook.getCurrent().thumbnailUri).toBeNull();
        await act(async () => { hook.getCurrent().setPreparedPng(new Uint8Array([1])); });
        expect(hook.getCurrent().thumbnailUri).toBe('blob:prepared-first');
        expect(revokeUrl).not.toHaveBeenCalled();

        await act(async () => { hook.getCurrent().setPreparedPng(new Uint8Array([2])); });
        expect(hook.getCurrent().thumbnailUri).toBe('blob:prepared-second');
        expect(revokeUrl.mock.calls).toEqual([['blob:prepared-first']]);

        const pending = createDeferred<Uint8Array>();
        const finishPreparation = pending.promise.then(hook.getCurrent().setPreparedPng);
        await hook.unmount();
        expect(revokeUrl.mock.calls).toEqual([['blob:prepared-first'], ['blob:prepared-second']]);
        await act(async () => { pending.resolve(new Uint8Array([3])); await finishPreparation; });
        expect(createUrl).toHaveBeenCalledTimes(2);
        expect(revokeUrl.mock.calls).toEqual([['blob:prepared-first'], ['blob:prepared-second']]);
    });
});
