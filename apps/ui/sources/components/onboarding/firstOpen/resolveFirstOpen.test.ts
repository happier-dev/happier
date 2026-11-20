import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { onboardingAuthHistoryState, onboardingHistoryState, recordOpeningSeen } from '@/sync/domains/state/onboardingUiState';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';

import { resolveFirstOpen } from './resolveFirstOpen';

const welcome = { accountRestored: false, segments: ['(app)', 'index'] } as const;

describe('first-open admission', () => {
    beforeEach(() => {
        replacePersistentUiStateForTest(onboardingHistoryState, {});
        replacePersistentUiStateForTest(onboardingAuthHistoryState, {});
        setReducedMotionPreferenceOverride(false);
    });

    afterEach(() => {
        setReducedMotionPreferenceOverride(null);
        vi.restoreAllMocks();
    });

    it('admits the fresh welcome and selects Still when reduced motion is requested', () => {
        expect(resolveFirstOpen(welcome)).toBe('in-app');
        setReducedMotionPreferenceOverride(true);
        expect(resolveFirstOpen(welcome)).toBe('reduced');
    });

    it.each([
        ['(app)', 'teams', '[teamId]', 'sign-in'],
        ['(app)', 'join', '[token]'],
        ['(app)', 'terminal', 'connect'],
        ['(app)', 'terminal', 'index'],
    ].map(segments => ({ segments })))('builds a link in-app even with a desktop overlay candidate ($segments)', ({ segments }) => {
        expect(resolveFirstOpen({ ...welcome, segments, desktopCandidate: 'overlay' })).toBe('in-app');
    });

    it('selects an overlay for a desktop candidate on the fresh welcome only', () => {
        expect(resolveFirstOpen({ ...welcome, desktopCandidate: 'overlay' })).toBe('overlay-eligible');
        expect(resolveFirstOpen({ ...welcome, segments: ['settings'], desktopCandidate: 'overlay' })).toBe('none');
    });

    it('does no device-history reads after the boot restores an Account', () => {
        const reads = vi.spyOn(getPersistenceStorage(), 'getString');
        expect(resolveFirstOpen({ ...welcome, accountRestored: true })).toBe('none');
        expect(reads).not.toHaveBeenCalled();
    });

    it('does no opening-history reads on a desktop launch without a native candidate', () => {
        const reads = vi.spyOn(onboardingHistoryState, 'read');
        expect(resolveFirstOpen({ ...welcome, desktopCandidate: null })).toBe('none');
        expect(reads).not.toHaveBeenCalled();
    });

    it('firstOpen.02.F3 reads only the opening marker on a later signed-out boot', () => {
        recordOpeningSeen(100);
        const reads = vi.spyOn(onboardingHistoryState, 'read');
        const authReads = vi.spyOn(onboardingAuthHistoryState, 'read');
        expect(resolveFirstOpen(welcome)).toBe('none');
        expect(reads.mock.calls).toEqual([['openingSeenAt']]);
        expect(authReads).not.toHaveBeenCalled();
    });

    it('carries forward both forms of legacy first-run history', () => {
        onboardingHistoryState.set('brandHeroSeenAt', 100);
        expect(resolveFirstOpen(welcome)).toBe('none');
        onboardingHistoryState.remove('brandHeroSeenAt');
        onboardingAuthHistoryState.set('completed', true);
        expect(resolveFirstOpen(welcome)).toBe('none');
    });
});
