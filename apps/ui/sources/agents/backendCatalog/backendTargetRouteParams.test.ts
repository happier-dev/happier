import { describe, expect, it } from 'vitest';

import { buildBackendTargetRouteParams, resolveBackendTargetFromRouteParams } from './backendTargetRouteParams';

describe('buildBackendTargetRouteParams', () => {
    it('prefers the current fallback target over stale serialized route params', () => {
        expect(buildBackendTargetRouteParams({
            agentType: 'customAcp',
            backendTarget: JSON.stringify({ kind: 'configuredAcpBackend', backendId: 'review-bot' }),
            backendTargetKey: 'acpBackend:review-bot',
            fallbackTarget: {
                kind: 'builtInAgent',
                agentId: 'claude',
            },
        })).toEqual({
            agentType: 'claude',
            backendTarget: JSON.stringify({
                kind: 'backend',
                backendId: 'claude',
                sourceKind: 'built_in',
            }),
            backendTargetKey: 'backend:claude',
        });
    });

    it('serializes configured ACP targets using the canonical V2 route contract', () => {
        expect(buildBackendTargetRouteParams({
            agentType: 'customAcp',
            backendTarget: JSON.stringify({ kind: 'configuredAcpBackend', backendId: 'review-bot' }),
            backendTargetKey: 'acpBackend:review-bot',
            fallbackTarget: {
                kind: 'configuredAcpBackend',
                backendId: 'review-bot',
            },
        })).toEqual({
            backendTarget: JSON.stringify({
                kind: 'backend',
                backendId: 'review-bot',
                configuredBackendId: 'review-bot',
                sourceKind: 'configured',
            }),
            backendTargetKey: 'backend:review-bot:configured:review-bot',
        });
    });

    it('accepts canonical V2 route params while returning the legacy compatibility target shape', () => {
        expect(resolveBackendTargetFromRouteParams({
            backendTarget: JSON.stringify({
                kind: 'backend',
                backendId: 'review-bot',
                configuredBackendId: 'review-bot',
                sourceKind: 'configured',
            }),
            backendTargetKey: 'backend:review-bot:configured:review-bot',
        })).toEqual({
            kind: 'configuredAcpBackend',
            backendId: 'review-bot',
        });
    });
});
