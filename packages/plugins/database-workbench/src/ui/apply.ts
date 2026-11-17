import { DATABASE_EDITS_APPLY_ACTION_ID_V1, type DatabaseDescriptorV1, type DatabaseRelationV1 } from '@happier-dev/database-protocol';
import type { PluginUiActionControlController } from '@happier-dev/plugin-sdk/ui';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { createStagedEdits } from './drafts.js';
import type { WorkbenchApplyOutcome, WorkbenchChange, WorkbenchControlBinding } from './models.js';
import { databaseActionSettlement } from './actionSettlement.js';
import { sameRelation } from './location.js';

type ApplyHost = Readonly<{
    drafts: ReturnType<typeof createStagedEdits<WorkbenchChange>>;
    draftKey(change: WorkbenchChange): string;
    target(targetKey: string): DatabaseDescriptorV1;
    isClosed(): boolean;
    onOutcome(value: WorkbenchApplyOutcome | undefined): void;
}>;

/** Review, staged counts and Apply share the transaction's exact target/relation membership. */
export function selectRelationChanges(changes: readonly WorkbenchChange[], targetKey: string, relation: DatabaseRelationV1 | undefined): readonly WorkbenchChange[] {
    return relation ? changes.filter(item => item.targetKey === targetKey && sameRelation(item.relation, relation)) : [];
}

export function createApplyControl(host: ApplyHost, targetKey: string, relation: DatabaseRelationV1): WorkbenchControlBinding {
    let submitted: readonly WorkbenchChange[] = [];
    const controller: PluginUiActionControlController = {
        prepare({ signal }) {
            if (host.isClosed() || signal.aborted || submitted.length) return null;
            submitted = selectRelationChanges(host.drafts.changes(), targetKey, relation);
            if (!submitted.length) return null;
            host.onOutcome(undefined);
            return { input: projectNativeJsonValueForTransport({ operation: 'edits.apply', target: host.target(targetKey).target, relation, changes: submitted.map(item => item.change) }) };
        },
        onSettled(execution) {
            if (host.isClosed()) return;
            const settled = databaseActionSettlement(execution, 'edits.apply');
            if (settled.status === 'success') {
                const result = settled.result;
                if (result.ok && result.operation === 'edits.apply') {
                    host.drafts.takeBackMany(submitted.filter(item => host.drafts.get(host.draftKey(item)) === item).map(host.draftKey));
                    host.onOutcome({ kind: 'applied', count: String(BigInt(result.inserted) + BigInt(result.updated) + BigInt(result.deleted)), at: new Date().toISOString() });
                } else if (!result.ok && result.status === 'conflict') {
                    host.onOutcome({ kind: 'conflict', rowKey: submitted[result.changeIndex]!.rowKey, why: result.reason });
                } else if (!result.ok && result.status === 'outcome_unknown') {
                    host.onOutcome({ kind: 'unknown', failure: result });
                } else if (!result.ok) host.onOutcome({ kind: 'refused', failure: result });
            } else if (settled.status === 'outcomeUnknown') {
                host.onOutcome({ kind: 'unknown', code: settled.code, message: settled.message });
            } else if (settled.status === 'error') {
                host.onOutcome({ kind: 'refused', code: settled.code, message: settled.message });
            }
            submitted = [];
        },
    };
    return { action: DATABASE_EDITS_APPLY_ACTION_ID_V1, controller };
}
