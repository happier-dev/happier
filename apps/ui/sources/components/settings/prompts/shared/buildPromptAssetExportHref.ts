import type { PromptExternalLinkEntryV1 } from '@happier-dev/protocol';

export function buildPromptAssetExportHref(args: Readonly<{
    artifactId: string;
    libraryKind: 'doc' | 'bundle';
    serverId?: string | null;
    link?: PromptExternalLinkEntryV1 | null;
}>): string {
    const basePath = args.libraryKind === 'bundle'
        ? `/(app)/settings/prompts/skills/${encodeURIComponent(args.artifactId)}/export`
        : `/(app)/settings/prompts/docs/${encodeURIComponent(args.artifactId)}/export`;

    const params = new URLSearchParams();
    if (args.serverId?.trim()) params.set('serverId', args.serverId.trim());
    if (!args.link) return params.size ? `${basePath}?${params.toString()}` : basePath;
    params.set('assetTypeId', args.link.assetTypeId);
    params.set('scope', args.link.scope);
    if (typeof args.link.workspacePath === 'string' && args.link.workspacePath.length > 0) {
        params.set('workspacePath', args.link.workspacePath);
    }

    const query = params.toString();
    return query.length > 0 ? `${basePath}?${query}` : basePath;
}
