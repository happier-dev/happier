import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushHookEffects } from '@/dev/testkit';
import { createCustomDebounce, createAdvancedDebounce } from './debounce';

describe('debounce utilities', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('createCustomDebounce', () => {
        describe('immediate execution', () => {
            it('should execute first two calls immediately by default', () => {
                const mockFn = vi.fn();
                const debouncedFn = createCustomDebounce(mockFn, { delay: 1000 });

                debouncedFn('first');
                debouncedFn('second');
                
                expect(mockFn).toHaveBeenCalledTimes(2);
                expect(mockFn).toHaveBeenNthCalledWith(1, 'first');
                expect(mockFn).toHaveBeenNthCalledWith(2, 'second');
            });

            it('should respect custom immediateCount', () => {
                const mockFn = vi.fn();
                const debouncedFn = createCustomDebounce(mockFn, { 
                    delay: 1000, 
                    immediateCount: 3 
                });

                debouncedFn('first');
                debouncedFn('second');
                debouncedFn('third');
                
                expect(mockFn).toHaveBeenCalledTimes(3);
                expect(mockFn).toHaveBeenNthCalledWith(1, 'first');
                expect(mockFn).toHaveBeenNthCalledWith(2, 'second');
                expect(mockFn).toHaveBeenNthCalledWith(3, 'third');
            });

            it('should handle zero immediate count', async () => {
                const mockFn = vi.fn();
                const debouncedFn = createCustomDebounce(mockFn, { 
                    delay: 1000, 
                    immediateCount: 0 
                });

                debouncedFn('first');
                debouncedFn('second');
                
                expect(mockFn).not.toHaveBeenCalled();
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 1000 });
                expect(mockFn).toHaveBeenCalledTimes(1);
                expect(mockFn).toHaveBeenCalledWith('second');
            });

            it('should handle large immediate count', () => {
                const mockFn = vi.fn();
                const debouncedFn = createCustomDebounce(mockFn, { 
                    delay: 1000, 
                    immediateCount: 10 
                });

                for (let i = 0; i < 8; i++) {
                    debouncedFn(`call-${i}`);
                }
                
                expect(mockFn).toHaveBeenCalledTimes(8);
            });

            it('should treat negative immediateCount as no immediate calls', async () => {
                const mockFn = vi.fn();
                const debouncedFn = createCustomDebounce(mockFn, {
                    delay: 1000,
                    immediateCount: -1
                });

                debouncedFn('first');
                debouncedFn('second');

                expect(mockFn).not.toHaveBeenCalled();
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 1000 });
                expect(mockFn).toHaveBeenCalledTimes(1);
                expect(mockFn).toHaveBeenCalledWith('second');
            });
        });

        describe('debounced execution', () => {
            it('should debounce calls after immediate count is reached', async () => {
                const mockFn = vi.fn();
                const debouncedFn = createCustomDebounce(mockFn, { delay: 1000 });

                debouncedFn('first');
                debouncedFn('second');
                debouncedFn('third');
                debouncedFn('fourth');
                
                expect(mockFn).toHaveBeenCalledTimes(2);
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 1000 });
                expect(mockFn).toHaveBeenCalledTimes(3);
                expect(mockFn).toHaveBeenNthCalledWith(3, 'fourth');
            });

            it('should use latest value when no reducer provided', async () => {
                const mockFn = vi.fn();
                const debouncedFn = createCustomDebounce(mockFn, { delay: 1000 });

                debouncedFn('immediate1');
                debouncedFn('immediate2');
                debouncedFn('debounced1');
                debouncedFn('debounced2');
                debouncedFn('debounced3');
                
                expect(mockFn).toHaveBeenCalledTimes(2);
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 1000 });
                expect(mockFn).toHaveBeenCalledTimes(3);
                expect(mockFn).toHaveBeenNthCalledWith(3, 'debounced3');
            });

            it('should reset debounce timer on each call', async () => {
                const mockFn = vi.fn();
                const debouncedFn = createCustomDebounce(mockFn, { delay: 1000 });

                debouncedFn('immediate1');
                debouncedFn('immediate2');
                debouncedFn('debounced1');
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 500 });
                debouncedFn('debounced2');
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 500 });
                expect(mockFn).toHaveBeenCalledTimes(2);
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 500 });
                expect(mockFn).toHaveBeenCalledTimes(3);
                expect(mockFn).toHaveBeenNthCalledWith(3, 'debounced2');
            });
        });

        describe('reducer functionality', () => {
            it('should use reducer to combine pending values', async () => {
                const mockFn = vi.fn();
                const debouncedFn = createCustomDebounce(mockFn, {
                    delay: 1000,
                    reducer: (prev: number, curr: number) => prev + curr
                });

                debouncedFn(1);
                debouncedFn(2);
                debouncedFn(3);
                debouncedFn(4);
                debouncedFn(5);
                
                expect(mockFn).toHaveBeenCalledTimes(2);
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 1000 });
                expect(mockFn).toHaveBeenCalledTimes(3);
                expect(mockFn).toHaveBeenNthCalledWith(3, 12); // 3 + 4 + 5
            });

            it('should work with object reducer for merging', async () => {
                const mockFn = vi.fn();
                const debouncedFn = createCustomDebounce(mockFn, {
                    delay: 1000,
                    reducer: (prev: { a?: number, b?: number }, curr: { a?: number, b?: number }) => ({ ...prev, ...curr })
                });

                debouncedFn({ a: 1 });
                debouncedFn({ a: 2 });
                debouncedFn({ a: 3, b: 10 });
                debouncedFn({ b: 20 });
                
                expect(mockFn).toHaveBeenCalledTimes(2);
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 1000 });
                expect(mockFn).toHaveBeenCalledTimes(3);
                expect(mockFn).toHaveBeenNthCalledWith(3, { a: 3, b: 20 });
            });

            it('should work with array reducer for concatenation', async () => {
                const mockFn = vi.fn();
                const debouncedFn = createCustomDebounce(mockFn, {
                    delay: 1000,
                    reducer: (prev: string[], curr: string[]) => [...prev, ...curr]
                });

                debouncedFn(['a']);
                debouncedFn(['b']);
                debouncedFn(['c', 'd']);
                debouncedFn(['e']);
                
                expect(mockFn).toHaveBeenCalledTimes(2);
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 1000 });
                expect(mockFn).toHaveBeenCalledTimes(3);
                expect(mockFn).toHaveBeenNthCalledWith(3, ['c', 'd', 'e']);
            });

            it('should work with max value reducer', async () => {
                const mockFn = vi.fn();
                const debouncedFn = createCustomDebounce(mockFn, {
                    delay: 1000,
                    reducer: (prev: number, curr: number) => Math.max(prev, curr)
                });

                debouncedFn(5);
                debouncedFn(3);
                debouncedFn(10);
                debouncedFn(7);
                debouncedFn(15);
                
                expect(mockFn).toHaveBeenCalledTimes(2);
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 1000 });
                expect(mockFn).toHaveBeenCalledTimes(3);
                expect(mockFn).toHaveBeenNthCalledWith(3, 15);
            });

            it('should handle complex object reducer', async () => {
                interface SearchParams {
                    query: string;
                    filters: string[];
                    page: number;
                }

                const mockFn = vi.fn();
                const debouncedFn = createCustomDebounce(mockFn, {
                    delay: 1000,
                    reducer: (prev: SearchParams, curr: SearchParams) => ({
                        query: curr.query,
                        filters: [...new Set([...prev.filters, ...curr.filters])],
                        page: Math.max(prev.page, curr.page)
                    })
                });

                debouncedFn({ query: 'test1', filters: ['a'], page: 1 });
                debouncedFn({ query: 'test2', filters: ['b'], page: 2 });
                debouncedFn({ query: 'test3', filters: ['b', 'c'], page: 1 });
                debouncedFn({ query: 'final', filters: ['d'], page: 3 });
                
                expect(mockFn).toHaveBeenCalledTimes(2);
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 1000 });
                expect(mockFn).toHaveBeenCalledTimes(3);
                expect(mockFn).toHaveBeenNthCalledWith(3, {
                    query: 'final',
                    filters: ['b', 'c', 'd'],
                    page: 3
                });
            });
        });

        describe('type safety', () => {
            it('should work with string type', () => {
                const mockFn = vi.fn<(args: string) => void>();
                const debouncedFn = createCustomDebounce(mockFn, { delay: 1000 });
                
                debouncedFn('test');
                expect(mockFn).toHaveBeenCalledWith('test');
            });

            it('should work with number type', () => {
                const mockFn = vi.fn<(args: number) => void>();
                const debouncedFn = createCustomDebounce(mockFn, { delay: 1000 });
                
                debouncedFn(42);
                expect(mockFn).toHaveBeenCalledWith(42);
            });

            it('should work with object type', () => {
                const mockFn = vi.fn<(args: { id: number; name: string }) => void>();
                const debouncedFn = createCustomDebounce(mockFn, { delay: 1000 });
                
                const testObj = { id: 1, name: 'test' };
                debouncedFn(testObj);
                expect(mockFn).toHaveBeenCalledWith(testObj);
            });

            it('should work with array type', () => {
                const mockFn = vi.fn<(args: number[]) => void>();
                const debouncedFn = createCustomDebounce(mockFn, { delay: 1000 });
                
                const testArray = [1, 2, 3];
                debouncedFn(testArray);
                expect(mockFn).toHaveBeenCalledWith(testArray);
            });
        });

        describe('edge cases', () => {
            it('should handle multiple rapid calls correctly', async () => {
                const mockFn = vi.fn();
                const debouncedFn = createCustomDebounce(mockFn, { delay: 1000 });

                for (let i = 0; i < 100; i++) {
                    debouncedFn(`call-${i}`);
                }
                
                expect(mockFn).toHaveBeenCalledTimes(2);
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 1000 });
                expect(mockFn).toHaveBeenCalledTimes(3);
                expect(mockFn).toHaveBeenNthCalledWith(3, 'call-99');
            });

            it('should handle null and undefined values', () => {
                const mockFn = vi.fn();
                const debouncedFn = createCustomDebounce(mockFn, { delay: 1000 });

                debouncedFn(null);
                debouncedFn(undefined);
                
                expect(mockFn).toHaveBeenCalledTimes(2);
                expect(mockFn).toHaveBeenNthCalledWith(1, null);
                expect(mockFn).toHaveBeenNthCalledWith(2, undefined);
            });

            it('should handle reducer with null values', async () => {
                const mockFn = vi.fn();
                const debouncedFn = createCustomDebounce(mockFn, {
                    delay: 1000,
                    reducer: (prev: string | null, curr: string | null) => curr || prev
                });

                debouncedFn('first');
                debouncedFn('second');
                debouncedFn(null);
                debouncedFn('fourth');
                
                expect(mockFn).toHaveBeenCalledTimes(2);
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 1000 });
                expect(mockFn).toHaveBeenCalledTimes(3);
                expect(mockFn).toHaveBeenNthCalledWith(3, 'fourth');
            });
        });
    });

    describe('createAdvancedDebounce', () => {
        describe('basic functionality', () => {
            it('should work like createCustomDebounce for basic usage', async () => {
                const mockFn = vi.fn();
                const { debounced } = createAdvancedDebounce(mockFn, { delay: 1000 });

                debounced('first');
                debounced('second');
                debounced('third');
                
                expect(mockFn).toHaveBeenCalledTimes(2);
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 1000 });
                expect(mockFn).toHaveBeenCalledTimes(3);
                expect(mockFn).toHaveBeenNthCalledWith(3, 'third');
            });

            it('executes immediately when delay is 0 (no timers)', async () => {
                const mockFn = vi.fn();
                const { debounced } = createAdvancedDebounce(mockFn, { delay: 0, immediateCount: 1 });

                debounced('first');
                debounced('second');
                debounced('third');

                expect(mockFn).toHaveBeenCalledTimes(3);
                expect(mockFn).toHaveBeenNthCalledWith(1, 'first');
                expect(mockFn).toHaveBeenNthCalledWith(2, 'second');
                expect(mockFn).toHaveBeenNthCalledWith(3, 'third');

                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 10 });
                expect(mockFn).toHaveBeenCalledTimes(3);
            });

            it('should work with reducer', async () => {
                const mockFn = vi.fn();
                const { debounced } = createAdvancedDebounce(mockFn, {
                    delay: 1000,
                    reducer: (prev: number, curr: number) => prev + curr
                });

                debounced(1);
                debounced(2);
                debounced(3);
                debounced(4);
                
                expect(mockFn).toHaveBeenCalledTimes(2);
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 1000 });
                expect(mockFn).toHaveBeenCalledTimes(3);
                expect(mockFn).toHaveBeenNthCalledWith(3, 7); // 3 + 4
            });
        });

        describe('cancel functionality', () => {
            it('should cancel pending execution', async () => {
                const mockFn = vi.fn();
                const { debounced, cancel } = createAdvancedDebounce(mockFn, { delay: 1000 });

                debounced('first');
                debounced('second');
                debounced('third');
                
                expect(mockFn).toHaveBeenCalledTimes(2);
                
                cancel();
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 1000 });
                expect(mockFn).toHaveBeenCalledTimes(2);
            });

            it('should allow new calls after cancel', async () => {
                const mockFn = vi.fn();
                const { debounced, cancel } = createAdvancedDebounce(mockFn, { delay: 1000 });

                debounced('first');
                debounced('second');
                debounced('third');
                
                cancel();
                
                debounced('fourth');
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 1000 });
                expect(mockFn).toHaveBeenCalledTimes(3);
                expect(mockFn).toHaveBeenNthCalledWith(3, 'fourth');
            });

            it('should handle cancel when no pending execution exists', () => {
                const mockFn = vi.fn();
                const { cancel } = createAdvancedDebounce(mockFn, { delay: 1000 });

                expect(() => cancel()).not.toThrow();
            });
        });

        describe('reset functionality', () => {
            it('should reset call count and allow immediate execution again', async () => {
                const mockFn = vi.fn();
                const { debounced, reset } = createAdvancedDebounce(mockFn, { delay: 1000 });

                debounced('first');
                debounced('second');
                debounced('third');
                
                expect(mockFn).toHaveBeenCalledTimes(2);
                
                reset();
                
                debounced('fourth');
                debounced('fifth');
                
                expect(mockFn).toHaveBeenCalledTimes(4);
                expect(mockFn).toHaveBeenNthCalledWith(3, 'fourth');
                expect(mockFn).toHaveBeenNthCalledWith(4, 'fifth');
            });

            it('should cancel pending execution when resetting', async () => {
                const mockFn = vi.fn();
                const { debounced, reset } = createAdvancedDebounce(mockFn, { delay: 1000 });

                debounced('first');
                debounced('second');
                debounced('third');
                
                reset();
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 1000 });
                expect(mockFn).toHaveBeenCalledTimes(2);
            });

            it('should handle reset when no calls have been made', () => {
                const mockFn = vi.fn();
                const { reset } = createAdvancedDebounce(mockFn, { delay: 1000 });

                expect(() => reset()).not.toThrow();
            });
        });

        describe('flush functionality', () => {
            it('should immediately execute pending call', async () => {
                const mockFn = vi.fn();
                const { debounced, flush } = createAdvancedDebounce(mockFn, { delay: 1000 });

                debounced('first');
                debounced('second');
                debounced('third');
                
                expect(mockFn).toHaveBeenCalledTimes(2);
                
                flush();
                
                expect(mockFn).toHaveBeenCalledTimes(3);
                expect(mockFn).toHaveBeenNthCalledWith(3, 'third');
            });

            it('should execute reduced value when reducer is provided', async () => {
                const mockFn = vi.fn();
                const { debounced, flush } = createAdvancedDebounce(mockFn, {
                    delay: 1000,
                    reducer: (prev: number, curr: number) => prev + curr
                });

                debounced(1);
                debounced(2);
                debounced(3);
                debounced(4);
                
                flush();
                
                expect(mockFn).toHaveBeenCalledTimes(3);
                expect(mockFn).toHaveBeenNthCalledWith(3, 7); // 3 + 4
            });

            it('should prevent timer execution after flush', async () => {
                const mockFn = vi.fn();
                const { debounced, flush } = createAdvancedDebounce(mockFn, { delay: 1000 });

                debounced('first');
                debounced('second');
                debounced('third');
                
                flush();
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 1000 });
                expect(mockFn).toHaveBeenCalledTimes(3);
            });

            it('should handle flush when no pending execution exists', () => {
                const mockFn = vi.fn();
                const { flush } = createAdvancedDebounce(mockFn, { delay: 1000 });

                expect(() => flush()).not.toThrow();
            });

            it('should not execute pending value after cancel followed by flush', () => {
                const mockFn = vi.fn();
                const { debounced, cancel, flush } = createAdvancedDebounce(mockFn, { delay: 1000 });

                debounced('first');
                debounced('second');
                debounced('third');
                cancel();
                flush();

                expect(mockFn).toHaveBeenCalledTimes(2);
            });

            it('should allow new calls after flush', async () => {
                const mockFn = vi.fn();
                const { debounced, flush } = createAdvancedDebounce(mockFn, { delay: 1000 });

                debounced('first');
                debounced('second');
                debounced('third');
                
                flush();
                
                debounced('fourth');
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 1000 });
                expect(mockFn).toHaveBeenCalledTimes(4);
                expect(mockFn).toHaveBeenNthCalledWith(4, 'fourth');
            });
        });

        describe('interaction between control methods', () => {
            it('should handle cancel after reset', async () => {
                const mockFn = vi.fn();
                const { debounced, reset, cancel } = createAdvancedDebounce(mockFn, { delay: 1000 });

                debounced('first');
                debounced('second');
                debounced('third');
                
                reset();
                debounced('fourth');
                debounced('fifth');
                debounced('sixth');
                
                cancel();
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 1000 });
                expect(mockFn).toHaveBeenCalledTimes(4);
            });

            it('should handle flush after reset', async () => {
                const mockFn = vi.fn();
                const { debounced, reset, flush } = createAdvancedDebounce(mockFn, { delay: 1000 });

                debounced('first');
                debounced('second');
                debounced('third');
                
                reset();
                debounced('fourth');
                debounced('fifth');
                debounced('sixth');
                
                flush();
                
                expect(mockFn).toHaveBeenCalledTimes(5);
                expect(mockFn).toHaveBeenNthCalledWith(5, 'sixth');
            });

            it('should handle multiple control method calls', async () => {
                const mockFn = vi.fn();
                const { debounced, reset, cancel, flush } = createAdvancedDebounce(mockFn, { delay: 1000 });

                debounced('first');
                cancel();
                reset();
                flush();
                
                expect(mockFn).toHaveBeenCalledTimes(1);
                
                debounced('second');
                debounced('third');
                
                expect(mockFn).toHaveBeenCalledTimes(3);
            });
        });

        describe('real-world scenarios', () => {
            it('should handle search use case with cancel on unmount', async () => {
                const mockSearch = vi.fn();
                const { debounced, cancel } = createAdvancedDebounce(mockSearch, {
                    delay: 500,
                    immediateCount: 1,
                    reducer: (prev: string, curr: string) => curr // Use latest query
                });

                debounced('r');
                debounced('re');
                debounced('rea');
                debounced('react');
                
                expect(mockSearch).toHaveBeenCalledTimes(1);
                
                // Simulate component unmount
                cancel();
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 500 });
                expect(mockSearch).toHaveBeenCalledTimes(1);
            });

            it('should handle save use case with flush on page unload', () => {
                const mockSave = vi.fn();
                const { debounced, flush } = createAdvancedDebounce(mockSave, {
                    delay: 2000,
                    immediateCount: 0,
                    reducer: (prev: { content: string }, curr: { content: string }) => curr
                });

                debounced({ content: 'draft1' });
                debounced({ content: 'draft2' });
                debounced({ content: 'draft3' });
                
                expect(mockSave).not.toHaveBeenCalled();
                
                // Simulate page unload
                flush();
                
                expect(mockSave).toHaveBeenCalledTimes(1);
                expect(mockSave).toHaveBeenCalledWith({ content: 'draft3' });
            });

            it('should handle analytics batching use case', async () => {
                const mockSendAnalytics = vi.fn();
                const { debounced } = createAdvancedDebounce(mockSendAnalytics, {
                    delay: 1000,
                    immediateCount: 0,
                    reducer: (prev: string[], curr: string[]) => [...prev, ...curr]
                });

                debounced(['click']);
                debounced(['scroll']);
                debounced(['hover', 'focus']);
                debounced(['blur']);
                
                expect(mockSendAnalytics).not.toHaveBeenCalled();
                
                await flushHookEffects({ cycles: 1, turns: 0, advanceTimersMs: 1000 });
                expect(mockSendAnalytics).toHaveBeenCalledTimes(1);
                expect(mockSendAnalytics).toHaveBeenCalledWith(['click', 'scroll', 'hover', 'focus', 'blur']);
            });
        });
    });
});
