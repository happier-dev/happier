export interface ChangelogSection {
    kind: 'Release' | 'Version';
    id: string;
    title: string;
    date: string;
    markdown: string;
}

export function parseChangelogSections(content: string): ChangelogSection[];
export function stripChangelogComments(markdown: string): string;
