import { describe, expect, it } from 'vitest';

import type { FeatureDecision } from '@happier-dev/protocol/features/decision';

import { resolveWorkflowsDestinationAccess } from './workflowsDestinationAccess';

function decision(
    featureId: 'workflows',
    state: FeatureDecision['state'],
    blockedBy: FeatureDecision['blockedBy'] = null,
    extra: Partial<FeatureDecision> = {},
): FeatureDecision {
    return {
        featureId,
        state,
        blockedBy,
        blockerCode: state === 'enabled' ? 'none' : 'feature_disabled',
        diagnostics: [],
        evaluatedAt: 0,
        scope: { scopeKind: 'runtime' },
        ...extra,
    };
}

describe('resolveWorkflowsDestinationAccess', () => {
    it('opens the whole destination only on the enabled Workflows decision', () => {
        expect(resolveWorkflowsDestinationAccess({
            workflows: decision('workflows', 'enabled'),
        })).toEqual({ kind: 'workflows', discoverable: true });
    });

    it('does not mount a second destination when Workflows is disabled', () => {
        expect(resolveWorkflowsDestinationAccess({
            workflows: decision('workflows', 'disabled', 'server'),
        })).toEqual({ kind: 'unavailable', discoverable: false });
    });

    it('lists a destination disabled only by local policy so its repair stays reachable', () => {
        expect(resolveWorkflowsDestinationAccess({
            workflows: decision('workflows', 'disabled', 'local_policy'),
        })).toEqual({ kind: 'locallyDisabled', discoverable: true });
    });

    it('never enables discovery from an unknown or missing bit', () => {
        expect(resolveWorkflowsDestinationAccess({
            workflows: decision('workflows', 'unknown', 'server'),
        })).toEqual({ kind: 'unavailable', discoverable: false });
        expect(resolveWorkflowsDestinationAccess({
            workflows: decision('workflows', 'unsupported', 'server', { blockerCode: 'endpoint_missing' }),
        })).toEqual({ kind: 'unavailable', discoverable: false });
    });

    it('waits, undiscovered, until the Workflows decision resolves', () => {
        expect(resolveWorkflowsDestinationAccess({ workflows: null }))
            .toEqual({ kind: 'resolving', discoverable: false });
    });
});
