import { describe, expect, it } from 'vitest';

import {
    canApplySteerConfigInFlight,
    canSteerUserMessageNow as canSteerUserMessageNowImpl,
    chooseSubmitMode as chooseSubmitModeImpl,
    decideSessionMessageDelivery as decideSessionMessageDeliveryImpl,
    selectSessionPendingRequestedAction as selectSessionPendingRequestedActionImpl,
} from './submitMode';

const chooseSubmitMode = (options: Parameters<typeof chooseSubmitModeImpl>[0]) =>
    chooseSubmitModeImpl(options);
const decideSessionMessageDelivery = (options: Parameters<typeof decideSessionMessageDeliveryImpl>[0]) =>
    decideSessionMessageDeliveryImpl(options);
const canSteerUserMessageNow = (options: Parameters<typeof canSteerUserMessageNowImpl>[0]) =>
    canSteerUserMessageNowImpl(options);

const selectSessionPendingRequestedAction = (
    options: Parameters<typeof selectSessionPendingRequestedActionImpl>[0],
) => selectSessionPendingRequestedActionImpl(options);

describe('selectSessionPendingRequestedAction', () => {
    const now = 1_000_000;
    const activeIdle = {
        active: true,
        presence: 'online',
        agentStateVersion: 1,
        thinking: false,
    } as any;
    const activeSteerable = {
        ...activeIdle,
        thinking: true,
        thinkingAt: now,
        agentState: {
            capabilities: {
                inFlightSteerSupported: true,
                inFlightSteerAvailable: true,
            },
        },
    } as any;

    it('keeps Always enqueue distinct from Always steer and resolves immediate actions exactly', () => {
        expect(selectSessionPendingRequestedAction({ session: activeSteerable, nowMs: now, preferSteer: false })).toEqual({
            v: 1, kind: 'enqueue',
        });
        expect(selectSessionPendingRequestedAction({ session: activeSteerable, nowMs: now, preferSteer: true })).toEqual({
            v: 1, kind: 'steer_if_active',
        });
        expect(selectSessionPendingRequestedAction({
            session: { ...activeIdle, agentState: { capabilities: { inFlightSteerSupported: true } } },
            nowMs: now,
            preferSteer: true,
        })).toEqual({
            v: 1, kind: 'steer_if_active',
        });
        expect(selectSessionPendingRequestedAction({
            session: activeSteerable,
            nowMs: now,
            timingOverride: 'send_now',
        })).toEqual({
            v: 1, kind: 'steer_now',
        });
        expect(selectSessionPendingRequestedAction({
            session: { ...activeIdle, runtimeActivityState: 'unknown' },
            nowMs: now,
        })).toEqual({ v: 1, kind: 'enqueue' });
        expect(selectSessionPendingRequestedAction({
            session: { ...activeSteerable, runtimeActivityState: 'active' },
            nowMs: now,
            preferSteer: true,
        })).toEqual({ v: 1, kind: 'steer_if_active' });
        expect(selectSessionPendingRequestedAction({
            session: { ...activeIdle, runtimeActivityState: 'unknown' },
            nowMs: now,
            timingOverride: 'send_now',
        })).toEqual({ v: 1, kind: 'send_now' });
        expect(selectSessionPendingRequestedAction({
            session: { ...activeIdle, presence: 'offline', runtimeActivityState: 'unknown' },
            nowMs: now,
            timingOverride: 'send_now',
        })).toEqual({ v: 1, kind: 'send_now' });
        expect(selectSessionPendingRequestedAction({
            session: {
                ...activeIdle,
                agentState: { controlledByUser: true, capabilities: { inFlightSteerSupported: false } },
            },
            nowMs: now,
            timingOverride: 'send_now',
        })).toEqual({ v: 1, kind: 'send_now' });
        expect(selectSessionPendingRequestedAction({
            session: { ...activeIdle, active: false, presence: 1 },
            nowMs: now,
        })).toEqual({ v: 1, kind: 'enqueue' });
        expect(selectSessionPendingRequestedAction({ session: activeSteerable, nowMs: now, firstTurn: true })).toEqual({
            v: 1, kind: 'send_now',
        });
    });

    it('uses the inactive-session resume policy for inactive and stale-active offline sessions', () => {
        const inactive = { ...activeIdle, active: false, presence: 'offline' };
        const staleActiveOffline = { ...activeIdle, presence: 'offline' };

        expect(selectSessionPendingRequestedAction({ session: inactive, nowMs: now })).toEqual({
            v: 1, kind: 'enqueue',
        });
        expect(selectSessionPendingRequestedAction({
            session: inactive,
            nowMs: now,
            sessionInactiveResumePolicy: 'when_available',
        })).toEqual({ v: 1, kind: 'send_now' });
        expect(selectSessionPendingRequestedAction({
            session: inactive,
            nowMs: now,
            sessionInactiveResumePolicy: 'online_only',
        })).toEqual({ v: 1, kind: 'enqueue' });
        expect(selectSessionPendingRequestedAction({
            session: staleActiveOffline,
            nowMs: now,
            sessionInactiveResumePolicy: 'when_available',
        })).toEqual({ v: 1, kind: 'send_now' });
        expect(selectSessionPendingRequestedAction({
            session: staleActiveOffline,
            nowMs: now,
            sessionInactiveResumePolicy: 'manual',
        })).toEqual({ v: 1, kind: 'enqueue' });
    });
});

describe('chooseSubmitMode', () => {
    const now = 1_000_000;

    it('routes interrupt mode through durable pending transport', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'interrupt',
            session: {
                active: true,
                presence: 'online',
                agentStateVersion: 1,
                pendingVersion: 0,
                pendingCount: 0,
                metadata: {},
            } as any,
        });

        expect(decision).toMatchObject({
            mode: 'server_pending',
            intent: 'interrupt',
            reason: 'interrupt_pending',
            pendingSupportState: 'supported',
        });
        expect(decision.directBypassReason).toBeUndefined();
    });

    it('keeps configured server_pending when pending support is not yet represented in the session summary', () => {
        expect(chooseSubmitMode({
            configuredMode: 'server_pending',
            session: { metadata: {} } as any,
        })).toBe('server_pending');
    });

    it('preserves explicit server_pending mode when pending is supported', () => {
        expect(chooseSubmitMode({
            configuredMode: 'server_pending',
            session: {
                pendingVersion: 0,
                pendingCount: 0,
                metadata: {},
            } as any,
        })).toBe('server_pending');
    });

    it('uses server_pending while thinking when configuredMode=server_pending and in-flight steer is supported and the session is online+ready', () => {
        expect(chooseSubmitMode({
            configuredMode: 'server_pending',
            busySteerSendPolicy: 'steer_immediately',
            session: {
                thinking: true,
                thinkingAt: now,
                active: true,
                presence: 'online',
                agentStateVersion: 1,
                agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
                pendingVersion: 0,
                pendingCount: 1,
                metadata: {},
            } as any,
            nowMs: now,
        })).toBe('server_pending');
    });

    it('uses server_pending while thinking when runtime steer availability has not arrived yet', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                thinking: true,
                thinkingAt: now,
                active: true,
                presence: 'online',
                agentStateVersion: 0,
                agentState: { controlledByUser: false },
                pendingVersion: 0,
                pendingCount: 1,
                metadata: { flavor: 'pi' },
            } as any,
            nowMs: now,
        })).toBe('server_pending');
    });

    it('uses server_pending for inactive sessions when pending queue V2 is supported even if stale signals look steerable', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                active: false,
                presence: 'online',
                thinking: true,
                thinkingAt: now,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: now,
                agentStateVersion: 1,
                agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
                pendingVersion: 0,
                pendingCount: 0,
                metadata: {},
            } as any,
            nowMs: now,
        })).toBe('server_pending');
    });

    it('keeps server_pending while thinking when in-flight steer is supported but unavailable for the active turn', () => {
        expect(chooseSubmitMode({
            configuredMode: 'server_pending',
            busySteerSendPolicy: 'steer_immediately',
            session: {
                thinking: true,
                thinkingAt: now,
                active: true,
                presence: 'online',
                agentStateVersion: 1,
                agentState: {
                    controlledByUser: false,
                    capabilities: {
                        inFlightSteer: true,
                        inFlightSteerSupported: true,
                        inFlightSteerAvailable: false,
                    },
                },
                pendingVersion: 0,
                pendingCount: 1,
                metadata: {},
            } as any,
            nowMs: now,
        })).toBe('server_pending');
    });

    it('prefers server_pending while controlledByUser when queue is supported', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                agentState: { controlledByUser: true },
                pendingVersion: 0,
                pendingCount: 0,
                metadata: {},
            } as any,
        })).toBe('server_pending');
    });

    it('keeps agent_queue for shared local attachment when remote writes are allowed', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                presence: 'online',
                agentStateVersion: 1,
                agentState: {
                    controlledByUser: false,
                    localControl: {
                        attached: true,
                        topology: 'shared',
                        remoteWritable: true,
                    },
                },
                pendingVersion: 0,
                pendingCount: 0,
                metadata: {},
            } as any,
        })).toBe('agent_queue');
    });

    it('uses server_pending for shared local attachment unless remote writeability is explicit', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                presence: 'online',
                agentStateVersion: 1,
                agentState: {
                    controlledByUser: false,
                    localControl: {
                        attached: true,
                        topology: 'shared',
                    },
                },
                pendingVersion: 0,
                pendingCount: 0,
                metadata: {},
            } as any,
        })).toBe('server_pending');
    });

    it('prefers server_pending while thinking when queue is supported', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                thinking: true,
                thinkingAt: now,
                active: true,
                presence: 'online',
                pendingVersion: 0,
                pendingCount: 0,
                metadata: {},
            } as any,
            nowMs: now,
        })).toBe('server_pending');
    });

    it('keeps steerable busy sends durable-first while the session is online+ready', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                thinking: true,
                thinkingAt: now,
                active: true,
                presence: 'online',
                agentStateVersion: 1,
                agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
                pendingVersion: 0,
                pendingCount: 1,
                metadata: {},
            } as any,
            nowMs: now,
        })).toBe('server_pending');
    });

    it('honors an explicit server_pending send intent even when normal routing would steer immediately', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            explicitMode: 'server_pending',
            session: {
                thinking: true,
                thinkingAt: now,
                active: true,
                presence: 'online',
                agentStateVersion: 1,
                agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
                pendingVersion: 0,
                pendingCount: 1,
                metadata: {},
            } as any,
            nowMs: now,
        })).toBe('server_pending');
    });

    it('prefers server_pending while thinking when in-flight steer is supported but the user prefers server_pending', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'server_pending',
            session: {
                thinking: true,
                thinkingAt: now,
                active: true,
                presence: 'online',
                agentStateVersion: 1,
                agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
                pendingVersion: 0,
                pendingCount: 1,
                metadata: {},
            } as any,
            nowMs: now,
        } as any)).toBe('server_pending');
    });

    it('exposes a rich decision for busy sends that stay queued by policy', () => {
        expect(decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'server_pending',
            session: {
                thinking: true,
                thinkingAt: now,
                active: true,
                presence: 'online',
                agentStateVersion: 1,
                agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
                pendingVersion: 0,
                pendingCount: 1,
                metadata: {},
            } as any,
            nowMs: now,
        })).toMatchObject({
            mode: 'server_pending',
            intent: 'default',
            reason: 'busy_policy_pending',
            pendingSupportState: 'supported',
        });
    });

    it('exposes force-immediate as a one-shot explicit direct decision', () => {
        expect(decideSessionMessageDelivery({
            configuredMode: 'server_pending',
            forceImmediate: true,
            session: {
                active: true,
                presence: 'online',
                agentStateVersion: 1,
                pendingVersion: 0,
                pendingCount: 1,
                metadata: {},
            } as any,
            nowMs: now,
        })).toMatchObject({
            mode: 'agent_queue',
            intent: 'explicit_immediate',
            reason: 'force_immediate_direct',
            directBypassReason: 'force_immediate',
            pendingSupportState: 'supported',
        });
    });

    it('does not treat stale thinking as busy when choosing composer delivery', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                thinking: true,
                thinkingAt: now - 120_000,
                active: true,
                presence: 'online',
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: now - 1_000,
                agentStateVersion: 1,
                agentState: { controlledByUser: false, capabilities: { inFlightSteer: false } },
                pendingVersion: 0,
                pendingCount: 0,
                metadata: {},
            } as any,
            nowMs: now,
        })).toBe('agent_queue');
    });

    it('does not treat detached runtime activity as a busy foreground turn', () => {
        expect(decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            session: {
                active: true,
                activeAt: now - 10_000,
                presence: 'online',
                thinking: false,
                thinkingAt: 0,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: now - 5_000,
                runtimeActivityState: 'active',
                runtimeActivityRevision: 1,
                runtimeActivityActiveCount: 1,
                runtimeActivityObservedAt: now - 1_000,
                agentStateVersion: 1,
                agentState: { controlledByUser: false, capabilities: { inFlightSteer: false } },
                pendingVersion: 0,
                pendingCount: 0,
                metadata: {},
            } as any,
            nowMs: now,
        })).toMatchObject({
            mode: 'agent_queue',
            reason: 'configured_mode',
        });
    });

    it('does not block a foreground-ready send when detached activity telemetry is absent', () => {
        expect(decideSessionMessageDeliveryImpl({
            configuredMode: 'agent_queue',
            session: {
                active: true,
                presence: 'online',
                thinking: false,
                thinkingAt: 0,
                agentStateVersion: 1,
                agentState: { controlledByUser: false, capabilities: { inFlightSteer: false } },
                pendingVersion: 0,
                pendingCount: 0,
                metadata: {},
            } as any,
            nowMs: now,
        })).toMatchObject({ mode: 'agent_queue', reason: 'configured_mode' });
    });

    it('prefers server_pending when the session is offline but queue is supported', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                presence: 0,
                agentStateVersion: 0,
                pendingVersion: 0,
                pendingCount: 0,
                metadata: {},
            } as any,
        })).toBe('server_pending');
    });

    it('prefers server_pending when the agent is not ready but queue is supported', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                presence: 'online',
                agentStateVersion: 0,
                pendingVersion: 0,
                pendingCount: 0,
                metadata: {},
            } as any,
        })).toBe('server_pending');
    });

    it('keeps agent_queue for inactive sessions if queue is not supported', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                active: false,
                presence: 'online',
                thinking: true,
                thinkingAt: now,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: now,
                agentStateVersion: 1,
                agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
                metadata: {},
            } as any,
            nowMs: now,
        })).toBe('agent_queue');
    });

    it('keeps explicit server_pending when pending support is not yet represented on inactive sessions', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            explicitMode: 'server_pending',
            session: {
                active: false,
                presence: 'online',
                agentStateVersion: 1,
                metadata: {},
            } as any,
            nowMs: now,
        })).toBe('server_pending');
    });

    it('keeps agent_queue when pending is supported but the CLI version is too old (prevents stranded pending)', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                presence: 0,
                agentStateVersion: 0,
                pendingVersion: 0,
                pendingCount: 0,
                metadata: { version: '0.0.1' },
            } as any,
        })).toBe('agent_queue');
    });

    it('keeps agent_queue for explicit server_pending on inactive sessions when the CLI version is too old', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            explicitMode: 'server_pending',
            session: {
                active: false,
                presence: 'online',
                agentStateVersion: 1,
                pendingVersion: 0,
                pendingCount: 0,
                metadata: { version: '0.0.1' },
            } as any,
            nowMs: now,
        })).toBe('agent_queue');
    });
});

describe('decideSessionMessageDelivery — non-steerable payload honesty (lane P, O-design stage 2)', () => {
    const now = 1_000_000;
    const steerableBusySession = (overrides?: Record<string, unknown>) => ({
        thinking: true,
        thinkingAt: now,
        active: true,
        presence: 'online',
        agentStateVersion: 1,
        agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
        pendingVersion: 0,
        pendingCount: 0,
        metadata: { permissionMode: 'default' },
        permissionMode: 'default',
        // Fresh user-intended change (lane X, X2): set at/after the active turn start.
        permissionModeUpdatedAt: now,
        ...overrides,
    } as any);

    it('never silently returns agent_queue while busy for a mode-change payload — routes to pending with the local reason', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: steerableBusySession({ permissionMode: 'plan' }),
            text: 'do the thing',
            nowMs: now,
        });
        expect(decision.mode).toBe('server_pending');
        expect(decision.nonSteerablePayloadReason).toBe('mode_change_refused');
    });

    it('routes special commands to pending while busy (mirrors the CLI steer gate)', () => {
        for (const text of ['/clear', '/compact', '/compact focus on the tests']) {
            const decision = decideSessionMessageDelivery({
                configuredMode: 'agent_queue',
                busySteerSendPolicy: 'steer_immediately',
                session: steerableBusySession(),
                text,
                nowMs: now,
            });
            expect(decision.mode).toBe('server_pending');
            expect(decision.nonSteerablePayloadReason).toBe('special_command');
        }
    });

    it('keeps non-Happier slash prompts eligible for durable-first steering while busy', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: steerableBusySession(),
            text: '/model',
            nowMs: now,
        });

        expect(decision.mode).toBe('server_pending');
        expect(decision.nonSteerablePayloadReason ?? null).toBeNull();
    });

    it('routes steerable payloads through durable pending while busy', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: steerableBusySession(),
            text: 'just steer this text',
            nowMs: now,
        });
        expect(decision.mode).toBe('server_pending');
        expect(decision.nonSteerablePayloadReason ?? null).toBeNull();
    });

    it('respects sessionPermissionModeApplyTiming=next_prompt — mode never applies mid-turn, so durable steering stays honest', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: steerableBusySession({ permissionMode: 'plan' }),
            text: 'do the thing',
            permissionModeApplyTiming: 'next_prompt',
            nowMs: now,
        });
        expect(decision.mode).toBe('server_pending');
        expect(decision.nonSteerablePayloadReason ?? null).toBeNull();
    });

    it('honors the kill-switch without bypassing durable-first busy steer delivery', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: steerableBusySession({ permissionMode: 'plan' }),
            text: 'do the thing',
            nonSteerableSendPrompt: 'off',
            nowMs: now,
        });
        expect(decision.mode).toBe('server_pending');
    });

    it('keeps the steer-immediate reason when no payload facts exist (no selected mode, no text)', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: steerableBusySession({ permissionMode: undefined }),
            nowMs: now,
        });
        expect(decision.mode).toBe('server_pending');
        expect(decision.reason).toBe('busy_steer_immediate');
    });

    it('keeps an occupied Claude Unified steer slot on the durable steer-if-active action', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: steerableBusySession({
                agentState: {
                    controlledByUser: false,
                    capabilities: {
                        inFlightSteer: true,
                        inFlightSteerSupported: true,
                        inFlightSteerAvailable: false,
                    },
                },
            }),
            text: 'second steer while the first steer is still in flight',
            nowMs: now,
        });

        expect(decision.mode).toBe('server_pending');
        expect(decision.requestedAction).toEqual({ v: 1, kind: 'steer_if_active' });
    });

    it('keeps a temporarily unavailable supported steer on the durable steer-if-active action', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: steerableBusySession({
                agentState: {
                    controlledByUser: false,
                    capabilities: {
                        inFlightSteer: true,
                        inFlightSteerAvailable: false,
                        inFlightSteerUnavailableReason: 'unsafe_window',
                        inFlightSteerStateAt: now,
                    },
                },
            }),
            text: 'hello',
            nowMs: now,
        });
        expect(decision.mode).toBe('server_pending');
        expect(decision.requestedAction).toEqual({ v: 1, kind: 'steer_if_active' });
    });

    it('keeps idle sessions on durable steer-if-active delivery when steer support is published', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            session: steerableBusySession({ thinking: false, thinkingAt: 0, permissionMode: 'plan' }),
            text: 'do the thing',
            nowMs: now,
        });
        expect(decision.mode).toBe('server_pending');
        expect(decision.requestedAction).toEqual({ v: 1, kind: 'steer_if_active' });
        expect(decision.nonSteerablePayloadReason ?? null).toBeNull();
    });
});

describe('decideSessionMessageDelivery — apply-config-and-steer (lane Q)', () => {
    const now = 1_000_000;
    const configApplySession = (overrides?: Record<string, unknown>) => ({
        thinking: true,
        thinkingAt: now,
        active: true,
        presence: 'online',
        agentStateVersion: 1,
        agentState: {
            controlledByUser: false,
            capabilities: { inFlightSteer: true, inFlightConfigApplySupported: true },
        },
        pendingVersion: 0,
        pendingCount: 0,
        metadata: { permissionMode: 'default' },
        permissionMode: 'plan',
        // Fresh user-intended change (lane X, X2): set at/after the active turn start.
        permissionModeUpdatedAt: now,
        ...overrides,
    } as any);

    it('routes a mode-change payload to durable pending when the user chose apply-and-steer and the backend supports it', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: configApplySession(),
            text: 'do the thing',
            applyConfigAndSteer: true,
            nowMs: now,
        });
        expect(decision.mode).toBe('server_pending');
        expect(decision.reason).toBe('busy_steer_config_apply');
        expect(decision.nonSteerablePayloadReason ?? null).toBeNull();
    });

    it('stays demoted to pending when the backend does not publish the capability (fail-closed)', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: configApplySession({
                agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
            }),
            text: 'do the thing',
            applyConfigAndSteer: true,
            nowMs: now,
        });
        expect(decision.mode).toBe('server_pending');
        expect(decision.nonSteerablePayloadReason).toBe('mode_change_refused');
    });

    it('never lets special commands through the apply-and-steer route', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: configApplySession({ permissionMode: 'default' }),
            text: '/clear',
            applyConfigAndSteer: true,
            nowMs: now,
        });
        expect(decision.mode).toBe('server_pending');
        expect(decision.nonSteerablePayloadReason).toBe('special_command');
    });

    it('routes provider-owned config change blockers to pending while busy', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: configApplySession({ permissionMode: 'default' }),
            text: 'use the selected model',
            providerNonSteerablePayloadReason: 'provider_config_change_refused',
            nowMs: now,
        });

        expect(decision.mode).toBe('server_pending');
        expect(decision.nonSteerablePayloadReason).toBe('provider_config_change_refused');
    });

    it('does not change behavior when the flag is absent', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: configApplySession(),
            text: 'do the thing',
            nowMs: now,
        });
        expect(decision.mode).toBe('server_pending');
        expect(decision.nonSteerablePayloadReason).toBe('mode_change_refused');
    });

    it('canApplySteerConfigInFlight reflects the published capability', () => {
        expect(canApplySteerConfigInFlight(configApplySession())).toBe(true);
        expect(canApplySteerConfigInFlight(configApplySession({
            agentState: { capabilities: { inFlightSteer: true } },
        }))).toBe(false);
        expect(canApplySteerConfigInFlight(null)).toBe(false);
    });

    it('canSteerUserMessageNow uses the shared busy-steer runtime gates', () => {
        expect(canSteerUserMessageNow({
            session: {
                thinking: true,
                thinkingAt: now,
                active: true,
                presence: 'online',
                agentStateVersion: 1,
                agentState: {
                    controlledByUser: false,
                    capabilities: {
                        inFlightSteer: true,
                        inFlightSteerSupported: true,
                        inFlightSteerAvailable: true,
                    },
                },
                metadata: {},
            } as any,
            nowMs: now,
        })).toBe(true);

        expect(canSteerUserMessageNow({
            session: {
                thinking: true,
                thinkingAt: now,
                active: true,
                presence: 'online',
                agentStateVersion: 1,
                agentState: {
                    controlledByUser: true,
                    capabilities: {
                        inFlightSteer: true,
                        inFlightSteerSupported: true,
                        inFlightSteerAvailable: true,
                    },
                },
                metadata: {},
            } as any,
            nowMs: now,
        })).toBe(false);
    });
});

describe('decideSessionMessageDelivery — fresh-change gate (lane X, X2, incident cmq8y3nlx)', () => {
    const now = 1_000_000;
    const turnStartedAt = now - 60_000;
    const busyDriftSession = (overrides?: Record<string, unknown>) => ({
        thinking: true,
        thinkingAt: turnStartedAt,
        latestTurnStatus: 'in_progress',
        latestTurnStatusObservedAt: turnStartedAt,
        active: true,
        presence: 'online',
        agentStateVersion: 1,
        agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
        pendingVersion: 0,
        pendingCount: 0,
        metadata: { permissionMode: 'default' },
        permissionMode: 'plan',
        ...overrides,
    } as any);

    it('a plain message with STALE unconverged drift (change predates the active turn) stays steerable via durable pending — no modal route', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: busyDriftSession({ permissionModeUpdatedAt: turnStartedAt - 5_000 }),
            text: 'just steer this text',
            nowMs: now,
        });
        expect(decision.mode).toBe('server_pending');
        expect(decision.reason).toBe('busy_steer_immediate');
        expect(decision.nonSteerablePayloadReason ?? null).toBeNull();
    });

    it('drift WITHOUT a user-change timestamp is standing drift, not a fresh intent — steers silently', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: busyDriftSession({ permissionModeUpdatedAt: undefined }),
            text: 'just steer this text',
            nowMs: now,
        });
        expect(decision.mode).toBe('server_pending');
        expect(decision.nonSteerablePayloadReason ?? null).toBeNull();
    });

    it('a FRESH mode change (made during the active turn) keeps the honest modal route', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: busyDriftSession({ permissionModeUpdatedAt: turnStartedAt + 5_000 }),
            text: 'do the thing',
            nowMs: now,
        });
        expect(decision.mode).toBe('server_pending');
        expect(decision.nonSteerablePayloadReason).toBe('mode_change_refused');
    });

    it('special commands stay gated regardless of mode freshness', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: busyDriftSession({ permissionModeUpdatedAt: turnStartedAt - 5_000 }),
            text: '/clear',
            nowMs: now,
        });
        expect(decision.mode).toBe('server_pending');
        expect(decision.nonSteerablePayloadReason).toBe('special_command');
    });

    it('thinking-only busy sessions use thinkingAt as the turn-start estimate', () => {
        const base = {
            latestTurnStatus: undefined,
            latestTurnStatusObservedAt: undefined,
            thinkingAt: turnStartedAt,
        };
        const stale = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: busyDriftSession({ ...base, permissionModeUpdatedAt: turnStartedAt - 1 }),
            text: 'text',
            nowMs: now,
        });
        expect(stale.mode).toBe('server_pending');

        const fresh = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: busyDriftSession({ ...base, permissionModeUpdatedAt: turnStartedAt + 1 }),
            text: 'text',
            nowMs: now,
        });
        expect(fresh.mode).toBe('server_pending');
        expect(fresh.nonSteerablePayloadReason).toBe('mode_change_refused');
    });
});

describe('decideSessionMessageDelivery — steer text without applying (lane X, X3 Case B)', () => {
    const now = 1_000_000;
    const session = (overrides?: Record<string, unknown>) => ({
        thinking: true,
        thinkingAt: now - 60_000,
        active: true,
        presence: 'online',
        agentStateVersion: 1,
        agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
        pendingVersion: 0,
        pendingCount: 0,
        metadata: { permissionMode: 'default' },
        permissionMode: 'plan',
        permissionModeUpdatedAt: now,
        ...overrides,
    } as any);

    it('routes the TEXT only through durable pending when the user chose defer-and-steer (setting stays desired-state)', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: session(),
            text: 'do the thing',
            steerWithoutConfig: true,
            nowMs: now,
        });
        expect(decision.mode).toBe('server_pending');
        expect(decision.reason).toBe('busy_steer_text_only');
        expect(decision.nonSteerablePayloadReason ?? null).toBeNull();
    });

    it('never lets special commands through the defer-and-steer route', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: session(),
            text: '/compact keep the tests',
            steerWithoutConfig: true,
            nowMs: now,
        });
        expect(decision.mode).toBe('server_pending');
        expect(decision.nonSteerablePayloadReason).toBe('special_command');
    });

    it('does not change behavior when the flag is absent', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: session(),
            text: 'do the thing',
            nowMs: now,
        });
        expect(decision.mode).toBe('server_pending');
        expect(decision.nonSteerablePayloadReason).toBe('mode_change_refused');
    });
});
