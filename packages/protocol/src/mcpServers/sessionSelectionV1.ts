import { z } from 'zod';

function dedupeStrings(values: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export const SessionMcpSelectionV1Schema = z
  .preprocess(
    (raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      return raw;
    },
    z.object({
      v: z.literal(1).default(1),
      managedServersEnabled: z.boolean().default(true),
      forceIncludeServerIds: z.array(z.string().min(1)).default([]),
      forceExcludeServerIds: z.array(z.string().min(1)).default([]),
    }),
  )
  .transform((value) => ({
    ...value,
    forceIncludeServerIds: dedupeStrings(value.forceIncludeServerIds),
    forceExcludeServerIds: dedupeStrings(value.forceExcludeServerIds),
  }));

export type SessionMcpSelectionV1 = z.infer<typeof SessionMcpSelectionV1Schema>;

export function parseSessionMcpSelectionV1Json(raw: string | null | undefined): SessionMcpSelectionV1 | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    const selection = SessionMcpSelectionV1Schema.safeParse(parsed);
    return selection.success ? selection.data : null;
  } catch {
    return null;
  }
}

export function readSessionMcpSelectionV1FromMetadata(metadata: unknown): SessionMcpSelectionV1 | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).mcpSelectionV1;
  if (raw === undefined) return null;
  const parsed = SessionMcpSelectionV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
