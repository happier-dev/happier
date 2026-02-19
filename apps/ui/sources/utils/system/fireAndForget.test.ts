import { describe, expect, it, vi } from 'vitest';
import { fireAndForget } from './fireAndForget';

describe('fireAndForget', () => {
    it('prevents unhandledRejection for a rejected promise', async () => {
        const unhandledSpy = vi.fn();
        process.on('unhandledRejection', unhandledSpy);
        try {
            fireAndForget(Promise.reject(new Error('boom')));
            await new Promise((resolve) => setTimeout(resolve, 0));
        } finally {
            process.removeListener('unhandledRejection', unhandledSpy);
        }
        expect(unhandledSpy).not.toHaveBeenCalled();
    });

    it('invokes the optional onError handler', async () => {
        const onError = vi.fn();
        const error = new Error('boom');
        fireAndForget(Promise.reject(error), { onError });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(onError).toHaveBeenCalledWith(error);
    });

    it('logs to console.error when a tag is provided', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const error = new Error('boom');
            fireAndForget(Promise.reject(error), { tag: 'test.tag' });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(consoleError).toHaveBeenCalled();
            expect(consoleError.mock.calls[0]?.[0]).toContain('[fireAndForget]');
            expect(consoleError.mock.calls[0]?.[0]).toContain('test.tag');
        } finally {
            consoleError.mockRestore();
        }
    });

    it('ignores non-promise inputs', () => {
        expect(() => fireAndForget(undefined as any, { tag: 'test.tag' })).not.toThrow();
        expect(() => fireAndForget(null as any, { tag: 'test.tag' })).not.toThrow();
        expect(() => fireAndForget({} as any, { tag: 'test.tag' })).not.toThrow();
    });
});
