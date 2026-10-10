import { describe, expect, it, vi } from 'vitest';
import { fireAndForget } from './fireAndForget';
import { RetryableServerResponseError } from '@/sync/runtime/connectivity/transientConnectivityErrors';

describe('fireAndForget', () => {
    it.each([
        Object.assign(new Error('retired Home'), { name: 'StaleServerGenerationError' }),
        Object.assign(new Error('Home changed'), { name: 'ServerFetchAbortedForServerSwitchError' }),
        new TypeError('Network request failed'),
        Object.assign(new Error('cancelled'), { name: 'AbortError' }),
        new RetryableServerResponseError(503, 'temporarily unavailable'),
    ])('records recoverable background failures without reporting a developer error: $name', async (error) => {
        const report = vi.spyOn(console, 'error').mockImplementation(() => {});
        const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => {});
        const onError = vi.fn();
        try {
            fireAndForget(Promise.reject(error), { tag: 'test.recoverable', onError });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(report).not.toHaveBeenCalled();
            expect(diagnostic).toHaveBeenCalledWith('[fireAndForget] test.recoverable', error);
            expect(onError).toHaveBeenCalledWith(error);
        } finally {
            report.mockRestore();
            diagnostic.mockRestore();
        }
    });

    it('redacts recoverable failure details when the caller requests tag-only diagnostics', async () => {
        const diagnostic = vi.spyOn(console, 'info').mockImplementation(() => {});
        try {
            const error = new RetryableServerResponseError(503, 'SECRET');
            fireAndForget(Promise.reject(error), { tag: 'test.safe', logError: false });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(diagnostic).toHaveBeenCalledWith('[fireAndForget] test.safe');
            expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('SECRET');
        } finally { diagnostic.mockRestore(); }
    });
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

    it('can log only the tag without dumping the rejected error object', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const error = Object.assign(new Error('network failed'), {
                config: { headers: { Authorization: 'Bearer SECRET' } },
            });
            fireAndForget(Promise.reject(error), { tag: 'test.safe', logError: false });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(consoleError).toHaveBeenCalledWith('[fireAndForget] test.safe');
            expect(JSON.stringify(consoleError.mock.calls)).not.toContain('SECRET');
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
