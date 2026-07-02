import { describe, expect, it } from 'vitest';

import { resolveExistingSessionAutomationAvailability } from './existingSessionAutomationAvailability';

describe('resolveExistingSessionAutomationAvailability', () => {
    it('returns hydrating while the target session is still being hydrated', () => {
        expect(resolveExistingSessionAutomationAvailability({
            sessionHydrated: false,
            session: null,
            sessionDekBase64: null,
            accountSettings: {},
        })).toEqual({ kind: 'hydrating' });
    });

    it('blocks when the target session is missing', () => {
        expect(resolveExistingSessionAutomationAvailability({
            sessionHydrated: true,
            session: null,
            sessionDekBase64: null,
            accountSettings: {},
        })).toEqual({
            kind: 'blocked',
            reason: 'session_not_found',
        });
    });

    it('blocks when the target session has no canonical machine id override', () => {
        expect(resolveExistingSessionAutomationAvailability({
            sessionHydrated: true,
            session: {
                id: 's1',
                encryptionMode: 'plain',
                metadata: {
                    flavor: 'claude',
                    claudeSessionId: 'claude-session-1',
                },
            },
            sessionDekBase64: null,
            accountSettings: {},
        })).toEqual({
            kind: 'blocked',
            reason: 'machine_id_missing',
        });
    });

    it('does not use stale metadata as the automation assignment machine id', () => {
        expect(resolveExistingSessionAutomationAvailability({
            sessionHydrated: true,
            session: {
                id: 's1',
                encryptionMode: 'plain',
                metadata: {
                    machineId: 'm-stale',
                    flavor: 'claude',
                    claudeSessionId: 'claude-session-1',
                },
            },
            sessionDekBase64: null,
            accountSettings: {},
        })).toEqual({
            kind: 'blocked',
            reason: 'machine_id_missing',
        });
    });

    it('prefers an explicit machine id override over stale session metadata', () => {
        expect(resolveExistingSessionAutomationAvailability({
            sessionHydrated: true,
            session: {
                id: 's1',
                encryptionMode: 'plain',
                metadata: {
                    machineId: 'm-stale',
                    flavor: 'claude',
                    claudeSessionId: 'claude-session-1',
                },
            },
            machineIdOverride: 'm-target',
            sessionDekBase64: null,
            accountSettings: {},
        })).toEqual({
            kind: 'ready',
            machineId: 'm-target',
            eligibility: {
                eligible: true,
                agentId: 'claude',
                strategy: 'vendor_resume',
            },
        });
    });

    it('blocks when the target session is not eligible for existing-session automations', () => {
        expect(resolveExistingSessionAutomationAvailability({
            sessionHydrated: true,
            session: {
                id: 's1',
                encryptionMode: 'plain',
                metadata: {
                    machineId: 'm1',
                    flavor: 'claude',
                },
            },
            machineIdOverride: 'm1',
            sessionDekBase64: null,
            accountSettings: {},
        })).toEqual({
            kind: 'blocked',
            reason: 'session_not_eligible',
            eligibility: {
                eligible: false,
                reasonCode: 'vendor_resume_id_missing',
            },
        });
    });

    it('blocks encrypted sessions until the resume key is available', () => {
        expect(resolveExistingSessionAutomationAvailability({
            sessionHydrated: true,
            session: {
                id: 's1',
                encryptionMode: 'e2ee',
                metadata: {
                    machineId: 'm1',
                    flavor: 'claude',
                    claudeSessionId: 'claude-session-1',
                },
            },
            machineIdOverride: 'm1',
            sessionDekBase64: null,
            accountSettings: {},
        })).toEqual({
            kind: 'blocked',
            reason: 'resume_key_missing',
            machineId: 'm1',
            eligibility: {
                eligible: true,
                agentId: 'claude',
                strategy: 'vendor_resume',
            },
        });
    });

    it('allows resumable sessions once requirements are met', () => {
        expect(resolveExistingSessionAutomationAvailability({
            sessionHydrated: true,
            session: {
                id: 's1',
                encryptionMode: 'plain',
                metadata: {
                    machineId: 'm1',
                    flavor: 'claude',
                    claudeSessionId: 'claude-session-1',
                },
            },
            machineIdOverride: 'm1',
            sessionDekBase64: null,
            accountSettings: {},
        })).toEqual({
            kind: 'ready',
            machineId: 'm1',
            eligibility: {
                eligible: true,
                agentId: 'claude',
                strategy: 'vendor_resume',
            },
        });
    });

    it('surfaces configured ACP attach eligibility as an explicit compat backend carrier instead of a shared customAcp agent id', () => {
        expect(resolveExistingSessionAutomationAvailability({
            sessionHydrated: true,
            session: {
                id: 's1',
                encryptionMode: 'plain',
                metadata: {
                    machineId: 'm1',
                    flavor: 'acp:review-bot',
                },
            },
            machineIdOverride: 'm1',
            sessionDekBase64: null,
            accountSettings: {},
        })).toEqual({
            kind: 'ready',
            machineId: 'm1',
            eligibility: {
                eligible: true,
                strategy: 'happy_attach',
                compatBackendId: 'review-bot',
            },
        });
    });
});
