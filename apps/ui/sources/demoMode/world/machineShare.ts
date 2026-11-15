import type { useMachineShareController, MachineShareGrantRow } from '@/components/sharing/machines/useMachineShareController';
import { presentMachineAuthorityV1 } from '@happier-dev/protocol/machines/machineAuthorityV1';
import { buildDemoSessionShareModel } from './sessionShare';
import { DEMO_MACHINE_ID } from './constants';
import { buildDemoMachines } from './machines';

const noop = () => {};
const refuse = async () => ({ ok: false as const, errorCode: 'demo_read_only', error: 'demo_read_only' });

/** Local display facts only; the demo never creates Machine access or audience keys. */
export function buildDemoMachineShareController(): ReturnType<typeof useMachineShareController> {
    const sessionShare = buildDemoSessionShareModel();
    const machine = buildDemoMachines().find(candidate => candidate.id === DEMO_MACHINE_ID);
    const authority = presentMachineAuthorityV1({ platform: machine?.metadata?.platform,
        isolationPolicy: machine?.metadata?.agentIsolation, isolation: machine?.daemonState?.agentIsolation });
    const grants: MachineShareGrantRow[] = sessionShare.grants.map(row => ({
        grant: row.grant, principal: row.principal,
        level: { kind: 'locked', value: row.level.value === 'admin' ? 'admin' : 'view',
            reason: { code: 'demo_read_only', message: row.level.kind === 'locked' ? row.level.reason.message : '' } },
        removal: row.removal, operation: row.operation,
        removalConsequences: [], readiness: 'ready', audience: [], canPrepareKeys: false,
    }));
    return {
        model: { revision: 1, editable: false, stale: false, owner: sessionShare.owner, grants,
            directory: { query: '', sections: [] } },
        actions: { setQuery: noop, retryDirectory: noop, loadMore: noop, addPrincipal: noop, retryMutation: noop,
            setAccessLevel: noop, requestRemove: noop, confirmRemove: noop, cancelRemove: noop, explain: noop },
        response: null,
        guestExecution: { machineId: DEMO_MACHINE_ID, serverId: null, placement: authority.separateUsers.placement,
            availability: authority.separateUsers.availability, isolation: authority.isolation,
            runAs: authority.separateUsers.availability.kind === 'unavailable' ? null : authority.separateUsers.placement,
            canChooseRunAs: false, canEnableSeparateUsers: false,
            previewSeparateUsers: refuse, applySeparateUsers: refuse },
        viewerRow: null, inherited: [], canLeave: false, loading: false, issue: undefined, notice: undefined,
        retryContent: async () => {}, approvalId: null, prepareKeys: noop,
    };
}
