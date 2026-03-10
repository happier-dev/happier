export function defaultPromptAssetTargetInput(params: Readonly<{
    libraryKind: 'doc' | 'bundle';
    title: string;
}>): string {
    const baseTitle = params.title.trim();
    if (params.libraryKind === 'doc') {
        const normalized = baseTitle.length > 0 ? baseTitle : 'prompt';
        return normalized.toLowerCase().endsWith('.md') ? normalized : `${normalized}.md`;
    }

    const slug = (baseTitle.length > 0 ? baseTitle : 'skill')
        .toLowerCase()
        .replace(/[^a-z0-9/-]+/g, '-')
        .replace(/\/+/g, '/')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug.length > 0 ? slug : 'skill';
}
