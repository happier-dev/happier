import { describe, expect, it } from 'vitest';

import { evaluateFeatureDecision } from './featureDecisionEngine';

describe('featureDecisionEngine', () => {
    it('blocks by build policy before local/server checks', () => {
        const result = evaluateFeatureDecision({
            featureId: 'automations',
            scope: { scopeKind: 'runtime' },
            supportsClient: true,
            buildPolicy: 'deny',
            localPolicyEnabled: true,
            serverSupported: true,
            serverEnabled: true,
        });

        expect(result.state).toBe('disabled');
        expect(result.blockedBy).toBe('build_policy');
        expect(result.blockerCode).toBe('build_disabled');
    });

    it('enables only when all required axes pass', () => {
        const result = evaluateFeatureDecision({
            featureId: 'automations',
            scope: { scopeKind: 'runtime' },
            supportsClient: true,
            buildPolicy: 'neutral',
            localPolicyEnabled: true,
            serverSupported: true,
            serverEnabled: true,
        });

        expect(result.state).toBe('enabled');
        expect(result.blockedBy).toBeNull();
        expect(result.blockerCode).toBe('none');
    });

    it('returns unsupported when endpoint is missing', () => {
        const result = evaluateFeatureDecision({
            featureId: 'voice',
            scope: { scopeKind: 'runtime' },
            supportsClient: true,
            buildPolicy: 'neutral',
            localPolicyEnabled: true,
            serverSupported: false,
            serverEnabled: false,
        });

        expect(result.state).toBe('unsupported');
        expect(result.blockedBy).toBe('server');
        expect(result.blockerCode).toBe('endpoint_missing');
    });
});
