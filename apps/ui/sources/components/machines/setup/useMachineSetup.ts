import * as React from 'react';
import {
  ManagedMachineActionOutputSchemasV1,
  MachineSetupPlanResultV1Schema,
  type MachineSetupPlanResultV1,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachineSetupPresetChoice } from '@/components/settings/machines/managed/machineSetupPresetChoices';
import type { MachinePresetItemV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { machineSetupSourceOriginKeyV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { prepareMachineSetupPresetApplyInput } from '@/components/settings/machines/managed/machineSetupApply';
import {
  prepareMachineSetupSourcesApplyInput,
  type MachineSetupPreparedApply,
  type MachineSetupPreparedRemove,
} from '@/components/settings/machines/managed/machineSetupReview';
import {
  prepareMachineSetupSoftwareRemoveInput,
  removeMachineSetupSoftware,
} from '@/components/settings/machines/managed/machineSetupSoftware';
import { useActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import { isActionOperationTerminal } from '@/sync/domains/actionOperations/actionOperationStore';
import {
  homeDomainFailureCode,
  homeDomainFailureFromActionFailure,
} from '@/sync/api/home/homeDomainActions';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useMachineField } from '@/sync/store/hooks';

const execute = createFrontDoorActionExecute();

/** What the person asked to review: the reviewed change decides which Action Apply runs and how it re-plans. */
export type MachineSetupReviewIntent =
  | Readonly<{ kind: 'reapply' }>
  | Readonly<{ kind: 'preset'; preset: MachineSetupPresetChoice }>
  /** Stop using one attached preset (its source origin key); what it set up stays unless the review removes it. */
  | Readonly<{ kind: 'stop'; sourceKey: string; name: string }>
  | Readonly<{
      kind: 'remove';
      item: Exclude<MachinePresetItemV1, { kind: 'app' }>;
    }>;

type Prepared =
  | Extract<MachineSetupPreparedApply, { ok: true }>
  | Extract<MachineSetupPreparedRemove, { ok: true }>;
export type MachineSetupFailure = Readonly<{
  code: string;
  during: 'check' | 'review' | 'apply';
  failure?: ActionExecuteFailure;
}>;

/**
 * The Setup tab's one data port (P-M1): the Machine's current setup read through `machines.setup.plan` on open and on
 * Check again, the daemon's published observation as the last-known row facts, and one in-place review that Apply turns
 * into the operation's own rows. Every effect goes through the existing Actions (`machines.setup.plan`, `.apply`,
 * `.remove`) and their approval continuation; composition stays with the tab.
 */
export function useMachineSetup(
  input: Readonly<{
    serverId: string;
    machineId: string;
    active: boolean;
    online: boolean | null;
  }>,
) {
  const { serverId, machineId } = input;
  const observation = useMachineField(machineId, 'daemonState', 'setup', {
    serverId,
    enabled: input.active,
  });
  const { binding } = useServerCredentialAccountScopeBinding(serverId);
  const homeId = getServerProfileById(serverId)?.serverIdentityId ?? null;
  const scopeKey = JSON.stringify([
    serverId,
    binding?.accountId ?? null,
    machineId,
  ]);

  const [current, setCurrent] = React.useState<Readonly<{
    key: string;
    plan: MachineSetupPlanResultV1;
    checkedAt: number;
  }> | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [failure, setFailure] = React.useState<MachineSetupFailure | null>(
    null,
  );
  const [review, setReview] = React.useState<Readonly<{
    intent: MachineSetupReviewIntent;
    prepared: Prepared | null;
  }> | null>(null);
  const [pending, setPending] = React.useState<'review' | 'apply' | null>(null);
  const [operationId, setOperationId] = React.useState<string | null>(null);
  const plan = current?.key === scopeKey ? current.plan : null;

  const context = React.useCallback(
    () =>
      binding
        ? {
            surface: 'ui' as const,
            serverId,
            expectedAccountId: binding.accountId,
          }
        : null,
    [binding, serverId],
  );
  const readCurrent = React.useRef<Promise<void> | null>(null);
  const check = React.useCallback((): Promise<void> => {
    const ctx = context();
    if (!binding?.isCurrent() || !ctx || !homeId) return Promise.resolve();
    if (readCurrent.current) return readCurrent.current;
    setChecking(true);
    const promise = (async () => {
      try {
        const result = await execute(
          'machines.setup.plan',
          { homeId, machineId },
          ctx,
        );
        if (!binding.isCurrent()) return;
        const outcome = classifyHomeActionOutcome(result);
        if (outcome.kind === 'failed') {
          setFailure({
            code: homeDomainFailureCode(outcome.failure),
            during: 'check',
            failure: outcome.failure,
          });
          return;
        }
        const parsed =
          outcome.kind === 'completed'
            ? MachineSetupPlanResultV1Schema.safeParse(outcome.result)
            : null;
        if (!parsed?.success) {
          setFailure({ code: 'managed_response_invalid', during: 'check' });
          return;
        }
        setCurrent({ key: scopeKey, plan: parsed.data, checkedAt: Date.now() });
        setFailure((previous) =>
          previous?.during === 'check' ? null : previous,
        );
      } catch {
        if (binding.isCurrent())
          setFailure({ code: 'managed_request_failed', during: 'check' });
      } finally {
        readCurrent.current = null;
        setChecking(false);
      }
    })();
    readCurrent.current = promise;
    return promise;
  }, [binding, context, homeId, machineId, scopeKey]);

  // Opening the tab (or the Machine coming back) is the demand for a check; publications never start one.
  const demanded =
    input.active && input.online !== false && !!binding && !!homeId;
  React.useEffect(() => {
    if (demanded) void check();
  }, [demanded, check]);

  const approval = useActionApprovalContinuation({
    scopeKey,
    serverId,
    onExecuted: () => {},
  });
  const opened = React.useCallback(
    (
      actionId: 'machines.setup.apply' | 'machines.setup.remove',
      result: unknown,
    ) => {
      const output =
        ManagedMachineActionOutputSchemasV1[actionId].safeParse(result);
      setPending(null);
      if (!output.success) {
        setFailure({ code: 'managed_response_invalid', during: 'apply' });
        return;
      }
      setReview(null);
      setOperationId(output.data.operationId);
    },
    [],
  );

  const prepare = React.useCallback(
    async (intent: MachineSetupReviewIntent, removeItemKeys?: string[]) => {
      const ctx = context();
      if (!binding?.isCurrent() || !ctx || !homeId || pending) return;
      setPending('review');
      setFailure(null);
      setReview({ intent, prepared: null });
      try {
        const isCurrent = () => binding.isCurrent();
        let prepared: MachineSetupPreparedApply | MachineSetupPreparedRemove | null;
        if (intent.kind === 'preset') {
          prepared = await prepareMachineSetupPresetApplyInput({
            executeAction: execute,
            context: ctx,
            homeId,
            machineId,
            preset: intent.preset,
            isCurrent,
            ...(removeItemKeys?.length ? { removeItemKeys } : {}),
          });
        } else if (intent.kind === 'remove') {
          prepared = await prepareMachineSetupSoftwareRemoveInput({
            executeAction: execute,
            context: ctx,
            homeId,
            machineId,
            setup: { items: [intent.item] },
            isCurrent,
            ...(removeItemKeys ? { removeItemKeys } : {}),
          });
        } else {
          // Re-apply the setup the Machine already has: its own sources, planned again for their effects now. Stop
          // using proposes the same sources without that preset; native retention keeps its items by default.
          const result = await execute(
            'machines.setup.plan',
            { homeId, machineId },
            ctx,
          );
          const outcome = classifyHomeActionOutcome(result);
          const parsed =
            outcome.kind === 'completed'
              ? MachineSetupPlanResultV1Schema.safeParse(outcome.result)
              : null;
          prepared =
            outcome.kind === 'failed'
              ? outcome.failure
              : !parsed?.success
                ? {
                    ok: false,
                    errorCode: 'managed_response_invalid',
                    error: 'managed_response_invalid',
                  }
                : await prepareMachineSetupSourcesApplyInput({
                    executeAction: execute,
                    context: ctx,
                    homeId,
                    machineId,
                    combined: false,
                    isCurrent,
                    targets: [
                      {
                        homeId,
                        machineId,
                        sources:
                          intent.kind === 'stop'
                            ? parsed.data.sources.filter(
                                (source) => machineSetupSourceOriginKeyV1(source) !== intent.sourceKey,
                              )
                            : parsed.data.sources,
                        ...(intent.kind === 'stop' ? { current: parsed.data } : {}),
                        desiredRevision: parsed.data.desiredRevision,
                        ...(removeItemKeys?.length ? { removeItemKeys } : {}),
                      },
                    ],
                  });
        }
        if (!binding.isCurrent()) return;
        if (!prepared) { setReview(null); return; }
        if (prepared.ok) setReview({ intent, prepared });
        else {
          setReview(null);
          setFailure({
            code: homeDomainFailureCode(
              homeDomainFailureFromActionFailure(prepared),
            ),
            during: 'review',
            failure: prepared,
          });
        }
      } catch {
        if (binding.isCurrent()) {
          setReview(null);
          setFailure({ code: 'managed_request_failed', during: 'review' });
        }
      } finally {
        setPending(null);
      }
    },
    [binding, context, homeId, machineId, pending],
  );

  const apply = React.useCallback(async () => {
    const ctx = context();
    const prepared = review?.prepared;
    if (!binding?.isCurrent() || !ctx || !prepared || pending) return;
    const actionId =
      review.intent.kind === 'remove'
        ? ('machines.setup.remove' as const)
        : ('machines.setup.apply' as const);
    setPending('apply');
    setFailure(null);
    // A run that fails or is declined goes back to the tab: the next try reads the Plan again.
    const settleFailed = (code: string) => {
      setFailure({ code, during: 'apply' });
      setReview(null);
      setPending(null);
    };
    try {
      const result =
        'targets' in prepared.input
          ? await execute.confirmed('machines.setup.apply', prepared.input, ctx)
          : await removeMachineSetupSoftware({
              executeAction: execute,
              context: ctx,
              prepared: { ...prepared, input: prepared.input },
            });
      if (!binding.isCurrent()) return;
      const outcome = classifyHomeActionOutcome(result);
      if (outcome.kind === 'failed')
        return settleFailed(homeDomainFailureCode(outcome.failure));
      if (outcome.kind === 'approval_pending') {
        approval.requestApproval(
          createActionApprovalContinuation({
            artifactId: outcome.artifactId,
            actionId,
            scope: binding.scope,
            expectedInput: prepared.input,
            onSucceeded: (value: unknown) => opened(actionId, value),
            onFailed: settleFailed,
          }),
        );
        return;
      }
      opened(actionId, outcome.result);
    } catch {
      if (binding.isCurrent()) settleFailed('managed_request_failed');
    }
  }, [approval, binding, context, opened, pending, review]);

  const cancelReview = React.useCallback(() => {
    setReview(null);
    setFailure((previous) => (previous?.during === 'check' ? previous : null));
  }, []);

  // The Apply this tab started is shown as its own operation rows; once it settles, the setup is read again.
  const operation = useActionOperation({
    serverId,
    operationId: operationId ?? '',
  });
  const settled =
    operationId !== null &&
    operation !== null &&
    isActionOperationTerminal(operation.snapshot.state);
  React.useEffect(() => {
    if (settled) void check();
  }, [settled, check]);

  return {
    observation,
    plan,
    checkedAt: current?.key === scopeKey ? current.checkedAt : null,
    checking,
    failure,
    review,
    pending,
    approvalId: approval.approvalId,
    operationId, operation: operationId ? operation : null,
    check,
    prepare,
    apply,
    cancelReview,
    dismissOperation: () => setOperationId(null),
  };
}
export type MachineSetupState = ReturnType<typeof useMachineSetup>;

type SetupItem = Exclude<MachinePresetItemV1, { kind: 'app' }>;
type RecipeStatus = MachineSetupPlanResultV1['support'][number]['status'];
export type MachineSetupRecipeRow = Readonly<{
    key: string;
    ref: SetupItem['selection']['ref'];
    item: SetupItem;
    title: NonNullable<MachineSetupPlanResultV1['recipeTitles']>[number]['title'] | null;
    status: RecipeStatus | null;
    /** The owner's typed reason when the state needs one (unsupported, unchecked). */
    reason: MachineSetupPlanResultV1['support'][number]['reason'] | null;
    /** The Plan source that holds it, so the row can name the preset it came from. */
    sourceIndex: number;
    /** From the Machine's preset (changed through the preset), or added on this Machine (removable here). */
    fromPreset: boolean;
    removable: boolean;
}>;

const NO_RECIPES: readonly MachineSetupRecipeRow[] = Object.freeze([]);
const sameRef = (a: SetupItem['selection']['ref'], b: SetupItem['selection']['ref']) =>
    a.pluginId === b.pluginId && a.recipeId === b.recipeId && a.revision === b.revision;

/** The apps the Machine's setup sources hold, in source order: read only, since their state lives on their Environment. */
export function readMachineSetupApps(sources: readonly MachineSetupPlanResultV1['sources'][number][]) {
    return sources.flatMap((source, sourceIndex) => (source.setup.items ?? []).flatMap((item, itemIndex) =>
        item.kind === 'app' ? [{ key: `${sourceIndex}.${itemIndex}`, item, sourceIndex, source }] : []));
}

/**
 * One row per recipe the Machine's setup holds, in source order: its own name from the Plan's declaration read, and
 * its state from the Plan's check, else the daemon's last published observation (MR7: a row fact, never a setting).
 */
export function readMachineSetupRecipes(
    plan: MachineSetupPlanResultV1 | null,
    observation: Readonly<{ recipes: readonly Readonly<{ ref: SetupItem['selection']['ref']; status: RecipeStatus; reason?: MachineSetupPlanResultV1['support'][number]['reason'] }>[] }> | null,
): readonly MachineSetupRecipeRow[] {
    if (!plan) return NO_RECIPES;
    const rows: MachineSetupRecipeRow[] = [];
    plan.sources.forEach((source, sourceIndex) => {
        (source.setup.items ?? []).forEach((item, itemIndex) => {
            if (item.kind === 'app') return;
            const ref = item.selection.ref;
            if (rows.some(row => sameRef(row.ref, ref))) return;
            const checked = plan.support.find(entry => entry.sourceIndex === sourceIndex && entry.itemIndex === itemIndex);
            const observed = observation?.recipes.find(entry => sameRef(entry.ref, ref));
            rows.push({
                key: `${sourceIndex}.${itemIndex}`, ref, item,
                title: plan.recipeTitles?.find(entry => sameRef(entry.ref, ref))?.title ?? null,
                status: checked?.status ?? observed?.status ?? null,
                reason: (checked ?? observed)?.reason ?? null,
                sourceIndex,
                fromPreset: source.kind !== 'direct',
                removable: source.kind === 'direct',
            });
        });
    });
    return rows;
}
