import {
  KnownCanonicalToolNameV2Schema,
  ToolHappierMetaV2Schema,
  getToolInputSchemaV2,
  getToolResultSchemaV2,
} from '@happier-dev/protocol/tools/v2';

type UnknownRecord = Record<string, unknown>;
type FixtureEvent = {
  kind?: unknown;
  protocol?: unknown;
  payload?: unknown;
};

function isClaudeToolUsePayload(payload: unknown): payload is { type: 'tool_use'; id: string; name: string; input?: unknown } {
  return (
    !!payload &&
    typeof payload === 'object' &&
    (payload as UnknownRecord).type === 'tool_use' &&
    typeof (payload as UnknownRecord).id === 'string' &&
    ((payload as UnknownRecord).id as string).length > 0 &&
    typeof (payload as UnknownRecord).name === 'string' &&
    ((payload as UnknownRecord).name as string).length > 0
  );
}

function isClaudeToolResultPayload(payload: unknown): payload is { type: 'tool_result'; tool_use_id: string; content?: unknown } {
  return (
    !!payload &&
    typeof payload === 'object' &&
    (payload as UnknownRecord).type === 'tool_result' &&
    typeof (payload as UnknownRecord).tool_use_id === 'string' &&
    ((payload as UnknownRecord).tool_use_id as string).length > 0
  );
}

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function isNormalizedPermissionRequestPayload(payload: unknown): payload is {
  toolName: string;
  permissionId?: string;
  id?: string;
  toolCallId?: string;
} {
  const record = asRecord(payload);
  if (!record) return false;
  const toolName = record.toolName;
  if (typeof toolName !== 'string' || toolName.trim().length === 0) return false;
  return true;
}

function getToolNameFromKey(key: string): string | null {
  // Expected fixture key shape:
  //   <protocol>/<provider>/<kind>/<toolName?>
  const parts = key.split('/');
  if (parts.length < 4) return null;
  return parts.slice(3).join('/') || null;
}

export function validateNormalizedToolFixturesV2(params: {
  fixturesExamples: Record<string, unknown>;
}): { ok: true } | { ok: false; reason: string } {
  const examples = params.fixturesExamples;
  const diagnostics: string[] = [];
  const maxDiagnostics = 12;

  const protocolFromFixtureKey = (key: string): string | null => {
    const proto = key.split('/')[0] ?? '';
    if (proto === 'acp' || proto === 'codex' || proto === 'claude') return proto;
    return null;
  };

  const addDiagnostic = (key: string, eventIndex: number, reason: string) => {
    if (diagnostics.length >= maxDiagnostics) return;
    diagnostics.push(`${key} [#${eventIndex}] ${reason}`);
  };

  for (const [key, eventsUnknown] of Object.entries(examples)) {
    const events = eventsUnknown as FixtureEvent[];
    if (!Array.isArray(events)) continue;

    for (const [eventIndex, ev] of events.entries()) {
      const kind = typeof ev?.kind === 'string' ? ev.kind : null;
      const protocol = typeof ev?.protocol === 'string' ? ev.protocol : protocolFromFixtureKey(key);
      const payload = ev?.payload;

      // Important: not all provider tool traces are normalized in Happier's V2 canonical format.
      // - ACP + Codex tool traces are emitted by our normalizers and must include `_happier`.
      // - Claude tool traces are currently recorded from raw Claude `tool_use` / `tool_result` blocks.
      //   These are valuable for drift detection, but do not include `_happier` yet.
      //
      // Only validate the normalized V2 schema envelope for protocols that actually produce it.
      const shouldValidateV2Envelope = protocol === 'acp' || protocol === 'codex';

      if (kind === 'tool-call') {
        const payloadRecord = asRecord(payload);
        const name = typeof payloadRecord?.name === 'string' ? payloadRecord.name : null;
        const input = payloadRecord?.input;
        if (!shouldValidateV2Envelope) {
          if (protocol === 'claude') {
            if (!isClaudeToolUsePayload(payload)) {
              addDiagnostic(key, eventIndex, 'claude tool-use payload does not match expected schema');
            }
          } else {
            addDiagnostic(key, eventIndex, `unsupported protocol for tool-call payload: ${String(protocol ?? 'unknown')}`);
          }
          continue;
        }
        const happier = asRecord(asRecord(input)?._happier);
        if (!happier) {
          addDiagnostic(key, eventIndex, 'tool-call missing _happier metadata');
          continue;
        }
        const parsedMeta = ToolHappierMetaV2Schema.safeParse(happier);
        if (!parsedMeta.success) {
          addDiagnostic(key, eventIndex, 'tool-call invalid _happier metadata');
          continue;
        }
        if (name && parsedMeta.data.canonicalToolName !== name) {
          addDiagnostic(key, eventIndex, 'tool-call canonicalToolName mismatch');
          continue;
        }

        if (name) {
          const parsedName = KnownCanonicalToolNameV2Schema.safeParse(name);
          if (parsedName.success) {
            const schema = getToolInputSchemaV2(parsedName.data);
            const parsed = schema.safeParse(input);
            if (!parsed.success) {
              addDiagnostic(key, eventIndex, 'tool-call input does not match V2 schema');
            }
          }
        }
      }

      if (kind === 'tool-result' || kind === 'tool-call-result') {
        const toolNameFromKey = getToolNameFromKey(key);
        const payloadRecord = asRecord(payload);
        const output = payloadRecord?.output;
        if (!shouldValidateV2Envelope) {
          if (protocol === 'claude' && kind === 'tool-result') {
            if (!isClaudeToolResultPayload(payload)) {
              addDiagnostic(key, eventIndex, 'claude tool-result payload does not match expected schema');
            }
          } else {
            addDiagnostic(key, eventIndex, `unsupported protocol for tool-result payload: ${String(protocol ?? 'unknown')}`);
          }
          continue;
        }
        const happier = asRecord(asRecord(output)?._happier);
        if (!happier) {
          addDiagnostic(key, eventIndex, 'tool-result missing _happier metadata');
          continue;
        }
        const parsedMeta = ToolHappierMetaV2Schema.safeParse(happier);
        if (!parsedMeta.success) {
          addDiagnostic(key, eventIndex, 'tool-result invalid _happier metadata');
          continue;
        }
        if (toolNameFromKey && parsedMeta.data.canonicalToolName !== toolNameFromKey) {
          addDiagnostic(key, eventIndex, 'tool-result canonicalToolName mismatch');
          continue;
        }

        if (toolNameFromKey) {
          const parsedName = KnownCanonicalToolNameV2Schema.safeParse(toolNameFromKey);
          if (parsedName.success) {
            const schema = getToolResultSchemaV2(parsedName.data);
            const parsed = schema.safeParse(output);
            if (!parsed.success) {
              addDiagnostic(key, eventIndex, 'tool-result output does not match V2 schema');
            }
          }
        }
      }

      if (kind === 'permission-request') {
        if (shouldValidateV2Envelope) {
          if (!isNormalizedPermissionRequestPayload(payload)) {
            addDiagnostic(key, eventIndex, 'permission-request payload does not match expected schema');
          }
          continue;
        }
        if (protocol === 'claude') {
          if (!asRecord(payload)) {
            addDiagnostic(key, eventIndex, 'claude permission-request payload must be an object');
          }
          continue;
        }
        addDiagnostic(key, eventIndex, `unsupported protocol for permission-request payload: ${String(protocol ?? 'unknown')}`);
      }
    }
  }

  if (diagnostics.length > 0) {
    const suffix = diagnostics.length >= maxDiagnostics ? ` (showing first ${maxDiagnostics} issues)` : '';
    return { ok: false, reason: `${diagnostics.join('; ')}${suffix}` };
  }

  return { ok: true };
}
