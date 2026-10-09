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

/** The setup review a preparation or run asked for: its digest, the safe resolved effect and any requested scope. */
export type ProjectSetupConsent = Pick<ProjectSetupConsentRequiredV1, 'code' | 'reviewedEffectDigest'>
  & Readonly<{ reviewedEffect?: unknown; consentScope?: ProjectSetupConsentFailureDetailsV1['consentScope'] }>;

function readConsentDetails(error: unknown): ProjectSetupConsentFailureDetailsV1 | null {
  return error && typeof error === 'object' && 'consent' in error ? (error.consent as ProjectSetupConsentFailureDetailsV1) : null;
}
type Pending = Readonly<{ key: string }> | null;
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
  const approval = useActionApprovalContinuation({
    scopeKey,
    serverId: workspace.serverId,
    onExecuted: onChanged,
  });
  const requestApprovalRef = React.useRef<
    (registration: ActionApprovalRegistration) => void
  >(() => {});
  requestApprovalRef.current = approval.requestApproval;
  const [pending, setPending] = React.useState<Pending>(null);
  const [failure, setFailure] = React.useState<Failure>(null);
  const [choiceRequest, setChoiceRequest] = React.useState<RunChoiceRequest | null>(null);
  const [consent, setConsent] = React.useState<
    (ProjectSetupConsent & Readonly<{ scopeKey: string }>) | null
  >(null);
  const [reviewOpenScope, setReviewOpenScope] = React.useState<string | null>(null);
  const openSetupReview = React.useCallback(() => setReviewOpenScope(scopeKey), [scopeKey]);
  const dismissConsent = React.useCallback(() => { setConsent(null); setReviewOpenScope(null); }, []);
  const lifetime = React.useMemo(() => new AbortController(), [binding, scopeKey]);

  React.useEffect(() => {
    const retirement = binding?.onRetire(() => {
      lifetime.abort(); setPending(null); setFailure(null); setConsent(null); setReviewOpenScope(null); setChoiceRequest(null);
    });
    return () => { retirement?.dispose(); lifetime.abort(); };
  }, [binding, lifetime]);

  const client = React.useMemo(
    () =>
      accountId
        ? createProjectManifestActionClient({
            workspace,
            expectedAccountId: accountId,
            signal: lifetime.signal,
            onApprovalPending: (registration) =>
              requestApprovalRef.current(registration),
          })
        : null,
    [accountId, lifetime, workspace],
  );

  const dispatch = React.useCallback(
    async <T>(key: string, call: () => Promise<T>, runSelection?: ProjectScriptSelection): Promise<T | null> => {
      if (!client || !binding?.isCurrent() || lifetime.signal.aborted) return null;
      const signal = lifetime.signal;
      setPending({ key });
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
        if (!signal?.aborted)
          setPending((current) => (current?.key === key ? null : current));
      }
    },
    [binding, client, lifetime, scopeKey],
  );

  const run = React.useCallback(
    async (key: string, selection: ProjectScriptSelection, choice?: ProjectExecutionChoiceV1) => {
      if (!client) return;
      setChoiceRequest(null);
      const result = await dispatch(key, () => client.runScript(selection, choice), selection);
      if (!result) return;
      if ('operation' in result) {
        publishAcceptedOperation(binding, result.operation);
      } else
        setConsent({
          scopeKey,
          code: result.code,
          reviewedEffectDigest: result.reviewedEffectDigest,
          ...(result.consentScope ? { consentScope: result.consentScope } : {}),
        });
    },
    [binding, client, dispatch, scopeKey],
  );

  const choiceRequired = choiceRequest?.scopeKey === scopeKey ? choiceRequest : null;
  const dismissChoice = React.useCallback(() => setChoiceRequest(null), []);
  const chooseForRun = React.useCallback(async (choice: ProjectExecutionChoiceV1) => {
    if (!choiceRequired || lifetime.signal.aborted || !binding?.isCurrent()) return;
    if (choice.kind === 'workers' && choice.destination.kind !== 'machine') return;
    await run(choiceRequired.key, choiceRequired.selection, choice);
  }, [binding, choiceRequired, lifetime, run]);

  const prepare = React.useCallback(
    async (expectedEffectDigest?: string, consentScope?: ProjectSetupConsentFailureDetailsV1['consentScope']) => {
      if (!client) return;
      const result = await dispatch('setup', async () => {
        // "Until it changes" is the person's own Project Trust grant for this exact reviewed effect
        // (D18); it is written first through the one decision owner, then setup runs under it.
        if (expectedEffectDigest && consentScope === 'untilChanged' && binding?.isCurrent()) {
          const remembered = await rememberProjectSetupConsent({
            scope: { serverId: binding.serverId, accountId: binding.accountId },
            workspace, reviewedEffectDigest: expectedEffectDigest,
          });
          if (remembered.kind !== 'remembered') throw Object.assign(new Error(remembered.kind === 'changed'
            ? 'project_setup_effect_changed' : remembered.code), { code: remembered.kind === 'changed'
            ? 'project_setup_effect_changed' : remembered.code });
        }
        return client.prepare({
          phase: 'setup',
          ...(expectedEffectDigest ? { expectedEffectDigest } : {}),
          ...(expectedEffectDigest && consentScope ? { consentScope } : {}),
        });
      });
      if (!result) return;
      if ('kind' in result && result.kind === 'pendingApproval') {
        setConsent({
          scopeKey,
          code: result.code,
          reviewedEffectDigest: result.reviewedEffectDigest,
          ...(result.consentScope ? { consentScope: result.consentScope } : {}),
        });
        return;
      }
      setConsent(null);
      if ('operation' in result) publishAcceptedOperation(binding, result.operation);
      onChanged();
    },
    [binding, client, dispatch, onChanged, scopeKey, workspace],
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
    setupStop,
    setupReviewOpen: reviewOpenScope === scopeKey || consent?.scopeKey === scopeKey,
    openSetupReview,
    ready: client !== null,
    client,
    add,
    run,
    choiceRequired,
    dismissChoice,
    chooseForRun,
    prepare,
    pendingKey: pending?.key ?? null,
    failure,
    consent: consent?.scopeKey === scopeKey ? consent : null,
    dismissConsent,
    approvalId: approval.approvalId,
  };
}

export type ProjectScriptsController = ReturnType<typeof useProjectScriptsController>;
