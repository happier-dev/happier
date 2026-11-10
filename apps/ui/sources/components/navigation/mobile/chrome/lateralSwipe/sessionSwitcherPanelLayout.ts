/**
 * Where everything in the switcher panel sits. The list grows UP from the bar: the nearest row is
 * at the bottom, further rows above it, and each section's heading above its rows — so every
 * offset here is measured from the list's bottom edge, the unit the scrub and the reveal use.
 */

import type { SessionSwitcherSection, SessionSwitcherSource } from '@/sync/domains/session/navigation/sessionSwitcherOrder';

import type { SessionSwitcherRow } from './sessionSwitcherRows';
import type { SessionSwitcherMode } from './useSessionSwitcher';

/** One row: the title line (name, status glyph, when) over one line of status or draft. */
export const SESSION_SWITCHER_ROW_HEIGHT = 48;
const HEADER_HEIGHT = 24;
/** The docked panel's "Switch to" title row; the list viewport sits beneath it. */
export const SESSION_SWITCHER_DOCKED_HEADER_HEIGHT = 44;
const END_NOTE_HEIGHT = 60;
/** Breathing room at the list's top and bottom, inside the panel. */
export const SESSION_SWITCHER_LIST_INSET = 8;

export type SessionSwitcherHeading =
    | 'openTabs' | 'recent' | 'recentOnThisDevice' | 'sessions'
    | 'nextInSessions' | 'previousInSessions' | 'furtherBack' | 'moreRecent';

export type SessionSwitcherPanelItem =
    | Readonly<{ kind: 'row'; key: string; row: SessionSwitcherRow; index: number; bottom: number }>
    /** Where you are, in the sideways panel: index -1, "Here". */
    | Readonly<{ kind: 'here'; key: string; row: SessionSwitcherRow; bottom: number }>
    | Readonly<{ kind: 'heading'; key: string; heading: SessionSwitcherHeading; synced: boolean; bottom: number }>
    | Readonly<{ kind: 'end'; key: string; direction: 'next' | 'previous'; source: SessionSwitcherSource; bottom: number }>;

export type SessionSwitcherPanelLayout = Readonly<{
    items: readonly SessionSwitcherPanelItem[];
    /** Bottom offset of each selectable row by index; `-1` is stored at position 0 as the Here row when present. */
    rowBottoms: readonly number[];
    hereBottom: number | null;
    contentHeight: number;
}>;

function headingFor(section: SessionSwitcherSection, hasOpenTabs: boolean): SessionSwitcherHeading {
    if (section === 'openTabs') return 'openTabs';
    if (section === 'list') return 'sessions';
    return hasOpenTabs ? 'recent' : 'recentOnThisDevice';
}

export function layoutSessionSwitcherPanel(params: Readonly<{
    mode: SessionSwitcherMode;
    rows: readonly SessionSwitcherRow[];
    current: SessionSwitcherRow | null;
    source: SessionSwitcherSource;
    syncOn: boolean;
}>): SessionSwitcherPanelLayout {
    const items: SessionSwitcherPanelItem[] = [];
    const rowBottoms: number[] = [];
    let y = SESSION_SWITCHER_LIST_INSET;
    let hereBottom: number | null = null;

    if (params.mode !== 'up' && params.current) {
        hereBottom = y;
        items.push({ kind: 'here', key: `here:${params.current.key}`, row: params.current, bottom: y });
        y += SESSION_SWITCHER_ROW_HEIGHT;
    }

    if (params.mode !== 'up') {
        if (params.rows.length === 0) {
            items.push({ kind: 'end', key: 'end', direction: params.mode, source: params.source, bottom: y });
            y += END_NOTE_HEIGHT;
        } else {
            params.rows.forEach((row, index) => {
                rowBottoms.push(y);
                items.push({ kind: 'row', key: row.key, row, index, bottom: y });
                y += SESSION_SWITCHER_ROW_HEIGHT;
            });
            const heading: SessionSwitcherHeading = params.source === 'list'
                ? (params.mode === 'next' ? 'nextInSessions' : 'previousInSessions')
                : (params.mode === 'next' ? 'furtherBack' : 'moreRecent');
            items.push({ kind: 'heading', key: `heading:${heading}`, heading, synced: false, bottom: y });
            y += HEADER_HEIGHT;
        }
        return { items, rowBottoms, hereBottom, contentHeight: y + SESSION_SWITCHER_LIST_INSET };
    }

    const hasOpenTabs = params.rows.some((row) => row.section === 'openTabs');
    params.rows.forEach((row, index) => {
        rowBottoms.push(y);
        items.push({ kind: 'row', key: row.key, row, index, bottom: y });
        y += SESSION_SWITCHER_ROW_HEIGHT;
        const next = params.rows[index + 1];
        if (!next || next.section !== row.section) {
            const heading = headingFor(row.section, hasOpenTabs);
            items.push({ kind: 'heading', key: `heading:${heading}`, heading, synced: row.section === 'openTabs' && params.syncOn, bottom: y });
            y += HEADER_HEIGHT;
        }
    });
    return { items, rowBottoms, hereBottom, contentHeight: y + SESSION_SWITCHER_LIST_INSET };
}
