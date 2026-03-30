import { describe, expect, it } from 'vitest';

import { describePromptLibraryEntrySubtitle } from './describePromptLibraryEntrySubtitle';

describe('describePromptLibraryEntrySubtitle', () => {
    it('hides raw schema and user origin metadata while keeping friendly import and export details', () => {
        const subtitle = describePromptLibraryEntrySubtitle({
            origin: 'imported',
            linkedTargets: ['Laptop', 'Desktop'],
            labels: {
                imported: 'Imported',
                builtIn: 'Built-in',
                exportsCount: (count) => `${count} exports`,
            },
        });

        expect(subtitle).toBe('Imported · 2 exports · Laptop, Desktop');
    });

    it('omits empty metadata for user-created entries', () => {
        const subtitle = describePromptLibraryEntrySubtitle({
            origin: 'user',
            linkedTargets: [],
            labels: {
                imported: 'Imported',
                builtIn: 'Built-in',
                exportsCount: (count) => `${count} exports`,
            },
        });

        expect(subtitle).toBeUndefined();
    });
});
