import type { ScmFileStatus } from '@/scm/scmStatusFiles';

export type ChangedFilesReviewRow =
    | Readonly<{ kind: 'section'; key: string; title: string }>
    | Readonly<{
        kind: 'file';
        key: string;
        sectionKey: string;
        indexInSection: number;
        fileIndex: number;
        file: ScmFileStatus;
        collapsed?: boolean;
    }>;

export function buildChangedFilesReviewRows(input: Readonly<{
    sections: readonly Readonly<{ key: string; title: string; files: readonly ScmFileStatus[] }>[];
}>): readonly ChangedFilesReviewRow[] {
    const rows: ChangedFilesReviewRow[] = [];
    let fileIndex = 0;

    for (const section of input.sections) {
        if (!section || section.files.length === 0) continue;
        rows.push({ kind: 'section', key: `section:${section.key}`, title: section.title });

        for (let indexInSection = 0; indexInSection < section.files.length; indexInSection++) {
            const file = section.files[indexInSection];
            if (!file?.fullPath) continue;
            rows.push({
                kind: 'file',
                key: `file:${section.key}:${file.fullPath}`,
                sectionKey: section.key,
                indexInSection,
                fileIndex,
                file,
            });
            fileIndex += 1;
        }
    }

    return rows;
}
