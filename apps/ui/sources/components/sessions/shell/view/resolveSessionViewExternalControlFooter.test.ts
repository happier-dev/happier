import { describe, expect, it, vi } from 'vitest';

import {
    ExternalSessionOperationSharedPresentationV1Schema,
    type ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol/sessions/external/operationV1';

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
    it('withholds takeover preflight when the linked Machine cannot supply writer safety', () => {
        const footer = resolveFooter({
            externalSessionLink: { machineId: 'offline-machine' },
            externalSessionRuntime: { status: null },
            externalSessionTakeover: {
                takeoverInFlight: null,
                takeoverPreflightInFlight: false,
                requestTakeoverPreflight: vi.fn(),
            },
            isHiddenSystemSessionSession: false,
        });

        // No Take over and nothing else to offer: the row says nothing beyond the header.
        expect(footer).toBeNull();
    });

    it.each([
        ['working', 'status.workingExternally', false],
        ['waiting', 'status.needsInputExternally', true],
        ['retrying', 'status.retryingExternally', true],
        ['idle', 'status.ready', false],
        ['recentlyActive', 'status.recentlyActive', false],
        ['unknown', 'status.externalStatusUnknown', false],
    ] as const)(
        'uses pushed %s presentation and canonical Agent/machine identity for descriptive status',
        (state, labelKey, needsAttention) => {
            const footer = resolveFooter({
                externalSessionLink: { machineId: 'machine-1' },
                externalSessionRuntimePresentation: {
                    externalAgent: {
                        state,
                        labelKey,
                    },
                },
                externalSessionIdentity: {
                    agentLabel: 'Codex',
                    machineLabel: 'MacBook Pro',
                },
                externalSessionRuntime: { status: null },
                externalSessionTakeover: {
                    writerSafety: 'native_prevention',
                    takeoverInFlight: null,
                    takeoverPreflightInFlight: false,
                    requestTakeoverPreflight: vi.fn(),
                },
                isHiddenSystemSessionSession: false,
            });

            expect(footer?.externalAgentPresentation).toEqual({
                state,
                labelKey,
                needsAttention,
                agentLabel: 'Codex',
                machineLabel: 'MacBook Pro',
            });
        },
    );

    it('treats a missing pushed presentation as a calm unknown state', () => {
        const footer = resolveFooter({
            externalSessionLink: { machineId: 'machine-1' },
            externalSessionRuntime: { status: null },
            externalSessionTakeover: {
                writerSafety: 'native_prevention',
                takeoverInFlight: null,
                takeoverPreflightInFlight: false,
                requestTakeoverPreflight: vi.fn(),
            },
            isHiddenSystemSessionSession: false,
        });

        expect(footer?.externalAgentPresentation).toMatchObject({
            state: 'unknown',
            needsAttention: false,
        });
    });

    it('projects materialize as a distinct primary intent only with current online write readiness', async () => {
        const requestMaterialize = vi.fn(async () => true);
        const footer = resolveFooter({
            externalSessionLink: { machineId: 'machine-1' },
            materializeNeeded: true,
            materializeAvailable: true,
            hasWriteAccess: true,
            externalSessionRuntime: { status: null },
            externalSessionTakeover: {
                takeoverInFlight: null,
                takeoverPreflightInFlight: false,
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
                requestTakeoverPreflight: vi.fn(),
            },
            externalSessionMaterialize: {
                materializeInFlight: false,
                requestMaterialize,
            },
            isHiddenSystemSessionSession: false,
        });
        expect(unknownFooter?.materialize?.requestEnabled).toBe(false);

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
        'leaves %s progress as the sole operation action owner',
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
                    requestTakeoverPreflight,
                },
                externalSessionMaterialize: {
                    materializeInFlight: false,
                    requestMaterialize,
                },
                isHiddenSystemSessionSession: false,
            });

            // The progress card is the one way forward; the row offers nothing beside it.
            expect(footer).toBeNull();
            expect(requestTakeoverPreflight).not.toHaveBeenCalled();
            expect(requestMaterialize).not.toHaveBeenCalled();
        },
    );

    describe('continue in a new session', () => {
        const takeover = {
            takeoverInFlight: null,
            takeoverPreflightInFlight: false,
            requestTakeoverPreflight: vi.fn(),
        } as const;
        const idleStatus = {
            machineOnline: true,
            runnerActive: false,
            activity: 'idle',
            canTakeOverDirect: false,
            canTakeOverPersist: false,
        } as const;

        function resolveContinue(overrides: Partial<ResolverTestInput> & Readonly<{
            status?: NonNullable<ResolverTestInput['externalSessionRuntime']['status']> | null;
            continueAvailable?: boolean;
            continueInFlight?: boolean;
            requestContinue?: () => Promise<void>;
        }> = {}) {
            const { status, continueAvailable, continueInFlight, requestContinue, ...rest } = overrides;
            return resolveFooter({
                externalSessionLink: { machineId: 'machine-1' },
                externalSessionRuntime: { status: status === undefined ? idleStatus : status },
                externalSessionTakeover: takeover,
                hasWriteAccess: true,
                externalSessionContinueInNewSession: {
                    available: continueAvailable ?? true,
                    inFlight: continueInFlight ?? false,
                    requestContinue: requestContinue ?? vi.fn(async () => {}),
                },
                isHiddenSystemSessionSession: false,
                ...rest,
            });
        }

        it('offers it exactly where takeover is a dead end: status known, idle, neither takeover mode', async () => {
            const requestContinue = vi.fn(async () => {});
            const footer = resolveContinue({ requestContinue });
            expect(footer?.continueInNewSession).toEqual(expect.objectContaining({
                requestEnabled: true,
                inFlight: false,
            }));
            await footer?.continueInNewSession?.onRequest();
            expect(requestContinue).toHaveBeenCalledTimes(1);

            expect(resolveContinue({ status: null })?.continueInNewSession ?? null).toBeNull();
            expect(resolveContinue({ status: { ...idleStatus, canTakeOverDirect: true } })?.continueInNewSession ?? null)
                .toBeNull();
            expect(resolveContinue({ status: { ...idleStatus, canTakeOverPersist: true } })?.continueInNewSession ?? null)
                .toBeNull();
            // A running outside Agent keeps Re-check: takeover may open once it stops.
            expect(resolveContinue({ status: { ...idleStatus, runnerActive: true } })?.continueInNewSession ?? null)
                .toBeNull();
        });

        it('is withheld when its owner says it is unavailable or an operation blocks new ones', () => {
            expect(resolveContinue({ continueAvailable: false })?.continueInNewSession ?? null).toBeNull();
            expect(resolveContinue({ externalSessionOperationBlocksNewOperation: true })?.continueInNewSession ?? null)
                .toBeNull();
        });

        it('needs write access, an online machine and no request already in flight', () => {
            expect(resolveContinue({ hasWriteAccess: false })?.continueInNewSession?.requestEnabled).toBe(false);
            expect(resolveContinue({ status: { ...idleStatus, machineOnline: false } })?.continueInNewSession?.requestEnabled)
                .toBe(false);
            const inFlight = resolveContinue({ continueInFlight: true })?.continueInNewSession;
            expect(inFlight).toEqual(expect.objectContaining({ requestEnabled: false, inFlight: true }));
            const importing = resolveContinue({
                materializeNeeded: true,
                externalSessionMaterialize: { materializeInFlight: true, requestMaterialize: vi.fn() },
            })?.continueInNewSession;
            // A plain Import in flight disables Continue without claiming Continue is the one running.
            expect(importing).toEqual(expect.objectContaining({ requestEnabled: false, inFlight: false }));
        });
    });

    // One message per state: a row that offers nothing only repeats the header's Agent and Machine.
    it('renders nothing when the row offers no way forward and nothing is in flight', () => {
        const base = {
            externalSessionLink: { machineId: 'machine-1' },
            externalSessionIdentity: { agentLabel: 'Muse', machineLabel: 'NLDW4' },
            externalSessionTakeover: {
                writerSafety: 'unsupported',
                takeoverInFlight: null,
                takeoverPreflightInFlight: false,
                requestTakeoverPreflight: vi.fn(),
            },
            isHiddenSystemSessionSession: false,
        } as const;
        expect(resolveFooter({ ...base, externalSessionRuntime: { status: null } })).toBeNull();
        expect(resolveFooter({
            ...base,
            externalSessionRuntime: { status: { machineOnline: false, runnerActive: false, activity: 'idle' } },
        })).toBeNull();
    });

    it('keeps the row while the reader\'s own import is in flight before any operation is published', () => {
        const footer = resolveFooter({
            externalSessionLink: { machineId: 'machine-1' },
            materializeNeeded: true,
            hasWriteAccess: true,
            externalSessionRuntime: { status: null },
            externalSessionTakeover: {
                writerSafety: 'unsupported',
                takeoverInFlight: null,
                takeoverPreflightInFlight: false,
                requestTakeoverPreflight: vi.fn(),
            },
            externalSessionMaterialize: { materializeInFlight: true, requestMaterialize: vi.fn() },
            isHiddenSystemSessionSession: false,
        });
        expect(footer?.materialize).toEqual(expect.objectContaining({ inFlight: true }));
    });

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
                writerSafety: 'native_prevention',
                takeoverInFlight: null,
                takeoverPreflightInFlight: false,
                requestTakeoverPreflight: vi.fn(),
            },
            isHiddenSystemSessionSession: false,
        });

        expect(footer?.activity).toBe('unknown');
    });

    it('offers one explicit takeover preflight before status is fetched when writer safety is known', async () => {
        const requestTakeoverPreflight = vi.fn(async () => false);
        const footer = resolveFooter({
            externalSessionLink: {
                machineId: 'machine-1',
            },
            externalSessionRuntime: {
                status: null,
            },
            externalSessionTakeover: {
                writerSafety: 'native_prevention',
                takeoverInFlight: null,
                takeoverPreflightInFlight: false,
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
                writerSafety: 'native_prevention',
                takeoverInFlight: null,
                takeoverPreflightInFlight: false,
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
                writerSafety: 'native_prevention',
                takeoverInFlight: null,
                takeoverPreflightInFlight: false,
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
                writerSafety: 'native_prevention',
                takeoverInFlight: null,
                takeoverPreflightInFlight: false,
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
                writerSafety: 'native_prevention',
                takeoverInFlight: null,
                takeoverPreflightInFlight: false,
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
                writerSafety: 'native_prevention',
                takeoverInFlight: null,
                takeoverPreflightInFlight: false,
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
                writerSafety: 'native_prevention',
                takeoverInFlight: null,
                takeoverPreflightInFlight: false,
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
