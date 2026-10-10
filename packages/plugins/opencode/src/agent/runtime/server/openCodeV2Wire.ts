import { asRecord, normalizeString, readNonBlankOpaqueIdentifier } from './openCodeParsing.js';
import type { OpenCodePromptPart } from './promptParts.js';

/**
 * The wire shape of OpenCode's standalone V2 server, mapped to and from the
 * runtime domain the rest of this plugin already speaks.
 *
 * This module owns **only** the V2 ↔ domain translation. It is not a client:
 * its callers are the two route owners — `openCodeServerClient.ts` for Session
 * runtime operations and the External Sessions read client
 * (`agent/surfaces/sessions/external/client.ts`) for the browse reads — and each
 * of those remains the only owner of its own V1 routes. Keeping the mapping
 * here keeps one dialect's wire details out of the other's, and keeps both
 * surfaces reading the V2 envelope exactly one way.
 *
 * Every route, payload and envelope below follows released OpenCode v2.0.15
 * (`6f3639d82ed0760091792189b78f8eeb44f699b1`), with native v2.0.20
 * command/skill catalog envelopes and flat prompt admission observed:
 *
 * - `packages/protocol/src/api.ts` composes the whole standalone inventory, and
 *   it is `/api/*` only — no root `/session`, no `/global/*`, no MCP group;
 * - `packages/protocol/src/groups/location.ts` declares the `location` query as
 *   an OpenAPI `deepObject`, and `packages/server/src/location.ts` reads it back
 *   as the literal key `location[directory]`;
 * - `packages/server/src/middleware/session-location.ts` resolves every
 *   `/api/session/:sessionID/...` route from the stored session row, so those
 *   routes take no location query at all;
 * - the location-scoped reads answer `{ location, data }`
 *   (`Location.response`), the session reads answer `{ data }` or
 *   `{ data, cursor }`, and the mutations answer `204 No Content`.
 *
 * Byte policy. Anything OpenCode minted or authored and that Happier hands
 * back or shows verbatim is read for presence only and kept byte-exact:
 * pagination cursors, message and tool-call ids (through the one
 * `readNonBlankOpaqueIdentifier` owner), user/text/reasoning/tool semantic
 * text (`readSemanticText`, which validates the type and nothing else), and
 * the permission ask, which this module only renames — `permissionBridge.ts`
 * remains the sole fail-closed validator of its id, session and patterns.
 * The remaining `normalizeString` sites are deliberate and closed:
 * `location.directory` (a path, canonicalized the same way every V1 reader
 * does), the caller-selected model `variant`, provider/model inventory ids
 * (the model-resolution owner in `runtimeController.ts` trims both sides of
 * that comparison, as V1's `readProviderList` already did), and the
 * `type`/`status`/`finish`/tool-name vocabulary the projection classifies on.
 * Do not add a new trim here for a provider-minted value.
 */

/** `Location.Ref` as the deepObject query key the V2 server actually parses. */
export function openCodeV2LocationQuery(
  directory: string | null,
): Readonly<Record<string, string | undefined>> {
  return { 'location[directory]': directory ?? undefined };
}

/** The `data` member of a V2 success envelope, whichever envelope it is. */
export function readOpenCodeV2Data(response: unknown): unknown {
  return asRecord(response)?.data;
}

export function readOpenCodeV2DataArray(response: unknown): readonly unknown[] {
  const data = readOpenCodeV2Data(response);
  return Array.isArray(data) ? data : [];
}

/**
 * One page of `/api/session/:sessionID/message`.
 *
 * The cursor is opaque and the schema forbids combining it with `order`, so a
 * follow-up page sends the cursor alone.
 */
export function readOpenCodeV2MessagePage(response: unknown): Readonly<{
  messages: readonly unknown[];
  nextCursor: string | null;
}> {
  const messages = readOpenCodeV2Data(response);
  if (!Array.isArray(messages)) throw new Error('OpenCode session message page is invalid');
  const cursor = readNonBlankOpaqueIdentifier(asRecord(asRecord(response)?.cursor)?.next);
  return {
    messages,
    nextCursor: cursor,
  };
}

/**
 * `{ data: Record<Session.ID, { type: 'running' }> }` from
 * `/api/session/active`, read as the busy answer for every session the server
 * reports. The route's own description is decisive: "Sessions absent from the
 * result are inactive", so an absent session is absent from this map too —
 * callers that need an idle answer for a specific session derive it, and callers
 * that reconcile many links keep "reported busy" and "not reported" distinct.
 */
export function readOpenCodeV2ActiveSessionStatusMap(
  response: unknown,
): Record<string, Readonly<{ type: 'busy' }>> {
  const active = asRecord(readOpenCodeV2Data(response));
  if (!active) {
    throw new Error('OpenCode /api/session/active returned an invalid status map');
  }
  const entries: Array<[string, Readonly<{ type: 'busy' }>]> = [];
  for (const [sessionId, value] of Object.entries(active)) {
    if (!asRecord(value)) {
      throw new Error('OpenCode /api/session/active returned an invalid status map');
    }
    entries.push([sessionId, { type: 'busy' }]);
  }
  return Object.fromEntries(entries);
}

/** The busy/idle answer the runtime's per-session status polling expects. */
export function readOpenCodeV2SessionStatus(
  response: unknown,
  sessionId: string,
): Readonly<{ type: 'busy' | 'idle' }> {
  const active = asRecord(readOpenCodeV2Data(response));
  return { type: asRecord(active?.[sessionId]) ? 'busy' : 'idle' };
}

/**
 * One page of `/api/session`.
 *
 * The envelope is `{ data: Session.Info[], cursor: { previous?, next? } }`
 * (`packages/protocol/src/groups/session.ts`). The cursor is an opaque
 * server-minted token that already carries the page's own query, so a
 * continuation sends it with nothing but a limit.
 */
export function readOpenCodeV2SessionListPage(response: unknown): Readonly<{
  sessions: readonly unknown[];
  nextCursor: string | null;
}> {
  const cursor = readNonBlankOpaqueIdentifier(asRecord(asRecord(response)?.cursor)?.next);
  return {
    sessions: readOpenCodeV2DataArray(response),
    nextCursor: cursor,
  };
}

/**
 * `Session.Info` in the vocabulary the External Sessions readers already parse.
 *
 * V2 moved the working directory into `location: Location.Ref`
 * (`packages/schema/src/session.ts`), while every Happier reader — candidate
 * projection, link canonicalization, transcript scope validation — reads a flat
 * `directory` beside `id`, `title` and `time`. Hoisting it here keeps those
 * readers dialect-blind instead of teaching each one a second session shape.
 */
export function normalizeOpenCodeV2SessionInfo(raw: unknown): unknown {
  const record = asRecord(raw);
  if (!record) return raw;
  const directory = normalizeString(asRecord(record.location)?.directory);
  return directory ? { ...record, directory } : record;
}

export class OpenCodeSkillIdentityError extends Error {
  readonly code = 'opencode_skill_identity_missing';
  constructor() {
    super('OpenCode skill selection has no unique native identity');
    this.name = 'OpenCodeSkillIdentityError';
  }
}

/**
 * PromptInput.Prompt — { text, files?, agents?, skills? }.
 *
 * V1 accepted an array of typed parts; V2 accepts one prompt with the text
 * flattened and agent mentions as their own attachment list. Text parts are
 * concatenated in order, which is what the V1 server did with them too.
 */
export function buildOpenCodeV2Prompt(input: Readonly<{
  text: string;
  parts?: readonly OpenCodePromptPart[];
}>): Readonly<{
  text: string;
  files?: readonly Readonly<{ uri: string; name?: string }>[];
  agents?: readonly Readonly<{ name: string }>[];
  skills?: readonly Readonly<{ id: string }>[];
}> {
  const parts = input.parts;
  if (!parts || parts.length === 0) return { text: input.text };

  const textChunks: string[] = [];
  const files: Array<Readonly<{ uri: string; name?: string }>> = [];
  const agents: Array<Readonly<{ name: string }>> = [];
  const skills: Array<Readonly<{ id: string }>> = [];
  for (const part of parts) {
    if (part.type === 'text') textChunks.push(part.text);
    else if (part.type === 'file') {
      files.push({
        uri: part.url,
        ...(part.filename ? { name: part.filename } : {}),
      });
    } else if (part.type === 'skill') {
      if (!part.id || !part.id.trim()) throw new OpenCodeSkillIdentityError();
      skills.push({ id: part.id });
    } else agents.push({ name: part.name });
  }
  return {
    text: textChunks.join('\n'),
    ...(files.length > 0 ? { files } : {}),
    ...(agents.length > 0 ? { agents } : {}),
    ...(skills.length > 0 ? { skills } : {}),
  };
}

/**
 * `Model.Ref` — `{ id, providerID, variant? }`.
 *
 * V2 has no per-prompt model: `session.prompt` carries none and
 * `session.switchModel` is its own route, so the caller selects first and
 * prompts second.
 */
export function buildOpenCodeV2ModelRef(input: Readonly<{
  providerID: string;
  modelID: string;
  variant?: string | null;
}>): Readonly<{ id: string; providerID: string; variant?: string }> {
  const variant = normalizeString(input.variant);
  return {
    id: input.modelID,
    providerID: input.providerID,
    ...(variant ? { variant } : {}),
  };
}

/**
 * `PermissionV2.Request` in the vocabulary the permission bridge parses.
 *
 * V2 renamed the two load-bearing fields: the permission name moved from
 * `permission` into a **string** `action` (V1's `action` was a record), and
 * `patterns` became `resources`. Without this remap the bridge reads every V2
 * ask as malformed and auto-rejects it.
 */
export function normalizeOpenCodeV2PermissionRequest(
  raw: unknown,
): Readonly<Record<string, unknown>> | null {
  const record = asRecord(raw);
  if (!record) return null;
  const { action, resources, ...rest } = record;
  return {
    ...rest,
    permission: action,
    patterns: resources,
  };
}

/** Released V2's strict `{ action, resource, effect }` permission rule. */
export function buildOpenCodeV2PermissionRuleset(
  permissions: readonly unknown[],
): readonly unknown[] {
  return permissions.map((rule) => {
    const record = asRecord(rule);
    if (!record) return rule;
    if (typeof record.effect === 'string' && typeof record.resource === 'string') return record;
    const { permission: action, pattern: resource, action: effect, ...rest } = record;
    if (typeof action !== 'string' || typeof effect !== 'string') return record;
    return {
      ...rest,
      action,
      resource: typeof resource === 'string' ? resource : '*',
      effect,
    };
  });
}

/**
 * V2 `Provider.Info` carries neither a `models` map nor `env`: models are their
 * own location-scoped inventory (`/api/model`) keyed back by `providerID`.
 * Rejoining them here keeps `providersList` one shape for both dialects, so the
 * model-resolution owner in `runtimeController.ts` stays dialect-blind.
 */
export function combineOpenCodeV2Providers(
  providers: readonly unknown[],
  models: readonly unknown[],
): readonly Readonly<{
  id: string;
  env?: readonly string[];
  models?: Readonly<Record<string, unknown>>;
}>[] {
  const modelsByProvider = new Map<string, Record<string, unknown>>();
  for (const rawModel of models) {
    const model = asRecord(rawModel);
    const providerId = normalizeString(model?.providerID);
    const modelId = normalizeString(model?.id);
    if (!providerId || !modelId) continue;
    const bucket = modelsByProvider.get(providerId) ?? {};
    bucket[modelId] = rawModel;
    modelsByProvider.set(providerId, bucket);
  }

  if (models.length > 0 && modelsByProvider.size === 0) throw new Error('Invalid OpenCode provider inventory');
  const parsedProviders = providers.flatMap((rawProvider) => {
    const id = normalizeString(asRecord(rawProvider)?.id);
    if (!id) return [];
    const providerModels = modelsByProvider.get(id);
    return [{
      id,
      ...(providerModels ? { models: providerModels } : {}),
    }];
  });
  if (providers.length > 0 && parsedProviders.length === 0) throw new Error('Invalid OpenCode provider inventory');
  return parsedProviders;
}

type NormalizedOpenCodeMessage = Readonly<{
  info: Readonly<Record<string, unknown>>;
  parts: readonly unknown[];
}>;

/**
 * Semantic text a provider or user authored. Its type is validated and nothing
 * else: leading and trailing bytes are content the transcript shows verbatim.
 */
function readSemanticText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readV2Time(value: unknown): Readonly<Record<string, unknown>> | null {
  const time = asRecord(value);
  if (!time) return null;
  const created = time.created;
  const completed = time.completed;
  return {
    ...(created === undefined ? {} : { created }),
    ...(completed === undefined ? {} : { completed }),
  };
}

/**
 * The text a V2 tool state produced, as the single `output` value the tool
 * projection reads.
 *
 * `LLM.ToolContent` is a union of text and file content; only the text carries
 * output bytes. `structured`, `result` and the provider metadata have no V1
 * counterpart the projection reads, so they are not invented into one.
 */
function readV2ToolOutput(state: Readonly<Record<string, unknown>> | null): unknown {
  const content = state?.content;
  if (Array.isArray(content)) {
    const text = content
      .map((entry) => (normalizeString(asRecord(entry)?.type) === 'text'
        ? readSemanticText(asRecord(entry)?.text)
        : null))
      .filter((entry): entry is string => entry !== null);
    if (text.length > 0) return text.join('\n');
  }
  return state?.result;
}

function normalizeV2AssistantContent(params: Readonly<{
  content: unknown;
  sessionId: string;
  messageId: string;
}>): readonly unknown[] {
  if (!Array.isArray(params.content)) return [];
  return params.content.flatMap((rawEntry): readonly unknown[] => {
    const entry = asRecord(rawEntry);
    const type = normalizeString(entry?.type);
    if (type === 'text' || type === 'reasoning') {
      const text = readSemanticText(entry?.text);
      return text === null ? [] : [{ type, text }];
    }
    if (type !== 'tool') return [];
    // OpenCode minted this tool-call id; it keys the tool lifecycle verbatim.
    const callId = readNonBlankOpaqueIdentifier(entry?.id) ?? '';
    const tool = normalizeString(entry?.name);
    const state = asRecord(entry?.state);
    const status = normalizeString(state?.status);
    if (!callId || !tool || !status) return [];
    const output = readV2ToolOutput(state);
    return [{
      type: 'tool',
      sessionID: params.sessionId,
      messageID: params.messageId,
      callID: callId,
      tool,
      state: {
        status,
        ...(state?.input === undefined ? {} : { input: state.input }),
        ...(output === undefined ? {} : { output }),
        ...(state?.metadata === undefined ? {} : { metadata: state.metadata }),
      },
    }];
  });
}

/**
 * One `Session.Message` in the `{ info, parts }` shape the transcript
 * projection, completion classifier and tool tracker all read.
 *
 * V2 replaced V1's `{ info: { role, ... }, parts: [...] }` with a tagged union
 * discriminated by `type`, so the role, the parts and the session scope all
 * have to be restored here — the projection is not the place to learn a second
 * message vocabulary.
 *
 * `parentID` has no V2 field at all. The runtime uses it for exactly one thing:
 * anchoring a terminal assistant message to the user message that started the
 * turn. The ordered timeline is the only evidence for that anchor, so the
 * caller supplies the preceding user message and nothing wider is inferred.
 *
 * Message types with no V1 counterpart the projection consumes
 * (`agent-switched`, `model-switched`, `system`, `shell`) are returned without
 * a role, which the projection already classifies as `unknown` and ignores.
 */
export function normalizeOpenCodeV2Message(params: Readonly<{
  raw: unknown;
  sessionId: string;
  precedingUserMessageId: string | null;
}>): NormalizedOpenCodeMessage | null {
  const record = asRecord(params.raw);
  // OpenCode minted this message id; projection and turn anchoring read it back.
  const id = readNonBlankOpaqueIdentifier(record?.id) ?? '';
  if (!record || !id) return null;

  const type = normalizeString(record.type);
  const time = readV2Time(record.time);
  const base = {
    id,
    ...(time ? { time } : {}),
    ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
  };
  // Accounting belongs to the native assistant/compaction message, including
  // messages deliberately omitted from the user-facing transcript.
  const modelId = readNonBlankOpaqueIdentifier(asRecord(record.model)?.modelID);
  const accounting = {
    ...(record.tokens === undefined ? {} : { tokens: record.tokens }),
    ...(record.cost === undefined ? {} : { cost: record.cost }),
    ...(modelId ? { modelID: modelId } : {}),
    ...(['completed', 'failed'].includes(String(record.status)) ? { nativeAccountingComplete: true } : {}),
  };

  if (type === 'user') {
    const text = readSemanticText(record.text);
    return {
      info: { ...base, role: 'user', sessionID: params.sessionId },
      parts: text === null ? [] : [{ type: 'text', text }],
    };
  }

  if (type === 'synthetic') {
    // V1 marked provider-authored filler with `synthetic`, which the projection
    // already treats as internal.
    return {
      info: { ...base, role: 'user', sessionID: params.sessionId, synthetic: true },
      parts: [],
    };
  }

  if (type === 'compaction') {
    // V1 represented a compaction as an assistant message flagged `summary`,
    // which is exactly the `compaction_internal` classification.
    return {
      info: { ...base, ...accounting, role: 'assistant', sessionID: params.sessionId, summary: true },
      parts: [],
    };
  }

  if (type === 'assistant') {
    const finish = normalizeString(record.finish);
    return {
      info: {
        ...base,
        ...accounting,
        role: 'assistant',
        sessionID: params.sessionId,
        ...(params.precedingUserMessageId ? { parentID: params.precedingUserMessageId } : {}),
        ...(finish ? { finish } : {}),
        ...(record.error === undefined ? {} : { error: record.error }),
      },
      parts: normalizeV2AssistantContent({
        content: record.content,
        sessionId: params.sessionId,
        messageId: id,
      }),
    };
  }

  return { info: { ...base, ...(type === 'idle' ? { type, outcome: record.outcome } : {}) }, parts: [] };
}

/** The ordered timeline, normalized with each assistant anchored to its user. */
export function normalizeOpenCodeV2Messages(
  raw: readonly unknown[],
  sessionId: string,
): readonly unknown[] {
  let precedingUserMessageId: string | null = null;
  const normalized: unknown[] = [];
  for (const entry of raw) {
    const message = normalizeOpenCodeV2Message({
      raw: entry,
      sessionId,
      precedingUserMessageId,
    });
    if (!message) continue;
    if (message.info.role === 'user' && message.info.synthetic !== true) {
      precedingUserMessageId = readNonBlankOpaqueIdentifier(message.info.id);
    }
    normalized.push(message);
  }
  return normalized;
}
