import type { useMachineShareController, MachineShareGrantRow } from '@/components/sharing/machines/useMachineShareController';
import { buildDemoSessionShareModel } from './sessionShare';

const noop = () => {};
const refuse = async () => ({ ok: false as const, errorCode: 'demo_read_only', error: 'demo_read_only' });

/** Local display facts only; the demo never creates Machine access or audience keys. */
export function buildDemoMachineShareController(): ReturnType<typeof useMachineShareController> {
    const sessionShare = buildDemoSessionShareModel();
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
        guestExecution: { placement: 'daemon', canEnableSeparateUsers: false,
            previewSeparateUsers: refuse, applySeparateUsers: refuse },
        viewerRow: null, inherited: [], canLeave: false, loading: false, issue: undefined, notice: undefined,
        retryContent: async () => {}, approvalId: null, prepareKeys: noop,
    };
}
