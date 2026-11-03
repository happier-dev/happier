import { PluginError } from '@happier-dev/plugin-sdk';
import { resolveManifestTargetedContributions } from '@happier-dev/cli-common/plugins/registration';
import {
    projectPluginUiTargetedContributionIdentityV1,
    projectPluginUiTargetedContributionsV1,
} from '@happier-dev/protocol/plugins/ui/targetedContributions';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { PluginUiAccountExecutableOrigin } from '../reactNative/executableModuleHost';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { createPluginSurfaceTargetedDeclarationSource } from './pluginSurfaceTargetedDeclarations';

/** The finite Account semantic projection shared by Actions and mounted UI.
 * Reading this snapshot does not discover or mount a renderer or Resource. */
export async function readAccountTargetedContributionSnapshot(input:
    Parameters<typeof createPluginSurfaceTargetedDeclarationSource>[0]
    & Readonly<{ origin: PluginUiAccountExecutableOrigin }>,
) {
    const availability = readPluginAccountAvailability(input.accountLifetime.scope);
    await availability.ensureCurrentAccountExecution(input.pluginId);
    const assertCurrent = () => {
        input.signal.throwIfAborted();
        const selected = availability.readCurrentAccountExecution(input.pluginId);
        if (!input.isCurrent() || !input.accountLifetime.isCurrent()
            || input.origin.serverId !== input.accountLifetime.scope.serverId
            || input.origin.accountId !== input.accountLifetime.scope.accountId
            || selected.kind !== 'available' || selected.custodyId !== input.origin.custodyId
            || !pluginSourceCustodyV1Equal(selected.sourceCustody, input.origin.sourceCustody)) {
            throw new PluginError({ code: 'plugin_action_generation_retired' });
        }
    };
    assertCurrent();
    const source = createPluginSurfaceTargetedDeclarationSource(input);
    const declarations = await source.readCurrentDeclarations();
    assertCurrent();
    const admitted = resolveManifestTargetedContributions(declarations);
    const readSourceCustody = (pluginId: string, occurrenceId: string) => declarations.find(row => (
        row.manifest.id === pluginId && row.occurrenceId === occurrenceId
    ))?.sourceCustody;
    const projectIdentity = <TIdentity extends Readonly<{ pluginId: string; occurrenceId: string }>>(identity: TIdentity) => (
        projectPluginUiTargetedContributionIdentityV1({ identity, readSourceCustody })
    );
    const readSnapshots = (pluginId: string, occurrenceId: string) => {
        const declaration = declarations.find(row => row.manifest.id === pluginId && row.occurrenceId === occurrenceId);
        if (!declaration) throw new PluginError({ code: 'plugin_targeted_contributions_unavailable' });
        return declaration.manifest.contributes.pluginContributionPoints.flatMap(point => [...point.protocols]
            .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : left.version - right.version)
            .map(protocol => {
                const snapshot = admitted.read({ targetPluginId: pluginId, pointId: point.id, protocol });
                if (!snapshot || snapshot.target.occurrenceId !== occurrenceId) {
                    throw new PluginError({ code: 'plugin_targeted_contributions_unavailable' });
                }
                return { point: { pointId: point.id, protocol: { id: protocol.id, version: protocol.version } }, snapshot };
            }));
    };
    const snapshots = readSnapshots(input.pluginId, input.origin.custodyId);
    const projected = projectPluginUiTargetedContributionsV1({
        target: { pluginId: input.pluginId, occurrenceId: input.origin.custodyId }, snapshots, readSourceCustody,
    });
    const targetSourceCustody = declarations.find(row => row.manifest.id === input.pluginId
        && row.occurrenceId === input.origin.custodyId)?.targetSourceCustody;
    const targetedContributions = targetSourceCustody ? Object.freeze({ ...projected,
        target: Object.freeze({ ...projected.target, sourceCustody: targetSourceCustody }),
    }) : projected;
    assertCurrent();
    return { availability, assertCurrent, projectIdentity, readSnapshots, readSourceCustody, snapshots, targetedContributions };
}
