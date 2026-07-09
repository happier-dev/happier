import { describe, expect, it, vi } from 'vitest';

import { resolveSessionViewDirectControlFooter } from './resolveSessionViewDirectControlFooter';

describe('resolveSessionViewDirectControlFooter', () => {
    it('normalizes unexpected status activity values to unknown', () => {
        const footer = resolveSessionViewDirectControlFooter({
            externalSessionLink: {
                machineId: 'machine-1',
            },
            externalSessionRuntime: {
                status: {
                    machineOnline: true,
                    runnerActive: false,
                    activity: 'paused',
                    canTakeOverDirect: true,
                    canTakeOverPersist: false,
                },
            },
            externalSessionTakeover: {
                takeoverInFlight: null,
                requestTakeover: vi.fn(),
            },
            isHiddenSystemSessionSession: false,
        });

        expect(footer?.activity).toBe('unknown');
    });

    it('keeps takeover callbacks pointed at the latest request handler', async () => {
        const firstRequestTakeover = vi.fn(async () => true);
        const secondRequestTakeover = vi.fn(async () => true);

        const firstFooter = resolveSessionViewDirectControlFooter({
            externalSessionLink: {
                machineId: 'machine-1',
            },
            externalSessionRuntime: {
                status: {
                    machineOnline: true,
                    runnerActive: false,
                    activity: 'idle',
                    canTakeOverDirect: true,
                    canTakeOverPersist: true,
                },
            },
            externalSessionTakeover: {
                takeoverInFlight: null,
                requestTakeover: firstRequestTakeover,
            },
            isHiddenSystemSessionSession: false,
        });

        const secondFooter = resolveSessionViewDirectControlFooter({
            externalSessionLink: {
                machineId: 'machine-1',
            },
            externalSessionRuntime: {
                status: {
                    machineOnline: true,
                    runnerActive: false,
                    activity: 'idle',
                    canTakeOverDirect: true,
                    canTakeOverPersist: true,
                },
            },
            externalSessionTakeover: {
                takeoverInFlight: null,
                requestTakeover: secondRequestTakeover,
            },
            isHiddenSystemSessionSession: false,
        });

        await secondFooter?.onRequestTakeOverDirect?.();

        expect(firstRequestTakeover).not.toHaveBeenCalled();
        expect(secondRequestTakeover).toHaveBeenCalledWith('direct');
    });

    it('returns an awaitable takeover promise from footer callbacks without leaking internal results', async () => {
        const requestTakeover = vi.fn(async () => true);
        const footer = resolveSessionViewDirectControlFooter({
            externalSessionLink: {
                machineId: 'machine-1',
            },
            externalSessionRuntime: {
                status: {
                    machineOnline: true,
                    runnerActive: false,
                    activity: 'idle',
                    canTakeOverDirect: true,
                    canTakeOverPersist: true,
                },
            },
            externalSessionTakeover: {
                takeoverInFlight: null,
                requestTakeover,
            },
            isHiddenSystemSessionSession: false,
        });

        const directResult = footer?.onRequestTakeOverDirect?.();
        const persistedResult = footer?.onRequestTakeOverPersist?.();

        expect(directResult).toBeInstanceOf(Promise);
        expect(persistedResult).toBeInstanceOf(Promise);
        await expect(directResult).resolves.toBeUndefined();
        await expect(persistedResult).resolves.toBeUndefined();
        expect(requestTakeover).toHaveBeenNthCalledWith(1, 'direct');
        expect(requestTakeover).toHaveBeenNthCalledWith(2, 'persisted');
    });

    it('keeps different session footers on their own takeover handlers even when their status matches', async () => {
        const firstRequestTakeover = vi.fn(async () => true);
        const secondRequestTakeover = vi.fn(async () => true);

        const firstFooter = resolveSessionViewDirectControlFooter({
            externalSessionLink: {
                machineId: 'machine-1',
            },
            externalSessionRuntime: {
                status: {
                    machineOnline: true,
                    runnerActive: false,
                    activity: 'idle',
                    canTakeOverDirect: true,
                    canTakeOverPersist: true,
                },
            },
            externalSessionTakeover: {
                takeoverInFlight: null,
                requestTakeover: firstRequestTakeover,
            },
            isHiddenSystemSessionSession: false,
        });

        const secondFooter = resolveSessionViewDirectControlFooter({
            externalSessionLink: {
                machineId: 'machine-1',
            },
            externalSessionRuntime: {
                status: {
                    machineOnline: true,
                    runnerActive: false,
                    activity: 'idle',
                    canTakeOverDirect: true,
                    canTakeOverPersist: true,
                },
            },
            externalSessionTakeover: {
                takeoverInFlight: null,
                requestTakeover: secondRequestTakeover,
            },
            isHiddenSystemSessionSession: false,
        });

        await firstFooter?.onRequestTakeOverDirect?.();
        await secondFooter?.onRequestTakeOverDirect?.();

        expect(firstRequestTakeover).toHaveBeenCalledWith('direct');
        expect(secondRequestTakeover).toHaveBeenCalledWith('direct');
    });
});
