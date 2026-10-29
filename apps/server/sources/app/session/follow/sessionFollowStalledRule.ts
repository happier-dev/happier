import { isDeepStrictEqual } from 'node:util';
import { SESSION_FOLLOW_ZERO_FRONTIER_V1, isSessionFollowTurnEqualV1, type SessionFollowFrontierV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { isSessionFollowStalledOccurrenceCurrentV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceOccurrenceV1';
import { parseSessionFollowRulePhysicalKeyV1, buildSessionFollowRulePhysicalKeyV1, type SessionFollowPersonalProgressRequestV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { mergeSessionFollowSelectedDeliveriesV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import type { SessionFollowSessionPendingObservationV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { mutateReservedAccountScopedKvRowInTx } from '@/app/kv/reservedAccountScopedKvRow';
import { mayInjectSessionContextInTx } from '@/app/session/access/sessionContextInjection';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { invalidateSessionRelationProjectionsInTx } from '@/app/session/relations/sessionRelationChanges';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { TransactionReplayRequiredError, type Tx } from '@/storage/inTx';
import { accountFollowRuleRowDomain, listAccountFollowRuleRowsInTx } from './accountFollowRuleService';
import { readSessionFollowRuleProgressInTx, writeSessionFollowRuleProgressInTx, type SessionFollowRuleProgressAdmission } from './sessionFollowRuleProgress';
import { createDeliveryMuteReaderInTx } from './sessionDeliveryMuteService';
import { readCurrentSourceSessionFollowFrontier, type SessionFollowSourceFrontierRow } from '@/app/session/relations/sessionEdgeFrontier';

type StalledRuleSelection = Extract<SessionFollowPersonalProgressRequestV1, { kind: 'session_stalled' }>;
type RuleObservation = Extract<SessionFollowSessionPendingObservationV1, { relation: 'rule' }>;
const sourceSelect = { id: true, active: true, lastActiveAt: true, latestTurnId: true, latestTurnStatus: true, archivedAt: true,
    seq: true, latestReadyEventSeq: true, agentStateVersion: true } as const;

/** The private Account executor admits its match; Home never opens its rule. */
export async function admitStalledSessionFollowRulesInTx(tx: Tx, input: Readonly<{
    accountId: string; authentication: SessionAccessAuthentication; selection: StalledRuleSelection;
}>) {
    const selection = input.selection;
    const [source, destination] = await Promise.all([
        tx.session.findUnique({ where: { id: selection.sourceSessionId }, select: sourceSelect }),
        tx.session.findUnique({ where: { id: selection.destinationSessionId }, select: { accountId: true, archivedAt: true } }),
    ]);
    if (!source || destination?.accountId !== input.accountId || destination.archivedAt !== null
        || !isSessionFollowStalledOccurrenceCurrentV1(selection.presence, { ...source, activeAt: source.lastActiveAt.getTime() })
        || !(await mayInjectSessionContextInTx(tx, { authentication: input.authentication, sourceSessionId: source.id,
            destinationSessionId: selection.destinationSessionId, configuringAccountId: input.accountId })).ok)
        return { accepted: false, alreadyRepresented: false };
    const muted = createDeliveryMuteReaderInTx(tx, { accountId: input.accountId,
        receiver: { kind: 'session', sessionId: selection.destinationSessionId } });
    let accepted = false;
    let alreadyRepresented = true;
    for (const rule of selection.rules) {
        const progress = await readSessionFollowRuleProgressInTx(tx, { accountId: input.accountId, rule,
            sourceSessionId: source.id, destinationSessionId: selection.destinationSessionId });
        if (!progress || await muted({ senderSessionId: source.id, source: { kind: 'session', sessionId: source.id } }) !== false
            || await muted({ senderSessionId: source.id, source: { kind: 'rule', ruleId: rule.ruleId } }) !== false) continue;
        accepted = true;
        const turn = { id: selection.presence.turnId, status: 'stalled' as const };
        if (isSessionFollowTurnEqualV1(progress.delivered.turn, turn)) continue;
        alreadyRepresented = false;
        const stalled = { ruleVersion: rule.ruleVersion, presence: selection.presence, effectiveDelivery: rule.selectedDelivery };
        const previous = progress.envelope.sources?.find(entry => entry.sourceSessionId === source.id);
        if (isDeepStrictEqual(previous?.stalled, stalled)) continue;
        const sources = (progress.envelope.sources ?? []).filter(entry => entry.sourceSessionId !== source.id);
        sources.push({ sourceSessionId: source.id, delivered: progress.delivered, stalled });
        const result = await mutateReservedAccountScopedKvRowInTx(tx, { accountId: input.accountId,
            physicalKey: buildSessionFollowRulePhysicalKeyV1(rule.ruleId), expectedRevision: progress.revision,
            envelope: { ...progress.envelope, sources }, domain: accountFollowRuleRowDomain,
            markChanged: async ({ tx: changedTx }) => {
                const changes = await invalidateSessionRelationProjectionsInTx(changedTx, [selection.destinationSessionId]);
                const change = changes.find(entry => entry.accountId === input.accountId);
                if (!change) throw new Error('Follow stalled selection requires receiver publication');
                return change;
            } });
        if (result.status !== 'updated') throw new TransactionReplayRequiredError('follow-rule-progress-conflict');
    }
    return { accepted, alreadyRepresented: accepted && alreadyRepresented };
}

/** Private progress stays here; runtime readers receive only an aggregate vote. */
export async function readStalledSessionFollowRulesInTx(tx: Tx, input: Readonly<{
    accountId: string; destinationSessionId: string; sourceSessionId?: string; includeRepresented?: true;
    readMuted?: ReturnType<typeof createDeliveryMuteReaderInTx>;
}>) {
    const listed = await listAccountFollowRuleRowsInTx(tx, input);
    if (listed.status !== 'listed') return [];
    const candidates: { progress: SessionFollowRuleProgressAdmission;
        stalled: NonNullable<NonNullable<SessionFollowRuleProgressAdmission['envelope']['sources']>[number]['stalled']> }[] = [];
    for (const row of listed.rows) {
        const envelope = row.envelope;
        const ruleId = parseSessionFollowRulePhysicalKeyV1(row.physicalKey);
        if (!envelope || !ruleId || envelope.receiver.kind !== 'session' || envelope.receiver.sessionId !== input.destinationSessionId) continue;
        for (const entry of envelope.sources ?? []) {
            if (!entry.stalled || entry.stalled.ruleVersion !== envelope.version
                || input.sourceSessionId && entry.sourceSessionId !== input.sourceSessionId
                || !input.includeRepresented && isSessionFollowTurnEqualV1(entry.delivered.turn,
                    { id: entry.stalled.presence.turnId, status: 'stalled' })) continue;
            candidates.push({ progress: { accountId: input.accountId, destinationSessionId: input.destinationSessionId,
                sourceSessionId: entry.sourceSessionId, rule: { ruleId, ruleVersion: envelope.version },
                revision: row.revision, envelope, delivered: entry.delivered, encountered: true }, stalled: entry.stalled });
        }
    }
    const sources = new Map<string, SessionFollowSourceFrontierRow & { id: string; lastActiveAt: Date; archivedAt: Date | null }>();
    for (const ids of portableQueryChunks({ values: [...new Set(candidates.map(entry => entry.progress.sourceSessionId))],
        bindingsPerValue: 1, fixedBindings: 0 })) {
        for (const source of await tx.session.findMany({ where: { id: { in: [...ids] } }, select: sourceSelect })) sources.set(source.id, source);
    }
    const muted = input.readMuted ?? createDeliveryMuteReaderInTx(tx, { accountId: input.accountId,
        receiver: { kind: 'session', sessionId: input.destinationSessionId } });
    const grouped = new Map<string, { observation: RuleObservation; progress: SessionFollowRuleProgressAdmission[] }>();
    for (const { progress, stalled } of candidates) {
        const source = sources.get(progress.sourceSessionId);
        if (!source || !isSessionFollowStalledOccurrenceCurrentV1(stalled.presence, { ...source, activeAt: source.lastActiveAt.getTime() })
            || await muted({ senderSessionId: source.id, source: { kind: 'session', sessionId: source.id } }) !== false
            || await muted({ senderSessionId: source.id, source: { kind: 'rule', ruleId: progress.rule.ruleId } }) !== false) continue;
        const group = grouped.get(source.id);
        if (group) {
            group.observation.effectiveDelivery = mergeSessionFollowSelectedDeliveriesV1([
                group.observation.effectiveDelivery, stalled.effectiveDelivery ])!;
            group.progress.push(progress);
        } else grouped.set(source.id, { observation: { sourceSessionId: source.id, destinationSessionId: input.destinationSessionId,
            relation: 'rule', effectiveDelivery: stalled.effectiveDelivery, presence: stalled.presence,
            // A public Turn fact, not a copy of any private rule's consumption cursor.
            delivered: SESSION_FOLLOW_ZERO_FRONTIER_V1,
            observed: readCurrentSourceSessionFollowFrontier(source) }, progress: [progress] });
    }
    return [...grouped.values()];
}

/** Provider acceptance is checked by the incumbent no-original ACK owner first. */
export async function acknowledgeStalledSessionFollowRulesInTx(tx: Tx,
    progress: readonly SessionFollowRuleProgressAdmission[], consumed: SessionFollowFrontierV1): Promise<void> {
    for (const entry of progress) {
        if (!await writeSessionFollowRuleProgressInTx(tx, entry, { ...entry.delivered, turn: consumed.turn }))
            throw new TransactionReplayRequiredError('follow-rule-progress-conflict');
    }
}
