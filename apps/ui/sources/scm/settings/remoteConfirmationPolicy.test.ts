import { describe, expect, it } from 'vitest';

import {
    setRemoteConfirmationForKind,
    shouldConfirmRemoteOperation,
} from './remoteConfirmationPolicy';
import type { ScmRemoteConfirmPolicy } from './preferences';

describe('remoteConfirmationPolicy', () => {
    it.each([
        ['always', true, true],
        ['pull_only', true, false],
        ['push_only', false, true],
        ['never', false, false],
    ] as const)('maps %s to pull=%s push=%s', (policy, confirmsPull, confirmsPush) => {
        expect(shouldConfirmRemoteOperation(policy, 'pull')).toBe(confirmsPull);
        expect(shouldConfirmRemoteOperation(policy, 'push')).toBe(confirmsPush);
    });

    it.each([
        ['always', 'pull', false, 'push_only'],
        ['always', 'push', false, 'pull_only'],
        ['push_only', 'push', false, 'never'],
        ['pull_only', 'pull', false, 'never'],
        ['never', 'pull', true, 'pull_only'],
        ['never', 'push', true, 'push_only'],
        ['pull_only', 'push', true, 'always'],
        ['push_only', 'pull', true, 'always'],
    ] as const)('sets %s %s confirmation to %s as %s', (policy, kind, enabled, expected) => {
        expect(setRemoteConfirmationForKind(policy, kind, enabled)).toBe(expected);
    });

    it('falls back to always for unknown stored values', () => {
        const policy = 'legacy_value' as ScmRemoteConfirmPolicy;

        expect(shouldConfirmRemoteOperation(policy, 'pull')).toBe(true);
        expect(setRemoteConfirmationForKind(policy, 'push', false)).toBe('pull_only');
    });
});
