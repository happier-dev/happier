import { describe, expect, it } from 'vitest';

import {
    resolveMachineSessionGoalExecutionCapabilities,
    resolveSessionGoalExecutionCapabilities,
} from './sessionGoalExecutionCapabilities';

describe('session goal execution capabilities', () => {
    it('uses the live runtime registry for active sessions', () => {
        expect(resolveSessionGoalExecutionCapabilities({
            session: {
                active: true,
                agentState: {
                    capabilities: {
                        sessionGoalSetSupported: true,
                        sessionGoalClearSupported: false,
                    },
                },
            },
            machine: {
                metadata: { daemonSessionGoalControlsSupported: true },
            },
        })).toEqual({ canSet: true, canClear: false });
    });

    it('fails closed when an active runner does not publish goal controls', () => {
        expect(resolveSessionGoalExecutionCapabilities({
            session: { active: true, agentState: null },
            machine: {
                metadata: { daemonSessionGoalControlsSupported: true },
            },
        })).toEqual({ canSet: false, canClear: false });
    });

    it('uses the daemon-owned capability for inactive sessions', () => {
        expect(resolveSessionGoalExecutionCapabilities({
            session: { active: false, agentState: null },
            machine: {
                metadata: { daemonSessionGoalControlsSupported: true },
            },
        })).toEqual({ canSet: true, canClear: true });

        expect(resolveSessionGoalExecutionCapabilities({
            session: { active: false, agentState: null },
            machine: { metadata: {} },
        })).toEqual({ canSet: false, canClear: false });
    });

    it('fails closed for pre-session controls unless the daemon advertises support', () => {
        expect(resolveMachineSessionGoalExecutionCapabilities({
            metadata: { daemonSessionGoalControlsSupported: true },
        })).toEqual({ canSet: true, canClear: true });
        expect(resolveMachineSessionGoalExecutionCapabilities({ metadata: {} })).toEqual({
            canSet: false,
            canClear: false,
        });
    });
});
