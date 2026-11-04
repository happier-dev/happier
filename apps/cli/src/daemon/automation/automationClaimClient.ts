import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from 'axios';
import type {
  AutomationAccountCurrentnessWitnessV1,
  AutomationV3WorkerClaimResponse,
  AutomationV3WorkerAssignmentsResponse,
  AutomationRunLifecycleOccurrenceEvidenceV1,
  AutomationV3WorkerExecutionDispatchOutcome,
} from '@happier-dev/protocol';
import { AutomationV3WorkerClaimResponseSchema, AutomationV3WorkerAssignmentsResponseSchema, AutomationV3WorkerStartResponseSchema, AutomationV3WorkerHeartbeatResponseSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { AutomationExecutionRunLifecycleSourcesResponseSchema, AutomationExecutionRunLifecycleReportResponseSchema } from '@happier-dev/protocol/automations/automationRunLifecycle';

import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { classifyDaemonServerWorkError } from '@/daemon/serverWork/classifyDaemonServerWorkError';
import { logger } from '@/ui/logger';
import {
  createDefaultPluginInstallationPublisherHeader,
  type CreatePluginInstallationPublisherHeader,
} from '@/plugins/installations/publisherProof';
import type {
  AutomationClaimRunResponse,
  AutomationWorkerAssignmentsResponse,
} from './automationTypes';

function authHeaders(token: string): Record<string, string> {
  return {
    ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export type AutomationClaimClient = ReturnType<typeof createAutomationClaimClient>;

export type AutomationLeaseRenewalProgress = Readonly<{
  stage: 'publisher_proof' | 'http' | 'response_decode';
  renewalStartedAtMs: number;
  stageStartedAtMs: number;
  publisherProofDurationMs?: number;
  httpDurationMs?: number;
}>;

type AutomationWorkerProtocol = 'v3';

/**
 * A claim may have committed after its response was lost. Only retry a request
 * for which Axios received no HTTP response and the caller did not cancel, so
 * the same signed request can rejoin the server-owned claim receipt without
 * replaying received failures or overriding cancellation.
 */
function isAmbiguousAutomationClaimTransportFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return true;
  if ('code' in error && error.code === 'ERR_CANCELED') return false;
  return !('response' in error && error.response !== undefined);
}

function toWorkerAssignmentResponseFromV3(
  response: AutomationV3WorkerAssignmentsResponse,
): AutomationWorkerAssignmentsResponse {
  return {
    assignments: response.assignments.map((assignment) => ({
      machineId: assignment.machineId,
      automationId: assignment.automationId,
      nextClaimAt: assignment.nextClaimAt,
      ...(assignment.executionRecipeVersion === undefined ? {} : { executionRecipeVersion: assignment.executionRecipeVersion }),
    })),
    settings: response.settings,
  };
}

function toWorkerClaimResponse(response: AutomationV3WorkerClaimResponse): AutomationClaimRunResponse {
  if (response.run === null && response.automation === null) {
    return { protocol: 'v3', run: null, automation: null };
  }
  if (response.run === null || response.accountCurrentness === null) {
    throw new Error('Automation V3 claim response did not contain Run and Account currentness together');
  }
  if (response.run.automationId === null) {
    if (response.automation !== null) throw new Error('Direct Workflow claim unexpectedly contained an Automation');
    return {
      protocol: 'v3',
      run: {
        id: response.run.id,
        automationId: null,
        leaseExpiresAt: response.run.leaseExpiresAt,
        attempt: response.run.attempt,
        revision: response.run.revision,
        ...(response.run.workflowResumeRequestedRevision === undefined ? {} : {
          workflowResumeRequestedRevision: response.run.workflowResumeRequestedRevision,
        }),
        origin: response.run.origin,
        workflowAcceptedSnapshotEnvelope: response.run.workflowAcceptedSnapshotEnvelope,
        triggerId: null,
      },
      automation: null,
      accountCurrentness: response.accountCurrentness,
    };
  }
  if (response.automation === null) {
    throw new Error('Automation-origin V3 claim did not contain its Automation');
  }
  return {
    protocol: 'v3',
      run: {
        id: response.run.id,
        automationId: response.run.automationId,
        leaseExpiresAt: response.run.leaseExpiresAt,
        attempt: response.run.attempt,
        revision: response.run.revision,
        ...(response.run.workflowResumeRequestedRevision === undefined ? {} : {
          workflowResumeRequestedRevision: response.run.workflowResumeRequestedRevision,
        }),
        recipeKind: response.run.recipeKind,
      executionInputEnvelope: response.run.executionInputEnvelope,
      ...(response.run.workflowAcceptedSnapshotEnvelope === undefined ? {} : {
        workflowAcceptedSnapshotEnvelope: response.run.workflowAcceptedSnapshotEnvelope,
      }),
      ...(response.run.automationEvidenceEnvelope !== undefined
        ? { automationEvidenceEnvelope: response.run.automationEvidenceEnvelope }
        : {}),
      triggerId: response.run.triggerId,
      cause: response.run.cause,
      ...(response.run.causeWorkDepth !== undefined ? { causeWorkDepth: response.run.causeWorkDepth } : {}),
      ...(response.run.lastSucceededRun !== undefined ? { lastSucceededRun: response.run.lastSucceededRun } : {}),
      resultDelivery: response.run.resultDelivery ?? { kind: 'none' },
    },
    automation: {
      id: response.automation.id,
      name: response.automation.name,
      enabled: response.automation.enabled,
      ...(response.automation.workflowDefinitionId !== undefined ? { workflowDefinitionId: response.automation.workflowDefinitionId } : {}),
      ...(response.automation.scopeSessionId !== undefined ? { scopeSessionId: response.automation.scopeSessionId } : {}),
    },
    accountCurrentness: response.accountCurrentness,
  };
}

export function createAutomationClaimClient(params: {
  token: string;
  createPublisherHeader?: CreatePluginInstallationPublisherHeader;
}) {
  const baseUrl = resolveServerHttpBaseUrl();
  const token = params.token;
  const createPublisherHeader = params.createPublisherHeader
    ?? createDefaultPluginInstallationPublisherHeader;
  async function workerHeaders(request: Readonly<{
    method: 'GET' | 'POST';
    path: string;
    body: unknown;
  }>): Promise<Record<string, string>> {
    const publisherHeader = await createPublisherHeader(request);
    return {
      ...authHeaders(token),
      ...(publisherHeader
        ? { [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: publisherHeader }
        : {}),
    };
  }

  return {
    async reportRequesterCustodyUnavailable(input: Readonly<{ machineId: string; runId: string }>): Promise<void> {
      const path = `/v3/automations/runs/${encodeURIComponent(input.runId)}/requester-custody-unavailable`;
      const body = { machineId: input.machineId };
      await axios.post(`${baseUrl}${path}`, body, { headers: await workerHeaders({ method: 'POST', path, body }), timeout: 15_000 });
    },
    async fetchAssignments(machineId: string): Promise<AutomationWorkerAssignmentsResponse> {
      const response = await axios.get<AutomationV3WorkerAssignmentsResponse>(
        `${baseUrl}/v3/automations/worker/assignments`,
        {
          headers: await workerHeaders({ method: 'GET', path: '/v3/automations/worker/assignments', body: null }),
          params: { machineId },
          timeout: 15_000,
        },
      );
      const sources = await axios.get(`${baseUrl}/v3/automations/worker/run-lifecycle`, {
        headers: await workerHeaders({ method: 'GET', path: '/v3/automations/worker/run-lifecycle', body: null }),
        params: { machineId }, timeout: 15_000,
      }).then(result => AutomationExecutionRunLifecycleSourcesResponseSchema.parse(result.data).sources)
        .catch((error: unknown) => {
          // Supported older servers lack this additive source endpoint. Keep ordinary claims usable.
          if (axios.isAxiosError(error) && error.response?.status === 404) return [];
          throw error;
        });
      return { ...toWorkerAssignmentResponseFromV3(AutomationV3WorkerAssignmentsResponseSchema.parse(response.data)), runLifecycleSources: sources };
    },

    async reportRunLifecycle(machineId: string, occurrence: AutomationRunLifecycleOccurrenceEvidenceV1, signal: AbortSignal): Promise<void> {
      const path = '/v3/automations/worker/run-lifecycle';
      const body = { machineId, occurrence };
      const response = await axios.post<unknown>(`${baseUrl}${path}`, body, {
        headers: await workerHeaders({ method: 'POST', path, body }), signal, timeout: 15_000,
      });
      if (!AutomationExecutionRunLifecycleReportResponseSchema.parse(response.data).consumed) throw new Error('run_source_admission_ineligible');
    },

    async claimRun(paramsClaim: { machineId: string; leaseDurationMs: number; scope?: 'session_scoped' | 'workflow' }): Promise<AutomationClaimRunResponse> {
      const body = {
        machineId: paramsClaim.machineId,
        leaseDurationMs: paramsClaim.leaseDurationMs,
        ...(paramsClaim.scope !== undefined ? { scope: paramsClaim.scope } : {}),
      };
      const headers = await workerHeaders({ method: 'POST', path: '/v3/automations/runs/claim', body });
      const request = { headers, timeout: 15_000 };
      const postClaim = () => axios.post<AutomationV3WorkerClaimResponse>(
        `${baseUrl}/v3/automations/runs/claim`, body, request,
      );
      const response = await postClaim().catch(async (error: unknown) => {
        if (!isAmbiguousAutomationClaimTransportFailure(error)) throw error;
        return await postClaim();
      });
      return toWorkerClaimResponse(AutomationV3WorkerClaimResponseSchema.parse(response.data));
    },

    async heartbeatRun(paramsHeartbeat: {
      protocol: AutomationWorkerProtocol;
      runId: string;
      machineId: string;
      attempt: number;
      leaseDurationMs: number;
      renewalDeadlineAtMs: number;
      signal: AbortSignal;
      onProgress?: (progress: AutomationLeaseRenewalProgress) => void;
    }): Promise<number> {
      const path = `/${paramsHeartbeat.protocol}/automations/runs/${encodeURIComponent(paramsHeartbeat.runId)}/heartbeat`;
      const body = {
        machineId: paramsHeartbeat.machineId,
        attempt: paramsHeartbeat.attempt,
        leaseDurationMs: paramsHeartbeat.leaseDurationMs,
      };
      const renewalStartedAtMs = Date.now();
      let progress: AutomationLeaseRenewalProgress = {
        stage: 'publisher_proof', renewalStartedAtMs, stageStartedAtMs: renewalStartedAtMs,
      };
      const observeProgress = () => {
        try {
          paramsHeartbeat.onProgress?.(progress);
        } catch { /* Local diagnostics cannot change renewal transport. */ }
      };
      // Keep phases in the active renewal, so expiry/late-response diagnostics
      // can attribute a pending request without writing healthy ticks to disk.
      observeProgress();
      try {
        const remainingBudgetMs = () => {
          paramsHeartbeat.signal.throwIfAborted();
          const remainingMs = paramsHeartbeat.renewalDeadlineAtMs - Date.now();
          if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
            throw Object.assign(new Error('automation_claim_renewal_deadline_exceeded'), { code: 'ETIMEDOUT' });
          }
          return remainingMs;
        };
        remainingBudgetMs();
        // Publisher proof may involve filesystem work that cannot be cancelled.
        // Retire this wait on the owner's signal; a late proof cannot issue HTTP.
        const headers = await new Promise<Awaited<ReturnType<typeof workerHeaders>>>((resolve, reject) => {
          const abort = () => { dispose(); reject(paramsHeartbeat.signal.reason); };
          const dispose = () => paramsHeartbeat.signal.removeEventListener('abort', abort);
          paramsHeartbeat.signal.addEventListener('abort', abort, { once: true });
          if (paramsHeartbeat.signal.aborted) { abort(); return; }
          void workerHeaders({ method: 'POST', path, body }).then(
            headers => { dispose(); resolve(headers); },
            error => { dispose(); reject(error); },
          );
        });
        const timeout = Math.min(15_000, remainingBudgetMs());
        const httpStartedAtMs = Date.now();
        progress = { ...progress, stage: 'http', stageStartedAtMs: httpStartedAtMs,
          publisherProofDurationMs: httpStartedAtMs - renewalStartedAtMs };
        observeProgress();
        const response = await axios.post(`${baseUrl}${path}`, body, { headers, timeout, signal: paramsHeartbeat.signal });
        const decodeStartedAtMs = Date.now();
        progress = { ...progress, stage: 'response_decode', stageStartedAtMs: decodeStartedAtMs,
          httpDurationMs: decodeStartedAtMs - httpStartedAtMs };
        observeProgress();
        const { leaseExpiresAt } = AutomationV3WorkerHeartbeatResponseSchema.parse(response.data);
        remainingBudgetMs();
        if (leaseExpiresAt === null) throw new Error('automation_claim_lease_unavailable');
        return leaseExpiresAt;
      } catch (error) {
        const failure = paramsHeartbeat.signal.aborted && axios.isCancel(error) ? paramsHeartbeat.signal.reason : error;
        const classification = classifyDaemonServerWorkError(failure);
        try {
          logger.warnLocalFile('[DAEMON AUTOMATION] Lease renewal transport', {
            runId: paramsHeartbeat.runId, machineId: paramsHeartbeat.machineId, attempt: paramsHeartbeat.attempt,
            event: 'failure', ...progress, durationMs: Date.now() - progress.stageStartedAtMs,
            status: classification.statusCode, errorKind: classification.kind,
          });
        } catch { /* Local diagnostics cannot change renewal transport. */ }
        throw failure;
      }
    },

    async startRun(paramsStart: {
      protocol: AutomationWorkerProtocol;
      runId: string;
      machineId: string;
      attempt: number;
      accountCurrentness: AutomationAccountCurrentnessWitnessV1;
    }): Promise<AutomationAccountCurrentnessWitnessV1 | null> {
      if (!paramsStart.accountCurrentness) throw new Error('Automation start requires Account currentness');
      const path = `/v3/automations/runs/${encodeURIComponent(paramsStart.runId)}/start`;
      const body = { machineId: paramsStart.machineId, attempt: paramsStart.attempt,
        accountCurrentness: paramsStart.accountCurrentness };
      const response = await axios.post(`${baseUrl}${path}`, body, {
        headers: await workerHeaders({ method: 'POST', path, body }), timeout: 15_000,
      });
      return AutomationV3WorkerStartResponseSchema.parse(response.data).accountCurrentness;
    },

    async succeedRun(paramsSucceed: {
      protocol: AutomationWorkerProtocol;
      runId: string;
      machineId: string;
      attempt: number;
      accountCurrentness: AutomationAccountCurrentnessWitnessV1;
      producedSessionId?: string | null;
      resultEnvelope?: string | null;
    }): Promise<void> {
      if (!paramsSucceed.accountCurrentness) throw new Error('Automation success requires Account currentness');
      const path = `/v3/automations/runs/${encodeURIComponent(paramsSucceed.runId)}/succeed`;
      const body = {
        machineId: paramsSucceed.machineId,
        attempt: paramsSucceed.attempt,
        accountCurrentness: paramsSucceed.accountCurrentness,
        producedSessionId: paramsSucceed.producedSessionId ?? null,
        resultEnvelope: paramsSucceed.resultEnvelope ?? null,
      };
      await axios.post(
        `${baseUrl}${path}`,
        body,
        {
          headers: await workerHeaders({ method: 'POST', path, body }),
          timeout: 15_000,
        },
      );
    },

    async settleExecutionDispatch(paramsSettlement: {
      protocol: 'v3';
      runId: string;
      machineId: string;
      attempt: number;
      accountCurrentness: AutomationAccountCurrentnessWitnessV1;
      outcome: AutomationV3WorkerExecutionDispatchOutcome;
    }): Promise<void> {
      const path = `/v3/automations/runs/${encodeURIComponent(paramsSettlement.runId)}/execution-dispatch/settle`;
      const body = {
        machineId: paramsSettlement.machineId,
        attempt: paramsSettlement.attempt,
        accountCurrentness: paramsSettlement.accountCurrentness,
        outcome: paramsSettlement.outcome,
      };
      await axios.post(
        `${baseUrl}${path}`,
        body,
        {
          headers: await workerHeaders({ method: 'POST', path, body }),
          timeout: 15_000,
        },
      );
    },

    async failRun(paramsFail: {
      protocol: AutomationWorkerProtocol;
      runId: string;
      machineId: string;
      attempt: number;
      accountCurrentness: AutomationAccountCurrentnessWitnessV1;
      producedSessionId?: string | null;
      errorCode: string;
      terminalState?: 'skipped';
      /** Current private failure envelope. */
      errorDetailEnvelope: string | null;
      errorMessage?: never;
    }): Promise<void> {
      if (!paramsFail.accountCurrentness) throw new Error('Automation failure requires Account currentness');
      if (!Object.prototype.hasOwnProperty.call(paramsFail, 'errorDetailEnvelope')) {
        throw new Error('Automation failure requires a private error-detail envelope');
      }
      if (Object.prototype.hasOwnProperty.call(paramsFail, 'errorMessage')) {
        throw new Error('Automation failure cannot send raw error detail');
      }
      const path = `/v3/automations/runs/${encodeURIComponent(paramsFail.runId)}/fail`;
      const body = {
        machineId: paramsFail.machineId,
        attempt: paramsFail.attempt,
        accountCurrentness: paramsFail.accountCurrentness,
        ...(paramsFail.producedSessionId === undefined ? {} : { producedSessionId: paramsFail.producedSessionId }),
        errorCode: paramsFail.errorCode,
        ...(paramsFail.terminalState !== undefined ? { terminalState: paramsFail.terminalState } : {}),
        errorDetailEnvelope: paramsFail.errorDetailEnvelope,
      };
      await axios.post(
        `${baseUrl}${path}`,
        body,
        {
          headers: await workerHeaders({ method: 'POST', path, body }),
          timeout: 15_000,
        },
      );
    },
  };
}
