import { notifyDaemonConnectedServiceRuntimeAuthFailure } from '@/daemon/controlClient';

import {
  drainRuntimeAuthFailureReportOutboxItems,
} from './runtimeAuthFailureReportOutbox';
import { resolveRuntimeAuthFailureReportOutboxDelivery } from './resolveRuntimeAuthFailureReportOutboxDelivery';
import type {
  DrainRuntimeAuthFailureReportOutboxItemsResult,
  RuntimeAuthFailureReportOutboxItem,
} from './runtimeAuthFailureReportOutboxTypes';

type RuntimeAuthFailureReportOutboxDaemonNotify = (body: Readonly<{
  reportId: string;
  sessionId: string;
  switchesThisTurn: number;
  resumePromptMode?: RuntimeAuthFailureReportOutboxItem['resumePromptMode'];
  classification: RuntimeAuthFailureReportOutboxItem['classification'];
}>) => Promise<unknown>;

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
        reportId: item.reportId,
        sessionId: item.sessionId,
        switchesThisTurn: item.switchesThisTurn,
        ...(item.resumePromptMode ? { resumePromptMode: item.resumePromptMode } : {}),
        classification: item.classification,
      });
      return {
        status: resolveRuntimeAuthFailureReportOutboxDelivery({
          expectedReportId: item.reportId,
          response,
        }),
      };
    },
  });
}
