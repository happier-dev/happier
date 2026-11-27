#!/usr/bin/env tsx

import * as fs from 'fs';
import * as path from 'path';

import type { ChangelogData } from '../changelog/types';
import { buildChangelogBundle, renderChangelogBundle } from '../../../../scripts/pipeline/release/release-notes/changelog-sections.mjs';

function parseChangelogContent(content: string): ChangelogData {
    return buildChangelogBundle(content);
}

function parseChangelog(): ChangelogData {
    const changelogPath = path.join(__dirname, '../../CHANGELOG.md');

    const content = fs.readFileSync(changelogPath, 'utf-8');
    return parseChangelogContent(content);
}

function main() {
    console.log('Parsing CHANGELOG.md...');
    
    const changelogData = parseChangelog();
    const outputPath = path.join(__dirname, '../changelog/changelog.json');
    
    // Ensure directory exists
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    
    const rendered = renderChangelogBundle(fs.readFileSync(path.join(__dirname, '../../CHANGELOG.md'), 'utf-8'));
    if (process.argv.includes('--check')) {
        if (fs.readFileSync(outputPath, 'utf-8') !== rendered) {
            throw new Error('Bundled changelog is stale. Run tsx sources/scripts/parseChangelog.ts.');
        }
    } else {
        fs.writeFileSync(outputPath, rendered);
    }
    
    console.log(`✅ Parsed ${changelogData.entries.length} changelog entries`);
    console.log(`📝 Latest release: ${changelogData.latestReleaseId ?? 'none'}`);
    console.log(`${process.argv.includes('--check') ? 'Verified' : 'Wrote'} ${outputPath}`);
}

if (require.main === module) {
    main();
}

export { parseChangelog, parseChangelogContent };
