import { describe, expect, it } from 'vitest';

import {
    buildBackendTargetRouteParams,
    resolveBackendTargetFromRouteParams,
} from './backendTargetRouteParams';

describe('buildBackendTargetRouteParams', () => {
    it('prefers the current fallback target over stale serialized route params', () => {
        expect(buildBackendTargetRouteParams({
            backendTarget: JSON.stringify({ kind: 'configuredAcpBackend', backendId: 'review-bot' }),
            backendTargetKey: 'acpBackend:review-bot',
            fallbackTarget: {
                kind: 'backend',
                backendId: 'claude',
            },
        })).toEqual({
            agentType: 'claude',
            backendTarget: JSON.stringify({
                kind: 'backend',
                backendId: 'claude',
            }),
            backendTargetKey: 'backend:claude',
        });
    });

    it('serializes configured ACP targets using the canonical V2 route contract', () => {
        expect(buildBackendTargetRouteParams({
            backendTarget: JSON.stringify({ kind: 'configuredAcpBackend', backendId: 'review-bot' }),
            backendTargetKey: 'acpBackend:review-bot',
            fallbackTarget: {
                kind: 'backend',
                backendId: 'review-bot',
                configuredBackendId: 'review-bot',
            },
        })).toEqual({
            backendTarget: JSON.stringify({
                kind: 'backend',
                backendId: 'review-bot',
                configuredBackendId: 'review-bot',
            }),
            backendTargetKey: 'backend:review-bot:configured:review-bot',
        });
    });

    it('accepts canonical V2 route params', () => {
        expect(resolveBackendTargetFromRouteParams({
            backendTarget: JSON.stringify({
                kind: 'backend',
                backendId: 'review-bot',
                configuredBackendId: 'review-bot',
            }),
            backendTargetKey: 'backend:review-bot:configured:review-bot',
        })).toEqual({
            kind: 'backend',
            backendId: 'review-bot',
            configuredBackendId: 'review-bot',
        });
    });

    it('round-trips a qualified external Agent identity without a backend alias', () => {
        const target = {
            kind: 'agent' as const,
            identity: { pluginId: 'acme.review', localId: 'review' },
        };
        const route = buildBackendTargetRouteParams({ fallbackTarget: target });

        expect(route).toEqual({
            backendTarget: JSON.stringify(target),
            backendTargetKey: 'agent:acme.review/review',
        });
        expect(resolveBackendTargetFromRouteParams(route)).toEqual(target);
        expect(resolveBackendTargetFromRouteParams({
            backendTargetKey: 'agent:acme.review/review',
        })).toEqual(target);
    });

    it('does not reconstruct unknown backend ids from agentType route compatibility alone anymore', () => {
        expect(resolveBackendTargetFromRouteParams({
            agentType: 'acme.review.backend',
        })).toBeNull();
    });

    it('does not reconstruct configured ACP backend targets from legacy agentType acp:<backendId> params anymore', () => {
        expect(resolveBackendTargetFromRouteParams({
            agentType: 'acp:review-bot',
        })).toBeNull();
    });

    it('serializes plugin backend ids through backendTarget fields (without overloading agentType)', () => {
        expect(buildBackendTargetRouteParams({
            fallbackTarget: {
                kind: 'backend',
                backendId: 'acme.review.backend',
            },
        })).toEqual({
            backendTarget: JSON.stringify({
                kind: 'backend',
                backendId: 'acme.review.backend',
            }),
            backendTargetKey: 'backend:acme.review.backend',
        });
    });
});
