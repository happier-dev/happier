#!/usr/bin/env tsx

import * as fs from 'fs';
import * as path from 'path';

interface ChangelogEntry {
    id: string;
    versionLabel: string;
    date: string;
    markdown: string;
}

interface ChangelogData {
    entries: ChangelogEntry[];
    latestReleaseId: string | null;
}

function parseChangelogContent(content: string): ChangelogData {
    const entries: ChangelogEntry[] = [];

    // Split by release headers while preserving everything under each release as markdown.
    const versionSections = content.split(/^## Version (.+?) - (\d{4}-\d{2}-\d{2})$/gm);

    // Skip the first element (content before first version)
    for (let i = 1; i < versionSections.length; i += 3) {
        const versionLabel = versionSections[i]?.trim();
        const dateStr = versionSections[i + 1];
        const changesContent = versionSections[i + 2];

        if (!versionLabel || !dateStr || changesContent === undefined) {
            continue;
        }

        const markdown = changesContent.trim();
        entries.push({
            id: versionLabel,
            versionLabel,
            date: dateStr.trim(),
            markdown,
        });
    }

    return {
        entries,
        latestReleaseId: entries[0]?.id ?? null,
    };
}

function parseChangelog(): ChangelogData {
    const changelogPath = path.join(__dirname, '../../CHANGELOG.md');

    if (!fs.existsSync(changelogPath)) {
        console.warn('CHANGELOG.md not found, creating empty changelog data');
        return { entries: [], latestReleaseId: null };
    }

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
    
    // Write the parsed data
    fs.writeFileSync(outputPath, JSON.stringify(changelogData, null, 2));
    
    console.log(`✅ Parsed ${changelogData.entries.length} changelog entries`);
    console.log(`📝 Latest release: ${changelogData.latestReleaseId ?? 'none'}`);
    console.log(`💾 Output written to: ${outputPath}`);
}

if (require.main === module) {
    main();
}

export { parseChangelog, parseChangelogContent };
