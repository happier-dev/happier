export interface ChangelogEntry {
    id: string;
    versionLabel: string;
    date: string;
    markdown: string;
}

export interface ChangelogData {
    entries: ChangelogEntry[];
    latestReleaseId: string | null;
}
