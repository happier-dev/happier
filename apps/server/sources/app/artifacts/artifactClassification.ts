import type { ArtifactCallerAccessV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { getArtifactKindPolicyV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';

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

/** Retiring rows keep physical-byte custody, but are unavailable to all live readers and writers. */
export const artifactVisibleWhere = Object.freeze({ ...artifactOrdinaryWhere, deletedAt: null });

/** Revision trimming is available for the owner of an admitted, ordinary browser Artifact. */
export function viewerMayTrimArtifactRevisions(access: ArtifactCallerAccessV1, kindHint: string | null | undefined): boolean {
    return access === 'owner' && getArtifactKindPolicyV1(kindHint).browserListed;
}

/** SQL projection of the same classification for byte aggregates that cannot hydrate content. */
export function artifactOrdinarySqlPredicate(mysql: boolean): string {
    const quote = (name: string) => mysql ? `\`${name}\`` : `"${name}"`;
    return `NOT EXISTS (SELECT 1 FROM ${quote("AccountPluginUiArtifact")} ui WHERE ui.${quote("artifactId")} = a.${quote("id")})
        AND NOT EXISTS (SELECT 1 FROM ${quote("AccountPluginRelease")} pr WHERE pr.${quote("packageAssetArtifactId")} = a.${quote("id")})`;
}

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
