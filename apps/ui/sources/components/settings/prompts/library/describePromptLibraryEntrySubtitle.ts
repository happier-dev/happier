type PromptLibraryEntryOrigin = string | null;

export function describePromptLibraryEntrySubtitle(args: Readonly<{
    origin: PromptLibraryEntryOrigin;
    linkedTargets: readonly string[];
    folderName?: string | null;
    tags?: readonly string[] | null;
    labels: Readonly<{
        imported: string;
        builtIn: string;
        exportsCount: (count: number) => string;
    }>;
}>): string | undefined {
    const parts: string[] = [];

    if (args.origin === 'imported') {
        parts.push(args.labels.imported);
    } else if (args.origin === 'built_in') {
        parts.push(args.labels.builtIn);
    }

    if (args.folderName) {
        parts.push(args.folderName);
    }

    if ((args.tags?.length ?? 0) > 0) {
        parts.push(args.tags!.join(', '));
    }

    if (args.linkedTargets.length > 0) {
        parts.push(args.labels.exportsCount(args.linkedTargets.length));
        parts.push(args.linkedTargets.join(', '));
    }

    return parts.length > 0 ? parts.join(' · ') : undefined;
}
