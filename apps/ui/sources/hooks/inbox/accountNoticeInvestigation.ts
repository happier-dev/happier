import type { TriageFailureSubjectV1 } from '@happier-dev/triage-protocol/v1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { FailureActionOutcome, FailureAgentAction, FailureActionPlacement } from '@happier-dev/protocol/plugins/contributions/ui/failureActionPresentation';
import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionTargetV1';
import { readAccountNoticeArtifactHeader, type AccountNoticeArtifact } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { ArtifactActionOutputSchemasV1 } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { readOwnedNoticeArtifactV1, ACCOUNT_NOTICE_ARTIFACT_KIND_V1, type AccountNoticeRecoveryChoiceV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { readFailureActionsBinding, type FailureActionsBinding } from './failureActionsBinding';

export type FailureInvestigationSubject = AccountNoticeArtifact | TriageFailureSubjectV1;
export type FailureInvestigationExecutionOptions = Readonly<{
    signal?: AbortSignal;
    externalActionTarget?: ActionExecutorContext['externalActionTarget'];
    placement?: FailureActionPlacement;
}>;
export const failureInvestigationSubjectKey = (entry: FailureInvestigationSubject) =>
    'artifact' in entry ? entry.artifact.id : JSON.stringify(entry);
const NO_RECOVERY_CHOICES: readonly AccountNoticeRecoveryChoiceV1[] = Object.freeze([]);
type PresentationResult = Readonly<{ kind: 'presentation'; outcome: FailureActionOutcome | null }>;
type ActionsResult = Readonly<{ kind: 'actions'; actions: readonly FailureAgentAction[] | null }>;
type LinkedResult = Readonly<{ kind: 'linkedSession'; session: ActionSessionAddressV1 | null }>;
type FailureInvestigationUnavailable = Extract<FailureActionOutcome, { kind: 'unavailable' }>;
export type FailureAgentActionsReadResult = ActionsResult['actions'] | FailureInvestigationUnavailable;

function presentActionRefusal(result: Extract<ActionExecuteResult, { ok: false }>): FailureInvestigationUnavailable {
    return { kind: 'unavailable', code: result.errorCode ?? 'unknown_error' };
}

/** The host owns Account/notice admission; the declared plugin Action owns investigation behavior. */
export function createAccountNoticeInvestigation(input: Readonly<{
    scope: ServerAccountScope | null;
    isCurrent(): boolean;
    captureCurrent?(): () => boolean;
    execute: FrontDoorActionExecute;
    binding?: FailureActionsBinding | null;
}>) {
    const read = (entry: FailureInvestigationSubject) => {
        if (!input.scope || !input.isCurrent()) return null;
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
    const context = (options?: FailureInvestigationExecutionOptions) => {
        const isCurrent = input.captureCurrent?.() ?? input.isCurrent;
        return { surface: 'ui' as const, authority: 'present_user' as const,
        serverId: input.scope?.serverId, expectedAccountId: input.scope?.accountId,
        verifyMachineAdmissionCurrent: async () => isCurrent() && input.isCurrent(),
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.externalActionTarget ? { externalActionTarget: options.externalActionTarget } : {}) };
    };
    const unavailable = () => ({ ok: false,
        errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' } as const);
    const binding = () => input.binding === undefined ? readFailureActionsBinding(input.scope) : input.binding;
    async function invoke(command: Readonly<Record<string, unknown>>, options?: FailureInvestigationExecutionOptions) {
        const contribution = binding();
        if (!input.scope || !input.isCurrent() || options?.signal?.aborted) return unavailable();
        if (!contribution) return { ok: false, errorCode: 'failure_actions_unavailable', error: 'failure_actions_unavailable' } as const;
        const result = await input.execute('action.invoke', {
            action: { pluginId: contribution.pluginId, localId: contribution.action }, input: command,
        }, context(options));
        return input.isCurrent() && !options?.signal?.aborted ? result : unavailable();
    }
    const recoveryChoices = (entry: AccountNoticeArtifact): readonly AccountNoticeRecoveryChoiceV1[] => {
        if (!input.scope || !input.isCurrent()) return NO_RECOVERY_CHOICES;
        const header = readAccountNoticeArtifactHeader(entry.artifact, input.scope.accountId);
        if (!header || header.status !== 'open' || header.resolved || header.healthPhase !== 'open'
            || header.source.kind !== 'host' || header.source.topic !== 'service_health'
            || !header.page || !('kind' in header.page)
            || !areServerProfileIdentifiersEquivalent(header.page.page === 'environment' ? header.page.environment.serverId
                : header.page.machine.serverId, input.scope.serverId)) return NO_RECOVERY_CHOICES;
        return entry.header.recoveryChoices && sameStrictJsonValue(entry.header.recoveryChoices, header.recoveryChoices)
            ? entry.header.recoveryChoices : NO_RECOVERY_CHOICES;
    };
    return {
        scope: input.scope,
        dispose: () => {},
        async readAgentActions(entry: FailureInvestigationSubject, includeDefault: boolean,
            options?: FailureInvestigationExecutionOptions): Promise<FailureAgentActionsReadResult> {
            const subject = read(entry);
            if (!subject) return presentActionRefusal(unavailable());
            const result = await invoke({ kind: 'readAgentActions', context: subject, includeDefault }, options);
            if (!result.ok) return presentActionRefusal(result);
            // The Action executor validates the contribution's declared output union.
            const answer = result.result as ActionsResult | PresentationResult;
            if (answer.kind === 'actions' && answer.actions !== null) return answer.actions;
            return answer.kind === 'presentation' && answer.outcome?.kind === 'unavailable'
                ? answer.outcome : { kind: 'unavailable', code: 'invalid_result' };
        },
        async launch(entry: FailureInvestigationSubject, intent: Readonly<{ actionId?: string; delivery?: 'send' | 'compose' }>,
            options?: FailureInvestigationExecutionOptions): Promise<FailureActionOutcome | null> {
            const subject = read(entry);
            if (!subject) return presentActionRefusal(unavailable());
            const result = await invoke({ kind: 'launch', context: subject, ...intent,
                ...(options?.placement ? { placement: options.placement } : {}) }, options);
            return result.ok ? (result.result as PresentationResult).outcome : presentActionRefusal(result);
        },
        async openEditor(actionId?: string) {
            await invoke({ kind: 'edit', ...(actionId === undefined ? {} : { actionId }) });
        },
        async readLinkedSession(entry: TriageFailureSubjectV1, options?: FailureInvestigationExecutionOptions) {
            const subject = read(entry);
            if (!subject) return null;
            const result = await invoke({ kind: 'readLinkedSession', context: subject }, options);
            return result.ok ? (result.result as LinkedResult).session : null;
        },
        readRecoveryChoices: recoveryChoices,
        async runRecoveryChoice(entry: AccountNoticeArtifact, index: number,
            options?: FailureInvestigationExecutionOptions): Promise<ActionExecuteResult> {
            const choice = Number.isInteger(index) && index >= 0 ? recoveryChoices(entry)[index] : undefined;
            if (!choice || options?.signal?.aborted || !input.scope) return unavailable();
            const opened = await input.execute('artifact.get', { artifactId: entry.artifact.id }, context(options));
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
                ? { ...choice.input, expectedRevision: current.revision } : choice.input, context(options));
        },
        readOutcomeSubject(entry: FailureInvestigationSubject) {
            const context = read(entry);
            return context?.kind === 'failure' ? context.subject : context;
        },
        isEligible(entry: FailureInvestigationSubject): boolean { return read(entry) !== null; },
    };
}
