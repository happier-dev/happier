#!/usr/bin/env tsx

import * as fs from 'fs';
import * as path from 'path';

import type { ChangelogData } from '../changelog/types';
import { parseChangelogSections, stripChangelogComments } from '../../../../scripts/pipeline/release/release-notes/changelog-sections.mjs';

export function parseChangelogContent(content: string): ChangelogData {
    const entries = parseChangelogSections(stripChangelogComments(content)).map((section) => ({
        id: section.id,
        title: section.title,
        date: section.date,
        markdown: section.markdown.trim(),
    }));
    const ids = new Set<string>();
    for (const entry of entries) {
        if (ids.has(entry.id)) throw new Error(`Duplicate changelog release id: ${entry.id}`);
        ids.add(entry.id);
    }
    return { entries, latestReleaseId: entries[0]?.id ?? null };
}

function parseChangelog(): ChangelogData {
    return parseChangelogContent(fs.readFileSync(path.join(__dirname, '../../CHANGELOG.md'), 'utf-8'));
}

function main() {
    console.log('Parsing CHANGELOG.md...');
    
    const changelogData = parseChangelog();
    const outputPath = path.join(__dirname, '../changelog/changelog.json');
    
    const rendered = JSON.stringify(changelogData, null, 2);
    if (process.argv.includes('--check')) {
        if (fs.readFileSync(outputPath, 'utf-8') !== rendered) {
            throw new Error('Bundled changelog is stale. Run tsx sources/scripts/parseChangelog.ts.');
        }
    } else {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, rendered);
    }
    
    console.log(`✅ Parsed ${changelogData.entries.length} changelog entries`);
    console.log(`📝 Latest release: ${changelogData.latestReleaseId ?? 'none'}`);
    console.log(`${process.argv.includes('--check') ? 'Verified' : 'Wrote'} ${outputPath}`);
}

if (require.main === module) {
    main();
}

export { parseChangelog };
