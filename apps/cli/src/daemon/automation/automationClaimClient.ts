import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from 'axios';
import type {
  AutomationAccountCurrentnessWitnessV1,
  AutomationV3WorkerClaimResponse,
  AutomationV3WorkerAssignmentsResponse,
  AutomationV3WorkerExecutionDispatchOutcome,
} from '@happier-dev/protocol';
import {
  AutomationV3WorkerClaimResponseSchema,
  AutomationV3WorkerAssignmentsResponseSchema,
  AutomationV3WorkerStartResponseSchema,
  DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE,
  PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import {
  createDefaultPluginInstallationPublisherHeader,
  type CreatePluginInstallationPublisherHeader,
} from '@/plugins/installations/publisherProof';
import type {
  AutomationClaimRunResponse,
  AutomationDaemonAssignmentsResponse,
  AutomationV2ClaimedAutomation,
  AutomationV2ClaimedRun,
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

type AutomationWorkerProtocol = 'v3' | 'v2';

function getStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const response = (error as { response?: { status?: unknown } }).response;
  return typeof response?.status === 'number' && Number.isFinite(response.status)
    ? response.status
    : null;
}

function getErrorUrl(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const url = (error as { config?: { url?: unknown } }).config?.url;
  return typeof url === 'string' && url.trim().length > 0 ? url.trim() : null;
}

/** A missing protocol endpoint is a version negotiation result, never a retry signal. */
export function isMissingAutomationWorkerEndpointError(
  error: unknown,
  expectedUrls: string | readonly string[],
): boolean {
  const status = getStatusCode(error);
  if (status !== 404 && status !== 405 && status !== 501) return false;
  const url = getErrorUrl(error);
  if (!url) return false;
  try {
    const actual = new URL(url);
    const accepted = typeof expectedUrls === 'string' ? [expectedUrls] : expectedUrls;
    return accepted.some((expectedUrl) => actual.href === new URL(expectedUrl).href);
  } catch {
    return false;
  }
}

function toWorkerAssignmentResponseFromV3(
  response: AutomationV3WorkerAssignmentsResponse,
): AutomationWorkerAssignmentsResponse {
  return {
    assignments: response.assignments.map((assignment) => ({
      machineId: assignment.machineId,
      automationId: assignment.automationId,
      nextClaimAt: assignment.nextClaimAt,
    })),
    settings: response.settings,
  };
}

/**
 * The observed predecessor has only schedule-aware V2 assignments. Normalize
 * its lack of settings once at this compatibility boundary to the Protocol
 * default so the worker still has one required downstream shape.
 */
function toWorkerAssignmentResponseFromV2(
  response: AutomationDaemonAssignmentsResponse,
): AutomationWorkerAssignmentsResponse {
  return {
    assignments: response.assignments.map((assignment) => ({
      machineId: assignment.machineId,
      automationId: assignment.automation.id,
      nextClaimAt: assignment.automation.nextRunAt,
    })),
    settings: {
      maxActiveRunsPerMachine: DEFAULT_AUTOMATION_V3_MAX_ACTIVE_RUNS_PER_MACHINE,
    },
  };
}

function toWorkerClaimResponse(response: AutomationV3WorkerClaimResponse): AutomationClaimRunResponse {
  if (response.run === null && response.automation === null) {
    return { protocol: 'v3', run: null, automation: null };
  }
  if (
    response.run === null
    || response.automation === null
    || response.accountCurrentness === null
  ) {
    throw new Error('Automation V3 claim response did not contain Run, Automation, and Account currentness together');
  }
  return {
    protocol: 'v3',
    run: {
      id: response.run.id,
      automationId: response.run.automationId,
      attempt: response.run.attempt,
      executionInputEnvelope: response.run.executionInputEnvelope,
      triggerId: response.run.triggerId,
      cause: response.run.cause,
      resultDelivery: response.run.resultDelivery ?? { kind: 'none' },
    },
    automation: {
      id: response.automation.id,
      name: response.automation.name,
      enabled: response.automation.enabled,
    },
    accountCurrentness: response.accountCurrentness,
  };
}

type AutomationV2ClaimResponseWire = Readonly<{
  run: AutomationV2ClaimedRun | null;
  automation: AutomationV2ClaimedAutomation | null;
}>;

function toWorkerClaimResponseFromV2(response: AutomationV2ClaimResponseWire): AutomationClaimRunResponse {
  if (response.run === null && response.automation === null) {
    return { protocol: 'v2', run: null, automation: null };
  }
  if (response.run === null || response.automation === null) {
    throw new Error('Automation V2 claim response did not contain both Run and Automation payloads');
  }
  return {
    protocol: 'v2',
    run: {
      id: response.run.id,
      automationId: response.run.automationId,
      attempt: response.run.attempt,
    },
    automation: response.automation,
  };
}

export function createAutomationClaimClient(params: {
  token: string;
  createPublisherHeader?: CreatePluginInstallationPublisherHeader;
}) {
  const baseUrl = configuration.apiServerUrl;
  const token = params.token;
  const createPublisherHeader = params.createPublisherHeader
    ?? createDefaultPluginInstallationPublisherHeader;
  let assignmentProtocol: AutomationWorkerProtocol | null = null;
  let latestAssignmentRead = 0;
  // V3 is unreleased and has no partial-capability compatibility mode. Once
  // this server/account client observes V3 assignments, their later absence
  // is an error rather than authority to select the released V2 seam.
  let hasObservedV3Assignments = false;

  function isMissingEndpointError(
    error: unknown,
    expectedPathnames: string | readonly string[],
  ): boolean {
    const paths = typeof expectedPathnames === 'string' ? [expectedPathnames] : expectedPathnames;
    return isMissingAutomationWorkerEndpointError(
      error,
      paths.map((pathname) => `${baseUrl}${pathname}`),
    );
  }

  function requireAssignmentProtocol(): AutomationWorkerProtocol {
    if (!assignmentProtocol) {
      throw new Error('Automation worker must fetch assignments before claiming a Run');
    }
    return assignmentProtocol;
  }

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
    isMissingEndpointError,

    async fetchAssignments(machineId: string): Promise<AutomationWorkerAssignmentsResponse> {
      const assignmentRead = ++latestAssignmentRead;
      const assignmentsUrl = `${baseUrl}/v3/automations/worker/assignments`;
      try {
        const response = await axios.get<AutomationV3WorkerAssignmentsResponse>(
          assignmentsUrl,
          {
            headers: await workerHeaders({
              method: 'GET',
              path: '/v3/automations/worker/assignments',
              body: null,
            }),
            params: { machineId },
            timeout: 15_000,
          },
        );
        hasObservedV3Assignments = true;
        if (assignmentRead === latestAssignmentRead) {
          assignmentProtocol = 'v3';
        }
        return toWorkerAssignmentResponseFromV3(
          AutomationV3WorkerAssignmentsResponseSchema.parse(response.data),
        );
      } catch (error) {
        if (!isMissingEndpointError(error, '/v3/automations/worker/assignments')) {
          throw error;
        }
        if (hasObservedV3Assignments) {
          throw error;
        }
      }

      const response = await axios.get<AutomationDaemonAssignmentsResponse>(
        `${baseUrl}/v2/automations/daemon/assignments`,
        {
          headers: await workerHeaders({
            method: 'GET',
            path: '/v2/automations/daemon/assignments',
            body: null,
          }),
          params: { machineId },
          timeout: 15_000,
        },
      );
      if (assignmentRead === latestAssignmentRead) {
        assignmentProtocol = 'v2';
      }
      return toWorkerAssignmentResponseFromV2(response.data);
    },

    async claimRun(paramsClaim: { machineId: string; leaseDurationMs: number }): Promise<AutomationClaimRunResponse> {
      const version = requireAssignmentProtocol();
      const body = {
        machineId: paramsClaim.machineId,
        leaseDurationMs: paramsClaim.leaseDurationMs,
      };
      if (version === 'v3') {
        const response = await axios.post<AutomationV3WorkerClaimResponse>(
          `${baseUrl}/v3/automations/runs/claim`,
          body,
          {
            headers: await workerHeaders({
              method: 'POST',
              path: '/v3/automations/runs/claim',
              body,
            }),
            timeout: 15_000,
          },
        );
        return toWorkerClaimResponse(AutomationV3WorkerClaimResponseSchema.parse(response.data));
      }

      const response = await axios.post<AutomationV2ClaimResponseWire>(
        `${baseUrl}/v2/automations/runs/claim`,
        body,
        {
          headers: await workerHeaders({
            method: 'POST',
            path: '/v2/automations/runs/claim',
            body,
          }),
          timeout: 15_000,
        },
      );
      const result = toWorkerClaimResponseFromV2(response.data);
      return result;
    },

    async heartbeatRun(paramsHeartbeat: {
      protocol: AutomationWorkerProtocol;
      runId: string;
      machineId: string;
      attempt: number;
      leaseDurationMs: number;
    }): Promise<void> {
      const path = `/${paramsHeartbeat.protocol}/automations/runs/${encodeURIComponent(paramsHeartbeat.runId)}/heartbeat`;
      const body = {
        machineId: paramsHeartbeat.machineId,
        attempt: paramsHeartbeat.attempt,
        leaseDurationMs: paramsHeartbeat.leaseDurationMs,
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

    async startRun(paramsStart: {
      protocol: AutomationWorkerProtocol;
      runId: string;
      machineId: string;
      attempt: number;
      accountCurrentness?: AutomationAccountCurrentnessWitnessV1;
    }): Promise<AutomationAccountCurrentnessWitnessV1 | null> {
      const version = paramsStart.protocol;
      if (version === 'v3') {
        if (!paramsStart.accountCurrentness) {
          throw new Error('Automation V3 start requires the claim Account currentness witness');
        }
        const path = `/v3/automations/runs/${encodeURIComponent(paramsStart.runId)}/start`;
        const body = {
            machineId: paramsStart.machineId,
            attempt: paramsStart.attempt,
            accountCurrentness: paramsStart.accountCurrentness,
        };
        const response = await axios.post(
          `${baseUrl}${path}`,
          body,
          {
            headers: await workerHeaders({ method: 'POST', path, body }),
            timeout: 15_000,
          },
        );
        return AutomationV3WorkerStartResponseSchema.parse(response.data).accountCurrentness;
      }
      const path = `/v2/automations/runs/${encodeURIComponent(paramsStart.runId)}/start`;
      const body = { machineId: paramsStart.machineId, attempt: paramsStart.attempt };
      await axios.post(
        `${baseUrl}${path}`,
        body,
        {
          headers: await workerHeaders({ method: 'POST', path, body }),
          timeout: 15_000,
        },
      );
      return null;
    },

    async succeedRun(paramsSucceed: {
      protocol: AutomationWorkerProtocol;
      runId: string;
      machineId: string;
      attempt: number;
      accountCurrentness?: AutomationAccountCurrentnessWitnessV1;
      producedSessionId?: string | null;
      resultEnvelope?: string | null;
    }): Promise<void> {
      const version = paramsSucceed.protocol;
      if (version === 'v3' && !paramsSucceed.accountCurrentness) {
        throw new Error('Automation V3 success requires the start Account currentness witness');
      }
      const path = `/${version}/automations/runs/${encodeURIComponent(paramsSucceed.runId)}/succeed`;
      const body = version === 'v3'
        ? {
          machineId: paramsSucceed.machineId,
          attempt: paramsSucceed.attempt,
          accountCurrentness: paramsSucceed.accountCurrentness,
          producedSessionId: paramsSucceed.producedSessionId ?? null,
          resultEnvelope: paramsSucceed.resultEnvelope ?? null,
        }
        : {
          machineId: paramsSucceed.machineId,
          attempt: paramsSucceed.attempt,
          producedSessionId: paramsSucceed.producedSessionId ?? null,
          summaryCiphertext: null,
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
      accountCurrentness?: AutomationAccountCurrentnessWitnessV1;
      producedSessionId?: string | null;
      errorCode: string;
      /** Current V3 private envelope; V2 retains only its released raw field. */
      errorDetailEnvelope?: string | null;
      errorMessage?: string;
    }): Promise<void> {
      const version = paramsFail.protocol;
      if (version === 'v3' && !paramsFail.accountCurrentness) {
        throw new Error('Automation V3 failure requires the current Account witness');
      }
      if (version === 'v3' && !Object.hasOwn(paramsFail, 'errorDetailEnvelope')) {
        throw new Error('Automation V3 failure requires a private error-detail envelope');
      }
      if (version === 'v3' && paramsFail.errorMessage !== undefined) {
        throw new Error('Automation V3 failure must not send a raw error message');
      }
      if (version === 'v2' && typeof paramsFail.errorMessage !== 'string') {
        throw new Error('Automation V2 failure requires its released raw error message');
      }
      const path = `/${version}/automations/runs/${encodeURIComponent(paramsFail.runId)}/fail`;
      const body = version === 'v3'
        ? {
          machineId: paramsFail.machineId,
          attempt: paramsFail.attempt,
          accountCurrentness: paramsFail.accountCurrentness,
          ...(paramsFail.producedSessionId === undefined
            ? {}
            : { producedSessionId: paramsFail.producedSessionId }),
          errorCode: paramsFail.errorCode,
          errorDetailEnvelope: paramsFail.errorDetailEnvelope ?? null,
        }
        : {
          machineId: paramsFail.machineId,
          attempt: paramsFail.attempt,
          ...(paramsFail.producedSessionId === undefined
            ? {}
            : { producedSessionId: paramsFail.producedSessionId }),
          errorCode: paramsFail.errorCode,
          errorMessage: paramsFail.errorMessage,
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
