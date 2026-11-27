export interface ChangelogSection {
    kind: 'Release' | 'Version';
    id: string;
    title: string;
    date: string;
    markdown: string;
}

export function parseChangelogSections(content: string): ChangelogSection[];
export function stripChangelogComments(markdown: string): string;

export interface ChangelogBundle {
    entries: Array<{ id: string; versionLabel: string; title: string; date: string; markdown: string }>;
    latestReleaseId: string | null;
}

export const CHANGELOG_BUNDLE_PATH: string;
export function buildChangelogBundle(content: string): ChangelogBundle;
export function renderChangelogBundle(content: string): string;
