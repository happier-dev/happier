import { describe, expect, it } from 'vitest';

import {
    describeTriageSourceFailureV1,
    resolveTriageRowFactStatusToneV1,
    formatTriageCountV1,
    formatTriageTimestampV1,
    projectTriageDetailFieldTextV1,
    projectTriageDetailFieldsV1,
} from './presentation.js';

/**
 * These projections are shared because a per-source copy makes one declared
 * format mean two things in one list. Each case below is written against the
 * declared contract vocabulary, not against a source.
 */

const NOW_MS = Date.UTC(2026, 7, 17, 12, 0, 0);

describe('triage detail presentation', () => {
    it('honours the declared compact number format rather than the plain one', () => {
        // The whole reason this is shared: `compact` is contract vocabulary, so
        // 12,400 is "12.4K" for every source that declares it.
        expect(formatTriageCountV1('en-US', 12_400, 'compact')).toBe('12.4K');
        expect(formatTriageCountV1('en-US', 12_400, 'plain')).toBe('12,400');
    });

    it('never presents a count the source could not promise as exact as a total', () => {
        const approximate = projectTriageDetailFieldTextV1({
            kind: 'number',
            id: 'source/events',
            label: 'Events',
            importance: 'primary',
            value: 12_400,
            format: 'compact',
            approximate: true,
        }, 'en-US', NOW_MS);
        const exact = projectTriageDetailFieldTextV1({
            kind: 'number',
            id: 'source/events',
            label: 'Events',
            importance: 'primary',
            value: 12_400,
            format: 'compact',
            approximate: false,
        }, 'en-US', NOW_MS);

        expect(approximate).toBe('~12.4K');
        expect(exact).toBe('12.4K');
    });

    it('reads a relative timestamp against the reader present it is given, not a hidden clock', () => {
        const fourMinutesAgo = formatTriageTimestampV1(
            'en-US',
            NOW_MS - 4 * 60 * 1000,
            'relative',
            NOW_MS,
        );
        const twoDaysAgo = formatTriageTimestampV1(
            'en-US',
            NOW_MS - 2 * 24 * 60 * 60 * 1000,
            'relative',
            NOW_MS,
        );

        expect(fourMinutesAgo).toBe('4 minutes ago');
        expect(twoDaysAgo).toBe('2 days ago');
        // An absolute format ignores the present entirely.
        expect(formatTriageTimestampV1('en-US', NOW_MS, 'absolute', NOW_MS))
            .not.toMatch(/ago|in /u);
    });

    it('renders a deferred fact as pending rather than as an empty value', () => {
        const [field] = projectTriageDetailFieldsV1([{
            id: 'source/labels',
            importance: 'secondary',
            value: { kind: 'detailOnly' },
        }]);

        expect(field?.kind).toBe('pending');
        // A pending field has no text, which is what stops a body from claiming
        // the provider said nothing about it.
        expect(field === undefined
            ? null
            : projectTriageDetailFieldTextV1(field, 'en-US', NOW_MS)).toBeNull();
    });

    it('keeps the entry and skips only the row when a value arm this build cannot render arrives', () => {
        const fields = projectTriageDetailFieldsV1([
            { id: 'source/known', importance: 'primary', value: { kind: 'text', value: 'kept' } },
            // A future arm reaches an older build exactly like this.
            {
                id: 'source/future',
                importance: 'primary',
                value: { kind: 'sparkline' },
            } as unknown as Parameters<typeof projectTriageDetailFieldsV1>[0][number],
        ]);

        expect(fields).toHaveLength(1);
        expect(fields[0]?.id).toBe('source/known');
    });

    it('prefers the source label vocabulary, then the fact label, then the id', () => {
        const [vocabulary, own, bare] = projectTriageDetailFieldsV1([
            { id: 'source/number', importance: 'primary', value: { kind: 'text', value: '1' } },
            {
                id: 'source/other',
                label: 'Own label',
                importance: 'primary',
                value: { kind: 'text', value: '2' },
            },
            { id: 'source/bare', importance: 'primary', value: { kind: 'text', value: '3' } },
        ], { 'source/number': 'Number' });

        expect(vocabulary?.label).toBe('Number');
        expect(own?.label).toBe('Own label');
        expect(bare?.label).toBe('source/bare');
    });

    it('keeps diagnostic codes out of reader copy, including unknown source codes', () => {
        expect(describeTriageSourceFailureV1(null, 'Could not complete this read.'))
            .toBe('Could not complete this read.');
        expect(describeTriageSourceFailureV1(
            { class: 'authentication', code: 'source/unauthorized' },
            'Could not complete this read.',
        )).toBe('Could not complete this read.');
    });

    it('uses translated typed failure copy with a code-specific translation and a classified fallback', () => {
        const translations: Readonly<Record<string, string>> = {
            'plugins.triage.sourceSettings.failure.authentication': 'Reconnectez cette source.',
            'plugins.triage.sourceFailure.source/scope-missing': 'Choisissez un projet.',
        };
        const translate = (key: string, fallback?: string) => translations[key] ?? fallback ?? key;
        const failure = { class: 'authentication', code: 'source/unauthorized' } as const;
        expect(describeTriageSourceFailureV1(failure, 'Lecture indisponible.', translate))
            .toBe('Reconnectez cette source.');
        expect(describeTriageSourceFailureV1({ class: 'unknown', code: 'source/scope-missing' }, 'Lecture indisponible.', translate))
            .toBe('Choisissez un projet.');
        expect(describeTriageSourceFailureV1({ class: 'unknown', code: 'source/new-failure' }, 'Lecture indisponible.', translate))
            .toBe('Lecture indisponible.');
        expect(failure.code).toBe('source/unauthorized');
    });

    it('provides explicit source-language access guidance without replacing existing localized fallbacks', () => {
        const contextual = 'The source may have applied this change. Reload before trying again.';
        const permission = { class: 'permission', code: 'source/forbidden' } as const;
        const authentication = { class: 'authentication', code: 'source/unauthorized' } as const;
        expect(describeTriageSourceFailureV1(permission, contextual, undefined, 'en')).toContain('Grant it access');
        expect(describeTriageSourceFailureV1(authentication, contextual, undefined, 'en')).toContain('Reconnect');
        expect(describeTriageSourceFailureV1(permission, 'Lecture indisponible.')).toBe('Lecture indisponible.');
        for (const failureClass of ['transient', 'rateLimit', 'unknown'] as const) {
            expect(describeTriageSourceFailureV1({ class: failureClass, code: 'source/confirmation-failed' }, contextual, undefined, 'en'))
                .toBe(contextual);
        }
    });

    it.each(['transient', 'rateLimit', 'unknown'] as const)('preserves an uncertain write warning instead of generic retry advice (%s)', (failureClass) => {
        const warning = 'The source may have applied this change. Reload before trying again.';
        const translate = (key: string, fallback?: string) => key.startsWith('plugins.triage.sourceSettings.failure.')
            ? 'Try this request again.'
            : fallback ?? key;
        expect(describeTriageSourceFailureV1({ class: failureClass, code: 'source/confirmation-failed' }, warning, translate))
            .toBe(warning);
    });

    it('speaks a status fact in the shared status vocabulary: healthy and news stay quiet, a caution needs you, failure is rose', () => {
        expect(resolveTriageRowFactStatusToneV1('success')).toBe('secondary');
        expect(resolveTriageRowFactStatusToneV1('neutral')).toBe('secondary');
        expect(resolveTriageRowFactStatusToneV1('info')).toBe('secondary');
        expect(resolveTriageRowFactStatusToneV1('warning')).toBe('attention');
        expect(resolveTriageRowFactStatusToneV1('danger')).toBe('danger');
    });
});
