import { describe, expect, it } from 'vitest';
import { SUPPORTED_LANGUAGE_CODES, preloadTranslations, setPreferredLanguageFromSettings } from '@/text';

import {
    SESSION_COMPOSER_BANNER_KINDS,
    isSessionComposerBannerKind,
} from './composerBannerKinds';
import {
    buildCollapsedComposerBannerBadge,
    buildComposerBannerHideAction,
    isComposerBannerCollapsedInRecord,
    normalizeComposerBannerCollapseRecord,
    planComposerBannerCollapseToggle,
    resolveComposerBannerCollapseState,
    toggleComposerBannerCollapsedInRecord,
} from './composerBannerCollapse';

describe('composer banner per-kind default', () => {
    it('opens a default-closed kind only after its chip is pressed, and closes it again (owner 11-16 F4)', () => {
        expect(isComposerBannerCollapsedInRecord({}, 'cliVersionOutdated')).toBe(true);
        const opened = toggleComposerBannerCollapsedInRecord({}, 'cliVersionOutdated');
        expect(isComposerBannerCollapsedInRecord(opened, 'cliVersionOutdated')).toBe(false);
        expect(isComposerBannerCollapsedInRecord(toggleComposerBannerCollapsedInRecord(opened, 'cliVersionOutdated'), 'cliVersionOutdated')).toBe(true);
        // Default-open kinds keep their stored meaning: a present key is collapsed.
        expect(isComposerBannerCollapsedInRecord({}, 'staleSessionRunner')).toBe(false);
        expect(isComposerBannerCollapsedInRecord({ staleSessionRunner: true }, 'staleSessionRunner')).toBe(true);
    });
});

describe('composer banner kinds', () => {
    it('recognizes registered kinds and rejects everything else', () => {
        for (const kind of SESSION_COMPOSER_BANNER_KINDS) {
            expect(isSessionComposerBannerKind(kind)).toBe(true);
        }
        expect(isSessionComposerBannerKind('nope')).toBe(false);
        expect(isSessionComposerBannerKind('')).toBe(false);
        expect(isSessionComposerBannerKind(null)).toBe(false);
        expect(isSessionComposerBannerKind(7)).toBe(false);
    });

    it('keeps kind ids unique so persisted records cannot collide', () => {
        expect(new Set(SESSION_COMPOSER_BANNER_KINDS).size).toBe(SESSION_COMPOSER_BANNER_KINDS.length);
    });
});

describe('isComposerBannerCollapsedInRecord', () => {
    it('treats a missing or explicitly false entry as expanded', () => {
        expect(isComposerBannerCollapsedInRecord(null, 'usageLimitRecovery')).toBe(false);
        expect(isComposerBannerCollapsedInRecord(undefined, 'usageLimitRecovery')).toBe(false);
        expect(isComposerBannerCollapsedInRecord({}, 'usageLimitRecovery')).toBe(false);
        expect(isComposerBannerCollapsedInRecord({ usageLimitRecovery: false }, 'usageLimitRecovery')).toBe(false);
    });

    it('treats a true entry as collapsed without leaking across kinds', () => {
        const record = { usageLimitRecovery: true };
        expect(isComposerBannerCollapsedInRecord(record, 'usageLimitRecovery')).toBe(true);
        expect(isComposerBannerCollapsedInRecord(record, 'staleSessionRunner')).toBe(false);
    });
});

describe('toggleComposerBannerCollapsedInRecord', () => {
    it('collapses an expanded kind without mutating the input record', () => {
        const record = Object.freeze({ staleSessionRunner: true });
        const next = toggleComposerBannerCollapsedInRecord(record, 'usageLimitRecovery');

        expect(next).toEqual({ staleSessionRunner: true, usageLimitRecovery: true });
        expect(record).toEqual({ staleSessionRunner: true });
    });

    it('removes the entry when re-expanding instead of storing false', () => {
        const next = toggleComposerBannerCollapsedInRecord(
            { usageLimitRecovery: true, staleSessionRunner: true },
            'usageLimitRecovery',
        );

        expect(Object.prototype.hasOwnProperty.call(next, 'usageLimitRecovery')).toBe(false);
        expect(next).toEqual({ staleSessionRunner: true });
    });

    it('drops unregistered and non-collapsed entries while writing', () => {
        const next = toggleComposerBannerCollapsedInRecord(
            { retiredBannerKind: true, staleSessionRunner: false },
            'usageLimitRecovery',
        );

        expect(next).toEqual({ usageLimitRecovery: true });
    });
});

describe('normalizeComposerBannerCollapseRecord', () => {
    it('keeps only registered kinds that are actually collapsed', () => {
        expect(normalizeComposerBannerCollapseRecord({
            usageLimitRecovery: true,
            staleSessionRunner: false,
            retiredBannerKind: true,
        })).toEqual({ usageLimitRecovery: true });
    });

    it('normalizes missing input to an empty record', () => {
        expect(normalizeComposerBannerCollapseRecord(null)).toEqual({});
        expect(normalizeComposerBannerCollapseRecord(undefined)).toEqual({});
    });
});

describe('resolveComposerBannerCollapseState', () => {
    it('reads the ephemeral record while the remember setting is off', () => {
        expect(resolveComposerBannerCollapseState({
            remember: false,
            persisted: { usageLimitRecovery: true },
            ephemeral: { staleSessionRunner: true },
        })).toEqual({ staleSessionRunner: true });
    });

    it('reads the persisted record while the remember setting is on', () => {
        expect(resolveComposerBannerCollapseState({
            remember: true,
            persisted: { usageLimitRecovery: true },
            ephemeral: { staleSessionRunner: true },
        })).toEqual({ usageLimitRecovery: true });
    });

    it('ignores persisted entries for kinds that are no longer registered', () => {
        expect(resolveComposerBannerCollapseState({
            remember: true,
            persisted: { retiredBannerKind: true },
            ephemeral: {},
        })).toEqual({});
    });
});

describe('planComposerBannerCollapseToggle', () => {
    it('never writes device storage while the remember setting is off', () => {
        const plan = planComposerBannerCollapseToggle({
            remember: false,
            persisted: {},
            ephemeral: {},
            kind: 'usageLimitRecovery',
        });

        expect(plan.persisted).toBeNull();
        expect(plan.ephemeral).toEqual({ usageLimitRecovery: true });
    });

    it('never touches ephemeral state while the remember setting is on', () => {
        const plan = planComposerBannerCollapseToggle({
            remember: true,
            persisted: {},
            ephemeral: {},
            kind: 'usageLimitRecovery',
        });

        expect(plan.ephemeral).toBeNull();
        expect(plan.persisted).toEqual({ usageLimitRecovery: true });
    });

    it('re-expands from the persisted record without clearing sibling kinds', () => {
        const plan = planComposerBannerCollapseToggle({
            remember: true,
            persisted: { usageLimitRecovery: true, staleSessionRunner: true },
            ephemeral: {},
            kind: 'staleSessionRunner',
        });

        expect(plan.persisted).toEqual({ usageLimitRecovery: true });
    });

    it('leaves the persisted record intact when toggling with the setting off', () => {
        const persisted = { usageLimitRecovery: true };
        const plan = planComposerBannerCollapseToggle({
            remember: false,
            persisted,
            ephemeral: {},
            kind: 'usageLimitRecovery',
        });

        expect(plan.persisted).toBeNull();
        expect(persisted).toEqual({ usageLimitRecovery: true });
    });
});

describe('collapsible banner: banner or chip, one at a time', () => {
    const badge = { key: 'stale-session-runner', label: 'Runner update', tone: 'warning' as const };

    it('withholds the chip while the banner is expanded', () => {
        expect(buildCollapsedComposerBannerBadge({
            collapsed: false,
            badge,
            statusLabel: 'Runner outdated',
            expandHint: 'Show banner',
        })).toBeNull();
    });

    it('stands the chip in for a collapsed banner without dropping the status text', () => {
        expect(buildCollapsedComposerBannerBadge({
            collapsed: true,
            badge,
            statusLabel: 'Runner outdated',
            expandHint: 'Show banner',
        })).toEqual({
            ...badge,
            accessibilityLabel: 'Runner outdated',
            accessibilityHint: 'Show banner',
            accessibilityState: { expanded: false },
        });
    });

    it('gives the expanded banner a quiet Hide that runs the same toggle', () => {
        const toggle = () => {};
        expect(buildComposerBannerHideAction({
            bannerTestID: 'session-staleRunner-version',
            accessibilityLabel: 'Hide stale runner banner',
            onPress: toggle,
        })).toEqual(expect.objectContaining({
            testID: 'session-staleRunner-version-hide',
            accessibilityLabel: 'Hide stale runner banner',
            variant: 'quiet',
            onPress: toggle,
        }));
    });
});

describe('the banner Hide action', () => {
    it('reads a translated word in every language, never its key', async () => {
        for (const language of SUPPORTED_LANGUAGE_CODES) {
            await preloadTranslations(language as never);
            setPreferredLanguageFromSettings(language);
            const label = buildComposerBannerHideAction({ bannerTestID: 'b', accessibilityLabel: 'a', onPress: () => {} }).label;
            expect(label, language).not.toBe('common.hide');
            expect(label.length, language).toBeGreaterThan(0);
        }
    });
});
