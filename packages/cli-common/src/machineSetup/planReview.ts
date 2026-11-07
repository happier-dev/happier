import { createHash } from 'node:crypto';
import { MachineSetupEffectPlanV1Schema, type MachineSetupEffectPlanV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

type PlanContents = Omit<MachineSetupEffectPlanV1, 'v' | 'planDigest'>;
export type MachineSetupPlanComparisonV1 = Readonly<{
    targetChanged: boolean;
    fields: readonly Readonly<{ field: string; reviewedHash: string; currentHash: string }>[];
}>;

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        const object = value as Record<string, unknown>;
        return `{${Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Setup plans contain only admitted JSON');
    return encoded;
}
function hash(value: unknown): string {
    return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Review binds the target, not the changing distance from current state to it.
 * Native principal custody and Git configuration selection are distinct from
 * convergence observations such as PIDs, lock state, ACLs and tree snapshots.
 * Native owners still check prerequisites, provenance and each effect at Apply. */
function reviewedTarget(value: PlanContents) {
    const operation = { v: 1, basis: value.basis,
        steps: value.steps,
        ...(value.checks !== undefined ? { checks: value.checks } : {}),
        ...(value.selectedCheckIds !== undefined ? { selectedCheckIds: value.selectedCheckIds } : {}) };
    if (value.basis.kind !== 'agentIsolation') return operation;
    const { expectedPolicy: _policy, ...basis } = value.basis;
    return { ...operation, basis, nativeTargets: value.steps.map((step, index) => {
        const facts = value.nativeFacts[index]?.facts ?? {};
        switch (step.kind) {
            case 'user': {
                const { present, username, uid, gid, home, availableUid } = facts;
                return { present, username, uid, gid, home, availableUid };
            }
            case 'group': return { present: facts.present, gid: facts.gid };
            case 'workspaceAccess': return { agentUid: facts.agentUid, groupId: facts.groupId, gitMetadata: facts.gitMetadata };
            case 'pathTraversal': return { agentUid: facts.agentUid };
            case 'command': return 'kind' in step.check && step.check.kind === 'userManagerGroups' ? { uid: facts.uid, gid: facts.gid } : null;
            default: return null;
        }
    }) };
}

export function createMachineSetupEffectPlan(input: PlanContents): MachineSetupEffectPlanV1 {
    return MachineSetupEffectPlanV1Schema.parse({ v: 1, ...input, planDigest: hash(reviewedTarget(input)) });
}

/** Retained Workflow plans keep their recorded full-value hash; current
 * comparison uses their target without rewriting the retained record. */
export function readMachineSetupEffectPlanV1(value: unknown): MachineSetupEffectPlanV1 | null {
    const parsed = MachineSetupEffectPlanV1Schema.safeParse(value);
    if (!parsed.success) return null;
    const { v: _version, planDigest, ...contents } = parsed.data;
    if (hash(reviewedTarget(contents)) === planDigest || hash({ v: 1, ...contents }) === planDigest) return parsed.data;
    return null;
}

/** Content-free native CHECK/APPLY evidence. No step ids, paths, account names
 * or fact values enter this diagnostic; array indices identify the compared step. */
export function compareMachineSetupEffectPlansV1(reviewed: MachineSetupEffectPlanV1,
    current: MachineSetupEffectPlanV1): MachineSetupPlanComparisonV1 {
    const fields: Array<MachineSetupPlanComparisonV1['fields'][number]> = [];
    const compare = (field: string, before: unknown, after: unknown) => {
        const reviewedHash = hash(before === undefined ? { absent: true } : { value: before });
        const currentHash = hash(after === undefined ? { absent: true } : { value: after });
        if (reviewedHash !== currentHash) fields.push({ field, reviewedHash, currentHash });
    };
    compare('basis', reviewed.basis, current.basis);
    compare('steps', reviewed.steps, current.steps);
    compare('checks', reviewed.checks, current.checks);
    compare('selectedCheckIds', reviewed.selectedCheckIds, current.selectedCheckIds);
    compare('checkFacts', reviewed.checkFacts, current.checkFacts);
    for (let index = 0; index < Math.max(reviewed.nativeFacts.length, current.nativeFacts.length); index++) {
        const before = reviewed.nativeFacts[index], after = current.nativeFacts[index];
        compare(`nativeFacts[${index}].stepId`, before?.stepId, after?.stepId);
        compare(`nativeFacts[${index}].status`, before?.status, after?.status);
        compare(`nativeFacts[${index}].reason`, before?.reason, after?.reason);
        const keys = new Set([...Object.keys(before?.facts ?? {}), ...Object.keys(after?.facts ?? {})]);
        if ([...keys].some(key => !/^[A-Za-z][A-Za-z0-9_]*$/.test(key))) {
            compare(`nativeFacts[${index}].facts`, before?.facts, after?.facts);
        } else for (const key of [...keys].sort()) {
            compare(`nativeFacts[${index}].facts.${key}`, before?.facts[key], after?.facts[key]);
        }
    }
    return { targetChanged: hash(reviewedTarget(reviewed)) !== hash(reviewedTarget(current)), fields };
}
