import { describe, expect, it } from 'vitest';
import { parseDownloadStats } from './DownloadStats';
import { parseDiscordStats } from './DiscordMembers';
import { splitRollParts } from './RollingNumber';
import { formatStatCount } from './publicStats';

describe('public stat counters', () => {
    // The counters are read by whoever loads the page, so grouping follows the
    // visitor's locale rather than a hardcoded en-US. Pinned locales here because
    // the runtime default is the machine's, which would make this non-deterministic.
    it('groups a public total the way the reader’s locale does', () => {
        expect(formatStatCount(35020, 'en-US')).toBe('35,020');
        expect(formatStatCount(35020, 'de-DE')).toBe('35.020');

        // Swiss grouping is an apostrophe rather than a comma, but the exact code
        // point has moved between ICU versions, so pin the property that matters:
        // the separator follows the locale instead of a hardcoded en-US comma.
        const swiss = formatStatCount(35020, 'de-CH');
        expect(swiss).not.toContain(',');
        expect(swiss.replace(/\D/g, '')).toBe('35020');

        expect(formatStatCount(488, 'de-CH')).toBe('488');
    });

    // The whole rolling effect rests on this: digit columns are keyed by place
    // value from the right, so when the digit count changes the ones column stays
    // the ones column and rolls, instead of re-keying and reshuffling the row. An
    // index-from-the-left implementation would key the ones digit 'd1' in "99" and
    // 'd2' in "100" — React would unmount and remount every column.
    it('keys digit columns by place value so a digit-count change still rolls', () => {
        const two = splitRollParts('99');
        const three = splitRollParts('100');

        expect(two.map((p) => p.key)).toEqual(['d1', 'd0']);
        expect(three.map((p) => p.key)).toEqual(['d2', 'd1', 'd0']);

        const onesOf = (parts: ReturnType<typeof splitRollParts>) => parts[parts.length - 1];
        expect(onesOf(two).key).toBe(onesOf(three).key);
    });

    it('renders grouping separators as static glyphs, not digit columns', () => {
        expect(splitRollParts('1,004')).toEqual([
            { kind: 'digit', key: 'd3', digit: 1 },
            { kind: 'static', key: 's1', char: ',' },
            { kind: 'digit', key: 'd2', digit: 0 },
            { kind: 'digit', key: 'd1', digit: 0 },
            { kind: 'digit', key: 'd0', digit: 4 },
        ]);
    });

    it('accepts the minimal public download payload', () => {
        expect(parseDownloadStats({ totalDownloads: 21791 })).toEqual({ totalDownloads: 21791 });
        expect(parseDownloadStats({ totalDownloads: -1 })).toBeNull();
        expect(parseDownloadStats({ totalDownloads: '21791' })).toBeNull();
    });

    // Published stats are third-party input to the bundle: a malformed document
    // must leave the compiled-in fallback standing rather than render NaN.
    it('accepts the minimal public Discord payload and rejects malformed counts', () => {
        expect(parseDiscordStats({ memberCount: 478, presenceCount: 56 })).toEqual({ memberCount: 478 });
        expect(parseDiscordStats({ memberCount: -1 })).toBeNull();
        expect(parseDiscordStats({ memberCount: '478' })).toBeNull();
        expect(parseDiscordStats({ memberCount: Number.NaN })).toBeNull();
        expect(parseDiscordStats({})).toBeNull();
        expect(parseDiscordStats(null)).toBeNull();
    });
});
