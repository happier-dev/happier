import type { PromptExternalLinkEntryV1 } from '@happier-dev/protocol';

export function buildPromptAssetExportHref(args: Readonly<{
    artifactId: string;
    libraryKind: 'doc' | 'bundle';
    link?: PromptExternalLinkEntryV1 | null;
}>): string {
    const basePath = args.libraryKind === 'bundle'
        ? `/settings/prompts/skills/${args.artifactId}/export`
        : `/settings/prompts/docs/${args.artifactId}/export`;

    if (!args.link) return basePath;

    const params = new URLSearchParams();
    params.set('assetTypeId', args.link.assetTypeId);
    params.set('machineId', args.link.machineId);
    params.set('scope', args.link.scope);
    if (typeof args.link.workspacePath === 'string' && args.link.workspacePath.length > 0) {
        params.set('workspacePath', args.link.workspacePath);
    }

    const query = params.toString();
    return query.length > 0 ? `${basePath}?${query}` : basePath;
}
