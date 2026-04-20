import { describe, expect, it } from 'vitest';

import { AGENTS_UI_BEHAVIOR, CANONICAL_AGENTS_UI_BEHAVIOR, resolveAgentUiBehavior, resolveAgentUiBehaviorFromFlavor } from './registryUiBehavior';

describe('resolveAgentUiBehaviorFromFlavor', () => {
    it('keeps customAcp out of the canonical UI behavior registry (no active UI behavior special-casing)', () => {
        expect(AGENTS_UI_BEHAVIOR).not.toHaveProperty('customAcp');
        expect(CANONICAL_AGENTS_UI_BEHAVIOR).not.toHaveProperty('customAcp');
        expect(resolveAgentUiBehavior('customAcp').newSession?.getAgentInputExtraActionChips).toBeUndefined();
        expect(resolveAgentUiBehavior('customAcp').newSession?.canSelectWithoutDetectedCli).toBeUndefined();
    });

    it('resolves provider behavior through shared flavor aliases', () => {
        const behavior = resolveAgentUiBehaviorFromFlavor('open-code');

        expect(behavior?.directSessions?.browse?.getSourceOptions).toBeTypeOf('function');
    });

    it('keeps codex-specific permission footer overrides on the native codex agent', () => {
        const behavior = resolveAgentUiBehaviorFromFlavor('codex');

        expect(behavior?.permissions?.footer?.stopHandling).toBe('denyOnly');
        expect(behavior?.permissions?.footer?.supportsExecPolicyAmendment).toBe(true);
    });

    it('uses the generic codex-decision footer behavior for opencode flavors', () => {
        const behavior = resolveAgentUiBehaviorFromFlavor('open-code');

        expect(behavior?.permissions?.footer?.stopHandling).toBe('denyAndAbortRun');
        expect(behavior?.permissions?.footer?.supportsExecPolicyAmendment).toBe(false);
    });

    it('uses a neutral fallback for unknown backend/provider ids instead of the custom ACP behavior profile', () => {
        const unknownBehavior = resolveAgentUiBehavior('acme.review.backend');

        expect(unknownBehavior).toBe(resolveAgentUiBehavior('customAcp'));
        expect(unknownBehavior.newSession?.getAgentInputExtraActionChips).toBeUndefined();
        expect(unknownBehavior.newSession?.canSelectWithoutDetectedCli).toBeUndefined();
    });
});
