import { normalizeExecutionRunFeatureBlockerDetails } from '@/session/services/executionRuns';

import type { HappierBuiltInToolDispatchResult } from './types';

export type ExecutionRunToolResultContext = Readonly<{
  runId?: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOwnDataProperty(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function hasOwnDataProperty(record: Record<string, unknown>, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return Boolean(descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value'));
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = readOwnDataProperty(record, key);
  return typeof value === 'string' ? value : undefined;
}

function readRunId(context: ExecutionRunToolResultContext | undefined): string | null {
  const runId = context?.runId;
  return typeof runId === 'string' && runId.trim().length > 0 ? runId.trim() : null;
}

export function normalizeExecutionRunToolResult(
  result: unknown,
  context?: ExecutionRunToolResultContext,
): HappierBuiltInToolDispatchResult {
  if (!isRecord(result)) {
    return { ok: true, result };
  }

  const ok = readOwnDataProperty(result, 'ok');
  if (ok === false) {
    const code = readString(result, 'code');
    if (!code) {
      return {
        ok: false,
        errorCode: 'execution_run_result_invalid',
        error: 'Invalid execution run result',
      };
    }
    if (code === 'timeout') {
      const runId = readRunId(context);
      return {
        ok: false,
        errorCode: 'execution_run_wait_timeout',
        error: 'Execution run wait timed out',
        ...(runId ? { details: { runId } } : {}),
      };
    }
    const details = normalizeExecutionRunFeatureBlockerDetails(readOwnDataProperty(result, 'details'));
    return {
      ok: false,
      errorCode: code,
      error: readString(result, 'message') ?? code,
      ...(details ? { details } : {}),
    };
  }

  if (ok === true) {
    const data = readOwnDataProperty(result, 'data');
    if (hasOwnDataProperty(result, 'data')) {
      return { ok: true, result: data };
    }

    const { ok: _ok, ...payload } = result;
    return { ok: true, result: payload };
  }

  // `execution.run.start` returns its accepted run identity directly. It may
  // contain a nested typed waiter timeout, but that is observation metadata,
  // not a failed start and must keep the Run ID available to the caller.
  return { ok: true, result };
}
