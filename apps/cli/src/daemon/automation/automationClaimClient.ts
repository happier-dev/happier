import axios from 'axios';

import { configuration } from '@/configuration';
import type { AutomationClaimRunResponse, AutomationDaemonAssignmentsResponse } from './automationTypes';

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export type AutomationClaimClient = ReturnType<typeof createAutomationClaimClient>;

export function createAutomationClaimClient(params: { token: string }) {
  const baseUrl = configuration.serverUrl;
  const token = params.token;

  return {
    async fetchAssignments(machineId: string): Promise<AutomationDaemonAssignmentsResponse> {
      const response = await axios.get<AutomationDaemonAssignmentsResponse>(
        `${baseUrl}/v2/automations/daemon/assignments`,
        {
          headers: authHeaders(token),
          params: { machineId },
          timeout: 15_000,
        },
      );
      return response.data;
    },

    async claimRun(paramsClaim: { machineId: string; leaseDurationMs: number }): Promise<AutomationClaimRunResponse> {
      const response = await axios.post<AutomationClaimRunResponse>(
        `${baseUrl}/v2/automations/runs/claim`,
        {
          machineId: paramsClaim.machineId,
          leaseDurationMs: paramsClaim.leaseDurationMs,
        },
        {
          headers: authHeaders(token),
          timeout: 15_000,
        },
      );
      return response.data;
    },

    async heartbeatRun(paramsHeartbeat: {
      runId: string;
      machineId: string;
      leaseDurationMs: number;
    }): Promise<void> {
      await axios.post(
        `${baseUrl}/v2/automations/runs/${encodeURIComponent(paramsHeartbeat.runId)}/heartbeat`,
        {
          machineId: paramsHeartbeat.machineId,
          leaseDurationMs: paramsHeartbeat.leaseDurationMs,
        },
        {
          headers: authHeaders(token),
          timeout: 15_000,
        },
      );
    },

    async startRun(paramsStart: { runId: string; machineId: string }): Promise<void> {
      await axios.post(
        `${baseUrl}/v2/automations/runs/${encodeURIComponent(paramsStart.runId)}/start`,
        { machineId: paramsStart.machineId },
        {
          headers: authHeaders(token),
          timeout: 15_000,
        },
      );
    },

    async succeedRun(paramsSucceed: {
      runId: string;
      machineId: string;
      producedSessionId?: string | null;
      summaryCiphertext?: string | null;
    }): Promise<void> {
      await axios.post(
        `${baseUrl}/v2/automations/runs/${encodeURIComponent(paramsSucceed.runId)}/succeed`,
        {
          machineId: paramsSucceed.machineId,
          producedSessionId: paramsSucceed.producedSessionId ?? null,
          summaryCiphertext: paramsSucceed.summaryCiphertext ?? null,
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
      errorCode: string;
      errorMessage: string;
    }): Promise<void> {
      await axios.post(
        `${baseUrl}/v2/automations/runs/${encodeURIComponent(paramsFail.runId)}/fail`,
        {
          machineId: paramsFail.machineId,
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
