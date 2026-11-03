import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { BrowserAutomationSecretFillRequestV1Schema } from '@happier-dev/protocol/browser/automation/v1';
import { ConfidentialActionInputReviewV1Schema, type PrivateSecretContinuationV1 } from '@happier-dev/protocol/approvals/privateSecretContinuationV1';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ComputerSecretFillRequestV1Schema, SecretFillSettlementV1Schema, type SecretFillSettlementV1 } from '@happier-dev/protocol/computer/v1';

import { t } from '@/text';

type Binding<T> = T extends PrivateSecretContinuationV1
    ? Pick<T, 'actionId' | 'request' | 'requestId'> & Readonly<{ expectedServerIdentityId: string | null }>
    : never;
export type ConfidentialSecretApproval = Binding<PrivateSecretContinuationV1>;

/** Presentation classification only; the existing private continuation owns admission. */
export function isConfidentialSecretApprovalAction(actionId: string): boolean {
    return actionId === 'computer.secret.fill' || actionId === 'browser.automation.secret.fill';
}

export function readConfidentialSecretApproval(approval: ApprovalRequest): ConfidentialSecretApproval | null {
    if (approval.v !== 2) return null;
    const binding = { requestId: approval.executionOriginV1.requestId,
        expectedServerIdentityId: approval.executionOriginV1.serverIdentityId ?? null };
    if (approval.actionId === 'computer.secret.fill') {
        const parsed = ComputerSecretFillRequestV1Schema.safeParse(approval.actionArgs);
        return parsed.success ? { ...binding, actionId: 'computer.secret.fill', request: parsed.data } : null;
    }
    if (approval.actionId === 'browser.automation.secret.fill') {
        const parsed = BrowserAutomationSecretFillRequestV1Schema.safeParse(approval.actionArgs);
        return parsed.success ? { ...binding, actionId: 'browser.automation.secret.fill', request: parsed.data } : null;
    }
    return null;
}

/** One declared confidential input of a deferred Action request, in the words its declaration gives it. */
export type ConfidentialActionInput = Readonly<{ path: string; label: string }>;

/**
 * A consuming Action asked for confidential inputs it was not given (CRED-ASK): the person chooses each one
 * here, privately, against the request's value-free input. Presentation only; the continuation owner rebinds.
 */
export type ConfidentialActionInputsApproval = Readonly<{
    kind: 'action_inputs'; actionId: string; requestId: string; request: Record<string, unknown>;
    machineId: string | null; expectedServerIdentityId: string | null; inputs: readonly ConfidentialActionInput[];
}>;

/** Words a field name spells as letters ("apiToken" reads "API token"). */
const INITIALISMS = new Set(['api', 'id', 'url', 'dsn', 'ssh', 'aws', 'gcp', 'jwt', 'pat', 'smtp', 'imap']);

function humanizeInputPath(path: string): string {
    const leaf = path.split('.').at(-1) ?? path;
    const words = leaf.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase()
        .split(/\s+/).map(word => INITIALISMS.has(word) ? word.toUpperCase() : word).join(' ');
    return words ? words[0]!.toUpperCase() + words.slice(1) : path;
}

function readDeclaredInputTitle(actionId: string, path: string): string | null {
    const id = ActionIdSchema.safeParse(actionId);
    if (!id.success) return null;
    const title: unknown = getActionSpec(id.data).inputHints?.fields?.find(field => field.path === path)?.title;
    if (typeof title === 'string') return title;
    const fallback = title && typeof title === 'object' ? Reflect.get(title, 'fallback') : null;
    return typeof fallback === 'string' ? fallback : null;
}

export function readConfidentialActionInputsApproval(approval: ApprovalRequest): ConfidentialActionInputsApproval | null {
    if (approval.v !== 2 || !approval.preview || typeof approval.preview !== 'object') return null;
    const review = ConfidentialActionInputReviewV1Schema.safeParse(Reflect.get(approval.preview, 'confidentialInputs'));
    const args = approval.actionArgs;
    if (!review.success || review.data.paths.length === 0 || !args || typeof args !== 'object' || Array.isArray(args)) return null;
    return { kind: 'action_inputs', actionId: approval.actionId, requestId: approval.executionOriginV1.requestId,
        request: args as Record<string, unknown>, machineId: approval.executionOriginV1.machineId ?? null,
        expectedServerIdentityId: approval.executionOriginV1.serverIdentityId ?? null,
        inputs: review.data.paths.map(path => ({ path, label: readDeclaredInputTitle(approval.actionId, path) ?? humanizeInputPath(path) })) };
}

/**
 * The name "Save for next time" offers for a typed credential: the reviewed site's host, which the
 * person may change. A native target has no stable site name, so the person names it.
 */
export function resolveConfidentialSecretSaveName(approval: ConfidentialSecretApproval): string {
    return approval.actionId === 'browser.automation.secret.fill' ? new URL(approval.request.origin).host : '';
}

/** The executor's recorded fill settlement on a settled confidential approval; null when none was recorded. */
export function readConfidentialFillSettlement(approval: ApprovalRequest): SecretFillSettlementV1 | null {
    if (!isConfidentialSecretApprovalAction(approval.actionId) || approval.v !== 2) return null;
    const settlement = SecretFillSettlementV1Schema.safeParse(approval.execution?.result);
    return settlement.success ? settlement.data : null;
}

export type ConfidentialFillOutcome = Readonly<{ title: string; detail: string | null; warning: boolean }>;

/**
 * What became of the entry, said once (lab `b-secret` S): the outcome, why nothing was entered when
 * it was refused, and what to do next. Unknown completion is never retried. The approval page and the
 * transcript card both read it here.
 */
export function resolveConfidentialFillOutcome(fill: SecretFillSettlementV1): ConfidentialFillOutcome {
    if (fill.status === 'filled') return { title: t('approvals.confidential.filled'), detail: null, warning: false };
    if (fill.status === 'canceled') return { title: t('approvals.confidential.canceled'), detail: null, warning: false };
    if (fill.status === 'unknown') return { title: t('approvals.confidential.unknown'), detail: t('approvals.confidential.unknownBody'), warning: true };
    switch (fill.code) {
        case 'field_verification_unsupported':
            return { title: t('approvals.confidential.fieldUnsupported'), detail: t('approvals.confidential.fieldUnsupportedBody'), warning: true };
        case 'target_changed':
        case 'approval_changed':
            return { title: t('approvals.confidential.targetChanged'), detail: t('approvals.confidential.nothingEntered'), warning: true };
        case 'saved_secret_missing':
        case 'saved_secret_unavailable':
        case 'saved_secret_forbidden':
        case 'saved_secret_repair_required':
        case 'saved_secret_deleted':
        case 'saved_secret_mode_incompatible':
        case 'saved_secret_corrupt':
        case 'saved_secret_changed':
            return { title: t('approvals.confidential.savedUnavailable'), detail: t('approvals.confidential.savedUnavailableBody'), warning: true };
        default:
            return { title: t('approvals.confidential.refused'), detail: null, warning: true };
    }
}

/**
 * The submit control's own outcome, apart from the fill (lab `b-secret` F/F2): pressed, refused,
 * unconfirmed, or — when the request named one and it was not pressed — held for the person.
 */
export function resolveConfidentialSubmitOutcome(fill: SecretFillSettlementV1, submitControl: string | null): string | null {
    if (fill.status !== 'filled') return null;
    if (fill.submit?.status === 'submitted') return t('approvals.confidential.submitted');
    if (fill.submit?.status === 'unknown') return t('approvals.confidential.submitUnknown');
    if (fill.submit) return t('approvals.confidential.submitRefused');
    return submitControl ? t('approvals.confidential.submitHeld', { submitControl }) : null;
}

/**
 * What became of the Action the person supplied secret inputs to, said once. An outcome that cannot be confirmed
 * is never retried; a refusal before the Action ran says nothing happened.
 */
export function resolveConfidentialInputsOutcome(execution: Readonly<{ ok: boolean; errorCode?: string }>): ConfidentialFillOutcome {
    if (execution.ok) return { title: t('approvals.confidential.inputsDone'), detail: null, warning: false };
    if (execution.errorCode === 'approval_canceled') return { title: t('approvals.confidential.canceled'), detail: null, warning: false };
    if (execution.errorCode === 'action_outcome_unknown' || execution.errorCode === 'approval_execution_outcome_unknown') {
        return { title: t('approvals.confidential.inputsUnknown'), detail: t('approvals.confidential.inputsUnknownBody'), warning: true };
    }
    if (execution.errorCode === 'approval_changed' || execution.errorCode === 'approval_stale') {
        return { title: t('approvals.confidential.inputsChanged'), detail: t('approvals.confidential.inputsNothingRan'), warning: true };
    }
    if (execution.errorCode?.startsWith('saved_secret_')) {
        return { title: t('approvals.confidential.savedUnavailable'), detail: t('approvals.confidential.savedUnavailableBody'), warning: true };
    }
    return { title: t('approvals.confidential.inputsFailed'), detail: null, warning: true };
}
