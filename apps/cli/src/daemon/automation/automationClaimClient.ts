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
  AutomationV3WorkerStartResponseSchema,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
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
  };
}

/** The V2 fallback is schedule-only because that is all its server predicate can claim. */
function toWorkerAssignmentResponseFromV2(
  response: AutomationDaemonAssignmentsResponse,
): AutomationWorkerAssignmentsResponse {
  return {
    assignments: response.assignments.map((assignment) => ({
      machineId: assignment.machineId,
      automationId: assignment.automation.id,
      nextClaimAt: assignment.automation.nextRunAt,
    })),
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
      origin: response.run.origin,
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
    run: response.run,
    automation: response.automation,
  };
}

export function createAutomationClaimClient(params: { token: string }) {
  const baseUrl = configuration.apiServerUrl;
  const token = params.token;
  let assignmentProtocol: AutomationWorkerProtocol | null = null;
  let latestAssignmentRead = 0;
  let runProtocol: AutomationWorkerProtocol | null = null;

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

  function requireRunProtocol(): AutomationWorkerProtocol {
    const version = runProtocol ?? assignmentProtocol;
    if (!version) {
      throw new Error('Automation worker must fetch assignments before using Run lifecycle endpoints');
    }
    return version;
  }

  function runPath(runId: string, operation: 'heartbeat' | 'start' | 'succeed' | 'fail'): string {
    const version = requireRunProtocol();
    return `${baseUrl}/${version}/automations/runs/${encodeURIComponent(runId)}/${operation}`;
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
            headers: authHeaders(token),
            params: { machineId },
            timeout: 15_000,
          },
        );
        if (assignmentRead === latestAssignmentRead) {
          assignmentProtocol = 'v3';
        }
        return toWorkerAssignmentResponseFromV3(response.data);
      } catch (error) {
        if (!isMissingEndpointError(error, '/v3/automations/worker/assignments')) {
          throw error;
        }
      }

      const response = await axios.get<AutomationDaemonAssignmentsResponse>(
        `${baseUrl}/v2/automations/daemon/assignments`,
        {
          headers: authHeaders(token),
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
      const assignmentReadAtClaim = latestAssignmentRead;
      const body = {
        machineId: paramsClaim.machineId,
        leaseDurationMs: paramsClaim.leaseDurationMs,
      };
      const requestOptions = {
        headers: authHeaders(token),
        timeout: 15_000,
      };

      if (version === 'v3') {
        const claimUrl = `${baseUrl}/v3/automations/runs/claim`;
        try {
          const response = await axios.post<AutomationV3WorkerClaimResponse>(
            claimUrl,
            body,
            requestOptions,
          );
          const result = toWorkerClaimResponse(AutomationV3WorkerClaimResponseSchema.parse(response.data));
          runProtocol = 'v3';
          return result;
        } catch (error) {
          // An older server can publish V3 read projections before it has the
          // worker mutation family. No V3 Run has been returned at this point,
          // so retrying its schedule-only V2 claim cannot encode a new origin.
          if (!isMissingEndpointError(error, '/v3/automations/runs/claim')) {
            throw error;
          }
          if (assignmentReadAtClaim === latestAssignmentRead) {
            assignmentProtocol = 'v2';
          }
        }
      }

      const response = await axios.post<AutomationV2ClaimResponseWire>(
        `${baseUrl}/v2/automations/runs/claim`,
        body,
        requestOptions,
      );
      const result = toWorkerClaimResponseFromV2(response.data);
      runProtocol = 'v2';
      return result;
    },

    async heartbeatRun(paramsHeartbeat: {
      runId: string;
      machineId: string;
      attempt: number;
      leaseDurationMs: number;
    }): Promise<void> {
      await axios.post(
        runPath(paramsHeartbeat.runId, 'heartbeat'),
        {
          machineId: paramsHeartbeat.machineId,
          attempt: paramsHeartbeat.attempt,
          leaseDurationMs: paramsHeartbeat.leaseDurationMs,
        },
        {
          headers: authHeaders(token),
          timeout: 15_000,
        },
      );
    },

    async startRun(paramsStart: {
      runId: string;
      machineId: string;
      attempt: number;
      accountCurrentness?: AutomationAccountCurrentnessWitnessV1;
    }): Promise<AutomationAccountCurrentnessWitnessV1 | null> {
      const version = requireRunProtocol();
      if (version === 'v3') {
        if (!paramsStart.accountCurrentness) {
          throw new Error('Automation V3 start requires the claim Account currentness witness');
        }
        const response = await axios.post(
          runPath(paramsStart.runId, 'start'),
          {
            machineId: paramsStart.machineId,
            attempt: paramsStart.attempt,
            accountCurrentness: paramsStart.accountCurrentness,
          },
          {
            headers: authHeaders(token),
            timeout: 15_000,
          },
        );
        return AutomationV3WorkerStartResponseSchema.parse(response.data).accountCurrentness;
      }
      await axios.post(
        runPath(paramsStart.runId, 'start'),
        { machineId: paramsStart.machineId, attempt: paramsStart.attempt },
        {
          headers: authHeaders(token),
          timeout: 15_000,
        },
      );
      return null;
    },

    async succeedRun(paramsSucceed: {
      runId: string;
      machineId: string;
      attempt: number;
      accountCurrentness?: AutomationAccountCurrentnessWitnessV1;
      producedSessionId?: string | null;
      resultEnvelope?: string | null;
    }): Promise<void> {
      const version = requireRunProtocol();
      if (version === 'v3' && !paramsSucceed.accountCurrentness) {
        throw new Error('Automation V3 success requires the start Account currentness witness');
      }
      await axios.post(
        runPath(paramsSucceed.runId, 'succeed'),
        version === 'v3'
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
          },
        {
          headers: authHeaders(token),
          timeout: 15_000,
        },
      );
    },

    async settleExecutionDispatch(paramsSettlement: {
      runId: string;
      machineId: string;
      attempt: number;
      accountCurrentness: AutomationAccountCurrentnessWitnessV1;
      outcome: AutomationV3WorkerExecutionDispatchOutcome;
    }): Promise<void> {
      if (requireRunProtocol() !== 'v3') {
        throw new Error('Detached Automation execution requires the V3 worker protocol');
      }
      await axios.post(
        `${baseUrl}/v3/automations/runs/${encodeURIComponent(paramsSettlement.runId)}/execution-dispatch/settle`,
        {
          machineId: paramsSettlement.machineId,
          attempt: paramsSettlement.attempt,
          accountCurrentness: paramsSettlement.accountCurrentness,
          outcome: paramsSettlement.outcome,
        },
        {
          headers: authHeaders(token),
          timeout: 15_000,
        },
      );
    },

    async failRun(paramsFail: {
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
      const version = requireRunProtocol();
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
      await axios.post(
        runPath(paramsFail.runId, 'fail'),
        version === 'v3'
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
          },
        {
          headers: authHeaders(token),
          timeout: 15_000,
        },
      );
    },
  };
}
