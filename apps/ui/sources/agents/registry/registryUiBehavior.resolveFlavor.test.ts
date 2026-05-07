import { describe, expect, it } from 'vitest';

import { resolveAgentUiBehaviorFromFlavor } from './registryUiBehavior';

describe('resolveAgentUiBehaviorFromFlavor', () => {
    it('resolves provider behavior through shared flavor aliases', () => {
        const behavior = resolveAgentUiBehaviorFromFlavor('open-code');

        expect(behavior?.directSessions?.browse?.getSourceOptions).toBeTypeOf('function');
    });

    it('keeps codex-specific permission footer overrides on the native codex agent', () => {
        const behavior = resolveAgentUiBehaviorFromFlavor('codex');

        expect(behavior?.permissions?.footer?.stopHandling).toBe('denyOnly');
        expect(behavior?.permissions?.footer?.supportsExecPolicyAmendment).toBe(true);
        expect(behavior?.sessionUsage?.supportsExactContextUsageBadge).toBe(false);
    });

    it('uses the generic codex-decision footer behavior for opencode-family flavors', () => {
        const behavior = resolveAgentUiBehaviorFromFlavor('open-code');

        expect(behavior?.permissions?.footer?.stopHandling).toBe('denyAndAbortRun');
        expect(behavior?.permissions?.footer?.supportsExecPolicyAmendment).toBe(false);
        expect(behavior?.sessionUsage?.supportsExactContextUsageBadge).toBe(true);
    });
});
