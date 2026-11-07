import * as React from 'react';
import { DeploymentBindingsPatchInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

export type EnvironmentBindingApprovalChoiceInput = Readonly<{
    artifactId: string;
    approval: ApprovalRequest | null;
    serverId?: string | null;
}>;

const noDecisionOptions: Readonly<{ narrowedInput?: unknown }> = Object.freeze({});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Local input only; the existing approval decision handler owns consent and replay. */
export function useEnvironmentBindingApprovalChoice(input: EnvironmentBindingApprovalChoiceInput) {
    const approval = input.approval;
    const original = approval?.actionArgs;
    const origin = approval?.v === 2 ? approval.executionOriginV1 : null;
    const recordedReview = approval?.actionId === 'deployments.bindings.set'
        && approval.v === 2 && approval.status !== 'open'
        && approval.decision?.kind === 'approve' && approval.decision.narrowedInput !== undefined
        ? approval.decision.narrowedInput : original;
    const needsSelection = React.useMemo(() => {
        if (approval?.status !== 'open' || approval.actionId !== 'deployments.bindings.set') return false;
        const parsed = DeploymentBindingsPatchInputV1Schema.safeParse(original);
        return parsed.success && parsed.data.set.some(row => row.source.kind === 'secret' && row.source.ref === 'person_selects');
    }, [approval?.actionId, approval?.status, original]);
    const ownerRef = React.useRef({ artifactId: input.artifactId, original, origin,
        serverId: input.serverId, actionId: approval?.actionId, status: approval?.status });
    const previousOwner = ownerRef.current;
    // Artifact readers may parse the same signed body again. Allocation is not
    // a new request, but any actual signed operand/origin or scope change is.
    if (previousOwner.artifactId !== input.artifactId || previousOwner.serverId !== input.serverId
        || previousOwner.actionId !== approval?.actionId || previousOwner.status !== approval?.status
        || !sameStrictJsonValue(previousOwner.original, original)
        || !sameStrictJsonValue(previousOwner.origin, origin)) {
        ownerRef.current = { artifactId: input.artifactId, original, origin,
            serverId: input.serverId, actionId: approval?.actionId, status: approval?.status };
    }
    const owner = ownerRef.current;
    const currentOwner = React.useRef<typeof owner | null>(owner);
    currentOwner.current = owner;
    const pending = React.useRef<AbortController | null>(null);
    const retained = React.useRef<Readonly<{ dispose(): void }> | null>(null);
    const [choice, setChoice] = React.useState<Readonly<{
        owner: typeof owner;
        input: unknown;
        account: LazyActionAccountContext;
    }> | null>(null);
    React.useEffect(() => {
        currentOwner.current = owner;
        return () => {
            if (currentOwner.current === owner) currentOwner.current = null;
            pending.current?.abort();
            retained.current?.dispose();
            retained.current = null;
        };
    }, [owner]);
    const admittedChoice = choice?.owner === owner && choice.account.accountLifetime.isCurrent() ? choice : null;

    const choose = React.useCallback(async () => {
        if (!needsSelection || !input.serverId || currentOwner.current !== owner) return;
        pending.current?.abort();
        retained.current?.dispose();
        retained.current = null;
        const controller = new AbortController();
        pending.current = controller;
        let account: LazyActionAccountContext | null = null;
        let keepAccount = false;
        try {
            const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
            account = await captureLazyActionAccountContext(input.serverId, controller.signal);
            const captured = account;
            const isCurrent = () => currentOwner.current === owner && !controller.signal.aborted && captured.accountLifetime.isCurrent();
            if (!isCurrent() || account.credentialAuthorityKind !== 'account') return;
            if (origin?.accountId && origin.accountId !== account.accountId
                || origin?.serverIdentityId && origin.serverIdentityId !== account.serverIdentityId) return;
            const { presentSavedSecretReferencePicker } = await import('@/components/ui/forms/valueRefs/presentSavedSecretReferencePicker');
            if (!isCurrent() || !isRecord(original) || !Array.isArray(original.set)) return;
            // Preserve the signed JSON rather than its normalized schema output.
            const rows: unknown[] = [...original.set];
            for (let index = 0; index < rows.length; index++) {
                const row = rows[index];
                if (!isRecord(row) || !isRecord(row.source)
                    || row.source.kind !== 'secret' || row.source.ref !== 'person_selects') continue;
                const selected = await presentSavedSecretReferencePicker({ accountLifetime: account.accountLifetime,
                    signal: controller.signal, isCurrent });
                if (!selected || !isCurrent()) return;
                rows[index] = { ...row, source: { kind: 'secret', ...selected } };
            }
            const narrowed = getActionSpec('deployments.bindings.set').approvalNarrowing?.narrow(original, { ...original, set: rows });
            if (!DeploymentBindingsPatchInputV1Schema.safeParse(narrowed).success || !isCurrent()) return;
            const retirement = account.accountLifetime.onRetire(() => {
                controller.abort();
                setChoice(previous => previous?.owner === owner ? null : previous);
            });
            if (!isCurrent()) { retirement.dispose(); return; }
            retained.current = { dispose() { retirement.dispose(); controller.abort(); captured.dispose(); } };
            setChoice({ owner, input: narrowed, account });
            keepAccount = true;
        } finally {
            if (pending.current === controller) pending.current = null;
            if (!keepAccount) account?.dispose();
        }
    }, [input.serverId, needsSelection, original, origin, owner]);

    const reviewInput = admittedChoice?.input ?? recordedReview;
    const reviewRequest = React.useMemo(() => approval && reviewInput !== approval.actionArgs
        // A stored preview describes the original proposal. Re-project the
        // narrowed reference through the Action's observation-safe owner.
        ? { ...approval, actionArgs: reviewInput, preview: undefined } : approval, [approval, reviewInput]);

    return {
        reviewRequest,
        decisionOptions: admittedChoice ? { narrowedInput: admittedChoice.input } : noDecisionOptions,
        needsChoiceBeforeApprove: needsSelection && admittedChoice === null,
        choose,
    };
}
