import { describe, expect, it } from 'vitest';

import { canApplySteerConfigInFlight, chooseSubmitMode, decideSessionMessageDelivery } from './submitMode';

describe('chooseSubmitMode', () => {
    const now = 1_000_000;

    it('preserves interrupt mode', () => {
        expect(chooseSubmitMode({
            configuredMode: 'interrupt',
            session: { metadata: {} } as any,
        })).toBe('interrupt');
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

    it('uses agent_queue while thinking when configuredMode=server_pending and in-flight steer is supported and the session is online+ready', () => {
        expect(chooseSubmitMode({
            configuredMode: 'server_pending',
            busySteerSendPolicy: 'steer_immediately',
            session: {
                active: true,
                thinking: true,
                thinkingAt: Date.now(),
                presence: 'online',
                agentStateVersion: 1,
                agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
                pendingVersion: 0,
                pendingCount: 1,
                metadata: {},
            } as any,
        })).toBe('agent_queue');
    });

    it('uses provider-declared steer support while thinking when runtime state has not arrived yet', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: {
                active: true,
                thinking: true,
                thinkingAt: Date.now(),
                presence: 'online',
                agentStateVersion: 0,
                agentState: { controlledByUser: false },
                pendingVersion: 0,
                pendingCount: 1,
                metadata: { flavor: 'pi' },
            } as any,
        })).toBe('agent_queue');
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
        })).toBe('server_pending');
    });

    it('keeps server_pending while thinking when in-flight steer is supported but unavailable for the active turn', () => {
        expect(chooseSubmitMode({
            configuredMode: 'server_pending',
            busySteerSendPolicy: 'steer_immediately',
            session: {
                active: true,
                thinking: true,
                thinkingAt: Date.now(),
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

    it('prefers server_pending while thinking when queue is supported', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                active: true,
                presence: 'online',
                thinking: true,
                thinkingAt: Date.now(),
                agentStateVersion: 1,
                pendingVersion: 0,
                pendingCount: 0,
                metadata: {},
            } as any,
        })).toBe('server_pending');
    });

    it('keeps agent_queue when stale thinking follows a completed primary turn projection', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                active: true,
                presence: 'online',
                thinking: true,
                thinkingAt: 1_000,
                latestTurnStatus: 'completed',
                latestTurnStatusObservedAt: 2_000,
                agentStateVersion: 1,
                pendingVersion: 0,
                pendingCount: 0,
                metadata: {},
            } as any,
        })).toBe('agent_queue');
    });

    it('keeps agent_queue while thinking when in-flight steer is supported and the session is online+ready', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                active: true,
                thinking: true,
                thinkingAt: Date.now(),
                presence: 'online',
                agentStateVersion: 1,
                agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
                pendingVersion: 0,
                pendingCount: 1,
                metadata: {},
            } as any,
        })).toBe('agent_queue');
    });

    it('prefers server_pending while thinking when in-flight steer is supported but the user prefers server_pending', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'server_pending',
            session: {
                active: true,
                thinking: true,
                thinkingAt: Date.now(),
                presence: 'online',
                agentStateVersion: 1,
                agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
                pendingVersion: 0,
                pendingCount: 1,
                metadata: {},
            } as any,
        } as any)).toBe('server_pending');
    });

    it('exposes a rich decision for busy sends that stay queued by policy', () => {
        expect(decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'server_pending',
            session: {
                active: true,
                thinking: true,
                thinkingAt: now,
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

    it('uses pending delivery for provider config changes while an active turn can otherwise be steered', () => {
        expect(decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            providerNonSteerableReason: 'provider_config_change_refused',
            session: {
                active: true,
                thinking: true,
                thinkingAt: now,
                presence: 'online',
                agentStateVersion: 1,
                agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
                pendingVersion: 0,
                pendingCount: 1,
                metadata: {},
            } as any,
            nowMs: now,
        } as any)).toMatchObject({
            mode: 'server_pending',
            intent: 'default',
            reason: 'busy_non_steerable_payload_pending',
            nonSteerablePayloadReason: 'provider_config_change_refused',
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

    it('honors explicit server_pending send intent even when normal routing would steer immediately', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            explicitMode: 'server_pending',
            session: {
                active: true,
                thinking: true,
                thinkingAt: Date.now(),
                presence: 'online',
                agentStateVersion: 1,
                agentState: { controlledByUser: false, capabilities: { inFlightSteer: true } },
                pendingVersion: 0,
                pendingCount: 1,
                metadata: {},
            } as any,
        })).toBe('server_pending');
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

    it('keeps agent_queue if queue is not supported', () => {
        expect(chooseSubmitMode({
            configuredMode: 'agent_queue',
            session: {
                thinking: true,
                metadata: {},
            } as any,
        })).toBe('agent_queue');
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
        })).toBe('agent_queue');
    });
});

describe('decideSessionMessageDelivery — non-steerable payload honesty (G4 port of RD lane P stage 2)', () => {
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
        // Fresh user-intended change (X2): set at/after the active turn start.
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

    it('keeps steering for a steerable payload while busy (no behavior change)', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: steerableBusySession(),
            text: 'just steer this text',
            nowMs: now,
        });
        expect(decision.mode).toBe('agent_queue');
        expect(decision.nonSteerablePayloadReason ?? null).toBeNull();
    });

    it('respects sessionPermissionModeApplyTiming=next_prompt — mode never applies mid-turn, so steering stays honest', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: steerableBusySession({ permissionMode: 'plan' }),
            text: 'do the thing',
            permissionModeApplyTiming: 'next_prompt',
            nowMs: now,
        });
        expect(decision.mode).toBe('agent_queue');
        expect(decision.nonSteerablePayloadReason ?? null).toBeNull();
    });

    it('honors the kill-switch: nonSteerableSendPrompt=off restores legacy steer behavior for mode changes', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: steerableBusySession({ permissionMode: 'plan' }),
            text: 'do the thing',
            nonSteerableSendPrompt: 'off',
            nowMs: now,
        });
        expect(decision.mode).toBe('agent_queue');
    });

    it('keeps the provider-owned config gate even when the prompt is off (dev legacy demote)', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: steerableBusySession(),
            text: 'use the selected model',
            nonSteerableSendPrompt: 'off',
            providerNonSteerableReason: 'provider_config_change_refused',
            nowMs: now,
        });
        expect(decision.mode).toBe('server_pending');
        expect(decision.nonSteerablePayloadReason).toBe('provider_config_change_refused');
    });

    it('keeps legacy behavior byte-for-byte when no payload facts exist (no selected mode, no text)', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: steerableBusySession({ permissionMode: undefined }),
            nowMs: now,
        });
        expect(decision.mode).toBe('agent_queue');
        expect(decision.reason).toBe('busy_steer_immediate');
    });

    it('exposes the published session steer-unavailable reason on busy pending decisions (Seam A consumer)', () => {
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
        expect(decision.reason).toBe('busy_policy_pending');
        expect(decision.sessionSteerUnavailableReason).toBe('unsafe_window');
    });

    it('leaves idle sessions untouched by payload facts', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            session: steerableBusySession({ thinking: false, thinkingAt: 0, permissionMode: 'plan' }),
            text: 'do the thing',
            nowMs: now,
        });
        expect(decision.mode).toBe('agent_queue');
        expect(decision.nonSteerablePayloadReason ?? null).toBeNull();
    });
});

describe('decideSessionMessageDelivery — apply-config-and-steer (G4, LEAF-11 capability consumer)', () => {
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
        permissionModeUpdatedAt: now,
        ...overrides,
    } as any);

    it('routes a mode-change payload to agent_queue when the user chose apply-and-steer and the backend supports it', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: configApplySession(),
            text: 'do the thing',
            applyConfigAndSteer: true,
            nowMs: now,
        });
        expect(decision.mode).toBe('agent_queue');
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

    it('never honors apply-and-steer when in-flight steer is unavailable for the active turn (no blind injection)', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: configApplySession({
                agentState: {
                    controlledByUser: false,
                    capabilities: {
                        inFlightSteerSupported: true,
                        inFlightSteerAvailable: false,
                        inFlightConfigApplySupported: true,
                    },
                },
            }),
            text: 'do the thing',
            applyConfigAndSteer: true,
            nowMs: now,
        });
        expect(decision.mode).toBe('server_pending');
        expect(decision.nonSteerablePayloadReason).toBe('mode_change_refused');
    });

    it('never honors defer-and-steer when in-flight steer is unavailable for the active turn', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: configApplySession({
                agentState: {
                    controlledByUser: false,
                    capabilities: {
                        inFlightSteerSupported: true,
                        inFlightSteerAvailable: false,
                    },
                },
            }),
            text: 'do the thing',
            steerWithoutConfig: true,
            nowMs: now,
        });
        expect(decision.mode).toBe('server_pending');
        expect(decision.nonSteerablePayloadReason).toBe('mode_change_refused');
    });

    it('canApplySteerConfigInFlight reflects the published capability (fail-closed)', () => {
        expect(canApplySteerConfigInFlight(configApplySession())).toBe(true);
        expect(canApplySteerConfigInFlight(configApplySession({
            agentState: { capabilities: { inFlightSteer: true } },
        }))).toBe(false);
        expect(canApplySteerConfigInFlight(null)).toBe(false);
    });
});

describe('decideSessionMessageDelivery — fresh-change gate (G4, X2 NON-NEGOTIABLE)', () => {
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

    it('a plain message with STALE unconverged drift (change predates the active turn) steers silently — no modal route', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: busyDriftSession({ permissionModeUpdatedAt: turnStartedAt - 5_000 }),
            text: 'just steer this text',
            nowMs: now,
        });
        expect(decision.mode).toBe('agent_queue');
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
        expect(decision.mode).toBe('agent_queue');
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
        expect(stale.mode).toBe('agent_queue');

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

describe('decideSessionMessageDelivery — steer text without applying (G4, X3 Case B)', () => {
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

    it('steers the TEXT only when the user chose defer-and-steer (setting stays desired-state)', () => {
        const decision = decideSessionMessageDelivery({
            configuredMode: 'agent_queue',
            busySteerSendPolicy: 'steer_immediately',
            session: session(),
            text: 'do the thing',
            steerWithoutConfig: true,
            nowMs: now,
        });
        expect(decision.mode).toBe('agent_queue');
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
