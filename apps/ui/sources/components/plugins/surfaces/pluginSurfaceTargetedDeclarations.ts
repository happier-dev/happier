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
    resolveMachine?(): Promise<Readonly<{ machineId: string; serverId?: string | null }> | undefined>;
    /** Connection-owner fact; an optional pending Machine cannot hold Account admission. */
    isMachineAvailable?(): boolean;
    isCurrent(): boolean;
}>) {
    const availability = readPluginAccountAvailability(input.accountLifetime.scope);
    let machine = input.machine;
    const bindMachineSubscriptions = new Set<() => void>();
    let machineDeclarations: readonly TargetedContributionManifestDeclaration[] = [];
    const readDeclarations = (): readonly TargetedContributionManifestDeclaration[] => mergeTargetedContributionManifestDeclarations({
        targetPluginId: input.pluginId,
        accountDeclarations: availability.readCurrentAccountExecutionDeclarations()
            .map(row => ({ manifest: row.manifest, occurrenceId: row.custodyId, sourceCustody: row.sourceCustody })),
        machineDeclarations,
    });
    return {
        readDeclarations,
        async readCurrentDeclarations(signal: AbortSignal = input.signal,
            onAccountReady?: (declarations: readonly TargetedContributionManifestDeclaration[]) => Promise<void>) {
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
            if (onAccountReady && (machine || input.resolveMachine)) {
                await onAccountReady(readDeclarations());
                assertCurrent();
            }
            if (!machine && input.resolveMachine) {
                machine = await input.resolveMachine();
                assertCurrent();
                if (machine) for (const bind of bindMachineSubscriptions) bind();
            }
            if (machine) {
                const result = await machinePluginTargetedSourceDeclarationsRead(machine.machineId, {
                    serverId: machine.serverId, pluginId: input.pluginId,
                    accountLifetime: input.accountLifetime, signal,
                });
                assertCurrent();
                machineDeclarations = result.supported ? result.sourceDeclarations : [];
            }
            return readDeclarations();
        },
        subscribe(listener: () => void) {
            const unsubscribeAccount = availability.subscribe(listener, input.pluginId);
            let unsubscribeMachine: (() => void) | undefined;
            const bind = () => {
                if (machine && !unsubscribeMachine) unsubscribeMachine = subscribeMachineContributionRegistryProjectionInvalidation({
                    machineId: machine.machineId,
                    serverId: machine.serverId ?? input.accountLifetime.scope.serverId,
                }, listener);
            };
            bindMachineSubscriptions.add(bind);
            bind();
            return () => { bindMachineSubscriptions.delete(bind); unsubscribeAccount(); unsubscribeMachine?.(); };
        },
    };
}
