import {
  SessionHandoffStartRequestSchema,
  type ActionExecuteResult,
  type SessionHandoffStartRequest,
} from '@happier-dev/protocol';

import type { ActionOperationRunner } from './actionOperationRunner';
import type { ActionOperationAccessScope } from './actionOperationTypes';

type OperationContext = Readonly<{
  signal: AbortSignal;
  update: (value: Readonly<{
    progress?: import('@happier-dev/protocol').ActionOperationProgressV1;
    domainRef?: import('@happier-dev/protocol').ActionOperationDomainRefV1;
  }>) => void;
}>;

type HistoricalStart = (
  request: SessionHandoffStartRequest,
  options?: Readonly<{
    onProgress?: (progress: import('@happier-dev/protocol').ActionOperationProgressV1) => void;
  }>,
) => Promise<unknown>;

export function createTrackedSessionHandoffStart(params: Readonly<{
  runner: ActionOperationRunner;
  getScope: () => Promise<ActionOperationAccessScope>;
  startUntracked: HistoricalStart;
  coordinate: (
    request: SessionHandoffStartRequest,
    context: OperationContext,
    startSource: HistoricalStart,
  ) => Promise<ActionExecuteResult | Readonly<{ kind: 'cancelled' }>>;
}>) {
  type Result = ActionExecuteResult | Readonly<{ kind: 'cancelled' }>;
  type Attempt = {
    receipt: Promise<unknown>;
    receiptSettled: boolean;
    resolveReceipt: (value: unknown) => void;
    rejectReceipt: (error: unknown) => void;
    coordinate: Promise<Result> | null;
  };
  const attempts = new Map<string, Attempt>();

  return async (raw: unknown): Promise<unknown> => {
    const parsed = SessionHandoffStartRequestSchema.safeParse(raw);
    if (!parsed.success || !parsed.data.requestId) return await params.startUntracked(raw as SessionHandoffStartRequest);
    const request = parsed.data;
    const scope = await params.getScope();
    const key = JSON.stringify([scope.accountId, scope.machineId, request.requestId]);
    let resolveReceipt!: (value: unknown) => void;
    let rejectReceipt!: (error: unknown) => void;
    const receipt = new Promise<unknown>((resolve, reject) => {
      resolveReceipt = resolve;
      rejectReceipt = reject;
    });
    const attempt = attempts.get(key) ?? {
      receipt,
      receiptSettled: false,
      resolveReceipt,
      rejectReceipt,
      coordinate: null,
    };
    attempts.set(key, attempt);
    const execution = params.runner.executeHistorical<Result>({
      request: {
        actionId: 'session.handoff',
        input: request,
        requestId: request.requestId,
        scope: { sessionId: request.sessionId },
      },
      scope,
      title: 'Hand off session',
      cancellation: 'supported',
      scopeSessionId: request.sessionId,
      execute: async (context) => {
        if (!attempt.coordinate) {
          attempt.coordinate = params.coordinate(request, context, async (startRequest) => {
            const response = await params.startUntracked(startRequest, {
              onProgress: (progress) => context.update({ progress }),
            });
            if (!attempt.receiptSettled) {
              attempt.receiptSettled = true;
              attempt.resolveReceipt(response);
            }
            return response;
          });
        }
        return await attempt.coordinate;
      },
      projectResult: (result) => result,
    });
    void execution.then((result) => {
      if (attempt.receiptSettled) return;
      attempt.receiptSettled = true;
      attempt.resolveReceipt(result);
    }, (error) => {
      if (attempt.receiptSettled) return;
      attempt.receiptSettled = true;
      attempt.rejectReceipt(error);
    });
    return await attempt.receipt;
  };
}
