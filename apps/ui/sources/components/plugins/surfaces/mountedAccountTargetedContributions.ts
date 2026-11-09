import {
    DaemonPluginUiTargetedSurfaceMountV1Schema,
    PluginUiTargetedSurfaceMountCoreV1Schema,
    readDaemonPluginUiTargetedSurfaceMountV1,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
    projectPluginUiTargetedContributionsV1,
} from '@happier-dev/protocol/plugins/ui/targetedContributions';
import { selectPluginUiRendererChainMemberV1, resolvePluginUiRendererProjectionEntry } from '@happier-dev/protocol/plugins/contributions/ui';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import type { PluginUiAccountExecutableOrigin } from '../reactNative/executableModuleHost';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { machinePluginUiTargetedContributionsRead, type MachinePluginUiTargetedContributionsReadResult } from '@/sync/ops/machineContributionRegistryProjection';
import { readAccountTargetedContributionSnapshot } from './accountTargetedContributionSnapshot';
import type { MountedPluginUiTargetedSurfaceMountV1 } from './mountedTargetedContributions';

/** Adapts current Account custody into the shared admitted semantic/mount owners. */
type MountedAccountTargetedContributionsInput = Readonly<{
    pluginId: string;
    origin: PluginUiAccountExecutableOrigin;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal: AbortSignal;
    machine?: Readonly<{ machineId: string; serverId?: string | null }>;
    isCurrent(): boolean;
}>;

export async function readMountedAccountTargetedContributions(input: MountedAccountTargetedContributionsInput,
    onAccountReady?: (result: ReturnType<typeof projectMountedAccountTargetedContributions>) => Promise<void>,
) {
    const snapshot = await readAccountTargetedContributionSnapshot(input, onAccountReady
        ? async snapshot => { await onAccountReady(projectMountedAccountTargetedContributions(input, snapshot)); }
        : undefined);
    // The selected Machine also supplies Resource scopes for operation-only pages.
    const machineRead = input.machine ? await machinePluginUiTargetedContributionsRead(input.machine.machineId, {
        serverId: input.machine.serverId, pluginId: input.pluginId,
        accountLifetime: input.accountLifetime, signal: input.signal,
    }) : undefined;
    return projectMountedAccountTargetedContributions(input, snapshot, machineRead);
}

function projectMountedAccountTargetedContributions(input: MountedAccountTargetedContributionsInput,
    snapshot: Awaited<ReturnType<typeof readAccountTargetedContributionSnapshot>>,
    machineRead?: MachinePluginUiTargetedContributionsReadResult,
) {
    const { availability, assertCurrent, projectIdentity, readSnapshots, readSourceCustody, snapshots, targetedContributions }
        = snapshot;
    const projection = availability.readAccountUiProjection();
    const entriesById = { ...projection?.unknownEntriesById, ...projection?.reactNativeBundlesById, ...projection?.hostedWebById };
    const mounts: MountedPluginUiTargetedSurfaceMountV1[] = [];
    assertCurrent();
    for (const { point, snapshot } of snapshots) {
        for (const contribution of snapshot.contributions) {
            for (const surface of contribution.surfaces) {
                const contributor = projectIdentity(surface.contributor);
                const selection = availability.readCurrentAccountExecution(contributor.pluginId);
                if (selection.kind !== 'available' || selection.custodyId !== contributor.occurrenceId
                    || !pluginSourceCustodyV1Equal(selection.sourceCustody, contributor.sourceCustody)) {
                    if (!input.machine) continue;
                    if (!machineRead?.supported) continue;
                    const machineMount = readDaemonPluginUiTargetedSurfaceMountV1({
                        mounts: machineRead.targetedSurfaceMounts, target: machineRead.targetedContributions.target,
                        surface: { point, contributor, role: surface.role, presentation: surface.presentation },
                    });
                    if (machineMount) mounts.push(DaemonPluginUiTargetedSurfaceMountV1Schema.parse({
                        ...machineMount, target: targetedContributions.target,
                        // The Account target owns its admitted role input; the
                        // Machine supplies only this exact contributor mount.
                        inputSchema: surface.inputSchema,
                    }));
                    continue;
                }
                const candidates = surface.rendererChain.flatMap(renderer => {
                    const entry = entriesById[`uiRenderer:${renderer.pluginId}:${renderer.definition.id}`];
                    return entry ? [{ identity: renderer.identity, entry }] : [];
                });
                const availableIds = candidates.filter(({ entry }) => {
                    const state = entry.availability;
                    return state && typeof state === 'object' && 'state' in state && state.state === 'available';
                }).map(({ identity }) => identity.localId);
                const selectedIdentity = selectPluginUiRendererChainMemberV1(surface.rendererChain.map(renderer => renderer.identity), availableIds)
                    ?? surface.rendererChain[0]?.identity;
                const selected = candidates.find(candidate => candidate.identity.pluginId === selectedIdentity?.pluginId
                    && candidate.identity.localId === selectedIdentity.localId);
                if (!selected) continue;
                const artifactProjection = selected.entry.renderer && typeof selected.entry.renderer === 'object'
                    ? resolvePluginUiRendererProjectionEntry({ pluginId: contributor.pluginId,
                        renderer: selected.entry.renderer as Readonly<Record<string, unknown>>, entriesById }) : null;
                // A child's context target is its physical contributor, not
                // the parent's selected Machine target-operation fence.
                const contributorTargetedContributions = projectPluginUiTargetedContributionsV1({
                    target: { pluginId: contributor.pluginId, occurrenceId: contributor.occurrenceId },
                    snapshots: readSnapshots(contributor.pluginId, contributor.occurrenceId), readSourceCustody,
                });
                const core = PluginUiTargetedSurfaceMountCoreV1Schema.parse({
                    kind: 'targetedSurface', target: targetedContributions.target, point, contributor,
                    role: surface.role, presentation: surface.presentation, inputSchema: surface.inputSchema,
                    rendererChain: surface.rendererChain.map(renderer => renderer.identity),
                    selectedRenderer: { identity: selected.identity, renderer: selected.entry.renderer,
                        availability: selected.entry.availability, ...(artifactProjection ? { artifactProjection } : {}) },
                    resourceCapability: { readable: false, dynamic: false }, contributorTargetedContributions,
                });
                if (selection.sourceCustody.kind !== 'account_release' && selection.sourceCustody.kind !== 'bundled_first_party') continue;
                mounts.push(Object.freeze({ ...core, accountExecutionOrigin: Object.freeze({
                    ...input.accountLifetime.scope, custodyId: selection.custodyId, sourceCustody: selection.sourceCustody,
                }) }));
            }
        }
    }
    assertCurrent();
    // A portable page can consume its own daemon Resources. Embedded Machine
    // children keep their own census; other Account contributors remain separate.
    const machinePluginIds = new Set([input.pluginId,
        ...mounts.filter(mount => 'executionOrigin' in mount).map(mount => mount.contributor.pluginId)]);
    const resourceDeclarationsByPluginId = machineRead?.supported && machineRead.resourceDeclarationsByPluginId
        ? Object.fromEntries(Object.entries(machineRead.resourceDeclarationsByPluginId).filter(([pluginId]) => machinePluginIds.has(pluginId)))
        : undefined;
    return { supported: true as const, targetedContributions, targetedSurfaceMounts: Object.freeze(mounts), resourceDeclarationsByPluginId };
}
