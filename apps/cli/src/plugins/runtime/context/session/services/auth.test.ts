import { describe, expect, it, vi } from 'vitest';

import { createSessionScopedAuthServices } from './auth';

describe('createSessionScopedAuthServices runtime auth refresh', () => {
    it('reports connected-service runtime-auth classifications when selection is missing but recovery context is present', async () => {
        const recovery = {
            handled: true,
            report: null,
            statusCode: null,
            statusMessage: null,
            ok: true,
        };
        const reportFailure = vi.fn(async () => recovery);
        const resolveAdapter = vi.fn();
        const auth = createSessionScopedAuthServices({
            readSessionId: async () => 'happy-session-1',
            resolveAdapter,
            reportFailure,
        });
        const classification = {
            kind: 'auth_expired',
            limitCategory: 'auth_invalid',
            serviceId: 'openai-codex',
            profileId: 'codex-profile',
            groupId: null,
            resetsAtMs: null,
            retryAfterMs: null,
            planType: null,
            connectedServiceRecovery: 'available',
            rateLimits: null,
            source: 'structured_provider_error',
        };

        await expect(auth.services.refreshRuntimeAuth({
            agentId: 'opencode',
            serviceId: 'openai-codex',
            classification,
        })).resolves.toEqual({
            status: 'unavailable',
            reason: 'runtime_auth_selection_unavailable',
            recovery,
        });

        expect(resolveAdapter).not.toHaveBeenCalled();
        expect(reportFailure).toHaveBeenCalledWith({
            sessionId: 'happy-session-1',
            classification,
        });
    });

    it('does not report native runtime-auth classifications to connected-service recovery when selection is missing', async () => {
        const reportFailure = vi.fn(async () => ({
            handled: true,
            report: null,
            statusCode: null,
            statusMessage: null,
            ok: true,
        }));
        const resolveAdapter = vi.fn();
        const auth = createSessionScopedAuthServices({
            readSessionId: async () => 'happy-session-1',
            resolveAdapter,
            reportFailure,
        });

        await expect(auth.services.refreshRuntimeAuth({
            agentId: 'claude',
            serviceId: 'claude-subscription',
            classification: {
                kind: 'auth_expired',
                serviceId: 'claude-subscription',
                profileId: null,
                groupId: null,
                resetsAtMs: null,
                planType: null,
                rateLimits: null,
                source: 'structured_provider_error',
            },
        })).resolves.toEqual({
            status: 'unavailable',
            reason: 'runtime_auth_selection_unavailable',
        });

        expect(resolveAdapter).not.toHaveBeenCalled();
        expect(reportFailure).not.toHaveBeenCalled();
    });
});
