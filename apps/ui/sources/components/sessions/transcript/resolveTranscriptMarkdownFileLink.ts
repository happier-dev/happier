import {
    resolveWorkspaceFileReference,
    type ResolvedWorkspaceFileReference,
} from '@/utils/workspaceFileReferences/resolveWorkspaceFileReference';

export type ResolvedTranscriptMarkdownFileLink = ResolvedWorkspaceFileReference;

export function resolveTranscriptMarkdownFileLink(params: Readonly<{
    url: string;
    workspacePath: string | null | undefined;
}>): ResolvedTranscriptMarkdownFileLink | null {
    return resolveWorkspaceFileReference(params);
}
