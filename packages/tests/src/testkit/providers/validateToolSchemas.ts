import {
  KnownCanonicalToolNameV2Schema,
  ToolHappierMetaV2Schema,
  getToolInputSchemaV2,
  getToolResultSchemaV2,
} from '@happier-dev/protocol/tools/v2';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
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

  for (const [key, eventsUnknown] of Object.entries(examples)) {
    const events = eventsUnknown as any[];
    if (!Array.isArray(events)) continue;

    for (const ev of events) {
      const kind = typeof ev?.kind === 'string' ? ev.kind : null;
      const payload = ev?.payload;

      if (kind === 'tool-call') {
        const name = typeof payload?.name === 'string' ? payload.name : null;
        const input = payload?.input;
        const happy = asRecord(asRecord(input)?._happy);
        if (!happy) return { ok: false, reason: `tool-call missing _happy metadata (${key})` };
        const parsedMeta = ToolHappierMetaV2Schema.safeParse(happy);
        if (!parsedMeta.success) return { ok: false, reason: `tool-call invalid _happy metadata (${key})` };
        if (name && parsedMeta.data.canonicalToolName !== name) {
          return { ok: false, reason: `tool-call canonicalToolName mismatch (${key})` };
        }

        if (name) {
          const parsedName = KnownCanonicalToolNameV2Schema.safeParse(name);
          if (parsedName.success) {
            const schema = getToolInputSchemaV2(parsedName.data);
            const parsed = schema.safeParse(input);
            if (!parsed.success) {
              return { ok: false, reason: `tool-call input does not match V2 schema (${key})` };
            }
          }
        }
      }

      if (kind === 'tool-result' || kind === 'tool-call-result') {
        const toolNameFromKey = getToolNameFromKey(key);
        const output = payload?.output;
        const happy = asRecord(asRecord(output)?._happy);
        if (!happy) return { ok: false, reason: `tool-result missing _happy metadata (${key})` };
        const parsedMeta = ToolHappierMetaV2Schema.safeParse(happy);
        if (!parsedMeta.success) return { ok: false, reason: `tool-result invalid _happy metadata (${key})` };
        if (toolNameFromKey && parsedMeta.data.canonicalToolName !== toolNameFromKey) {
          return { ok: false, reason: `tool-result canonicalToolName mismatch (${key})` };
        }

        if (toolNameFromKey) {
          const parsedName = KnownCanonicalToolNameV2Schema.safeParse(toolNameFromKey);
          if (parsedName.success) {
            const schema = getToolResultSchemaV2(parsedName.data);
            const parsed = schema.safeParse(output);
            if (!parsed.success) {
              return { ok: false, reason: `tool-result output does not match V2 schema (${key})` };
            }
          }
        }
      }
    }
  }

  return { ok: true };
}

