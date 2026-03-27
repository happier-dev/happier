import chalk from 'chalk';

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

export function tryHandleApprovalRequestCreated(params: Readonly<{
  envelopeKind: string;
  json: boolean;
  result: unknown;
}>): boolean {
  if (!isApprovalRequestCreatedResult(params.result)) {
    return false;
  }

  if (params.json) {
    printJsonEnvelope({ ok: true, kind: params.envelopeKind, data: params.result });
    return true;
  }

  console.log(chalk.green('✓'), `approval requested: ${params.result.artifactId}`);
  return true;
}
