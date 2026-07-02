import { notifyDaemonConnectedServiceRuntimeAuthFailure } from '@/daemon/controlClient';

import {
  drainRuntimeAuthFailureReportOutboxItems,
} from './runtimeAuthFailureReportOutbox';
import type {
  DrainRuntimeAuthFailureReportOutboxItemsResult,
  RuntimeAuthFailureReportOutboxItem,
} from './runtimeAuthFailureReportOutboxTypes';

type RuntimeAuthFailureReportOutboxDaemonNotify = (body: Readonly<{
  sessionId: string;
  switchesThisTurn: number;
  resumePromptMode?: RuntimeAuthFailureReportOutboxItem['resumePromptMode'];
  classification: RuntimeAuthFailureReportOutboxItem['classification'];
}>) => Promise<unknown>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRetryableDaemonResponse(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.ok === false) return true;
  return typeof value.error === 'string' && value.error.trim().length > 0;
}

export async function drainRuntimeAuthFailureReportOutboxToDaemon(input: Readonly<{
  outboxDir?: string;
  notify?: RuntimeAuthFailureReportOutboxDaemonNotify;
  limit?: number;
}> = {}): Promise<DrainRuntimeAuthFailureReportOutboxItemsResult> {
  const notify = input.notify ?? notifyDaemonConnectedServiceRuntimeAuthFailure;
  return await drainRuntimeAuthFailureReportOutboxItems({
    ...(input.outboxDir ? { outboxDir: input.outboxDir } : {}),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    deliver: async (item) => {
      const response = await notify({
        sessionId: item.sessionId,
        switchesThisTurn: item.switchesThisTurn,
        ...(item.resumePromptMode ? { resumePromptMode: item.resumePromptMode } : {}),
        classification: item.classification,
      });
      return isRetryableDaemonResponse(response)
        ? { status: 'retry' as const }
        : { status: 'delivered' as const };
    },
  });
}
