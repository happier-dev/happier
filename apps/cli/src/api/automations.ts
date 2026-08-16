import axios from 'axios';
import { z } from 'zod';

import {
  createAuthenticationHttpStatusError,
  createHttpStatusError,
  isAuthenticationStatus,
} from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

const AutomationRunSummarySchema = z.object({
  id: z.string().min(1),
  automationId: z.string().min(1),
  state: z.enum(['queued', 'claimed', 'running', 'succeeded', 'failed', 'cancelled', 'expired']),
}).passthrough();

const RunAutomationNowResponseSchema = z.object({
  run: AutomationRunSummarySchema,
});

export type AutomationRunSummary = z.infer<typeof AutomationRunSummarySchema>;

export async function runAutomationNow(params: Readonly<{
  token: string;
  automationId: string;
  idempotencyKey?: string | null;
}>): Promise<AutomationRunSummary> {
  const serverUrl = resolveServerHttpBaseUrl();
  const response = await axios.post(
    `${serverUrl}/v2/automations/${encodeURIComponent(params.automationId)}/run-now`,
    undefined,
    {
      headers: {
        Authorization: `Bearer ${params.token}`,
        ...(params.idempotencyKey ? { 'Idempotency-Key': params.idempotencyKey } : {}),
      },
      timeout: 15_000,
      validateStatus: () => true,
    },
  );

  if (isAuthenticationStatus(response.status)) {
    throw createAuthenticationHttpStatusError(response.status, 'Authentication failed while running automation');
  }
  if (response.status < 200 || response.status >= 300) {
    const errorCode = typeof response.data?.error === 'string' ? response.data.error : undefined;
    const message = errorCode === 'automation_disabled'
      ? 'Automation is paused'
      : `Failed to run automation (${response.status})`;
    throw createHttpStatusError(response.status, message, errorCode);
  }

  return RunAutomationNowResponseSchema.parse(response.data).run;
}
