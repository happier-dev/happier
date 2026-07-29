import { describe, expect, it, vi } from 'vitest';

import {
    ExternalSessionOperationSharedPresentationV1Schema,
    type ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol';

import { presentExternalSessionOperationShell } from '@/components/sessions/external/progress/externalSessionOperationShellPresentation';

import { resolveSessionViewExternalControlFooter } from './resolveSessionViewExternalControlFooter';

type ResolverInput = Parameters<typeof resolveSessionViewExternalControlFooter>[0];
type ResolverTestInput = Omit<
    ResolverInput,
    'externalSessionRuntimePresentation' | 'externalSessionIdentity'
> & Partial<Pick<
    ResolverInput,
    'externalSessionRuntimePresentation' | 'externalSessionIdentity'
>>;

function resolveFooter(input: ResolverTestInput) {
    return resolveSessionViewExternalControlFooter({
        externalSessionRuntimePresentation: null,
        externalSessionIdentity: {
            agentLabel: null,
            machineLabel: null,
        },
        ...input,
    });
}

function createRecoveryProgress(
    status: 'awaiting_user_resume' | 'failed' | 'reconciliation_required',
): ExternalSessionOperationSharedPresentationV1 {
    return ExternalSessionOperationSharedPresentationV1Schema.parse({
        v: 1,
        operationId: 'operation-1',
        revision: 1,
        kind: 'materialize',
        status,
        phase: 'importing',
    });
}

describe('resolveSessionViewExternalControlFooter', () => {
    it.each([
        ['working', 'status.workingExternally', 'live', 'working'],
        ['waiting', 'status.needsInputExternally', 'attention', 'action'],
        ['idle', 'status.ready', 'ready', 'ready'],
        ['unknown', 'status.externalStatusUnknown', 'muted', 'none'],
    ] as const)(
        'uses pushed %s presentation and canonical Agent/machine identity for descriptive status',
        (state, labelKey, tone, indicator) => {
            const footer = resolveFooter({
                externalSessionLink: { machineId: 'machine-1' },
                externalSessionRuntimePresentation: {
                    controlConnectivity: 'offline',
                    detachedActivity: 'unknown',
                    externalAgent: {
                        state,
                        labelKey,
                        tone,
                        indicator,
                        nextExpiryAtMs: null,
                    },
                },
                externalSessionIdentity: {
                    agentLabel: 'Codex',
                    machineLabel: 'MacBook Pro',
                },
                externalSessionRuntime: { status: null },
                externalSessionTakeover: {
                    takeoverInFlight: null,
                    takeoverPreflightInFlight: false,
                    requestTakeover: vi.fn(),
                    requestTakeoverPreflight: vi.fn(),
                },
                isHiddenSystemSessionSession: false,
            });

            expect(footer?.externalAgentPresentation).toEqual({
                state,
                labelKey,
                agentLabel: 'Codex',
                machineLabel: 'MacBook Pro',
            });
        },
    );

    it('projects materialize as a distinct primary intent only with current online write readiness', async () => {
        const requestMaterialize = vi.fn(async () => true);
        const footer = resolveFooter({
            externalSessionLink: { machineId: 'machine-1' },
            materializeNeeded: true,
            hasWriteAccess: true,
            externalSessionRuntime: {
                status: {
                    machineOnline: true,
                    runnerActive: true,
                    activity: 'running',
                },
            },
            externalSessionTakeover: {
                takeoverInFlight: null,
                takeoverPreflightInFlight: false,
                requestTakeover: vi.fn(),
                requestTakeoverPreflight: vi.fn(),
            },
            externalSessionMaterialize: {
                materializeInFlight: false,
                requestMaterialize,
            },
            isHiddenSystemSessionSession: false,
        });

        expect(footer?.materialize).toEqual(expect.objectContaining({
            requestEnabled: true,
            inFlight: false,
            onRequest: expect.any(Function),
        }));
        await footer?.materialize?.onRequest();
        expect(requestMaterialize).toHaveBeenCalledTimes(1);

        const unknownFooter = resolveFooter({
            externalSessionLink: { machineId: 'machine-1' },
            materializeNeeded: true,
            hasWriteAccess: true,
            externalSessionRuntime: { status: null },
            externalSessionTakeover: {
                takeoverInFlight: null,
                takeoverPreflightInFlight: false,
                requestTakeover: vi.fn(),
                requestTakeoverPreflight: vi.fn(),
            },
            externalSessionMaterialize: {
                materializeInFlight: false,
                requestMaterialize,
            },
            isHiddenSystemSessionSession: false,
        });
        expect(unknownFooter?.materialize?.requestEnabled).toBe(true);

        const offlineFooter = resolveFooter({
            externalSessionLink: { machineId: 'machine-1' },
            materializeNeeded: true,
            hasWriteAccess: true,
            externalSessionRuntime: {
                status: {
                    machineOnline: false,
                    runnerActive: false,
                    activity: 'unknown',
                },
            },
            externalSessionTakeover: {
                takeoverInFlight: null,
                takeoverPreflightInFlight: false,
                requestTakeover: vi.fn(),
                requestTakeoverPreflight: vi.fn(),
            },
            externalSessionMaterialize: {
                materializeInFlight: false,
                requestMaterialize,
            },
            isHiddenSystemSessionSession: false,
        });
        expect(offlineFooter?.materialize?.requestEnabled).toBe(false);
    });

    it.each([
        'awaiting_user_resume',
        'failed',
        'reconciliation_required',
    ] as const)(
        'leaves %s progress as the sole operation action owner while preserving read-only status',
        (status) => {
            const operationShell = presentExternalSessionOperationShell(
                createRecoveryProgress(status),
            );
            const requestTakeoverPreflight = vi.fn();
            const requestMaterialize = vi.fn();
            const footer = resolveFooter({
                externalSessionOperationRunning: operationShell.running,
                externalSessionOperationBlocksNewOperation: operationShell.blocksNewOperation,
                externalSessionLink: { machineId: 'machine-1' },
                materializeNeeded: true,
                hasWriteAccess: true,
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
                    takeoverPreflightInFlight: false,
                    requestTakeover: vi.fn(),
                    requestTakeoverPreflight,
                },
                externalSessionMaterialize: {
                    materializeInFlight: false,
                    requestMaterialize,
                },
                isHiddenSystemSessionSession: false,
            });

            expect(footer).toEqual(expect.objectContaining({
                statusKnown: true,
                machineOnline: true,
                runnerActive: false,
                canTakeOverDirect: true,
                canTakeOverPersist: true,
                onRequestTakeoverPreflight: undefined,
                materialize: null,
            }));
            expect(requestTakeoverPreflight).not.toHaveBeenCalled();
            expect(requestMaterialize).not.toHaveBeenCalled();
        },
    );

    it('suppresses the external-control banner while the pushed operation presentation is active', () => {
        const footer = resolveFooter({
            externalSessionOperationRunning: true,
            externalSessionLink: {
                machineId: 'machine-1',
            },
            externalSessionRuntime: {
                status: {
                    machineOnline: true,
                    runnerActive: false,
                    activity: 'idle',
                },
            },
            externalSessionTakeover: {
                takeoverInFlight: null,
                takeoverPreflightInFlight: false,
                requestTakeover: vi.fn(),
                requestTakeoverPreflight: vi.fn(),
            },
            isHiddenSystemSessionSession: false,
        });

        expect(footer).toBeNull();
    });

    it('normalizes unexpected status activity values to unknown', () => {
        const footer = resolveFooter({
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
                takeoverPreflightInFlight: false,
                requestTakeover: vi.fn(),
                requestTakeoverPreflight: vi.fn(),
            },
            isHiddenSystemSessionSession: false,
        });

        expect(footer?.activity).toBe('unknown');
    });

    it('presents unfetched status as unknown and keeps one explicit takeover preflight available', async () => {
        const requestTakeoverPreflight = vi.fn(async () => false);
        const footer = resolveFooter({
            externalSessionLink: {
                machineId: 'machine-1',
            },
            externalSessionRuntime: {
                status: null,
            },
            externalSessionTakeover: {
                takeoverInFlight: null,
                takeoverPreflightInFlight: false,
                requestTakeover: vi.fn(),
                requestTakeoverPreflight,
            },
            isHiddenSystemSessionSession: false,
        });

        expect(footer).toEqual(expect.objectContaining({
            statusKnown: false,
            machineOnline: false,
            runnerActive: false,
            activity: 'unknown',
            takeoverPreflightInFlight: false,
            onRequestTakeoverPreflight: expect.any(Function),
        }));

        await footer?.onRequestTakeoverPreflight?.();
        expect(requestTakeoverPreflight).toHaveBeenCalledTimes(1);
    });

    it('keeps takeover preflight callbacks pointed at the latest request handler', async () => {
        const firstRequestTakeoverPreflight = vi.fn(async () => true);
        const secondRequestTakeoverPreflight = vi.fn(async () => true);

        const firstFooter = resolveFooter({
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
                takeoverPreflightInFlight: false,
                requestTakeover: vi.fn(),
                requestTakeoverPreflight: firstRequestTakeoverPreflight,
            },
            isHiddenSystemSessionSession: false,
        });

        const secondFooter = resolveFooter({
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
                takeoverPreflightInFlight: false,
                requestTakeover: vi.fn(),
                requestTakeoverPreflight: secondRequestTakeoverPreflight,
            },
            isHiddenSystemSessionSession: false,
        });

        await secondFooter?.onRequestTakeoverPreflight?.();

        expect(firstRequestTakeoverPreflight).not.toHaveBeenCalled();
        expect(secondRequestTakeoverPreflight).toHaveBeenCalledTimes(1);
    });

    it('returns an awaitable preflight promise from the footer callback without leaking internal results', async () => {
        const requestTakeoverPreflight = vi.fn(async () => true);
        const footer = resolveFooter({
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
                takeoverPreflightInFlight: false,
                requestTakeover: vi.fn(),
                requestTakeoverPreflight,
            },
            isHiddenSystemSessionSession: false,
        });

        const preflightResult = footer?.onRequestTakeoverPreflight?.();

        expect(preflightResult).toBeInstanceOf(Promise);
        await expect(preflightResult).resolves.toBeUndefined();
        expect(requestTakeoverPreflight).toHaveBeenCalledTimes(1);
    });

    it('keeps different session footers on their own preflight handlers even when their status matches', async () => {
        const firstRequestTakeoverPreflight = vi.fn(async () => true);
        const secondRequestTakeoverPreflight = vi.fn(async () => true);

        const firstFooter = resolveFooter({
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
                takeoverPreflightInFlight: false,
                requestTakeover: vi.fn(),
                requestTakeoverPreflight: firstRequestTakeoverPreflight,
            },
            isHiddenSystemSessionSession: false,
        });

        const secondFooter = resolveFooter({
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
                takeoverPreflightInFlight: false,
                requestTakeover: vi.fn(),
                requestTakeoverPreflight: secondRequestTakeoverPreflight,
            },
            isHiddenSystemSessionSession: false,
        });

        await firstFooter?.onRequestTakeoverPreflight?.();
        await secondFooter?.onRequestTakeoverPreflight?.();

        expect(firstRequestTakeoverPreflight).toHaveBeenCalledTimes(1);
        expect(secondRequestTakeoverPreflight).toHaveBeenCalledTimes(1);
    });

    it('preserves exact takeover capabilities and bounded running-process identity for presentation', () => {
        const footer = resolveFooter({
            externalSessionLink: {
                machineId: 'machine-1',
            },
            externalSessionRuntime: {
                status: {
                    machineOnline: true,
                    runnerActive: true,
                    activity: 'running',
                    canTakeOverDirect: false,
                    canTakeOverPersist: false,
                    trustedPid: 12_345,
                },
            },
            externalSessionTakeover: {
                takeoverInFlight: null,
                takeoverPreflightInFlight: false,
                requestTakeover: vi.fn(),
                requestTakeoverPreflight: vi.fn(),
            },
            isHiddenSystemSessionSession: false,
        });

        expect(footer).toEqual(expect.objectContaining({
            canTakeOverDirect: false,
            canTakeOverPersist: false,
            runnerActive: true,
            trustedPid: 12_345,
        }));
    });
});
