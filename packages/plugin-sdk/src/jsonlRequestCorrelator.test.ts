import { describe, expect, it } from 'vitest';

import { createJsonlRequestCorrelator } from './jsonlRequestCorrelator';

describe('createJsonlRequestCorrelator', () => {
    it('rejects duplicate pending ids and makes disposers one-shot', () => {
        const correlator = createJsonlRequestCorrelator<string, { ok: boolean }>();
        const entry = {
            resolve: () => undefined,
            reject: () => undefined,
        };

        const dispose = correlator.add('request-1', entry);

        expect(correlator.size).toBe(1);
        expect(correlator.has('request-1')).toBe(true);
        expect(() => correlator.add('request-1', entry)).toThrow(/request-1/);
        expect(dispose()).toBe(true);
        expect(dispose()).toBe(false);
        expect(correlator.resolve('request-1', { ok: true })).toBe(false);
        expect(correlator.reject('request-1', new Error('late'))).toBe(false);
    });

    it('settles entries once and removes them before invoking callbacks', () => {
        const correlator = createJsonlRequestCorrelator<string, string>();
        const settled: string[] = [];
        const rejected: string[] = [];

        correlator.add('resolve-id', {
            resolve: (response) => {
                expect(correlator.has('resolve-id')).toBe(false);
                settled.push(response);
            },
            reject: (error) => rejected.push(error.message),
        });
        correlator.add('reject-id', {
            resolve: (response) => settled.push(response),
            reject: (error) => {
                expect(correlator.has('reject-id')).toBe(false);
                rejected.push(error.message);
            },
        });

        expect(correlator.resolve('resolve-id', 'done')).toBe(true);
        expect(correlator.resolve('resolve-id', 'again')).toBe(false);
        expect(correlator.reject('reject-id', new Error('failed'))).toBe(true);
        expect(correlator.reject('reject-id', new Error('again'))).toBe(false);

        expect(settled).toEqual(['done']);
        expect(rejected).toEqual(['failed']);
        expect(correlator.size).toBe(0);
    });

    it('closes all pending entries once and rejects future additions', () => {
        const correlator = createJsonlRequestCorrelator<string, string>();
        const closeError = new Error('process closed');
        const rejections: Error[] = [];

        correlator.add('a', {
            resolve: () => undefined,
            reject: (error) => rejections.push(error),
        });
        correlator.add('b', {
            resolve: () => undefined,
            reject: (error) => rejections.push(error),
        });

        correlator.close(closeError);
        correlator.close(new Error('ignored'));

        expect(rejections).toEqual([closeError, closeError]);
        expect(correlator.size).toBe(0);
        expect(() => correlator.add('c', {
            resolve: () => undefined,
            reject: () => undefined,
        })).toThrow(closeError);
    });

    it('continues closing remaining entries when one reject callback throws', () => {
        const correlator = createJsonlRequestCorrelator<string, string>();
        const closeError = new Error('process closed');
        const callbackError = new Error('reject callback failed');
        const rejections: string[] = [];

        correlator.add('a', {
            resolve: () => undefined,
            reject: () => {
                rejections.push('a');
                throw callbackError;
            },
        });
        correlator.add('b', {
            resolve: () => undefined,
            reject: (error) => rejections.push(`b:${error.message}`),
        });

        expect(() => correlator.close(closeError)).toThrow(callbackError);
        expect(rejections).toEqual(['a', 'b:process closed']);
        expect(correlator.size).toBe(0);
        expect(() => correlator.add('c', {
            resolve: () => undefined,
            reject: () => undefined,
        })).toThrow(closeError);
    });

    it('exposes only provider-neutral pending request mechanics', () => {
        const correlator = createJsonlRequestCorrelator<string, string>();

        expect(Object.keys(correlator).sort()).toEqual(['add', 'close', 'has', 'reject', 'resolve', 'size']);
    });
});
