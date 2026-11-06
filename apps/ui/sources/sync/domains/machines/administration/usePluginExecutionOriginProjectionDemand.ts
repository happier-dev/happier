import * as React from 'react';
import { getPluginMachineExecutionOriginRef } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { getPluginExecutionOriginCandidateOrigin, type PluginExecutionOriginCandidateV1 } from './pluginExecutionOrigin';

import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';

import { useDaemonMergedProjectionInputs, type DaemonMergedProjectionInputsState } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { useMachinePresenceSummary, type MachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { PLUGIN_UI_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

// Unknown presence needs the first acquisition; execution still requires
// the canonical reachable verdict. Offline and absent Machines stay passive.
function isMachineProjectionDemandable(presence: MachinePresenceSummary): boolean {
    return presence.machineIsKnown === true && presence.reachability !== 'unreachable';
}

/** Demand reads only this verdict, so a rename or an unknown-to-reachable report wakes no demand. */
function sameProjectionDemand(left: MachinePresenceSummary, right: MachinePresenceSummary): boolean {
    return isMachineProjectionDemandable(left) === isMachineProjectionDemandable(right);
}

/** Selected targets and presented picker rows share the same acquisition owner. */
export function usePluginExecutionOriginProjectionDemand(target: MachineAdministrationTargetV1 | null,
    options: Readonly<{ sections?: readonly string[]; accountLifetime?: ActiveServerAccountScopeLifetime | null;
        /** `false`: the caller only acquires and reads no answer back, so answers do not re-render it. */
        observe?: boolean }> = {},
): DaemonMergedProjectionInputsState {
    // A caller's admitted lifetime is the same Home authority: no per-instance credential read here.
    const presence = useMachinePresenceSummary(target?.serverIdentityId, target?.machineId, options.accountLifetime, sameProjectionDemand);
    return useDaemonMergedProjectionInputs({ serverId: target?.serverIdentityId, machineId: target?.machineId,
        enabled: target !== null && isMachineProjectionDemandable(presence),
        accountLifetime: options.accountLifetime, sections: options.sections ?? PLUGIN_UI_SECTIONS, observe: options.observe });
}

/** Portable releases already have Account declarations; source rows need their owning Machine. */
export function readPluginPresentedExecutionOriginProjectionTargets(
    candidates: readonly PluginExecutionOriginCandidateV1[],
): readonly MachineAdministrationTargetV1[] {
    const targets = new Map<string, MachineAdministrationTargetV1>();
    for (const candidate of candidates) {
        if (!('source' in candidate) && candidate.materialization.portableRelease) continue;
        const origin = getPluginExecutionOriginCandidateOrigin(candidate);
        const target = { serverIdentityId: origin.serverIdentityId, machineId: getPluginMachineExecutionOriginRef(origin).machineId };
        targets.set(JSON.stringify([target.serverIdentityId, target.machineId]), target);
    }
    return [...targets.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, target]) => target);
}

function PluginOriginProjectionDemand(props: Readonly<{ target: MachineAdministrationTargetV1 }>) {
    usePluginExecutionOriginProjectionDemand(props.target, { observe: false });
    return null;
}

/** An open picker retains its presented read intent through temporary candidate withdrawal. */
export function PluginPresentedExecutionOriginProjectionDemand(props: Readonly<{
    targets: readonly MachineAdministrationTargetV1[];
}>) {
    const [targets, setTargets] = React.useState(props.targets);
    React.useLayoutEffect(() => {
        setTargets(previous => {
            const keys = new Set(previous.map(target => JSON.stringify([target.serverIdentityId, target.machineId])));
            const added = props.targets.filter(target => !keys.has(JSON.stringify([target.serverIdentityId, target.machineId])));
            return added.length === 0 ? previous : [...previous, ...added];
        });
    }, [props.targets]);
    return React.createElement(React.Fragment, null, targets.map(target => React.createElement(PluginOriginProjectionDemand, {
        key: JSON.stringify([target.serverIdentityId, target.machineId]), target,
    })));
}
