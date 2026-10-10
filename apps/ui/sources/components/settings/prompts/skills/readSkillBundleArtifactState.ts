import { PromptBundleArtifactHeaderV1Schema, PromptBundleBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import type { PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { resolveArtifactOrganizationHeaderV1, type ArtifactOrganizationHeaderV1 } from '@happier-dev/protocol/artifacts/artifactOrganizationV1';
import type { PromptFoldersV1 } from '@happier-dev/protocol/prompts/library/promptFoldersV1';

export type SkillBundleArtifactState = Readonly<{
    artifact: PromptLibraryStoredArtifact;
    title: string;
    folderId: string | null;
    tags: string[];
    organizationAvailable: boolean;
    body: import('@happier-dev/protocol').PromptBundleBodyV1;
}>;

/** Projects only the fresh Artifact admitted by the editor's captured Account store. */
export function readSkillBundleArtifactState(artifact: PromptLibraryStoredArtifact | null, folders?: PromptFoldersV1 | null): SkillBundleArtifactState | null {
    if (!artifact || typeof artifact.body !== 'string') return null;
    const header = PromptBundleArtifactHeaderV1Schema.safeParse(artifact.header);
    if (!header.success) return null;

    try {
        const parsed = PromptBundleBodyV1Schema.safeParse(JSON.parse(artifact.body));
        if (!parsed.success) return null;
        let organization: ArtifactOrganizationHeaderV1 | null;
        try {
            organization = folders ? resolveArtifactOrganizationHeaderV1({ artifactId: artifact.id,
                header: artifact.header ?? {}, owned: artifact.owned === true,
                artifactHeadersById: folders.artifactHeadersById }) : null;
        } catch { organization = null; }
        return {
            artifact,
            title: header.data.title,
            folderId: organization?.folderId ?? null,
            tags: organization?.tags ?? [],
            organizationAvailable: organization !== null,
            body: parsed.data,
        };
    } catch {
        return null;
    }
}
