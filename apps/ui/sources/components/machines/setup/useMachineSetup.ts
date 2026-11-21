import * as React from 'react';
import { readRetainedManagedOpaqueSetupSourcesV1 } from '@happier-dev/cli-common/machines/managed';
import {
  machineSetupSourceApplyOriginKeyV1,
  ManagedMachineActionOutputSchemasV1,
  MachineSetupPlanResultV1Schema,
  type MachineSetupPlanInputV1,
  type MachineSetupPlanResultV1,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import type { MachineSetupPresetChoice } from '@/components/settings/machines/managed/machineSetupPresetChoices';
import { isMachineSetupRecipeItemV1, type MachinePresetItemV1, type MachineSetupRecipeItemV1 } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import type { MachineSetupPresetReferenceV1, MachineSetupSourceEntryV1, MachineSetupSourceApplyV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { prepareMachineSetupPresetApplyInput, prepareMachineSetupSourcesAdditionApplyInput } from '@/components/settings/machines/managed/machineSetupApply';
import {
  prepareMachineSetupSourcesApplyInput,
  type MachineSetupPreparedApply,
  type MachineSetupPreparedRemove,
} from '@/components/settings/machines/managed/machineSetupReview';
import {
  prepareMachineSetupSoftwareRemoveInput,
  removeMachineSetupSoftware,
} from '@/components/settings/machines/managed/machineSetupSoftware';
import { useActionOperation, useMachineSetupActionOperation, useMachineSetupRunActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import { isActionOperationTerminal } from '@/sync/domains/actionOperations/actionOperationStore';
import {
  homeDomainFailureCode,
  homeDomainFailureFromActionFailure,
} from '@/sync/api/home/homeDomainActions';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { classifyAccountStorageReadFailure } from '@/sync/encryption/accountStorageContext';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useMachineField } from '@/sync/store/hooks';
import { useMachinePresetUpdates } from './useMachinePresetUpdates';
import {
  openManagedMachineSetupPlanSourcesV1,
  type ManagedMachineSetupSourcePresentationV1,
} from '@/sync/ops/machines/managedMachinePresetCustody';

const execute = createFrontDoorActionExecute();

export type MachineSetupSourcePresentationV1 = ManagedMachineSetupSourcePresentationV1;
export type MachineSetupOpenedSourceV1 = Readonly<{
  sourceIndex: number;
  source: MachineSetupSourceEntryV1;
  presetName?: string;
}>;

/** Local display copies retain the Plan source index; opaque rows remain present as unavailable. */
export function readOpenedMachineSetupSources(
  presentations: readonly MachineSetupSourcePresentationV1[] | null,
): readonly MachineSetupOpenedSourceV1[] {
  return presentations?.flatMap((presentation, sourceIndex) =>
    presentation.kind === 'opened'
      ? [{ sourceIndex, source: presentation.source, ...(presentation.presetName === undefined ? {} : { presetName: presentation.presetName }) }]
      : [],
  ) ?? [];
}

/** What the person asked to review: the reviewed change decides which Action Apply runs and how it re-plans. */
export type MachineSetupReviewIntent = Readonly<{ previousRunFailed?: true }> & (
  | Readonly<{ kind: 'reapply' }>
  | Readonly<{ kind: 'preset'; preset: MachineSetupPresetChoice }>
  /** `name`: the attached copy's name, so the review can say what it applies (as Stop using carries it). */
  | Readonly<{ kind: 'presetUpdate'; presetId: string; presetRevision: number; setupRevision: number; name?: string }>
  | Readonly<{ kind: 'sources'; sources: MachineSetupSourceApplyV1; candidatePreset?: MachineSetupPlanInputV1['candidatePreset'] }>
  /** Stop using one attached preset (its source origin key); what it set up stays unless the review removes it. */
  | Readonly<{ kind: 'stop'; sourceKey: string; name: string }>
  | Readonly<{
      kind: 'remove';
      item: MachineSetupRecipeItemV1;
    }>);

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
    /** Only Manage may read the plan; a Machine refuses anyone else, so nothing asks. */
    canCheck: boolean;
  }>,
) {
  const { serverId, machineId } = input;
  const observation = useMachineField(machineId, 'daemonState', 'setup', {
    serverId,
    enabled: input.active,
  });
  const retainedSetup = useMachineField(machineId, 'metadata', 'setup', { serverId, enabled: input.active });
  const { binding } = useServerCredentialAccountScopeBinding(serverId);
  const homeId = getServerProfileById(serverId)?.serverIdentityId ?? null;
  const presetUpdates = useMachinePresetUpdates({ serverId, machineId, active: input.active });
  const scopeKey = JSON.stringify([
    serverId,
    binding?.accountId ?? null,
    machineId,
  ]);

  const [current, setCurrent] = React.useState<Readonly<{
    key: string;
    plan: MachineSetupPlanResultV1;
    sourcePresentations: readonly MachineSetupSourcePresentationV1[];
    checkedAt: number;
    checkedAfterOperationId: string | null;
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
  const [accepted, setAccepted] = React.useState<Readonly<{
    scopeKey: string;
    operationId: string;
    actionId: 'machines.setup.apply' | 'machines.setup.remove';
    runId?: string;
  }> | Readonly<{ scopeKey: string; operationId: null; actionId?: never; runId?: never }> | null>(null);
  const retainedOperation = useMachineSetupActionOperation(binding ? { serverId, machineId, accountId: binding.accountId } : null);
  const currentAccepted = accepted?.scopeKey === scopeKey ? accepted : null;
  const operationId = currentAccepted ? currentAccepted.operationId : retainedOperation?.snapshot.operationId ?? null;
  const operation = useActionOperation({
    serverId,
    operationId: operationId ?? '',
  }, { machineId, actionId: currentAccepted?.actionId ?? retainedOperation?.snapshot.actionId ?? '', lifetime: binding });
  // The combined root owns settlement; its child owns native rows and output.
  const retainedResult = ManagedMachineActionOutputSchemasV1['machines.setup.apply'].safeParse(operation?.snapshot.result);
  const runId = currentAccepted?.runId ?? (retainedResult.success ? retainedResult.data.runId : undefined);
  const nativeOperation = useMachineSetupRunActionOperation(runId && binding ? {
    serverId, accountId: binding.accountId, machineId, runId,
  } : null);
  const progressOperation = runId ? nativeOperation : operation;
  const checkedAfterOperationId = operationId !== null && operation !== null && isActionOperationTerminal(operation.snapshot.state)
    ? operationId : null;
  const plan = current?.key === scopeKey ? current.plan : null;
  const sourcePresentations = React.useMemo(() => {
    if (!current || current.key !== scopeKey) return null;
    if (!retainedSetup) return current.sourcePresentations;
    const retained = readRetainedManagedOpaqueSetupSourcesV1(current.plan.sources, retainedSetup.sources);
    return current.sourcePresentations.map((presentation, index): MachineSetupSourcePresentationV1 => {
      const source = retained.get(machineSetupSourceApplyOriginKeyV1(current.plan.sources[index]!));
      return source ? { ...presentation, kind: 'opened', source } : presentation;
    });
  }, [current, scopeKey, retainedSetup]);

  const context = React.useCallback(
    () =>
      binding
        ? {
            surface: 'ui' as const,
            authority: 'present_user' as const,
            serverId,
            expectedAccountId: binding.accountId,
          }
        : null,
    [binding, serverId],
  );
  const readCurrent = React.useRef<Readonly<{ scopeKey: string; checkedAfterOperationId: string | null; promise: Promise<void> }> | null>(null);
  const check = React.useCallback((): Promise<void> => {
    const ctx = context();
    if (!binding?.isCurrent() || !ctx || !homeId) return Promise.resolve();
    const reading = readCurrent.current;
    if (reading) return reading.scopeKey === scopeKey && reading.checkedAfterOperationId === checkedAfterOperationId
      ? reading.promise
      // A pre-settlement read cannot establish a post-run observation. Join it,
      // then let this same owner read once for the newly settled operation.
      : reading.promise.then(() => check());
    setChecking(true);
    const promise = (async () => {
      try {
        const result = await execute(
          'machines.setup.plan',
          { homeId, machineId, mode: 'check' },
          ctx,
        );
        if (!binding.isCurrent()) return;
        if (!result.ok) {
          setFailure({
            code: homeDomainFailureCode(homeDomainFailureFromActionFailure(result)),
            during: 'check',
            failure: result,
          });
          return;
        }
        const outcome = classifyHomeActionOutcome(result);
        const parsed =
          outcome.kind === 'completed'
            ? MachineSetupPlanResultV1Schema.safeParse(outcome.result)
            : null;
        if (!parsed?.success) {
          setFailure({ code: 'managed_response_invalid', during: 'check' });
          return;
        }
        const presentations = await openManagedMachineSetupPlanSourcesV1({
          serverId,
          accountId: binding.accountId,
          plan: parsed.data,
        });
        if (!binding.isCurrent()) return;
        setCurrent({
          key: scopeKey,
          plan: parsed.data,
          sourcePresentations: presentations,
          checkedAt: Date.now(),
          checkedAfterOperationId,
        });
        setFailure((previous) =>
          previous?.during === 'check' ? null : previous,
        );
      } catch (error) {
        const reason = classifyAccountStorageReadFailure(error);
        if (reason === 'cancelled' || reason === 'scope-retired') return;
        if (binding.isCurrent())
          setFailure({ code: 'managed_request_failed', during: 'check' });
      } finally {
        readCurrent.current = null;
        setChecking(false);
      }
    })();
    readCurrent.current = { scopeKey, checkedAfterOperationId, promise };
    return promise;
  }, [binding, context, homeId, machineId, scopeKey, serverId, checkedAfterOperationId]);

  // Opening, reconnecting, or settling the displayed setup operation demands
  // one check. Other publications do not start reads.
  const demanded =
    input.active && input.online !== false && input.canCheck && !!binding && !!homeId;
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
      setAccepted({ scopeKey, operationId: output.data.operationId, actionId,
        ...('runId' in output.data && typeof output.data.runId === 'string' ? { runId: output.data.runId } : {}) });
    },
    [scopeKey],
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
        } else if (intent.kind === 'sources') {
          prepared = await prepareMachineSetupSourcesAdditionApplyInput({
            executeAction: execute, context: ctx, homeId, machineId, sources: intent.sources, isCurrent,
            ...(intent.candidatePreset === undefined ? {} : { candidatePreset: intent.candidatePreset }),
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
          // The open tab already holds the attached references; candidate Plan alone admits their replacement.
          const result = intent.kind === 'presetUpdate' ? null : await execute(
            'machines.setup.plan',
            { homeId, machineId },
            ctx,
          );
          const outcome = result ? classifyHomeActionOutcome(result) : null;
          const parsed =
            outcome?.kind === 'completed'
              ? MachineSetupPlanResultV1Schema.safeParse(outcome.result)
              : null;
          const baseline = intent.kind === 'presetUpdate' ? plan : parsed?.success ? parsed.data : null;
          prepared =
            result?.ok === false
              ? result
              : !baseline
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
                            ? baseline.sources.filter(
                                (source) => machineSetupSourceApplyOriginKeyV1(source) !== intent.sourceKey,
                              )
                            : intent.kind === 'presetUpdate'
                              ? baseline.sources.map(source => source.kind === 'accountPresetOpaque' && source.presetId === intent.presetId
                                ? { kind: source.kind, presetId: source.presetId, presetRevision: intent.presetRevision,
                                  contentEncryptionMode: source.contentEncryptionMode, setupRevision: intent.setupRevision }
                                : source)
                            : baseline.sources,
                        ...(intent.kind === 'presetUpdate' ? { candidatePreset: {
                          presetId: intent.presetId, presetRevision: intent.presetRevision,
                        } } : {}),
                        ...(intent.kind === 'stop' ? { current: baseline } : {}),
                        desiredRevision: baseline.desiredRevision,
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
    [binding, context, homeId, machineId, pending, plan],
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

  return {
    observation,
    presetUpdates,
    plan,
    sourcePresentations,
    checkedAt: current?.key === scopeKey ? current.checkedAt : null,
    checkedAfterOperationId: current?.key === scopeKey ? current.checkedAfterOperationId : null,
    checking,
    failure,
    review,
    pending,
    approvalId: approval.approvalId,
    operationId, operation: operationId ? operation : null,
    progressOperation: operationId ? progressOperation : null,
    check,
    prepare,
    apply,
    cancelReview,
    dismissOperation: () => setAccepted({ scopeKey, operationId: null }),
  };
}
export type MachineSetupState = ReturnType<typeof useMachineSetup>;

type SetupItem = MachineSetupRecipeItemV1;
type RecipeStatus = MachineSetupPlanResultV1['support'][number]['status'];
export type MachineSetupRecipeRow = Readonly<{
    key: string;
    ref: SetupItem['selection']['ref'];
    item: SetupItem;
    title: NonNullable<MachineSetupPlanResultV1['recipeTitles']>[number]['title'] | null;
    status: RecipeStatus | null;
    /** The owner's typed reason when the state needs one (unsupported, unchecked). */
    reason: MachineSetupPlanResultV1['support'][number]['reason'] | null;
    /** The missing fact selected by the native owner, when it is known. */
    requiredFact: string | null;
    /** The Plan source that holds it, so the row can name the preset it came from. */
    sourceIndex: number;
    /** Exact historical name from the opened recipient projection, never a current preset lookup. */
    presetName: string | null;
    /** From the Machine's preset (changed through the preset), or added on this Machine (removable here). */
    fromPreset: boolean;
    removable: boolean;
}>;

const NO_RECIPES: readonly MachineSetupRecipeRow[] = Object.freeze([]);
const sameRef = (a: SetupItem['selection']['ref'], b: SetupItem['selection']['ref']) =>
    a.pluginId === b.pluginId && a.recipeId === b.recipeId && a.revision === b.revision;

/**
 * The one attached saved preset whose catalog App still lacks the address a Plan refused for (`template_domain_required`
 * names only the template's address key): the Machine's published attachment list, read against the Account's presets.
 * Null when none or several match, so the caller keeps its Retry instead of guessing.
 */
export function findMachineSetupPresetMissingAddress(
    attached: readonly MachineSetupPresetReferenceV1[] | undefined,
    presets: readonly MachineSetupPresetChoice[],
    addressKey: string,
): string | null {
    const attachedIds = new Set((attached ?? []).flatMap(ref => ref.kind === 'accountPreset' ? [ref.presetId] : []));
    const matches = presets.flatMap(preset => !('kind' in preset) && attachedIds.has(preset.id)
        && (preset.setup.items ?? []).some(item => item.kind === 'app' && item.definition.definition.from === 'catalogApp'
            && !item.definition.domainBindings?.some(binding => binding.templateDomainId === addressKey)) ? [preset.id] : []);
    return matches.length === 1 ? matches[0]! : null;
}

/** The apps in locally opened sources, in their original Plan order. */
export function readMachineSetupApps(sources: readonly MachineSetupOpenedSourceV1[]) {
    return sources.flatMap(({ source, sourceIndex, presetName }) => (source.setup.items ?? []).flatMap((item, itemIndex) =>
        item.kind === 'app' ? [{ key: `${sourceIndex}.${itemIndex}`, item, sourceIndex, source, presetName }] : []));
}

/**
 * One row per recipe the Machine's setup holds, in source order: its own name from the Plan's declaration read, and
 * its state from the Plan's check, else the daemon's last published observation (MR7: a row fact, never a setting).
 */
export function readMachineSetupRecipes(
    plan: MachineSetupPlanResultV1 | null,
    sources: readonly MachineSetupOpenedSourceV1[],
    observation: Readonly<{ recipes: readonly Readonly<{ ref: SetupItem['selection']['ref']; status: RecipeStatus; reason?: MachineSetupPlanResultV1['support'][number]['reason'] }>[] }> | null | undefined,
): readonly MachineSetupRecipeRow[] {
    if (!plan) return NO_RECIPES;
    const rows: MachineSetupRecipeRow[] = [];
    sources.forEach(({ source, sourceIndex, presetName }) => {
        (source.setup.items ?? []).forEach((item, itemIndex) => {
            if (!isMachineSetupRecipeItemV1(item)) return;
            const ref = item.selection.ref;
            if (rows.some(row => sameRef(row.ref, ref))) return;
            const checked = plan.support.find(entry => entry.sourceIndex === sourceIndex && entry.itemIndex === itemIndex);
            const observed = observation?.recipes.find(entry => sameRef(entry.ref, ref));
            rows.push({
                key: `${sourceIndex}.${itemIndex}`, ref, item,
                title: plan.recipeTitles?.find(entry => sameRef(entry.ref, ref))?.title ?? null,
                status: checked?.status ?? observed?.status ?? null,
                reason: (checked ?? observed)?.reason ?? null,
                requiredFact: checked?.requiredFact ?? null,
                sourceIndex,
                presetName: source.kind === 'accountPreset' ? presetName ?? null : null,
                fromPreset: source.kind !== 'direct',
                removable: source.kind === 'direct',
            });
        });
    });
    return rows;
}
