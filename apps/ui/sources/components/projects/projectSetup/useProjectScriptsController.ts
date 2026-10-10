import * as React from 'react';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import {
  ProjectWorkerNoAcceptanceFailureDetailsV1Schema,
  type ProjectWorkerNoAcceptanceFailureDetailsV1,
  type ProjectSetupConsentFailureDetailsV1,
  type ProjectSetupConsentRequiredV1,
} from '@happier-dev/protocol/actions/projectActionFamily';

import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { publishActionOperationObservation } from '@/sync/domains/actionOperations/actionOperationRuntime';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

import {
  createProjectManifestActionClient,
  type ProjectScriptSelection,
} from './projectManifestActionClient';
import {
  editProjectManifestDocument,
  type ProjectManifestFileSnapshot,
} from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import type { ProjectNativeRefV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { rememberProjectSetupConsent } from './projectSetupConsentDecision';
import { useProjectSetupRun } from './projectScriptRuns';
import { useActionOperationStopControl } from '@/components/inbox/actionOperations/useActionOperationStopControl';
import { useActionOperation } from '@/sync/domains/actionOperations/useActionOperations';
import type { ActionOperationAddress, QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { randomUUID } from '@/platform/randomUUID';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { managedMachineCreationIntent, type ManagedMachineSelectionDraft, type ManagedMachineAcquisitionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { runManagedMachineCreation, type ManagedMachineCreationProgress } from '@/components/settings/machines/managed/managedMachineCreation';
import { useManagedMachineInventory } from '@/components/settings/machines/managed/useManagedMachineInventory';

/** The setup review a preparation or run asked for: its digest, the safe resolved effect and any requested scope. */
export type ProjectSetupConsent = Pick<ProjectSetupConsentRequiredV1, 'code' | 'reviewedEffectDigest'>
  & Readonly<{ reviewedEffect?: unknown; consentScope?: ProjectSetupConsentFailureDetailsV1['consentScope']; operation?: QualifiedActionOperation }>;

function readConsentDetails(error: unknown): ProjectSetupConsentFailureDetailsV1 | null {
  return error && typeof error === 'object' && 'consent' in error ? (error.consent as ProjectSetupConsentFailureDetailsV1) : null;
}
type PendingKeys = Readonly<Record<string, true>>;
type ManagedCreation = Readonly<{ scopeKey: string; key: string;
  acquisition: ManagedMachineAcquisitionDraft; progress: ManagedMachineCreationProgress;
  /** The reviewed recipe's machine name, for the Script row's creation notice. */
  machineName: string }>;
const EMPTY_PENDING: PendingKeys = {};
const EMPTY_CREATIONS: Readonly<Record<string, ManagedCreation>> = {};
type Failure = Readonly<{ key: string; code: string; workerRefusal?: ProjectWorkerNoAcceptanceFailureDetailsV1 }> | null;
type RunChoiceRequest = Readonly<{ scopeKey: string; key: string; selection: ProjectScriptSelection }>;

/** The accepted snapshot the Action returned joins the operation store at once (daemon state stays canonical). */
function publishAcceptedOperation(binding: ServerCredentialAccountScopeBinding | null, operation: ActionOperationSnapshotV1): void {
  if (!binding?.isCurrent()) return;
  publishActionOperationObservation({ serverId: binding.serverId, machineId: operation.scope.machineId, observation: 'available', snapshots: [operation] });
}

function readErrorCode(error: unknown): string {
  return error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : 'request_failed';
}

/**
 * The Scripts surface's one dispatch owner: Run (`projects.script.run`), setup preparation
 * (`projects.prepare`) and the shared Ask-first approval continuation, for one exact checkout and
 * the Account the Workbench captured. Status is never decided here; rows read the operation store.
 */
export function useProjectScriptsController(
  workspace: WorkspaceAddressV1,
  onChanged: () => void,
  binding: ServerCredentialAccountScopeBinding | null,
  options?: Readonly<{ execute?: (...args: Parameters<ReturnType<typeof createFrontDoorActionExecute>>) => ReturnType<ReturnType<typeof createFrontDoorActionExecute>> }>,
) {
  const accountId = binding?.isCurrent() ? binding.accountId : null;
  const setupOperation = useProjectSetupRun(workspace, accountId);
  const setupStop = useActionOperationStopControl(setupOperation);
  const scopeKey = JSON.stringify([
    workspace.serverId,
    accountId,
    workspace.machineId,
    workspace.workspaceId,
    workspace.rootPath,
  ]);
  // Keep the returned invocation address, not a second run history or a local status owner.
  const [retained, setRetained] = React.useState<Readonly<{ scopeKey: string; address: ActionOperationAddress }> | null>(null);
  const retainedOperation = useActionOperation(retained?.scopeKey === scopeKey
    ? retained.address : { serverId: workspace.serverId, operationId: '' });
  const heldOperation = retainedOperation?.snapshot.setupReview ? retainedOperation
    : setupOperation?.snapshot.setupReview ? setupOperation : null;
  const heldReview = heldOperation?.snapshot.setupReview;
  const approval = useActionApprovalContinuation({
    scopeKey,
    serverId: workspace.serverId,
    onExecuted: onChanged,
  });
  const requestApprovalRef = React.useRef<
    (registration: ActionApprovalRegistration) => void
  >(() => {});
  requestApprovalRef.current = approval.requestApproval;
  const [pending, setPending] = React.useState<Readonly<{ scopeKey: string; keys: PendingKeys }> | null>(null);
  const [failure, setFailure] = React.useState<Failure>(null);
  const [choiceRequest, setChoiceRequest] = React.useState<RunChoiceRequest | null>(null);
  const [consent, setConsent] = React.useState<
    (ProjectSetupConsent & Readonly<{ scopeKey: string }>) | null
  >(null);
  const [reviewOpenScope, setReviewOpenScope] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (heldReview) setReviewOpenScope(scopeKey);
  }, [heldOperation?.snapshot.operationId, heldReview?.reviewedEffectDigest, scopeKey]);
  const openSetupReview = React.useCallback(() => setReviewOpenScope(scopeKey), [scopeKey]);
  const dismissConsent = React.useCallback(() => { setConsent(null); setReviewOpenScope(null); }, []);
  const lifetime = React.useMemo(() => new AbortController(), [binding, scopeKey]);
  const execute = React.useMemo(() => createFrontDoorActionExecute(options?.execute ? { execute: options.execute } : undefined), [options?.execute]);
  // Local continuation identity, never a worker preference or a second resource store.
  const managedRuns = React.useMemo(() => new Map<string, { draft: ManagedMachineSelectionDraft;
    selection: ProjectScriptSelection; acquisition: ManagedMachineAcquisitionDraft }>(), [lifetime]);
  const runAborts = React.useMemo(() => new Map<string, AbortController>(), [lifetime]);
  const [creations, setCreations] = React.useState<Readonly<{
    scopeKey: string; values: Readonly<Record<string, ManagedCreation>>;
  }> | null>(null);
  const managedCreations = creations?.scopeKey === scopeKey ? creations.values : EMPTY_CREATIONS;
  const pendingKeys = pending?.scopeKey === scopeKey ? pending.keys : EMPTY_PENDING;
  const hasAcquisition = Object.values(managedCreations).some(creation => creation.acquisition.managedId);
  const inventoryIds = React.useMemo(() => hasAcquisition ? [workspace.serverId] : [], [hasAcquisition, workspace.serverId]);
  // The existing Home inventory supplies every row's enrollment; rows do not create observers.
  const inventory = useManagedMachineInventory(inventoryIds, undefined, execute);
  const cancelRun = React.useCallback((key: string) => {
    runAborts.get(key)?.abort(); runAborts.delete(key);
    setPending(previous => {
      if (previous?.scopeKey !== scopeKey || !previous.keys[key]) return previous;
      const { [key]: _canceled, ...keys } = previous.keys;
      return { scopeKey, keys };
    });
    setCreations(previous => {
      const creation = previous?.scopeKey === scopeKey ? previous.values[key] : null;
      if (!creation || !previous) return previous;
      return { scopeKey, values: { ...previous.values, [key]: { ...creation,
        progress: { kind: 'failed', code: 'continuation_retired',
          ...(creation.acquisition.managedId ? { managedId: creation.acquisition.managedId } : {}) } } } };
    });
  }, [runAborts, scopeKey]);

  React.useEffect(() => {
    const retirement = binding?.onRetire(() => {
      lifetime.abort(); runAborts.forEach(cancellation => cancellation.abort()); runAborts.clear();
      setCreations(null); setPending(null); setFailure(null); setConsent(null); setReviewOpenScope(null); setChoiceRequest(null); setRetained(null);
    });
    return () => { retirement?.dispose(); lifetime.abort(); runAborts.forEach(cancellation => cancellation.abort()); runAborts.clear(); };
  }, [binding, lifetime, runAborts]);

  const client = React.useMemo(
    () =>
      accountId
        ? createProjectManifestActionClient({
            workspace,
            expectedAccountId: accountId,
            execute: options?.execute,
            signal: lifetime.signal,
            onApprovalPending: (registration) =>
              requestApprovalRef.current(registration),
          })
        : null,
    [accountId, lifetime, options?.execute, workspace],
  );

  const dispatch = React.useCallback(
    async <T>(key: string, call: () => Promise<T>, runSelection?: ProjectScriptSelection, signal = lifetime.signal): Promise<T | null> => {
      if (!client || !binding?.isCurrent() || lifetime.signal.aborted) return null;
      setPending(previous => ({ scopeKey, keys: { ...(previous?.scopeKey === scopeKey ? previous.keys : {}), [key]: true } }));
      setFailure((current) => (current?.key === key ? null : current));
      try {
        const value = await call();
        return signal?.aborted ? null : value;
      } catch (error) {
        if (signal?.aborted) return null;
        // The typed D18 review is not a failure: it opens the setup review with its facts.
        const details = readConsentDetails(error);
        if (details) setConsent({ scopeKey, code: details.code, reviewedEffectDigest: details.reviewedEffectDigest,
          reviewedEffect: details.reviewedEffect, ...(details.consentScope ? { consentScope: details.consentScope } : {}) });
        else {
          const worker = ProjectWorkerNoAcceptanceFailureDetailsV1Schema.safeParse(
            error && typeof error === 'object' && 'workerRefusal' in error ? error.workerRefusal : undefined,
          );
          const code = readErrorCode(error);
          if (code === 'choice_required' && runSelection && !worker.success)
            setChoiceRequest({ scopeKey, key, selection: runSelection });
          else setFailure({ key, code, ...(worker.success ? { workerRefusal: worker.data } : {}) });
        }
        return null;
      } finally {
        if (!signal.aborted) setPending(previous => {
          if (previous?.scopeKey !== scopeKey || !previous.keys[key]) return previous;
          const { [key]: _completed, ...keys } = previous.keys;
          return { scopeKey, keys };
        });
      }
    },
    [binding, client, lifetime, scopeKey],
  );

  const run = React.useCallback(
    async (key: string, selection: ProjectScriptSelection, choice?: ProjectExecutionChoiceV1, managed?: ManagedMachineSelectionDraft) => {
      if (!client || !binding?.isCurrent() || lifetime.signal.aborted || runAborts.has(key)) return;
      const cancellation = new AbortController();
      runAborts.set(key, cancellation);
      const retirement = binding.onRetire(() => cancellation.abort());
      const current = () => binding.isCurrent() && !lifetime.signal.aborted && !cancellation.signal.aborted;
      setChoiceRequest(previous => previous?.key === key ? null : previous);
      const result = await dispatch(key, async () => {
        let destination = choice;
        if (managed) {
          if (managed.selection.homeId !== getServerProfileById(workspace.serverId)?.serverIdentityId)
            throw Object.assign(new Error('scope_mismatch'), { code: 'scope_mismatch' });
          const previous = managedRuns.get(key);
          const continuation = previous && sameStrictJsonValue(managedMachineCreationIntent(previous.draft), managedMachineCreationIntent(managed))
            ? previous : { draft: managed, selection, acquisition: { requestId: randomUUID(), selection: managed.selection } };
          continuation.selection = selection;
          managedRuns.set(key, continuation);
          const acquired = await runManagedMachineCreation({ draft: managedMachineCreationIntent(managed)!,
            acquisition: continuation.acquisition, scope: binding.scope, signal: cancellation.signal, isCurrent: current,
            executeAction: execute, onApprovalPending: registration => requestApprovalRef.current(registration),
            onAcquisitionChange: value => { continuation.acquisition = value; },
            onProgress: progress => { if (current()) setCreations(previous => ({ scopeKey,
              values: { ...(previous?.scopeKey === scopeKey ? previous.values : {}),
                [key]: { scopeKey, key, acquisition: continuation.acquisition, progress,
                  machineName: continuation.draft.receipt.launch.name } } })); },
          });
          if (!current() || acquired.kind === 'pending' || acquired.kind === 'delete_requested') return null;
          if (acquired.kind === 'failed') throw Object.assign(new Error(acquired.code), { code: acquired.code });
          destination = { kind: 'workers', destination: { kind: 'machine', machineId: acquired.machine.enrolledMachineId } };
        }
        if (!current()) return null;
        return createProjectManifestActionClient({ workspace, expectedAccountId: binding.accountId, execute,
          signal: cancellation.signal, onApprovalPending: registration => requestApprovalRef.current(registration) }).runScript(selection, destination);
      }, selection, cancellation.signal);
      retirement.dispose();
      if (runAborts.get(key) === cancellation) runAborts.delete(key);
      if (!current()) return;
      if (!result) return;
      if ('operation' in result) {
        publishAcceptedOperation(binding, result.operation);
        setRetained({ scopeKey, address: { serverId: workspace.serverId, operationId: result.operation.operationId } });
      } else
        setConsent({
          scopeKey,
          code: result.code,
          reviewedEffectDigest: result.reviewedEffectDigest,
          ...(result.consentScope ? { consentScope: result.consentScope } : {}),
        });
    },
    [binding, client, dispatch, execute, lifetime, managedRuns, runAborts, scopeKey, workspace],
  );

  const resumeManagedRun = React.useCallback(async (key: string) => {
    const continuation = managedRuns.get(key);
    if (continuation) await run(key, continuation.selection, undefined, continuation.draft);
  }, [managedRuns, run]);
  // The existing push-refreshed inventory owns enrollment observation. No timer or polling owner.
  const enrollment = inventory.entries[workspace.serverId];
  React.useEffect(() => {
    if (lifetime.signal.aborted || !binding?.isCurrent() || enrollment?.status !== 'ready') return;
    for (const creation of Object.values(managedCreations)) {
      if (creation.progress.kind !== 'acquiring' && creation.progress.kind !== 'enrollment_pending'
        && creation.progress.kind !== 'setup_pending') continue;
      if (enrollment.machines.some(machine => machine.id === creation.acquisition.managedId
        && machine.enrolledMachineId && machine.creationState === 'active'
        && machine.environmentSetup?.state !== 'pending' && machine.environmentSetup?.state !== 'running')) void resumeManagedRun(creation.key);
    }
  }, [binding, managedCreations, enrollment, lifetime, pendingKeys, resumeManagedRun]);

  const choiceRequired = choiceRequest?.scopeKey === scopeKey ? choiceRequest : null;
  const dismissChoice = React.useCallback(() => setChoiceRequest(null), []);
  const chooseForRun = React.useCallback(async (choice: ProjectExecutionChoiceV1) => {
    if (!choiceRequired || lifetime.signal.aborted || !binding?.isCurrent()) return;
    if (choice.kind === 'workers' && choice.destination.kind !== 'machine') return;
    await run(choiceRequired.key, choiceRequired.selection, choice);
  }, [binding, choiceRequired, lifetime, run]);

  const prepare = React.useCallback(
    async (expectedEffectDigest?: string, consentScope?: ProjectSetupConsentFailureDetailsV1['consentScope']) => {
      if (!client) return null;
      const result = await dispatch('setup', async () => {
        // Remember remeasures and resumes the exact held invocation through its existing owner.
        // It must not launch a separate preparation after deciding the Script's setup review.
        if (expectedEffectDigest && consentScope === 'untilChanged' && binding?.isCurrent()) {
          const remembered = await rememberProjectSetupConsent({
            scope: { serverId: binding.serverId, accountId: binding.accountId },
            workspace, reviewedEffectDigest: expectedEffectDigest, operation: heldOperation ?? undefined,
            signal: lifetime.signal,
          });
          if (remembered.kind !== 'remembered') throw Object.assign(new Error(remembered.kind === 'changed'
            ? 'project_setup_effect_changed' : remembered.code), { code: remembered.kind === 'changed'
            ? 'project_setup_effect_changed' : remembered.code });
          return remembered;
        }
        return client.prepare({
          phase: 'setup',
          ...(expectedEffectDigest ? { expectedEffectDigest } : {}),
          ...(expectedEffectDigest && consentScope ? { consentScope } : {}),
        });
      });
      if (!result) return null;
      if ('kind' in result && result.kind === 'pendingApproval') {
        setConsent({
          scopeKey,
          code: result.code,
          reviewedEffectDigest: result.reviewedEffectDigest,
          ...(result.consentScope ? { consentScope: result.consentScope } : {}),
        });
        return result;
      }
      setConsent(null);
      setReviewOpenScope(null);
      if ('operation' in result) {
        publishAcceptedOperation(binding, result.operation);
        setRetained({ scopeKey, address: { serverId: workspace.serverId, operationId: result.operation.operationId } });
      }
      onChanged();
      return result;
    },
    [binding, client, dispatch, heldOperation, lifetime, onChanged, scopeKey, workspace],
  );

  // Add to project file: one structured edit of the canonical document, one guarded write.
  const add = React.useCallback(
    async (key: string, definition: ProjectManifestFileSnapshot, source: ProjectNativeRefV1) => {
      const document = definition.document;
      if (!client || document?.status !== 'valid' || Object.hasOwn(document.manifest.scripts ?? {}, source.target)) return;
      const next = editProjectManifestDocument(document, [{ kind: 'set', path: ['scripts', source.target], value: { source } }]);
      const result = await dispatch(key, () => client.update({ expectedBasis: definition.basis, bytes: next.bytes }));
      if (!result) return;
      if (result.status === 'refused') setFailure({ key, code: result.code });
      onChanged();
    },
    [client, dispatch, onChanged],
  );

  return {
    accountId,
    setupOperation,
    retainedOperation,
    setupStop,
    setupReviewOpen: reviewOpenScope === scopeKey || consent?.scopeKey === scopeKey,
    openSetupReview,
    ready: client !== null,
    client,
    add,
    run,
    managedCreations,
    resumeManagedRun,
    cancelRun,
    choiceRequired,
    dismissChoice,
    chooseForRun,
    prepare,
    pendingKeys,
    failure,
    consent: heldReview && heldOperation ? { ...heldReview, operation: heldOperation }
      : consent?.scopeKey === scopeKey ? consent : null,
    dismissConsent,
    approvalId: approval.approvalId,
  };
}

export type ProjectScriptsController = ReturnType<typeof useProjectScriptsController>;
