import type { PluginUiArtifactProjection, PluginUiProjectionModel } from './projection';

export type PluginUiArtifactInvalidation = Readonly<{
    projectionGenerationChanged: boolean;
    changedPluginIds: readonly string[];
    changedArtifactIds: readonly string[];
    removedArtifactIds: readonly string[];
}>;

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readDigest(artifact: PluginUiArtifactProjection): string | null {
    const integrity = artifact.integrity;
    if (!integrity || typeof integrity !== 'object' || Array.isArray(integrity)) {
        return null;
    }
    return readString((integrity as Readonly<Record<string, unknown>>).digest);
}

function artifactFingerprint(artifact: PluginUiArtifactProjection): string {
    return JSON.stringify({
        artifactId: artifact.artifactId,
        pluginId: artifact.pluginId,
        digest: readDigest(artifact),
        cacheKey: readString(artifact.cacheKey),
        platform: readString(artifact.platform),
        channel: readString(artifact.channel),
    });
}

function sortValues(values: Iterable<string>): readonly string[] {
    return Object.freeze([...values].sort((left, right) => left.localeCompare(right)));
}

export function resolvePluginUiArtifactInvalidation(
    previous: PluginUiProjectionModel,
    next: PluginUiProjectionModel,
): PluginUiArtifactInvalidation {
    const changedArtifactIds = new Set<string>();
    const removedArtifactIds = new Set<string>();
    const changedPluginIds = new Set<string>();
    const projectionGenerationChanged = previous.generation !== next.generation;

    if (projectionGenerationChanged) {
        for (const artifact of Object.values(previous.uiArtifactsById)) {
            changedPluginIds.add(artifact.pluginId);
        }
        for (const artifact of Object.values(next.uiArtifactsById)) {
            changedPluginIds.add(artifact.pluginId);
        }
    }

    for (const [artifactId, previousArtifact] of Object.entries(previous.uiArtifactsById)) {
        const nextArtifact = next.uiArtifactsById[artifactId];
        if (!nextArtifact) {
            removedArtifactIds.add(artifactId);
            changedPluginIds.add(previousArtifact.pluginId);
            continue;
        }

        if (artifactFingerprint(previousArtifact) !== artifactFingerprint(nextArtifact)) {
            changedArtifactIds.add(artifactId);
            changedPluginIds.add(nextArtifact.pluginId);
        }
    }

    for (const [artifactId, nextArtifact] of Object.entries(next.uiArtifactsById)) {
        if (previous.uiArtifactsById[artifactId]) {
            continue;
        }
        changedArtifactIds.add(artifactId);
        changedPluginIds.add(nextArtifact.pluginId);
    }

    return Object.freeze({
        projectionGenerationChanged,
        changedArtifactIds: sortValues(changedArtifactIds),
        changedPluginIds: sortValues(changedPluginIds),
        removedArtifactIds: sortValues(removedArtifactIds),
    });
}
