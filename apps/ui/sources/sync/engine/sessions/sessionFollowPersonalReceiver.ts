import { evaluateSessionFollowRuleOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import { SESSION_FOLLOW_ZERO_FRONTIER_V1, isSessionFollowFrontierEqualV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { isFollowDeliveryMutedV1, type FollowDeliveryMuteScopeV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import type { SessionFollowPersonalProgressRequestV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import type { AcquiredSessionFollowRulesSnapshot } from '@/sync/api/session/sessionFollowRulesApi';
import type { SessionFollowPersonalReceiverOccurrence } from '@/sync/api/session/sessionFollowPersonalReceiverApi';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { log } from '@/log';

type ReceiverProgress = Extract<SessionFollowPersonalProgressRequestV1, { evaluation: 'receiver' }>;

/** Reflect accepted server progress into the existing private census, never a second cursor. */
function reflectProgress(snapshot: AcquiredSessionFollowRulesSnapshot, progress: ReceiverProgress): AcquiredSessionFollowRulesSnapshot {
    let changed = false;
    const rules = snapshot.rules.map(rule => {
        if (!progress.rules.some(witness => witness.ruleId === rule.ruleId && witness.ruleVersion === rule.version)) return rule;
        const previous = rule.sources?.find(source => source.sourceSessionId === progress.sourceSessionId)?.delivered ?? SESSION_FOLLOW_ZERO_FRONTIER_V1;
        const delivered = { ...previous, ...('sourceTurn' in progress ? {
            turn: progress.sourceTurn, readyEventSeq: Math.max(previous.readyEventSeq, progress.terminalSourceMessage.seq),
        } : 'sourceMessage' in progress && progress.sourceMessage ? {
            transcriptSeq: Math.max(previous.transcriptSeq, progress.sourceMessage.seq),
        } : { agentStateVersion: Math.max(previous.agentStateVersion, progress.sourceRequests!.agentStateVersion) }) };
        if (isSessionFollowFrontierEqualV1(previous, delivered)) return rule;
        changed = true;
        return { ...rule, sources: [...(rule.sources ?? []).filter(source => source.sourceSessionId !== progress.sourceSessionId),
            { sourceSessionId: progress.sourceSessionId, delivered }] };
    });
    return changed ? { ...snapshot, rules } : snapshot;
}

/** The captured app Account evaluates originals; settlement and dedupe stay with Follow. */
export function createSessionFollowPersonalReceiverRuntime(input: Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    readInputs(): Readonly<{ snapshot: AcquiredSessionFollowRulesSnapshot | null;
        mutedScopes: readonly FollowDeliveryMuteScopeV1[] | null }>;
    readSourceSessionIds(): readonly string[];
    acceptedProgress(previous: AcquiredSessionFollowRulesSnapshot, next: AcquiredSessionFollowRulesSnapshot): void;
    pending(occurrence: SessionFollowPersonalReceiverOccurrence, pending: boolean): void;
}>) {
    const controller = new AbortController();
    const demanded = new Set<string>();
    let running: Promise<void> | null = null;
    const current = () => !controller.signal.aborted && input.lifetime.isCurrent();
    const dispose = () => { controller.abort(); demanded.clear(); };
    const retirement = input.lifetime.onRetire(dispose);
    const consume = async (occurrence: SessionFollowPersonalReceiverOccurrence) => {
        const { snapshot, mutedScopes } = input.readInputs();
        if (!snapshot || mutedScopes === null || !current()) return false;
        const sourceMuted = isFollowDeliveryMutedV1(mutedScopes, { senderSessionId: occurrence.sourceSessionId,
            source: { kind: 'session', sessionId: occurrence.sourceSessionId } });
        const rules = snapshot.rules.filter(rule => rule.receiver.kind === 'account'
            && !isFollowDeliveryMutedV1(mutedScopes, { senderSessionId: occurrence.sourceSessionId, source: { kind: 'rule', ruleId: rule.ruleId } }));
        const evaluate = (evidence: SessionFollowPersonalReceiverOccurrence['evidence'], createdAt: number | undefined) => evaluateSessionFollowRuleOccurrenceV1({ accountId: input.lifetime.scope.accountId,
            evaluator: 'receiver', sourceSessionId: occurrence.sourceSessionId, production: occurrence.production,
            evidence, currentFacts: occurrence.currentFacts,
            rules: rules.filter(rule => rule.inception !== undefined && createdAt !== undefined && createdAt >= rule.inception.createdAt),
            personalFollowSuppressed: occurrence.personalFollowSuppressed,
            ...(sourceMuted ? { mutedReceivers: [{ kind: 'account' as const }] } : {}),
        });
        const original = occurrence.original;
        const fields = { evaluation: 'receiver' as const, production: occurrence.production, sourceSessionId: occurrence.sourceSessionId };
        let progress: ReceiverProgress;
        const selectedPolicies: FollowPolicyV1[] = [];
        if ('sourceRequests' in original) {
            const references = new Map<string, { ruleId: string; ruleVersion: number; requestIds: string[] }>();
            let unresolved = false;
            for (const request of original.sourceRequests.requests) {
                const evidence = original.requestEvidence.find(item => item.requestId === request.requestId)?.evidence;
                if (!evidence) return false;
                const evaluated = evaluate(evidence, request.createdAt);
                if (evaluated.status === 'other_evaluator') return true;
                unresolved ||= evaluated.pendingRuleIds.length > 0;
                const route = evaluated.routes.find(route => route.receiver.kind === 'account');
                selectedPolicies.push(...route?.policies ?? []);
                for (const rule of route?.rules ?? []) {
                    const selected = references.get(rule.ruleId) ?? { ruleId: rule.ruleId, ruleVersion: rule.version, requestIds: [] };
                    selected.requestIds.push(request.requestId);
                    references.set(rule.ruleId, selected);
                }
            }
            if (!references.size) return !unresolved;
            // One state-version frontier represents the complete current map;
            // settling one request at a time would consume its siblings.
            progress = { ...fields, sourceRequests: original.sourceRequests, rules: [...references.values()] };
        } else {
            const evaluated = evaluate(occurrence.evidence, occurrence.originalCreatedAt);
            if (evaluated.status === 'other_evaluator') return true;
            const route = evaluated.routes.find(route => route.receiver.kind === 'account');
            if (!route) return evaluated.pendingRuleIds.length === 0;
            selectedPolicies.push(...route.policies);
            const references = route.rules.map(rule => ({ ruleId: rule.ruleId, ruleVersion: rule.version }));
            if ('sourceTurn' in original) {
                if (!occurrence.terminalSourceMessage) return false;
                progress = { ...fields, rules: references, sourceTurn: original.sourceTurn, terminalSourceMessage: occurrence.terminalSourceMessage };
            } else progress = { ...fields, rules: references, sourceMessage: original.sourceMessage };
        }
        input.pending(occurrence, true);
        if (!occurrence.isRepresentedInInbox(selectedPolicies, progress.rules)) return false;
        const { submitSessionFollowPersonalReceiverProgress } = await import('@/sync/api/session/sessionFollowPersonalReceiverApi');
        const result = await submitSessionFollowPersonalReceiverProgress({ lifetime: input.lifetime, snapshot, progress, signal: controller.signal });
        if (!current() || !result.accepted) return false;
        // Inbox remains the source-backed Activity projection. No notification,
        // read-state or persisted viewer writer is introduced by this adapter.
        const latest = input.readInputs().snapshot;
        if (latest && latest.credentialScopeKey === snapshot.credentialScopeKey && latest.mode === snapshot.mode) {
            input.acceptedProgress(latest, reflectProgress(latest, progress));
        }
        input.pending(occurrence, false);
        return true;
    };
    const run = async () => {
        while (demanded.size && current()) {
            const { snapshot, mutedScopes } = input.readInputs();
            if (!snapshot || mutedScopes === null) return;
            const sourceSessionIds = [...demanded];
            demanded.clear();
            try {
                const { visitSessionFollowPersonalReceiverOriginals } = await import('@/sync/api/session/sessionFollowPersonalReceiverApi');
                await visitSessionFollowPersonalReceiverOriginals({ lifetime: input.lifetime, snapshot, sourceSessionIds,
                    signal: controller.signal, onOccurrence: consume });
            } catch (error) {
                // Failed or locked reads leave originals and server progress
                // untouched. The next existing catch-up/configuration wake retries.
                if (!controller.signal.aborted) {
                    log.log(`[session-follow] Personal receiver catch-up read failed reason=${error instanceof Error ? error.name : typeof error}`);
                }
            }
        }
    };
    const reconcile = (sourceSessionIds = input.readSourceSessionIds()) => {
        if (!current()) return;
        for (const id of sourceSessionIds) demanded.add(id);
        if (!running) {
            running = Promise.resolve().then(run).finally(() => { running = null; });
        }
    };
    const stopChanges = subscribeHomeAccountChange(event => {
        if (!current() || !areServerProfileIdentifiersEquivalent(event.serverId, input.lifetime.scope.serverId)) return;
        if (event.changeKinds !== undefined && !event.changeKinds.some(kind => kind === 'session' || kind === 'share')) return;
        reconcile(event.entityIds ?? input.readSourceSessionIds());
    }, { reconnect: 'refresh' });
    return { reconcile, dispose() { dispose(); retirement.dispose(); stopChanges(); } };
}
