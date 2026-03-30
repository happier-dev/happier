import { PromptBundleBodyV1Schema } from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';

export type SkillBundleArtifactState = Readonly<{
    title: string;
    folderId: string | null;
    tags: string[];
    body: import('@happier-dev/protocol').PromptBundleBodyV1;
}>;

export function readSkillBundleArtifactState(artifactId: string): SkillBundleArtifactState | null {
    const artifact = storage.getState().artifacts[artifactId] ?? null;
    const title = typeof artifact?.header?.title === 'string' ? artifact.header.title : artifact?.title;
    const bodyText = typeof artifact?.body === 'string' ? artifact.body : null;
    if (!title || !bodyText) return null;

    try {
        const parsed = PromptBundleBodyV1Schema.safeParse(JSON.parse(bodyText));
        if (!parsed.success) return null;
        return {
            title,
            folderId: typeof artifact?.header?.folderId === 'string' ? artifact.header.folderId : null,
            tags: Array.isArray(artifact?.header?.tags) ? artifact.header.tags.filter((tag): tag is string => typeof tag === 'string') : [],
            body: parsed.data,
        };
    } catch {
        return null;
    }
}
