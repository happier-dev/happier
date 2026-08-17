type PluginArtifactOwner = Readonly<{
    accountId: string;
    pluginId: string;
}>;

type ArtifactClassificationRelations = Readonly<{
    pluginUiArtifact: Readonly<{ release: PluginArtifactOwner }> | null;
    packageAssetRelease: PluginArtifactOwner | null;
}>;

export type ArtifactClassification =
    | Readonly<{ kind: "ordinary" }>
    | Readonly<{ kind: "plugin"; pluginId: string }>
    | Readonly<{ kind: "invalid" }>;

/**
 * Generic Artifact APIs must see only independently owned Account Artifacts.
 * Plugin-owned artifacts are admitted only by their qualified Availability owner.
 */
export const artifactOrdinaryWhere = Object.freeze({
    pluginUiArtifact: { is: null },
    packageAssetRelease: { is: null },
});

export function artifactClassificationFromRelations(
    relations: ArtifactClassificationRelations,
    expectedAccountId?: string,
): ArtifactClassification {
    const uiLink = relations.pluginUiArtifact ?? null;
    const uiOwner = uiLink?.release ?? null;
    const packageOwner = relations.packageAssetRelease ?? null;
    if ((uiLink !== null && uiOwner === null) || (relations.packageAssetRelease != null && packageOwner === null)) {
        return { kind: "invalid" };
    }
    if (uiOwner && packageOwner) return { kind: "invalid" };

    const owner = uiOwner ?? packageOwner;
    if (!owner) return { kind: "ordinary" };
    if (
        !owner.accountId
        || !owner.pluginId
        || (expectedAccountId !== undefined && owner.accountId !== expectedAccountId)
    ) {
        return { kind: "invalid" };
    }
    return { kind: "plugin", pluginId: owner.pluginId };
}
