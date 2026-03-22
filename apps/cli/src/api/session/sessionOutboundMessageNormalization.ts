import { normalizeToolCallV2, normalizeToolResultV2 } from '@/agent/tools/normalization';

import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import {
  backfillPermissionRequestOptionsInput,
  extractPermissionToolCallRawInput,
  getToolCallNameKey,
} from './toolCallInputHints';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function ensureOpaqueAcpToolCallInputEnvelope(input: unknown): unknown {
  const record = asRecord(input);
  if (!record) return input;

  const hasAcp = Object.prototype.hasOwnProperty.call(record, '_acp');
  const hasLocations = Object.prototype.hasOwnProperty.call(record, 'locations');
  if (hasAcp && hasLocations) return input;

  const next: Record<string, unknown> = { ...record };
  if (!hasAcp) next._acp = {};
  if (!hasLocations) next.locations = [];
  return next;
}

function ensureOpaqueAcpToolResultOutputEnvelope(output: unknown): unknown {
  const record = asRecord(output);
  if (record) {
    if (Object.prototype.hasOwnProperty.call(record, '_acp')) return output;
    return { ...record, _acp: {} };
  }

  return { output, _acp: {} };
}

export function normalizeCodexSessionMessageBody(params: {
  body: any;
  toolCallCanonicalNameByProviderAndId: Map<string, { rawToolName: string; canonicalToolName: string }>;
  debug: (message: string, data?: Record<string, unknown>) => void;
}): any {
  const body = params.body;

  if (body?.type === 'tool-call') {
    const callId = typeof body.callId === 'string' ? body.callId : undefined;
    const rawToolName = String(body?.name ?? '');
    const { canonicalToolName, input } = normalizeToolCallV2({
      protocol: 'codex',
      provider: 'codex',
      toolName: rawToolName,
      rawInput: body?.input,
      callId,
    });
    if (callId) {
      params.toolCallCanonicalNameByProviderAndId.set(getToolCallNameKey('codex', callId), {
        rawToolName,
        canonicalToolName,
      });
    }
    return { ...body, name: canonicalToolName, input };
  }

  if (body?.type === 'tool-call-result') {
    const callId = typeof body.callId === 'string' ? body.callId : undefined;
    const mapping = callId
      ? params.toolCallCanonicalNameByProviderAndId.get(getToolCallNameKey('codex', callId))
      : undefined;
    if (callId && !mapping) {
      params.debug('[Codex] Received tool-call-result without prior tool-call mapping (callId mismatch?)', {
        callId,
        type: body?.type,
      });
    }
    const canonicalToolName = mapping?.canonicalToolName ?? 'Unknown';
    const rawToolName = mapping?.rawToolName ?? 'unknown';
    const output = normalizeToolResultV2({
      protocol: 'codex',
      provider: 'codex',
      rawToolName,
      canonicalToolName,
      rawOutput: body?.output,
    });
    return { ...body, output };
  }

  return body;
}

export function normalizeAcpSessionMessageBody(params: {
  provider: ACPProvider;
  body: ACPMessageData;
  toolCallCanonicalNameByProviderAndId: Map<string, { rawToolName: string; canonicalToolName: string }>;
  permissionToolCallRawInputByProviderAndId: Map<string, unknown>;
  toolCallInputByProviderAndId: Map<string, unknown>;
}): ACPMessageData {
  const { provider, body } = params;

  // V2 tool-call normalization (canonical tool names + canonical input aliases + _happier/_raw).
  if (body.type === 'tool-call') {
    const callId = body.callId;
    const rawToolName = body.name;
    const rawInputHint = params.permissionToolCallRawInputByProviderAndId.get(
      getToolCallNameKey(provider, callId),
    );
    const hintedRawInput = (() => {
      if (!rawInputHint) return body.input;
      if (!body.input || typeof body.input !== 'object' || Array.isArray(body.input)) return rawInputHint;
      if (typeof rawInputHint !== 'object' || Array.isArray(rawInputHint)) return body.input;
      return { ...(rawInputHint as Record<string, unknown>), ...(body.input as Record<string, unknown>) };
    })();
    const { canonicalToolName, input } = normalizeToolCallV2({
      protocol: 'acp',
      provider,
      toolName: rawToolName,
      rawInput: hintedRawInput,
      callId,
    });
    const inputWithOpaque = ensureOpaqueAcpToolCallInputEnvelope(input);
    params.toolCallCanonicalNameByProviderAndId.set(getToolCallNameKey(provider, callId), {
      rawToolName,
      canonicalToolName,
    });
    params.toolCallInputByProviderAndId.set(getToolCallNameKey(provider, callId), inputWithOpaque);
    params.permissionToolCallRawInputByProviderAndId.delete(getToolCallNameKey(provider, callId));
    return { ...body, name: canonicalToolName, input: inputWithOpaque };
  }

  if (body.type === 'permission-request') {
    const rawInputHint = extractPermissionToolCallRawInput(body.options);
    const nextOptions =
      rawInputHint != null ? backfillPermissionRequestOptionsInput(body.options, rawInputHint) : body.options;
    if (rawInputHint != null) {
      params.permissionToolCallRawInputByProviderAndId.set(
        getToolCallNameKey(provider, body.permissionId),
        rawInputHint,
      );
    }
    let { canonicalToolName } = normalizeToolCallV2({
      protocol: 'acp',
      provider,
      toolName: body.toolName,
      rawInput: rawInputHint ?? nextOptions ?? {},
      callId: body.permissionId,
    });
    if (
      canonicalToolName === 'Write' &&
      typeof body.permissionId === 'string' &&
      body.permissionId.startsWith('write_todos')
    ) {
      canonicalToolName = 'TodoWrite';
    }
    return { ...body, toolName: canonicalToolName, options: nextOptions };
  }

  // Infer isError on tool results (preserve existing behavior).
  if (body.type === 'tool-result') {
    const callId = body.callId;
    const key = getToolCallNameKey(provider, callId);
    const mapping = params.toolCallCanonicalNameByProviderAndId.get(key);
    const canonicalToolName = mapping?.canonicalToolName ?? 'Unknown';
    const rawToolName = mapping?.rawToolName ?? 'unknown';

    const output = normalizeToolResultV2({
      protocol: 'acp',
      provider,
      rawToolName,
      canonicalToolName,
      rawOutput: (body as any).output,
    });
    const outputWithOpaque = ensureOpaqueAcpToolResultOutputEnvelope(output);

    const maybePatchedOutput = (() => {
      if (canonicalToolName !== 'TodoWrite' && canonicalToolName !== 'TodoRead') return outputWithOpaque;
      const outputRecord =
        outputWithOpaque && typeof outputWithOpaque === 'object' && !Array.isArray(outputWithOpaque)
          ? (outputWithOpaque as Record<string, unknown>)
          : null;
      if (!outputRecord) return outputWithOpaque;
      const existingTodos = Array.isArray((outputRecord as any).todos)
        ? ((outputRecord as any).todos as unknown[])
        : null;
      if (existingTodos && existingTodos.length > 0) return outputWithOpaque;

      const input = params.toolCallInputByProviderAndId.get(key);
      const inputRecord =
        input && typeof input === 'object' && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : null;
      const todos =
        inputRecord && Array.isArray((inputRecord as any).todos)
          ? ((inputRecord as any).todos as unknown[])
          : null;
      if (!todos || todos.length === 0) return outputWithOpaque;
      return { ...outputRecord, todos };
    })();

    // Avoid unbounded growth for tool calls that don't need later reconciliation.
    params.toolCallInputByProviderAndId.delete(key);

    if (typeof (body as any).isError === 'boolean') {
      return { ...(body as any), output: maybePatchedOutput } as ACPMessageData;
    }
    if (!maybePatchedOutput || typeof maybePatchedOutput !== 'object' || Array.isArray(maybePatchedOutput)) {
      return { ...(body as any), output: maybePatchedOutput } as ACPMessageData;
    }

    const record = maybePatchedOutput as Record<string, unknown>;
    const status = typeof record.status === 'string' ? record.status : null;
    const error = typeof record.error === 'string' ? record.error : null;
    const exitCode =
      typeof record.exit_code === 'number'
        ? record.exit_code
        : typeof record.exitCode === 'number'
          ? record.exitCode
          : null;
    const isError =
      Boolean(error && error.length > 0) || status === 'failed' || status === 'cancelled' || status === 'error';
    const inferredIsError =
      isError ||
      (typeof exitCode === 'number' && Number.isFinite(exitCode) && exitCode !== 0) ||
      record.ok === false ||
      record.success === false ||
      record.applied === false;
    return inferredIsError
      ? ({ ...(body as any), output: record, isError: true } as ACPMessageData)
      : ({ ...(body as any), output: record } as ACPMessageData);
  }

  return body;
}
