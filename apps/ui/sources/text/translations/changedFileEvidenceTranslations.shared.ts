

export type ChangedFileEvidenceTranslations = {
    -readonly [Key in keyof typeof en]: (typeof en)[Key] extends Readonly<Record<string, string>>
        ? { -readonly [Child in keyof (typeof en)[Key]]: string }
        : (typeof en)[Key] extends string
            ? string
            : (typeof en)[Key];
};



export function translated(value: ChangedFileEvidenceTranslations): ChangedFileEvidenceTranslations {
    return value;
}



export const en = {
    before: 'Before',
    after: 'After',
    binary: 'Binary file',
    truncated: 'Evidence content was bounded; original size and change statistics are retained when available.',
    truncatedOldBytes: ({ count }: { count: number }) => `Original before content: ${count} bytes`,
    truncatedNewBytes: ({ count }: { count: number }) => `Original after content: ${count} bytes`,
    truncatedDiffBytes: ({ count }: { count: number }) => `Original diff: ${count} bytes`,
    truncatedAddedLines: ({ count }: { count: number }) => `Added lines: ${count}`,
    truncatedRemovedLines: ({ count }: { count: number }) => `Removed lines: ${count}`,
    kind: {
        added: 'Added',
        modified: 'Modified',
        deleted: 'Deleted',
        renamed: 'Renamed',
        copied: 'Copied',
        unknown: 'Change kind unavailable',
    },
    howDetermined: 'How determined',
    howDeterminedForFile: ({ path }: { path: string }) => `How ${path} was determined`,
    content: {
        exact: 'Exact repository change',
        strong: 'Strong content evidence',
        best_effort: 'Best-effort content evidence',
    },
    attribution: {
        session_exact: 'Linked to this Session',
        session_likely: 'Likely changed by this Session',
        session_possible: 'Possibly changed by this Session',
        unknown: 'Session attribution unavailable',
    },
    reason: {
        provider_correlated: 'The agent reported this change for this turn.',
        canonical_tool_correlated: 'A diff or patch tool linked this change to this turn.',
        checkpoint_no_happier_overlap_observed: 'The checkpoint recorded no overlapping Happier turn in this process.',
        checkpoint_overlap_observed: 'Another Happier turn overlapped the checkpoint capture interval.',
        workspace_touched_path: 'This path was touched in the workspace; that does not identify the Session that changed it.',
        unavailable: 'Evidence does not establish which Session made this change.',
    },
    overlap: {
        observed: 'Another Happier turn overlapped this checkout during capture. Observations cover only this process; other processes and external writers are not tracked.',
        not_observed: 'No overlapping Happier turn was observed in this process. Other processes and external writers are not tracked; this does not establish exclusive authorship.',
        unknown: 'Checkpoint overlap is unknown. Other processes and external writers are not tracked.',
    },
    sources: {
        provider_native: 'Agent-native change report',
        provider_tool: 'Agent tool report',
        canonical_diff_tool: 'Diff tool evidence',
        canonical_patch_tool: 'Patch tool evidence',
        scm_checkpoint: 'Repository checkpoint',
        scm_reconciled: 'Reconciled repository snapshot',
        inferred: 'Workspace touched path',
    },
} as const;


export const changedFileEvidenceTranslationsEnglish = { en: { changedFileEvidence: en as ChangedFileEvidenceTranslations } } as const;