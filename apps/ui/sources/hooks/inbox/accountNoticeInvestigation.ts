import {
    TriageSessionHandoffChoicesV1Schema, TriageSessionHandoffInputV1Schema,
    TriageSessionHandoffSelectionV1Schema, TriageSessionHandoffResultV1Schema, type TriageSessionHandoffChoicesV1,
    type TriageSessionHandoffSelectionV1, type TriageSessionHandoffInputV1, type TriageFailureSubjectV1,
    triageFailureSubjectEntryV1, TriageReadSourceSessionLinksResultV1Schema,
    TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1,
} from '@happier-dev/triage-protocol/v1';
import { ActionApprovalRequestCreatedResultSchema, isActionOutcomeUnknownErrorCodeV1,
    type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readAccountNoticeArtifactHeader, type AccountNoticeArtifact } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { readOwnedNoticeArtifactV1, ACCOUNT_NOTICE_ARTIFACT_KIND_V1,
    type AccountNoticeRecoveryChoiceV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { sameStrictJsonValue, StrictJsonValueSchema, type JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { HealthNoticeInvestigationPlacement } from '@/components/inbox/detail/healthNoticeInvestigation';

/** Native failure surfaces and Inbox use the same configured handoff/recovery owner. */
export type FailureInvestigationSubject = AccountNoticeArtifact | TriageFailureSubjectV1;

export const failureInvestigationSubjectKey = (entry: FailureInvestigationSubject) => 'artifact' in entry ? entry.artifact.id
    : entry.kind === 'managedMachineOperation' || entry.kind === 'backupRun'
        ? JSON.stringify([entry.kind, entry.operation.serverId, entry.operation.machineId, entry.operation.operationId])
        : entry.kind === 'deploymentReceipt' ? JSON.stringify([entry.kind, entry.serverId, entry.environmentId, entry.deploymentId])
        : entry.kind === 'domain' ? JSON.stringify([entry.kind, entry.serverId, entry.environmentId, entry.domainId])
        : JSON.stringify([entry.kind, entry.target]);

const NO_RECOVERY_CHOICES: readonly AccountNoticeRecoveryChoiceV1[] = Object.freeze([]);

/** Inbox and notice detail share data-only intent. Configured Triage remains
 * the only Session/Agent/placement owner and re-reads native evidence on execution. */
export function createAccountNoticeInvestigation(input: Readonly<{
    scope: ServerAccountScope | null;
    isCurrent(): boolean;
    captureCurrent?(): () => boolean;
    execute: FrontDoorActionExecute;
}>) {
    // Triage owns these opaque identities; the mounted Account owner only
    // carries them across drawer lifetimes and independent notice presses.
    type Operation = { handoff: TriageSessionHandoffInputV1; recovery?: JsonValue; pending?: Promise<ActionExecuteResult> };
    const operations = new Map<string, Operation>();
    const read = (entry: FailureInvestigationSubject) => {
        if (!input.scope || !input.isCurrent()) { operations.clear(); return null; }
        if (!('artifact' in entry)) {
            const home = entry.kind === 'managedMachineOperation' || entry.kind === 'backupRun' ? entry.operation.serverId
                : entry.kind === 'service' ? entry.target.page === 'machine_service' ? entry.target.machine.serverId
                    : entry.target.environment.serverId : entry.serverId;
            return areServerProfileIdentifiersEquivalent(home, input.scope.serverId)
                ? { kind: 'failure' as const, subject: entry } : null;
        }
        const header = readAccountNoticeArtifactHeader(entry.artifact, input.scope.accountId);
        if (!header) return null;
        if (header.source.kind === 'plugin') return header.investigation
            ? { kind: 'entry' as const, entry: header.investigation.entry } : null;
        if (header.source.topic === 'resource_limit' && header.notice?.topic === 'resource_limit') {
            return { kind: 'healthAlert' as const, notice: { kind: 'host' as const, artifactId: entry.artifact.id, source: header.source },
                target: { kind: 'machine' as const, machine: { serverId: input.scope.serverId, machineId: header.notice.machineId } } };
        }
        if (header.source.topic !== 'service_health' || !header.page || !('kind' in header.page)) return null;
        const home = header.page.page === 'machine_service' ? header.page.machine.serverId : header.page.environment.serverId;
        if (!areServerProfileIdentifiersEquivalent(home, input.scope.serverId)) return null;
        return { kind: 'healthAlert' as const, notice: { kind: 'host' as const, artifactId: entry.artifact.id, source: header.source }, target: header.page };
    };
    const context = (signal?: AbortSignal) => {
        const isCurrent = input.captureCurrent?.() ?? input.isCurrent;
        return { surface: 'ui' as const, authority: 'present_user' as const,
        serverId: input.scope?.serverId, expectedAccountId: input.scope?.accountId,
        verifyMachineAdmissionCurrent: async () => isCurrent() && input.isCurrent(), ...(signal ? { signal } : {}) };
    };
    const unavailable = (): ActionExecuteResult => ({ ok: false,
        errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' });
    const outcomeUnknown = (): ActionExecuteResult => ({ ok: false,
        errorCode: 'action_outcome_unknown', error: 'action_outcome_unknown' });
    const executeOperation = (artifactId: string, operation: Operation, signal?: AbortSignal): Promise<ActionExecuteResult> => {
        if (operation.pending) return operation.pending;
        const pending = (async (): Promise<ActionExecuteResult> => {
            try {
                const result = await input.execute('action.invoke', {
                    action: { pluginId: 'happier.triage', localId: 'sessions/run-configured-v1' },
                    input: { v: 1, handoff: operation.handoff,
                        ...(operation.recovery === undefined ? {} : { resumeStart: operation.recovery }) },
                }, context(signal));
                if (!input.isCurrent()) { operations.clear(); return unavailable(); }
                if (operations.get(artifactId) !== operation) return result;
                if (!result.ok) {
                    if (operation.recovery === undefined && !isActionOutcomeUnknownErrorCodeV1(result.errorCode)
                        && result.effectAttempted !== true) operations.delete(artifactId);
                    return result;
                }
                const value = result.result;
                const handoff = value && typeof value === 'object' && 'handoff' in value
                    ? TriageSessionHandoffResultV1Schema.safeParse(value.handoff) : null;
                if (!handoff?.success) {
                    if (ActionApprovalRequestCreatedResultSchema.safeParse(value).success) operations.delete(artifactId);
                    return result;
                }
                if (handoff.data.kind === 'composed' || handoff.data.kind === 'sendResult') operations.delete(artifactId);
                else if (value && typeof value === 'object' && 'recovery' in value && value.recovery !== undefined) {
                    const recovery = StrictJsonValueSchema.safeParse(value.recovery);
                    if (recovery.success) operation.recovery = recovery.data;
                } else if (handoff.data.kind !== 'uncertain') operations.delete(artifactId);
                return result;
            } catch {
                if (!input.isCurrent()) { operations.clear(); return unavailable(); }
                return outcomeUnknown();
            }
        })();
        operation.pending = pending;
        void pending.then(() => { if (operation.pending === pending) operation.pending = undefined; });
        return pending;
    };
    const resume = (entry: FailureInvestigationSubject, options?: Readonly<{ signal?: AbortSignal }>): Promise<ActionExecuteResult> | null => {
        if (!read(entry) || options?.signal?.aborted) return Promise.resolve(unavailable());
        const operation = operations.get(failureInvestigationSubjectKey(entry));
        if (!operation) return null;
        if (operation.pending) return operation.pending;
        return operation.recovery === undefined ? Promise.resolve(outcomeUnknown())
            : executeOperation(failureInvestigationSubjectKey(entry), operation, options?.signal);
    };
    const recoveryChoices = (entry: AccountNoticeArtifact): readonly AccountNoticeRecoveryChoiceV1[] => {
        if (!input.scope || !input.isCurrent()) return NO_RECOVERY_CHOICES;
        const header = readAccountNoticeArtifactHeader(entry.artifact, input.scope.accountId);
        if (!header || header.status !== 'open' || header.resolved || header.healthPhase !== 'open'
            || header.source.kind !== 'host' || header.source.topic !== 'service_health'
            || !header.page || !('kind' in header.page) || header.page.page !== 'environment'
            || !areServerProfileIdentifiersEquivalent(header.page.environment.serverId, input.scope.serverId)) return NO_RECOVERY_CHOICES;
        return entry.header.recoveryChoices && sameStrictJsonValue(entry.header.recoveryChoices, header.recoveryChoices)
            ? entry.header.recoveryChoices : NO_RECOVERY_CHOICES;
    };
    return {
        dispose: () => operations.clear(),
        resume,
        /** Relationship truth comes from Triage's existing persisted entry link,
         * never from the transient admission/recovery custody above. */
        async readLinkedSession(subject: TriageFailureSubjectV1, options?: Readonly<{ signal?: AbortSignal }>) {
            if (!read(subject) || options?.signal?.aborted) return null;
            const result = await input.execute('action.invoke', {
                action: { pluginId: 'happier.triage', localId: TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1 },
                input: { v: 1, entryRef: triageFailureSubjectEntryV1(subject).entryRef },
            }, context(options?.signal));
            if (!input.isCurrent() || options?.signal?.aborted || !result.ok) return null;
            const links = TriageReadSourceSessionLinksResultV1Schema.safeParse(result.result);
            if (!links.success) return null;
            const latest = links.data.links.reduce<(typeof links.data.links)[number] | null>((previous, link) =>
                !previous || link.linkedAtMs > previous.linkedAtMs ? link : previous, null);
            return latest ? { serverId: input.scope!.serverId, sessionId: latest.sessionId } : null;
        },
        readRecoveryChoices: recoveryChoices,
        async runRecoveryChoice(entry: AccountNoticeArtifact, index: number,
            options?: Readonly<{ signal?: AbortSignal }>): Promise<ActionExecuteResult> {
            const choice = Number.isInteger(index) && index >= 0 ? recoveryChoices(entry)[index] : undefined;
            if (!choice || options?.signal?.aborted || !input.scope) return unavailable();
            const opened = await input.execute('artifact.get', { artifactId: entry.artifact.id }, context(options?.signal));
            if (!opened.ok) return opened;
            if (!input.isCurrent() || options?.signal?.aborted) return unavailable();
            const parsed = ArtifactActionOutputSchemasV1['artifact.get'].safeParse(opened.result);
            const current = parsed.success ? parsed.data.artifact : null;
            const notice = current && readOwnedNoticeArtifactV1(current, input.scope.accountId);
            if (!current || current.artifactId !== entry.artifact.id || !notice || notice.kind !== ACCOUNT_NOTICE_ARTIFACT_KIND_V1
                || notice.status !== 'open' || notice.resolved || notice.healthPhase !== 'open'
                || current.revision.headerVersion !== entry.artifact.headerVersion
                || current.revision.bodyVersion !== entry.artifact.bodyVersion
                || !sameStrictJsonValue(choice, notice.recoveryChoices?.[index])) {
                return { ok: false, errorCode: 'usage_notice_changed', error: 'usage_notice_changed' };
            }
            return input.execute(choice.actionId, choice.actionId === 'inbox.notice.dismiss'
                ? { ...choice.input, expectedRevision: current.revision } : choice.input, context(options?.signal));
        },
        readOutcomeSubject(entry: FailureInvestigationSubject) {
            const context = read(entry);
            return context?.kind === 'failure' ? context.subject : context;
        },
        isEligible(entry: FailureInvestigationSubject): boolean { return read(entry) !== null; },
        async readChoices(entry: FailureInvestigationSubject, options?: Readonly<{ signal?: AbortSignal }>): Promise<TriageSessionHandoffChoicesV1> {
            const missing = { v: 1, kind: 'unavailable', reason: 'catalogUnavailable' } as const;
            if (options?.signal?.aborted || !read(entry)) return missing;
            const result = await input.execute('action.invoke', {
                action: { pluginId: 'happier.triage', localId: 'actions/read-v1' },
                input: { v: 1, projection: 'sessionHandoff', task: 'investigate' },
            }, context(options?.signal));
            if (!result.ok || !input.isCurrent() || options?.signal?.aborted) return missing;
            const choices = TriageSessionHandoffChoicesV1Schema.safeParse(result.result);
            return choices.success ? choices.data : missing;
        },
        async run(entry: FailureInvestigationSubject, selection: TriageSessionHandoffSelectionV1,
            options?: Readonly<{ signal?: AbortSignal;
                placement?: HealthNoticeInvestigationPlacement;
            }>): Promise<ActionExecuteResult> {
            const notice = read(entry);
            if (!notice || options?.signal?.aborted) return unavailable();
            const retained = resume(entry, options);
            if (retained) return retained;
            const selected = TriageSessionHandoffSelectionV1Schema.safeParse(selection);
            if (!selected.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
            const { agentTargetKey, ...placement } = options?.placement ?? {};
            const handoff = TriageSessionHandoffInputV1Schema.parse({ task: 'investigate', ...selected.data,
                ...(agentTargetKey ? { agentChoice: { kind: 'target', targetKey: agentTargetKey } } : {}),
                context: notice.kind === 'entry' ? notice : { ...notice, ...placement },
                evidence: [notice.kind === 'entry' ? { kind: 'alertEntry', entry: notice.entry }
                    : notice.kind === 'failure' ? { kind: 'failure', subject: notice.subject } : { kind: 'alert', notice: notice.notice }] });
            const operation = { handoff };
            operations.set(failureInvestigationSubjectKey(entry), operation);
            return executeOperation(failureInvestigationSubjectKey(entry), operation, options?.signal);
        },
    };
}
