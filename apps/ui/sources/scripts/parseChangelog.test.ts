import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import bundled from '../changelog/changelog.json';

import { parseChangelog, parseChangelogContent } from './parseChangelog';

describe('parseChangelog', () => {
    it('bundles all authored releases and preserves the legacy semver Markdown', () => {
        const data = parseChangelog();
        expect(bundled).toEqual(data);

        const headings = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8')
            .split('\n').filter((line) => line.startsWith('## Release ') || line.startsWith('## Version '))
            .map((line) => line.slice(3).split(' - ')[0]);
        expect(data.entries.map((entry) => entry.title)).toEqual(headings);
        expect(JSON.stringify(data)).not.toContain('happier-release-note-projections');
        const markdown = data.entries.find((entry) => entry.id === '0.2.1')?.markdown ?? '';
        expect(markdown).toContain('## Bug Fixes');
        expect(markdown).toContain('### Claude');
        expect(markdown).not.toContain('## Version 0.2.1 - 2026-04-05');
    });

    it('preserves same-day source order and full Markdown without exposing comments', () => {
        const data = parseChangelogContent(`# Changelog
## Release 2026-09-29.2 - 2026-09-29
<!-- happier-release-note-projections:v1
{"expo":{"message":"hidden"}}
-->
Intro with **formatting**.
## Highlights
- A [link](https://example.test)
### Details
More text.
<!--
## Release hidden - 2026-09-29
-->
## Release 2026-09-29.1 - 2026-09-29
Earlier release.
## Version 0.2.10 - 2026-05-15
Semver.
## Version 1 - 2026-02-15
Legacy.
`.replace(/\n/g, '\r\n'));

        expect(data.latestReleaseId).toBe('2026-09-29.2');
        expect(data.entries.map((entry) => entry.id)).toEqual(['2026-09-29.2', '2026-09-29.1', '0.2.10', '1']);
        expect(data.entries[0]).toEqual({
            id: '2026-09-29.2', versionLabel: '2026-09-29.2', title: 'Release 2026-09-29.2', date: '2026-09-29',
            markdown: 'Intro with **formatting**.\n## Highlights\n- A [link](https://example.test)\n### Details\nMore text.',
        });
        expect(data.entries.at(-1)?.title).toBe('Version 1');
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
            title: 'Version 0.2.2',
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
            title: 'Version 0.2.1',
            date: '2026-04-05',
            markdown: `Previous release body.

- Earlier item`,
        });
    });
});
