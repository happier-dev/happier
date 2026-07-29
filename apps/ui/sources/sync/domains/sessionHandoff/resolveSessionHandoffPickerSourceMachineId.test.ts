import { describe, expect, it } from 'vitest';

import { resolveSessionHandoffPickerSourceMachineId } from './resolveSessionHandoffPickerSourceMachineId';

describe('resolveSessionHandoffPickerSourceMachineId', () => {
    it('prefers the current session metadata machine id over a divergent source machine hint', () => {
        expect(resolveSessionHandoffPickerSourceMachineId({
            sourceMachineId: ' machine_target ',
            sessionMetadata: { machineId: ' machine_source ' },
        })).toBe('machine_source');
    });

    it('falls back to externalSessionV1.machineId when machineId is missing', () => {
        expect(resolveSessionHandoffPickerSourceMachineId({
            sourceMachineId: ' machine_target ',
            sessionMetadata: {
                externalSessionV1: {
                    v: 1,
                    agentId: 'claude',
                    machineId: ' machine_direct ',
                    remoteSessionId: 'claude_session_1',
                    source: { kind: 'claudeConfig', configDir: '/Users/tester/.claude' },
                },
            },
        })).toBe('machine_direct');
    });

    it('falls back to released directSessionV1.machineId when machineId is missing', () => {
        expect(resolveSessionHandoffPickerSourceMachineId({
            sourceMachineId: ' machine_target ',
            sessionMetadata: {
                directSessionV1: {
                    v: 1,
                    providerId: 'claude',
                    machineId: ' machine_legacy ',
                    remoteSessionId: 'claude_session_1',
                    source: { kind: 'claudeConfig', configDir: '/Users/tester/.claude' },
                },
            },
        })).toBe('machine_legacy');
    });

    it('falls back to the provided source machine id when session metadata is missing', () => {
        expect(resolveSessionHandoffPickerSourceMachineId({
            sourceMachineId: ' machine_target ',
            sessionMetadata: null,
        })).toBe('machine_target');
    });

    it('returns null when no non-empty machine id is available', () => {
        expect(resolveSessionHandoffPickerSourceMachineId({
            sourceMachineId: '   ',
            sessionMetadata: { machineId: null, externalSessionV1: { machineId: '' } },
        })).toBeNull();
    });
});
