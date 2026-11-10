import { describe, expect, it } from 'vitest';

import {
    resolveSessionSwitcherDirectionalEntries,
    resolveSessionSwitcherFlickTarget,
    resolveSessionSwitcherRecentPool,
    resolveSessionSwitcherVerticalEntries,
} from './sessionSwitcherOrder';

const keys = (entries: readonly { key: string }[]) => entries.map((entry) => entry.key);

describe('session switcher order sources', () => {
    const list = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'];

    it('swipe sideways in list order: next lies further down the list, nearest first; previous is mirrored', () => {
        const next = resolveSessionSwitcherDirectionalEntries({
            source: 'list', direction: 'next', currentKey: 's4', listSessionKeys: list, pool: [],
        });
        const previous = resolveSessionSwitcherDirectionalEntries({
            source: 'list', direction: 'previous', currentKey: 's4', listSessionKeys: list, pool: [],
        });
        expect(keys(next)).toEqual(['s5', 's6', 's7']);
        expect(keys(previous)).toEqual(['s3', 's2', 's1']);
        expect(next.every((entry) => entry.section === 'list')).toBe(true);
    });

    it('lists each Session once when the list shows it twice (Needs you and its own group)', () => {
        // The Sessions list repeats a Session that needs you; the switcher's rows must not (device 11-10:
        // duplicate keys and the current Session offered as its own "next").
        const repeated = ['s2', 's4', 's1', 's2', 's3', 's4', 's5'];
        const next = resolveSessionSwitcherDirectionalEntries({
            source: 'list', direction: 'next', currentKey: 's4', listSessionKeys: repeated, pool: [],
        });
        const previous = resolveSessionSwitcherDirectionalEntries({
            source: 'list', direction: 'previous', currentKey: 's4', listSessionKeys: repeated, pool: [],
        });
        expect(keys(next)).toEqual(['s1', 's3', 's5']);
        expect(keys(previous)).toEqual(['s2']);
        expect(keys(resolveSessionSwitcherVerticalEntries({ source: 'list', currentKey: 's4', listSessionKeys: repeated, pool: [] })))
            .toEqual(['s2', 's1', 's3', 's5']);
    });

    it('offers nothing when the current session is not in the captured list (a step must not jump)', () => {
        expect(resolveSessionSwitcherDirectionalEntries({
            source: 'list', direction: 'next', currentKey: 'elsewhere', listSessionKeys: list, pool: [],
        })).toEqual([]);
    });

    it('recent pool: open tabs first by recency when two or more are open, then this device’s recents', () => {
        const pool = resolveSessionSwitcherRecentPool({
            currentKey: 'relay',
            mruSessionKeys: ['relay', 'docs', 'wal', 'fix', 'acme'],
            openTabs: [
                { tabId: 't-prs', sessionKey: null },
                { tabId: 't-fix', sessionKey: 'fix' },
                { tabId: 't-relay', sessionKey: 'relay' },
            ],
        });
        // The open tabs lead (by when their session was last opened; a non-session tab keeps rail order after them),
        // and a session already open as a tab is never listed twice.
        expect(keys(pool)).toEqual(['tab:t-relay', 'tab:t-fix', 'tab:t-prs', 'docs', 'wal', 'acme']);
        expect(pool.map((entry) => entry.section)).toEqual(['openTabs', 'openTabs', 'openTabs', 'recent', 'recent', 'recent']);
    });

    it('recent pool without tabs: the current one leads even before the device has recorded it', () => {
        const pool = resolveSessionSwitcherRecentPool({
            currentKey: 'new', mruSessionKeys: ['docs', 'wal'], openTabs: [{ tabId: 't1', sessionKey: 'docs' }],
        });
        expect(keys(pool)).toEqual(['new', 'docs', 'wal']);
    });

    it('drag up lists everything but the current one, nearest the bar = most recent; list source follows the list', () => {
        const pool = resolveSessionSwitcherRecentPool({ currentKey: 's2', mruSessionKeys: ['s2', 's5', 's1'], openTabs: [] });
        expect(keys(resolveSessionSwitcherVerticalEntries({ source: 'recent', currentKey: 's2', listSessionKeys: list, pool })))
            .toEqual(['s5', 's1']);
        expect(keys(resolveSessionSwitcherVerticalEntries({ source: 'list', currentKey: 's2', listSessionKeys: list, pool })))
            .toEqual(['s1', 's3', 's4', 's5', 's6', 's7']);
    });

    it('swipe sideways in recent order: next = further back in time, previous = more recent', () => {
        const pool = resolveSessionSwitcherRecentPool({ currentKey: 'b', mruSessionKeys: ['a', 'b', 'c', 'd'], openTabs: [] });
        expect(keys(resolveSessionSwitcherDirectionalEntries({ source: 'recent', direction: 'next', currentKey: 'b', listSessionKeys: [], pool })))
            .toEqual(['c', 'd']);
        expect(keys(resolveSessionSwitcherDirectionalEntries({ source: 'recent', direction: 'previous', currentKey: 'b', listSessionKeys: [], pool })))
            .toEqual(['a']);
    });

    it('flicks walk a frozen order: open tabs cycle, recents stop at the ends', () => {
        expect(resolveSessionSwitcherFlickTarget({ length: 4, fromIndex: 0, direction: 'next', cycle: false })).toBe(1);
        expect(resolveSessionSwitcherFlickTarget({ length: 4, fromIndex: 3, direction: 'next', cycle: false })).toBeNull();
        expect(resolveSessionSwitcherFlickTarget({ length: 4, fromIndex: 0, direction: 'previous', cycle: false })).toBeNull();
        expect(resolveSessionSwitcherFlickTarget({ length: 4, fromIndex: 3, direction: 'next', cycle: true })).toBe(0);
        expect(resolveSessionSwitcherFlickTarget({ length: 4, fromIndex: 0, direction: 'previous', cycle: true })).toBe(3);
        expect(resolveSessionSwitcherFlickTarget({ length: 1, fromIndex: 0, direction: 'next', cycle: true })).toBeNull();
    });
});
