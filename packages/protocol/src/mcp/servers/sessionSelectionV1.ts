import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

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

const SESSION_MCP_SELECTION_V1_FIELDS = {
  v: z._default(z.literal(1), 1),
  managedServersEnabled: z._default(z.boolean(), true),
  happierToolsEnabled: z.optional(z.boolean()),
  forceIncludeServerIds: z._default(z.array(z.string().check(z.minLength(1))), []),
  forceExcludeServerIds: z._default(z.array(z.string().check(z.minLength(1))), []),
} as const;

function normalizeSessionMcpSelectionV1(value: {
  v: 1;
  managedServersEnabled: boolean;
  happierToolsEnabled?: boolean;
  forceIncludeServerIds: string[];
  forceExcludeServerIds: string[];
}) {
  return {
    ...value,
    forceIncludeServerIds: dedupeStrings(value.forceIncludeServerIds),
    forceExcludeServerIds: dedupeStrings(value.forceExcludeServerIds),
  };
}

/** Closed current authoring/executable-declaration input. */
export const SessionMcpSelectionAuthoringV1Schema = lazyZodSchema(() => z.pipe(z.strictObject(SESSION_MCP_SELECTION_V1_FIELDS), z.transform(normalizeSessionMcpSelectionV1)));

export type SessionMcpSelectionAuthoringV1 = z.infer<typeof SessionMcpSelectionAuthoringV1Schema>;

/** Permissive legacy Session ingress retained for supported stored/session inputs. */
export const SessionMcpSelectionV1Schema = lazyZodSchema(() => z.pipe((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      return raw;
    }), z.object(SESSION_MCP_SELECTION_V1_FIELDS)), z.transform(normalizeSessionMcpSelectionV1)));

export type SessionMcpSelectionV1 = z.infer<typeof SessionMcpSelectionV1Schema>;

/** Closed metadata writes; the stored marker reader below keeps the released shape. */
export const SessionMcpSelectionRestartRequiredAuthoringV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  appliedSelection: SessionMcpSelectionAuthoringV1Schema,
}));

export const SessionMcpSelectionRestartRequiredV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  appliedSelection: SessionMcpSelectionV1Schema,
}));

export type SessionMcpSelectionRestartRequiredV1 = z.infer<typeof SessionMcpSelectionRestartRequiredV1Schema>;

function selectionBehaviorKey(selection: SessionMcpSelectionV1): string {
  const normalized = SessionMcpSelectionV1Schema.parse(selection);
  const forceExcludeServerIds = [...normalized.forceExcludeServerIds].sort();
  const excluded = new Set(forceExcludeServerIds);
  const forceIncludeServerIds = normalized.forceIncludeServerIds
    .filter((serverId) => !excluded.has(serverId))
    .sort();
  return JSON.stringify({
    managedServersEnabled: normalized.managedServersEnabled,
    happierToolsEnabled: normalized.happierToolsEnabled ?? true,
    forceIncludeServerIds,
    forceExcludeServerIds,
  });
}

/** Compares the effective selection policy; exclude wins over a redundant include. */
export function areSessionMcpSelectionsEquivalent(
  left: SessionMcpSelectionV1,
  right: SessionMcpSelectionV1,
): boolean {
  return selectionBehaviorKey(left) === selectionBehaviorKey(right);
}

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

export function readSessionMcpSelectionRestartRequiredV1FromMetadata(
  metadata: unknown,
): SessionMcpSelectionRestartRequiredV1 | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).mcpSelectionRestartRequiredV1;
  if (raw === undefined) return null;
  const parsed = SessionMcpSelectionRestartRequiredV1Schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
