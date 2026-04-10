import { describe, expect, it } from 'vitest';

import { parseChangelog, parseChangelogContent } from './parseChangelog';

describe('parseChangelog', () => {
    it('preserves the latest semver release as markdown grouped under its release header', () => {
        const data = parseChangelog();

        expect(data).toEqual(expect.objectContaining({ latestReleaseId: '0.2.1' }));
        expect(data.entries[0]).toEqual(
            expect.objectContaining({
                id: '0.2.1',
                versionLabel: '0.2.1',
                date: '2026-04-05',
            }),
        );

        const markdown = String(((data.entries[0] as unknown as Record<string, unknown>).markdown) ?? '');
        expect(markdown).toContain('## Bug Fixes');
        expect(markdown).toContain('### Claude');
        expect(markdown).not.toContain('## Version 0.2.1 - 2026-04-05');
    });

    it('treats a newly appended semver release as the latest entry and preserves its markdown body', () => {
        const data = parseChangelogContent(`# Changelog

## Version 0.2.2 - 2026-04-10

Short intro paragraph.

## Highlights

- Added a new feature
- Fixed a bug

### Notes

More detail here.

## Version 0.2.1 - 2026-04-05

Previous release body.

- Earlier item
`);

        expect(data.latestReleaseId).toBe('0.2.2');
        expect(data.entries).toHaveLength(2);
        expect(data.entries[0]).toEqual({
            id: '0.2.2',
            versionLabel: '0.2.2',
            date: '2026-04-10',
            markdown: `Short intro paragraph.

## Highlights

- Added a new feature
- Fixed a bug

### Notes

More detail here.`,
        });
        expect(data.entries[1]).toEqual({
            id: '0.2.1',
            versionLabel: '0.2.1',
            date: '2026-04-05',
            markdown: `Previous release body.

- Earlier item`,
        });
    });
});
