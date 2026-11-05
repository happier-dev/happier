import { PluginError } from '@happier-dev/plugin-sdk';
import { mergeTargetedContributionManifestDeclarations, type TargetedContributionManifestDeclaration } from '@happier-dev/cli-common/plugins/registration';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import {
    machinePluginTargetedSourceDeclarationsRead,
    subscribeMachineContributionRegistryProjectionInvalidation,
} from '@/sync/ops/machineContributionRegistryProjection';

/** One declaration source shared by Account Actions and mounted targeted UI. */
export function createPluginSurfaceTargetedDeclarationSource(input: Readonly<{
    pluginId: string;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal: AbortSignal;
    machine?: Readonly<{ machineId: string; serverId?: string | null }>;
    /** Connection-owner fact; an optional pending Machine cannot hold Account admission. */
    isMachineAvailable?(): boolean;
    isCurrent(): boolean;
}>) {
    const availability = readPluginAccountAvailability(input.accountLifetime.scope);
    let machineDeclarations: readonly TargetedContributionManifestDeclaration[] = [];
    const readDeclarations = (): readonly TargetedContributionManifestDeclaration[] => mergeTargetedContributionManifestDeclarations({
        targetPluginId: input.pluginId,
        accountDeclarations: availability.readCurrentAccountExecutionDeclarations()
            .map(row => ({ manifest: row.manifest, occurrenceId: row.custodyId, sourceCustody: row.sourceCustody })),
        machineDeclarations,
    });
    return {
        readDeclarations,
        async readCurrentDeclarations(signal: AbortSignal = input.signal) {
            const assertCurrent = () => {
                signal.throwIfAborted();
                if (!input.accountLifetime.isCurrent() || !input.isCurrent()) {
                    throw new PluginError({ code: 'plugin_action_generation_retired' });
                }
            };
            assertCurrent();
            await availability.ensureAccountTargetDeclarations(input.pluginId);
            assertCurrent();
            if (input.isMachineAvailable?.() === false) return readDeclarations();
            if (input.machine) {
                const result = await machinePluginTargetedSourceDeclarationsRead(input.machine.machineId, {
                    serverId: input.machine.serverId, pluginId: input.pluginId,
                    accountLifetime: input.accountLifetime, signal,
                });
                assertCurrent();
                machineDeclarations = result.supported ? result.sourceDeclarations : [];
            }
            return readDeclarations();
        },
        subscribe(listener: () => void) {
            const unsubscribeAccount = availability.subscribe(listener);
            const unsubscribeMachine = input.machine ? subscribeMachineContributionRegistryProjectionInvalidation({
                machineId: input.machine.machineId,
                serverId: input.machine.serverId ?? input.accountLifetime.scope.serverId,
            }, listener) : undefined;
            return () => { unsubscribeAccount(); unsubscribeMachine?.(); };
        },
    };
}
