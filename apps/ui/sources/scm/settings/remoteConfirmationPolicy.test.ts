import { describe, expect, it } from 'vitest';

import {
    setRemoteConfirmationForKind,
    shouldConfirmRemoteOperation,
} from './remoteConfirmationPolicy';

describe('remoteConfirmationPolicy', () => {
    it('supports independent pull and push confirmation decisions', () => {
        expect(shouldConfirmRemoteOperation('always', 'pull')).toBe(true);
        expect(shouldConfirmRemoteOperation('always', 'push')).toBe(true);

        expect(shouldConfirmRemoteOperation('pull_only', 'pull')).toBe(true);
        expect(shouldConfirmRemoteOperation('pull_only', 'push')).toBe(false);

        expect(shouldConfirmRemoteOperation('push_only', 'pull')).toBe(false);
        expect(shouldConfirmRemoteOperation('push_only', 'push')).toBe(true);

        expect(shouldConfirmRemoteOperation('never', 'pull')).toBe(false);
        expect(shouldConfirmRemoteOperation('never', 'push')).toBe(false);
    });

    it('updates only the requested operation while preserving the other operation', () => {
        expect(setRemoteConfirmationForKind('always', 'push', false)).toBe('pull_only');
        expect(setRemoteConfirmationForKind('push_only', 'push', false)).toBe('never');
        expect(setRemoteConfirmationForKind('never', 'push', true)).toBe('push_only');
        expect(setRemoteConfirmationForKind('pull_only', 'push', true)).toBe('always');

        expect(setRemoteConfirmationForKind('always', 'pull', false)).toBe('push_only');
        expect(setRemoteConfirmationForKind('pull_only', 'pull', false)).toBe('never');
        expect(setRemoteConfirmationForKind('never', 'pull', true)).toBe('pull_only');
        expect(setRemoteConfirmationForKind('push_only', 'pull', true)).toBe('always');
    });
});
