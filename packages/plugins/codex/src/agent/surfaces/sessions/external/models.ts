import { AgentExternalSessionTranscriptRawRecordSchema } from '@happier-dev/plugin-sdk/sessions/external';
import type {
  AgentExternalSessionCandidate,
  AgentExternalSessionLinkDataValue,
  AgentExternalSessionSource,
  AgentExternalSessionTranscriptItem,
  AgentExternalSessionsTranscriptPage,
} from '@happier-dev/plugin-sdk/sessions/external';
import { resolveTranscriptBodySessionMessageRole } from '@happier-dev/plugin-sdk/sessions';
import { z } from 'zod';

export type CodexExternalSessionSource = Readonly<{
  kind: 'codexHome';
  home: 'user' | 'connectedService';
  homePath?: string;
  connectedServiceId?: string;
  connectedServiceProfileId?: string;
  connectedServiceGroupId?: string;
}>;

const OptionalSourceStringSchema = z.string().min(1).optional();

export type CodexExternalSessionHandoffSource = Readonly<
  Omit<CodexExternalSessionSource, 'homePath'>
>;

export const CodexExternalSessionHandoffSourceSchema: z.ZodType<CodexExternalSessionHandoffSource> = z.object({
  kind: z.literal('codexHome'),
  home: z.enum(['user', 'connectedService']),
  connectedServiceId: OptionalSourceStringSchema,
  connectedServiceProfileId: OptionalSourceStringSchema,
  connectedServiceGroupId: OptionalSourceStringSchema,
});

export type CodexExternalSessionCandidate = Readonly<{
  remoteSessionId: string;
  title?: string;
  updatedAtMs: number;
  createdAtMs?: number;
  activity?: 'running' | 'active_recently' | 'idle' | 'unknown';
  archived?: boolean;
  details?: Readonly<Record<string, unknown>>;
}>;

export type CodexExternalSessionTranscriptSourcePage = Readonly<{
  items: readonly AgentExternalSessionTranscriptItem[];
  nextCursor: string | null;
  tailCursor?: string | null;
  hasMore?: boolean;
  truncated?: boolean;
  readAfterOutcome?:
    | 'already_current'
    | 'gap_or_cursor_expired'
    | 'source_replaced'
    | 'source_unavailable';
  diagnostics?: readonly Readonly<{
    code: string;
    count: number;
    positions: readonly number[];
  }>[];
}>;

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function projectAgentExternalSessionSourceToCodex(
  source: unknown,
): CodexExternalSessionSource | null {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const sourceRecord = source as Readonly<Record<string, unknown>>;
  if (sourceRecord.kind !== 'codexHome') return null;
  const home = sourceRecord.home;
  if (home !== 'user' && home !== 'connectedService') return null;
  const homePath = readOptionalString(sourceRecord.homePath);
  const connectedServiceId = readOptionalString(sourceRecord.connectedServiceId);
  const connectedServiceProfileId = readOptionalString(sourceRecord.connectedServiceProfileId);
  const connectedServiceGroupId = readOptionalString(sourceRecord.connectedServiceGroupId);
  return {
    kind: 'codexHome',
    home,
    ...(homePath ? { homePath } : {}),
    ...(connectedServiceId ? { connectedServiceId } : {}),
    ...(connectedServiceProfileId ? { connectedServiceProfileId } : {}),
    ...(connectedServiceGroupId ? { connectedServiceGroupId } : {}),
  };
}

export function projectCodexExternalSessionSourceToAgent(
  source: CodexExternalSessionSource,
): AgentExternalSessionSource {
  return {
    kind: source.kind,
    home: source.home,
    ...(source.homePath ? { homePath: source.homePath } : {}),
    ...(source.connectedServiceId ? { connectedServiceId: source.connectedServiceId } : {}),
    ...(source.connectedServiceProfileId
      ? { connectedServiceProfileId: source.connectedServiceProfileId }
      : {}),
    ...(source.connectedServiceGroupId
      ? { connectedServiceGroupId: source.connectedServiceGroupId }
      : {}),
  };
}

export function projectCodexExternalSessionSourceToHandoff(
  source: CodexExternalSessionSource | undefined,
): CodexExternalSessionHandoffSource | undefined {
  if (!source) return undefined;
  return {
    kind: source.kind,
    home: source.home,
    ...(source.connectedServiceId ? { connectedServiceId: source.connectedServiceId } : {}),
    ...(source.connectedServiceProfileId
      ? { connectedServiceProfileId: source.connectedServiceProfileId }
      : {}),
    ...(source.connectedServiceGroupId
      ? { connectedServiceGroupId: source.connectedServiceGroupId }
      : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readCodexTranscriptData(content: unknown): unknown {
  if (!isPlainObject(content) || content.type !== 'codex') return null;
  return content.data;
}

export function isCodexExternalSessionLinkDataValue(
  value: unknown,
  ancestors: ReadonlySet<object>,
): value is AgentExternalSessionLinkDataValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isCodexExternalSessionLinkDataValue(entry, nextAncestors));
  }
  if (!isPlainObject(value) || Reflect.ownKeys(value).some((key) => typeof key !== 'string')) return false;
  return Object.values(value).every((entry) => isCodexExternalSessionLinkDataValue(entry, nextAncestors));
}

function isLinkData(value: unknown): value is Readonly<Record<string, AgentExternalSessionLinkDataValue>> {
  return isPlainObject(value)
    && Reflect.ownKeys(value).every((key) => typeof key === 'string')
    && Object.values(value).every((entry) => isCodexExternalSessionLinkDataValue(entry, new Set([value])));
}

export function projectCodexExternalSessionCandidateToAgent(
  candidate: CodexExternalSessionCandidate,
): AgentExternalSessionCandidate {
  const details = isPlainObject(candidate.details) ? candidate.details : null;
  const source = projectAgentExternalSessionSourceToCodex(details?.source);
  const linkData: Record<string, AgentExternalSessionLinkDataValue> = {};
  if (source) linkData.source = projectCodexExternalSessionSourceToAgent(source);
  if (isCodexExternalSessionLinkDataValue(details?.runtimeDescriptorV1, new Set())) {
    linkData.runtimeDescriptorV1 = details.runtimeDescriptorV1;
  }
  const codexBackendMode = readOptionalString(details?.codexBackendMode);
  if (codexBackendMode) linkData.codexBackendMode = codexBackendMode;
  return {
    remoteSessionId: candidate.remoteSessionId,
    ...(candidate.title ? { title: candidate.title } : {}),
    updatedAtMs: candidate.updatedAtMs,
    ...(candidate.createdAtMs !== undefined ? { createdAtMs: candidate.createdAtMs } : {}),
    ...(candidate.archived !== undefined ? { archived: candidate.archived } : {}),
    ...(Object.keys(linkData).length > 0 ? { linkData } : {}),
  };
}

function projectTranscriptItem(
  item: AgentExternalSessionTranscriptItem,
): AgentExternalSessionTranscriptItem | null {
  if (!isPlainObject(item.raw) || !isLinkData(item.raw)) return null;
  const rawRole = item.raw.role;
  const content = item.raw.content;
  if (!isPlainObject(content)) return null;
  const codexData = readCodexTranscriptData(content);
  if (!isLinkData(content)) return null;
  const derivedRole = isPlainObject(codexData)
    ? resolveTranscriptBodySessionMessageRole({
      protocol: 'codex',
      body: codexData,
    })
    : rawRole === 'user' || rawRole === 'agent' || rawRole === 'event'
      ? rawRole
      : 'unknown';
  const messageRole = isPlainObject(codexData)
    ? derivedRole
    : item.messageRole ?? derivedRole;
  if (messageRole === null || messageRole === 'unknown') return null;
  // The canonical transcript raw record is exactly `{ role, content }`; consumers parse that
  // contract, so the envelope is preserved while every other top-level key on the source
  // record (paths, machine identity, and any future source-local fact) is dropped by
  // construction rather than by a denylist.
  const parsedRaw = AgentExternalSessionTranscriptRawRecordSchema.safeParse({
    role: rawRole === 'user' ? 'user' : 'agent',
    content,
  });
  if (!parsedRaw.success) return null;
  return {
    id: item.id,
    createdAtMs: item.createdAtMs,
    ...(item.localId !== undefined ? { localId: item.localId } : {}),
    ...(item.sidechainId !== undefined ? { sidechainId: item.sidechainId } : {}),
    messageRole,
    raw: parsedRaw.data,
  };
}

export function projectCodexExternalSessionTranscriptPageToAgent(
  page: CodexExternalSessionTranscriptSourcePage,
): AgentExternalSessionsTranscriptPage | null {
  const items = page.items.map(projectTranscriptItem);
  if (items.some((item) => item === null)) return null;
  return {
    items: items.filter((item): item is AgentExternalSessionTranscriptItem => item !== null),
    nextCursor: page.nextCursor,
    ...(page.tailCursor !== undefined ? { tailCursor: page.tailCursor } : {}),
    ...(page.hasMore !== undefined ? { hasMore: page.hasMore } : {}),
    ...(page.truncated !== undefined ? { truncated: page.truncated } : {}),
  };
}
