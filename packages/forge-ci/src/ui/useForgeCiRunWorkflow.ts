import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScmHostingRepositoryIdentityV1 } from '@happier-dev/plugin-sdk/scm';
import type { ForgeCiActionInputByOperationV1, ForgeCiMutationResultV1, ForgeCiTriggerValuesV1 } from '@happier-dev/triage-protocol/ci/v1';
import { projectForgeCiTriggerFieldsV1, reconcileForgeCiTriggerDraftV1, type ForgeCiTriggerDraftV1, type ForgeCiTriggerOptionsV1 } from '../runtime/triggerFields.js';
import { useForgeCiQueryStatusV1, useForgeCiQueryV1, useForgeCiQueryValueV1 } from './useForgeCiReads.js';
import { useForgeCiPagedQueryV1 } from './useForgeCiPagedQuery.js';
import type { ForgeCiBindingV1 } from './view/binding.js';
import type { ForgeCiMountedTriggerControllerV1, ForgeCiMountedViewV1 } from './mountedCiIntent.js';

/** Controlled logic for the selected-workflow sheet; both the shared form and plugin composition consume it. */
export function useForgeCiRunWorkflowV1(options: Readonly<{
  ci: ForgeCiBindingV1;
  repository: ScmHostingRepositoryIdentityV1;
  workflowId: string;
  initialRef: string;
  /** The selected definition stays readable; only an open form consumes environment choices. */
  formOpen?: boolean;
  view?: ForgeCiMountedViewV1 | null;
  enabled?: boolean;
  onStarted: (runId: string) => void;
}>) {
  const { ci, repository, workflowId, initialRef, onStarted } = options;
  const [ref, setRef] = useState(initialRef);
  const [draft, setDraft] = useState<ForgeCiTriggerDraftV1 | null>(null);
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const [receipt, setReceipt] = useState<Readonly<{
    input: ForgeCiActionInputByOperationV1['dispatchWorkflow'];
    result: ForgeCiMutationResultV1;
  }> | null>(null);
  const lease = useForgeCiQueryV1(ci.reads, 'readTrigger', ref.trim() === '' ? null : { repository, workflowId, ref: ref.trim() });
  const definition = useForgeCiQueryValueV1(lease);
  const status = useForgeCiQueryStatusV1(lease);
  const current = definition !== null && definition.workflowId === workflowId && definition.ref === ref.trim() ? definition : null;
  const needsEnvironments = current?.inputs.some(input => input.type === 'environment' && input.options === undefined) === true;
  const environmentsQuery = useForgeCiPagedQueryV1(ci.reads, 'listEnvironments', needsEnvironments ? { repository } : null, true, options.formOpen !== false);
  const environments = useForgeCiQueryValueV1(environmentsQuery);
  const environmentsStatus = useForgeCiQueryStatusV1(environmentsQuery);
  const environmentFailure = environmentsStatus.snapshot?.failure;
  const environmentOptions = useMemo<ForgeCiTriggerOptionsV1>(() => environmentFailure
    ? { kind: 'unavailable', failure: environmentFailure }
    : environments ? { kind: 'available', values: environments.rows.map(environment => environment.name) } : { kind: 'loading' },
  [environments, environmentFailure]);
  useEffect(() => {
    if (current === null) return;
    setDraft(previous => reconcileForgeCiTriggerDraftV1({
      projection: projectForgeCiTriggerFieldsV1({ definition: current, environmentOptions, ...(previous ? { baseline: previous.projection } : {}) }),
      ...(previous ? { baseline: previous } : {}),
    }));
  }, [current, environmentOptions]);
  const trigger = useMemo<ForgeCiMountedTriggerControllerV1>(() => ({
    available: current?.dispatchable === true && options.enabled !== false && ci.adapter !== null,
    environmentCursor: environments?.continuation ?? null,
    setRef,
    setDraftValues(values) {
      if (!draft || !current || draft.projection.definition !== current) return false;
      setDraft(reconcileForgeCiTriggerDraftV1({ projection: draft.projection, baseline: draft, values }));
      return true;
    },
    async loadMore(cursor) {
      if (!environmentsQuery || environmentsQuery.getValue()?.continuation !== cursor) return false;
      await environmentsQuery.loadMore();
      return environmentsQuery.getSnapshot().failure === null;
    },
  }), [current, options.enabled, ci.adapter, environments?.continuation, environmentsQuery, draft]);
  useEffect(() => { options.view?.setTriggerController(trigger); }, [options.view, trigger]);
  useEffect(() => () => { options.view?.setTriggerController(null); }, [options.view, workflowId]);
  const run = async (inputs: ForgeCiTriggerValuesV1) => {
    if (!ci.adapter || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    try {
      const input = { repository, workflowId, ref: ref.trim(), inputs };
      const outcome = await ci.adapter.dispatchWorkflow(input);
      await ci.reads?.completeMutation('dispatchWorkflow', outcome);
      setReceipt({ input, result: outcome });
      if (outcome.kind === 'confirmed' && outcome.affected.run) onStarted(outcome.affected.run.runId);
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };
  return { ref, setRef, draft, setDraft, current, status, environmentsQuery, environmentsStatus, sending, receipt, result: receipt?.result ?? null, run };
}

export type ForgeCiRunWorkflowControllerV1 = ReturnType<typeof useForgeCiRunWorkflowV1>;
