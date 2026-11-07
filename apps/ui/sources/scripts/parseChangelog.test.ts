import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import bundled from '../changelog/changelog.json';
import { parseChangelog, parseChangelogContent } from './parseChangelog';

describe('parseChangelog', () => {
    it('bundles the complete authored history, including modern and legacy releases', () => {
        const data = parseChangelog();

        const headings = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8')
            .split('\n').filter((line) => line.startsWith('## Release ') || line.startsWith('## Version '))
            .map((line) => line.slice(3).split(' - ')[0]);
        expect(data.entries.map((entry) => entry.title)).toEqual(headings);
        expect(JSON.stringify(data)).not.toContain('happier-release-note-projections');
        expect(bundled).toEqual(data);
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
            id: '2026-09-29.2', title: 'Release 2026-09-29.2', date: '2026-09-29',
            markdown: 'Intro with **formatting**.\n## Highlights\n- A [link](https://example.test)\n### Details\nMore text.',
        });
        expect(data.entries.at(-1)?.title).toBe('Version 1');
    });

    it('fails generation on malformed headings or duplicate identities rather than dropping releases', () => {
        expect(() => parseChangelogContent('## Release 2026-09-29.1\nBody')).toThrow(/heading/);
        expect(() => parseChangelogContent('## Version 1 - 2026-02-15\nOne\n## Version 1 - 2026-02-15\nTwo')).toThrow(/Duplicate/);
        expect(parseChangelogContent('# Changelog\n')).toEqual({ entries: [], latestReleaseId: null });
    });
});
