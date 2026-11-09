import { describe, expect, it } from 'vitest';

import { resolveWorkflowsFeature } from './workflowsFeature';

describe('resolveWorkflowsFeature', () => {
    it('advertises approved Workflow activation by default', () => {
        expect(resolveWorkflowsFeature({} as NodeJS.ProcessEnv).features?.workflows).toEqual({ enabled: true });
    });

    it('supports an explicit operator opt-out', () => {
        expect(resolveWorkflowsFeature({ HAPPIER_FEATURE_WORKFLOWS__ENABLED: '0' } as NodeJS.ProcessEnv).features?.workflows)
            .toEqual({ enabled: false });
    });

    it('accepts the released Automations env alias only when the canonical value is unset', () => {
        expect(resolveWorkflowsFeature({ HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '0' }).features?.workflows)
            .toEqual({ enabled: false });
        expect(resolveWorkflowsFeature({
            HAPPIER_FEATURE_WORKFLOWS__ENABLED: '1',
            HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '0',
        }).features?.workflows).toEqual({ enabled: true });
    });
});
