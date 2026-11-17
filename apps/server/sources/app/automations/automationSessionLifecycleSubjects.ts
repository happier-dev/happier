import type { Prisma } from '@prisma/client';
import {
    automationSubjectKeyV1, automationSubjectKeyMatchesV1,
    type AutomationSubjectContextV1,
} from '@happier-dev/protocol/automations/automationSubjectV1';

import { readRetainedCommittedSessionInputMachineTarget } from '@/app/session/messages/sessionInputAdmission';
import { getTransactionContext, type Tx } from '@/storage/inTx';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { portableQueryChunks } from '@/storage/portableQueryChunks';

export type AutomationSessionLifecycleSourceSubjects = Readonly<{
    sessionId: string;
    ownerAccountId: string;
    contexts: readonly AutomationSubjectContextV1[];
}>;

export type AutomationSessionLifecycleSourceFacts = Readonly<{
    id: string;
    accountId: string;
    projectKey: string | null;
    runtimeMachineTarget: unknown;
}>;

/** Consume the producer's existing Session row, without re-reading its write. */
export function projectAutomationSessionLifecycleSourceSubjects(
    serverId: string | null,
    session: AutomationSessionLifecycleSourceFacts,
): AutomationSessionLifecycleSourceSubjects {
    const placement = readRetainedCommittedSessionInputMachineTarget(session);
    return { sessionId: session.id,
        ownerAccountId: session.accountId,
        contexts: serverId === null ? [] : [
                { role: 'operand' as const, subject: { kind: 'session' as const, serverId, sessionId: session.id } },
                ...(session.projectKey === null ? [] : [{ role: 'context' as const,
                    subject: { kind: 'project' as const, serverId, projectKey: session.projectKey } }]),
                ...(placement?.homeId !== serverId ? [] : [{ role: 'context' as const,
                    subject: { kind: 'machine' as const, serverId, machineId: placement.machineId } }]),
            ],
    };
}

/** Discover demanded candidate Accounts once; an empty bucket does no ACL work.
 * The source owner consumes its admitted fan-out set. Other candidates resolve
 * visibility and admit in their own short transactions after source commit. */
export function buildAutomationSessionLifecycleCandidateWheres(
    sources: readonly Pick<AutomationSessionLifecycleSourceSubjects, 'contexts'>[],
): readonly Prisma.AutomationTriggerWhereInput[] {
    const selections = new Map<string, Readonly<{ subjectKind: string | null; subjectKey: string | null }>>();
    for (const source of sources) {
        const subjects = [{ subjectKind: null, subjectKey: null }, ...source.contexts.map(context => ({
            subjectKind: context.subject.kind, subjectKey: automationSubjectKeyV1(context.subject),
        }))];
        for (const subject of subjects) {
            selections.set(JSON.stringify(subject), subject);
        }
    }
    // At most two identity bindings per branch. Kind and
    // Prisma's portable offset are the statement's two fixed bindings.
    return portableQueryChunks({ values: [...selections.values()], bindingsPerValue: 2, fixedBindings: 2 })
        .map(chunk => ({ kind: 'sessionLifecycle', deletedAt: null,
            // Legacy exact-source rows also have null subject columns. Their
            // explicit one-time migration must precede current matching.
            definitionEnvelope: { not: null },
            automation: { deletedAt: null },
            OR: [...chunk],
        }));
}

const SESSION_LIFECYCLE_CANDIDATE_SELECT = {
    id: true,
    automationId: true,
    enabled: true,
    revision: true,
    sessionLifecycleEventsJson: true,
    sessionLifecyclePolicyKind: true,
    sessionLifecycleMatchCount: true,
    remainingOccurrences: true,
    subjectKind: true,
    subjectKey: true,
    sourceSessionId: true,
    sourceTurnId: true,
    automation: { select: { accountId: true, enabled: true, scopeSessionId: true } },
} as const;
export type SessionLifecycleCandidateRow = Prisma.AutomationTriggerGetPayload<{
    select: typeof SESSION_LIFECYCLE_CANDIDATE_SELECT;
}>;

type PreparedSessionLifecycleCandidates = Readonly<{
    source: AutomationSessionLifecycleSourceSubjects;
    rows: readonly SessionLifecycleCandidateRow[];
}>;
const preparedSessionLifecycleCandidates = Symbol('prepared-session-lifecycle-candidates');
type SessionLifecycleCandidateContext = {
    [preparedSessionLifecycleCandidates]?: Map<string, PreparedSessionLifecycleCandidates>;
};

/**
 * One source operation prepares its indexed candidates before publication locks.
 * Admission consumes those same row facts; birth and SQLite prepare here directly.
 * This transaction-local projection adds no authority or later currentness check.
 */
export async function readAutomationSessionLifecycleCandidatesInTx(
    tx: Tx,
    sessions: readonly AutomationSessionLifecycleSourceFacts[],
): Promise<readonly PreparedSessionLifecycleCandidates[]> {
    const context = getTransactionContext(tx, { optional: true }) as SessionLifecycleCandidateContext | undefined;
    const prepared = context ? (context[preparedSessionLifecycleCandidates] ??= new Map()) : new Map<string, PreparedSessionLifecycleCandidates>();
    const missing = sessions.filter(session => !prepared.has(session.id));
    if (missing.length > 0) {
        const serverId = await readCurrentServerIdentityId(process.env, tx);
        const sources = missing.map(session => projectAutomationSessionLifecycleSourceSubjects(serverId, session));
        const rows = (await Promise.all(buildAutomationSessionLifecycleCandidateWheres(sources)
            .map(where => tx.automationTrigger.findMany({
                where, orderBy: { id: 'asc' }, select: SESSION_LIFECYCLE_CANDIDATE_SELECT,
            })))).flat();
        for (const source of sources) prepared.set(source.sessionId, {
            source,
            rows: rows.filter(row => row.subjectKey === null || automationSubjectKeyMatchesV1(
                row.subjectKey, source.contexts, undefined, row.subjectKind ?? undefined,
            )),
        });
    }
    return sessions.map(session => prepared.get(session.id)!);
}
