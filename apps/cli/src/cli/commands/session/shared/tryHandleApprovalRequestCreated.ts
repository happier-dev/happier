import chalk from 'chalk';
import type { ActionExecutionPlacement } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';

export type ApprovalRequestCreatedResult = Readonly<{
  kind: 'approval_request_created';
  artifactId: string;
}>;

export function isApprovalRequestCreatedResult(value: unknown): value is ApprovalRequestCreatedResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.kind === 'approval_request_created'
    && typeof record.artifactId === 'string'
    && record.artifactId.trim().length > 0;
}

export async function tryHandleApprovalRequestCreated(params: Readonly<{
  envelopeKind: string;
  json: boolean;
  result: unknown;
  executionPlacement?: ActionExecutionPlacement;
  automationNotices?: ActionExecuteResult['automationNotices'];
}>): Promise<boolean> {
  if (!isApprovalRequestCreatedResult(params.result)) {
    return false;
  }

  if (params.executionPlacement === 'session') {
    const prerequisite = 'This action needs its originating daemon or agent session to run after approval. '
      + 'A standalone CLI request without that origin cannot execute; request the action from that session instead.';
    if (params.json) console.error(prerequisite);
    else console.log(prerequisite);
  }

  if (params.json) {
    await printJsonEnvelope({ ok: true, kind: params.envelopeKind, data: params.result,
      ...(params.automationNotices ? { automationNotices: params.automationNotices } : {}) });
    return true;
  }

  console.log(chalk.green('✓'), `approval requested: ${params.result.artifactId}`);
  return true;
}
