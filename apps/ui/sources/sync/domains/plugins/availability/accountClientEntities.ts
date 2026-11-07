import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginUiProjectionModel } from '../ui/projection';
import type { PluginUiAccountExecutableOrigin } from '../ui/projectionOrigins';

/** Client entity declarations borrow their selected manifest's Account custody. */
export function projectAccountClientEntities(input: Readonly<{
    manifest: PluginPortableReleaseManifestV1;
    hostAccountOrigin: PluginUiAccountExecutableOrigin;
    projectArtifact: (contributionId: string, executable: Readonly<{ artifactId: string; exportName: string }>) => boolean;
}>): Pick<PluginUiProjectionModel, 'workItemsById' | 'dragSourcesById' | 'dropTargetsById'> {
    const { manifest, hostAccountOrigin } = input;
    const project = <T extends Readonly<{ id: string; client: Readonly<{ artifactId: string; exportName: string }> }>>(
        family: string, declarations: readonly T[],
    ) => Object.freeze(Object.fromEntries(declarations.map(definition => {
        input.projectArtifact(`${family}/${definition.id}`, definition.client);
        const id = buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId: definition.id });
        return [id, Object.freeze({ id, pluginId: manifest.id, pluginVersion: manifest.version,
            occurrenceId: hostAccountOrigin.custodyId, definition, hostAccountOrigin })] as const;
    })));
    return {
        workItemsById: project('workItems', manifest.contributes.workItems ?? []),
        dragSourcesById: project('dragSources', manifest.contributes.dragSources ?? []),
        dropTargetsById: project('dropTargets', manifest.contributes.dropTargets ?? []),
    };
}
