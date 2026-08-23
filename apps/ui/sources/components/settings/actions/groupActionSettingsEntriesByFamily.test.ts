import { describe, expect, it } from 'vitest';

import type { ActionSettingsEntry } from './buildActionSettingsEntries';
import { groupActionSettingsEntriesByFamily } from './groupActionSettingsEntriesByFamily';

function entry(actionId: string, title: string): ActionSettingsEntry {
    return {
        kind: 'host',
        actionId: actionId as Extract<ActionSettingsEntry, { kind: 'host' }>['actionId'],
        title,
        description: null,
        enabled: true,
        targets: [],
    };
}

describe('groupActionSettingsEntriesByFamily', () => {
    it('groups entries into ordered family sections with runtime families first', () => {
        const sections = groupActionSettingsEntriesByFamily([
            entry('memory.search', 'Search memory'),
            entry('browser.navigate', 'Navigate browser'),
            entry('devices.simulator.input.tap', 'Tap simulator'),
            entry('browser.reload', 'Reload browser'),
        ]);

        const families = sections.map((section) => section.family);
        expect(families).toEqual(['browser', 'simulator', 'general']);
        // Browser section keeps both browser entries.
        const browser = sections.find((section) => section.family === 'browser')!;
        expect(browser.entries.map((candidate) => candidate.actionId)).toEqual(['browser.navigate', 'browser.reload']);
    });

    it('omits empty families and never emits a section with zero entries', () => {
        const sections = groupActionSettingsEntriesByFamily([entry('session.stop', 'Stop session')]);
        expect(sections).toHaveLength(1);
        expect(sections[0]!.family).toBe('session');
        expect(sections.every((section) => section.entries.length > 0)).toBe(true);
    });

    it('returns no sections for an empty entry list', () => {
        expect(groupActionSettingsEntriesByFamily([])).toEqual([]);
    });
});
