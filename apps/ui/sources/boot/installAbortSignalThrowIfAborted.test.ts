import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeAbortController, NativeAbortSignal } from '@/dev/testkit/fixtures/reactNativeFetchPrimitives';

import { installAbortSignalThrowIfAborted } from './installAbortSignalThrowIfAborted';

afterEach(() => {
    delete (NativeAbortSignal.prototype as Partial<AbortSignal>).throwIfAborted;
    vi.unstubAllGlobals();
});

describe('AbortSignal bootstrap compatibility', () => {
    it('adds native cancellation checks for signals created before and after installation', () => {
        // React Native installs this AbortController implementation without the newer method.
        vi.stubGlobal('AbortController', NativeAbortController);
        vi.stubGlobal('AbortSignal', NativeAbortSignal);
        const active = new AbortController();
        const aborted = new AbortController();
        aborted.abort();

        installAbortSignalThrowIfAborted();

        expect(() => active.signal.throwIfAborted()).not.toThrow();
        expect(() => aborted.signal.throwIfAborted()).toThrow(expect.objectContaining({ name: 'AbortError' }));
        const later = new AbortController();
        later.abort();
        expect(() => later.signal.throwIfAborted()).toThrow(expect.objectContaining({ name: 'AbortError' }));
    });

    it('preserves an existing platform implementation and its abort reason', () => {
        const implementation = AbortSignal.prototype.throwIfAborted;
        const controller = new AbortController();
        const reason = new Error('cancelled by caller');
        controller.abort(reason);

        installAbortSignalThrowIfAborted();
        installAbortSignalThrowIfAborted();

        expect(AbortSignal.prototype.throwIfAborted).toBe(implementation);
        expect(() => controller.signal.throwIfAborted()).toThrow(reason);
    });
});
