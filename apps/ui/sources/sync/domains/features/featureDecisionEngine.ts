import { createFeatureDecision, type FeatureDecision, type FeatureId } from '@happier-dev/protocol';

export type FeatureDecisionInput = Readonly<{
    featureId: FeatureId;
    supportsClient: boolean;
    buildPolicy: 'allow' | 'deny' | 'neutral';
    localPolicyEnabled: boolean;
    serverSupported: boolean;
    serverEnabled: boolean;
}>;

export function evaluateFeatureDecision(input: FeatureDecisionInput): FeatureDecision {
    const base = {
        featureId: input.featureId,
        diagnostics: [] as string[],
        evaluatedAt: Date.now(),
        scope: { scopeKind: 'runtime' as const },
    };

    if (!input.supportsClient) {
        return createFeatureDecision({
            ...base,
            state: 'disabled',
            blockedBy: 'client',
            blockerCode: 'not_implemented',
        });
    }

    if (input.buildPolicy === 'deny') {
        return createFeatureDecision({
            ...base,
            state: 'disabled',
            blockedBy: 'build_policy',
            blockerCode: 'build_disabled',
        });
    }

    if (!input.localPolicyEnabled) {
        return createFeatureDecision({
            ...base,
            state: 'disabled',
            blockedBy: 'local_policy',
            blockerCode: 'flag_disabled',
        });
    }

    if (!input.serverSupported) {
        return createFeatureDecision({
            ...base,
            state: 'unsupported',
            blockedBy: 'server',
            blockerCode: 'endpoint_missing',
        });
    }

    if (!input.serverEnabled) {
        return createFeatureDecision({
            ...base,
            state: 'disabled',
            blockedBy: 'server',
            blockerCode: 'feature_disabled',
        });
    }

    return createFeatureDecision({
        ...base,
        state: 'enabled',
        blockedBy: null,
        blockerCode: 'none',
    });
}
