import { describe, expect, it } from 'vitest';

import { resolveVerifiedLocalBrowserRecordingCaptureMachineId } from './localReverseCaptureOwnership';

const verifiedInput = {
    daemonStatus: {
        serviceInstalled: true,
        daemonRunning: true,
        needsAuth: false,
        machineId: ' machine-local ',
        daemonComparableKey: 'https://relay.example.test',
        daemonAccountId: 'account-local',
        daemonMachineRegistered: true,
    },
    activeRelayUrl: 'https://relay.example.test',
    activeLocalRelayUrl: null,
    uiAccountId: 'account-local',
    isMachineVisibleOnActiveServer: true,
} as const;

describe('resolveVerifiedLocalBrowserRecordingCaptureMachineId', () => {
    it('returns the normalized machine id only when local daemon ownership is fully verified', () => {
        expect(resolveVerifiedLocalBrowserRecordingCaptureMachineId(verifiedInput)).toBe('machine-local');
    });

    it('accepts a daemon relay that matches the active local relay URL', () => {
        expect(resolveVerifiedLocalBrowserRecordingCaptureMachineId({
            ...verifiedInput,
            daemonStatus: {
                ...verifiedInput.daemonStatus,
                daemonComparableKey: 'http://127.0.0.1:18829',
            },
            activeLocalRelayUrl: 'http://127.0.0.1:18829',
        })).toBe('machine-local');
    });

    it('fails closed when daemon ownership does not match the active UI context', () => {
        expect(resolveVerifiedLocalBrowserRecordingCaptureMachineId({
            ...verifiedInput,
            daemonStatus: {
                ...verifiedInput.daemonStatus,
                daemonComparableKey: 'https://other-relay.example.test',
            },
        })).toBeNull();
        expect(resolveVerifiedLocalBrowserRecordingCaptureMachineId({
            ...verifiedInput,
            daemonStatus: {
                ...verifiedInput.daemonStatus,
                daemonAccountId: 'other-account',
            },
        })).toBeNull();
        expect(resolveVerifiedLocalBrowserRecordingCaptureMachineId({
            ...verifiedInput,
            daemonStatus: {
                ...verifiedInput.daemonStatus,
                daemonMachineRegistered: false,
            },
        })).toBeNull();
        expect(resolveVerifiedLocalBrowserRecordingCaptureMachineId({
            ...verifiedInput,
            isMachineVisibleOnActiveServer: false,
        })).toBeNull();
    });
});
