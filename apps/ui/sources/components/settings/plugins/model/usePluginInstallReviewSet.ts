import * as React from 'react';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { ActionApprovalRequestCreatedResultSchema, projectUnexpectedActionFailureV1,
    type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { withActionAccountRequestSignal } from '@/sync/ops/actions/actionAccountContext';
import { resolveMachineAdministrationTargetLabel, type MachineAdministrationCandidateV1 } from '@/sync/domains/machines/administration/targetSelection';
import { resolveServerProfileForPortableIdentity } from '@/sync/domains/server/serverProfiles';
import type { usePluginCatalog } from './usePluginCatalog';
import { buildPluginCatalogInstallInput } from './buildPluginCatalogInstallInput';

type InstallListing = Readonly<{ pluginId: string; sourceId: string }>;
type ReviewTarget = Readonly<{
    target: MachineAdministrationTargetV1;
    targetLabel: Readonly<{ machine: string; server: string }>;
}>;

/** Each Artifact retains its own daemon candidate. The existing approval review
 * owner reads its facts/status and decides it; these references never grant consent. */
export type PluginInstallReviewRow = ReviewTarget & (
    | Readonly<{ kind: 'approval'; artifactId: string; serverId: string }>
    | Readonly<{ kind: 'settled'; result: ActionExecuteResult }>
);
export type PluginInstallReviewSet = Readonly<{
    pluginId: string;
    rows: readonly PluginInstallReviewRow[];
}>;

function readHomeProfileId(serverIdentityId: string): string {
    const resolution = resolveServerProfileForPortableIdentity(serverIdentityId);
    return resolution.kind === 'resolved' ? resolution.profile.id : serverIdentityId;
}

/** Collect ordinary exact-Machine Ask results without a second preview or decision path. */
export function usePluginInstallReviewSet(params: Readonly<{
    resolveInstallEntry: ReturnType<typeof usePluginCatalog>['resolveInstallEntry'];
    candidates: readonly MachineAdministrationCandidateV1[];
    getSignal: () => AbortSignal;
}>) {
    const execute = React.useMemo(() => createFrontDoorActionExecute(), []);
    // This callback belongs to the Account whose catalog supplied its operands,
    // including when a picker retains it across an Account change.
    const account = captureActiveServerAccountScopeLifetime();
    const [retained, setRetained] = React.useState<Readonly<{
        review: PluginInstallReviewSet;
        isCurrent: () => boolean;
    }> | null>(null);
    const run = React.useCallback(async (listing: InstallListing, targets: readonly MachineAdministrationTargetV1[]) => {
        const entry = params.resolveInstallEntry(listing);
        if (!account?.isCurrent() || !entry || targets.length === 0) return;
        const signal = params.getSignal();
        const isCurrent = () => account.isCurrent() && !signal.aborted;
        // Snapshot every operand before the first suspension. Later picker/listing
        // edits cannot retarget any of the approvals in this operation.
        const operations = targets.flatMap(value => {
            const target = { serverIdentityId: value.serverIdentityId, machineId: value.machineId };
            const input = buildPluginCatalogInstallInput(entry, target.machineId);
            return input ? [{ target,
                targetLabel: resolveMachineAdministrationTargetLabel({ target, candidates: params.candidates })
                    ?? { machine: target.machineId, server: target.serverIdentityId },
                input,
            }] : [];
        });
        setRetained(null);
        const rows = await withActionAccountRequestSignal({ accountLifetime: account }, signal, requestSignal =>
            Promise.all(operations.map(async ({ target, targetLabel, input }): Promise<PluginInstallReviewRow> => {
                let result: ActionExecuteResult;
                try {
                    // Normal dispatch preserves Ask (and deliberate policy waivers).
                    // Never call confirmed: the pending Artifact IS the review carrier.
                    result = await execute('plugins.install', input, { surface: 'ui', authority: 'present_user',
                        actionCaller: { kind: 'host' }, serverId: target.serverIdentityId, signal: requestSignal,
                        executionRunTargetMachineId: target.machineId,
                        externalActionTarget: { kind: 'machine', machineId: target.machineId } });
                } catch { result = projectUnexpectedActionFailureV1(null); }
                const pending = result.ok ? ActionApprovalRequestCreatedResultSchema.safeParse(result.result) : null;
                return pending?.success && pending.data.actionId === 'plugins.install'
                    // The review reads its Artifact on this device's profile for that Home (the portable
                    // identity is not a profile id); an unknown Home keeps the identity and reads as unavailable.
                    ? { kind: 'approval', target, targetLabel, artifactId: pending.data.artifactId,
                        serverId: readHomeProfileId(target.serverIdentityId) }
                    : { kind: 'settled', target, targetLabel, result };
            })));
        if (isCurrent()) setRetained({ review: { pluginId: entry.id, rows }, isCurrent });
    }, [account, execute, params.resolveInstallEntry, params.candidates, params.getSignal]);
    return { review: retained?.isCurrent() ? retained.review : null, run };
}
