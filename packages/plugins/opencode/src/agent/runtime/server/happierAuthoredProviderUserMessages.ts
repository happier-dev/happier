import { createHash } from 'node:crypto';

import { asRecord, normalizeString } from './openCodeParsing.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';

const HAPPIER_AUTHORED_PROVIDER_USER_MESSAGE_IDS_STORAGE_PREFIX =
  'opencode.server.happierAuthoredProviderUserMessageIds.v1';
const MAX_PENDING_PROMPT_ANCHORS = 128;
const MAX_PENDING_PROMPT_ANCHOR_AGE_MS = 30 * 60_000;

type PendingPromptAnchor = Readonly<{
  providerSessionId: string;
  submittedAtMs: number;
  digest: string;
  text?: string;
}>;

type PendingPromptAnchorMatch = Readonly<{
  anchor: PendingPromptAnchor;
  consumeAnchor: boolean;
}>;

function storageKeyForProviderSession(providerSessionId: string): string {
  return `${HAPPIER_AUTHORED_PROVIDER_USER_MESSAGE_IDS_STORAGE_PREFIX}:${encodeURIComponent(providerSessionId)}`;
}

function normalizePromptText(value: unknown): string {
  return normalizeString(value).trim();
}

function digestPromptText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64url');
}

function looksLikeOpenCodePromptStackWrapper(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes('[opencode prompt stack]')
    || normalized.includes('[analyze-mode]')
    || normalized.includes('[search-mode]')
    || normalized.includes('analysis mode. gather context')
    || normalized.includes('linked workspace files')
    || (
      normalized.includes('session title')
      && normalized.includes('options')
    );
}

function readStoredPendingPromptAnchors(value: unknown): readonly PendingPromptAnchor[] {
  const record = asRecord(value);
  if (record?.v !== 2 || !Array.isArray(record.pendingPromptAnchors)) return [];
  const anchors: PendingPromptAnchor[] = [];
  for (const rawAnchor of record.pendingPromptAnchors) {
    const anchor = asRecord(rawAnchor);
    const providerSessionId = normalizeString(anchor?.providerSessionId);
    const digest = normalizeString(anchor?.digest);
    const submittedAtMs = typeof anchor?.submittedAtMs === 'number' && Number.isFinite(anchor.submittedAtMs)
      ? Math.trunc(anchor.submittedAtMs)
      : NaN;
    if (!providerSessionId || !digest || !Number.isFinite(submittedAtMs) || submittedAtMs <= 0) continue;
    anchors.push({ providerSessionId, digest, submittedAtMs });
  }
  return anchors;
}

function readStoredProviderUserMessageIds(value: unknown): readonly string[] {
  const record = asRecord(value);
  if ((record?.v !== 1 && record?.v !== 2) || !Array.isArray(record.ids)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const rawId of record.ids) {
    const id = normalizeString(rawId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function prunePendingPromptAnchors(
  anchors: readonly PendingPromptAnchor[],
  nowMs: number,
): readonly PendingPromptAnchor[] {
  return anchors
    .filter((anchor) => nowMs - anchor.submittedAtMs <= MAX_PENDING_PROMPT_ANCHOR_AGE_MS)
    .slice(-MAX_PENDING_PROMPT_ANCHORS);
}

function matchPendingPromptAnchor(
  anchor: PendingPromptAnchor,
  input: Readonly<{
    providerSessionId: string;
    text: string;
    digest: string;
    createdAtMs: number;
  }>,
): PendingPromptAnchorMatch | null {
  if (
    anchor.providerSessionId !== input.providerSessionId
    || input.createdAtMs < anchor.submittedAtMs
    || input.createdAtMs - anchor.submittedAtMs > MAX_PENDING_PROMPT_ANCHOR_AGE_MS
  ) {
    return null;
  }

  if (anchor.digest === input.digest || input.text === anchor.text) {
    return { anchor, consumeAnchor: true };
  }

  if (
    anchor.text !== undefined
    && input.text.includes(anchor.text)
    && looksLikeOpenCodePromptStackWrapper(input.text)
  ) {
    return { anchor, consumeAnchor: false };
  }

  return null;
}

export function createOpenCodeHappierAuthoredProviderUserMessageIds(params: Readonly<{
  ctx: OpenCodeRuntimeContext;
  readProviderSessionId: () => string | null | undefined;
}>): Readonly<{
  has(messageId: string): boolean;
  add(messageId: string): Promise<void>;
  recordPendingPromptAnchor(input: Readonly<{
    text: string;
    submittedAtMs: number;
  }>): void;
  markIfHappierAuthoredProviderUserMessage(input: Readonly<{
    messageId: string;
    text: string;
    createdAtMs: number;
  }>): Promise<boolean>;
  hydrate(): Promise<void>;
  clearMemory(): void;
}> {
  const ids = new Set<string>();
  let pendingPromptAnchors: PendingPromptAnchor[] = [];

  async function persist(providerSessionId: string): Promise<void> {
    try {
      await params.ctx.storage.session.set(storageKeyForProviderSession(providerSessionId), {
        v: 2,
        providerSessionId,
        ids: [...ids],
        pendingPromptAnchors: pendingPromptAnchors
          .filter((anchor) => anchor.providerSessionId === providerSessionId)
          .map((anchor) => ({
            providerSessionId: anchor.providerSessionId,
            submittedAtMs: anchor.submittedAtMs,
            digest: anchor.digest,
          })),
      });
    } catch (error) {
      params.ctx.logger.debug('[OpenCodeServer] failed to persist Happier-authored provider user ids', { error });
    }
  }

  return {
    has(messageId) {
      return ids.has(messageId);
    },
    async add(messageId) {
      const normalizedMessageId = normalizeString(messageId);
      if (!normalizedMessageId || ids.has(normalizedMessageId)) return;
      ids.add(normalizedMessageId);
      const providerSessionId = normalizeString(params.readProviderSessionId());
      if (!providerSessionId) return;
      await persist(providerSessionId);
    },
    recordPendingPromptAnchor(input) {
      const text = normalizePromptText(input.text);
      const submittedAtMs = Number.isFinite(input.submittedAtMs) ? Math.trunc(input.submittedAtMs) : NaN;
      const providerSessionId = normalizeString(params.readProviderSessionId());
      if (!providerSessionId || !text || !Number.isFinite(submittedAtMs) || submittedAtMs <= 0) return;
      pendingPromptAnchors = [
        ...pendingPromptAnchors,
        {
          providerSessionId,
          submittedAtMs,
          digest: digestPromptText(text),
          text,
        },
      ];
      pendingPromptAnchors = [
        ...prunePendingPromptAnchors(pendingPromptAnchors, submittedAtMs),
      ];
      void persist(providerSessionId);
    },
    async markIfHappierAuthoredProviderUserMessage(input) {
      const messageId = normalizeString(input.messageId);
      if (!messageId) return false;
      if (ids.has(messageId)) return true;
      const providerSessionId = normalizeString(params.readProviderSessionId());
      if (!providerSessionId) return false;
      const text = normalizePromptText(input.text);
      const createdAtMs = Number.isFinite(input.createdAtMs) ? Math.trunc(input.createdAtMs) : NaN;
      if (!text || !Number.isFinite(createdAtMs) || createdAtMs <= 0) return false;
      const digest = digestPromptText(text);
      const matchedAnchor = pendingPromptAnchors
        .map((anchor) => matchPendingPromptAnchor(anchor, {
          providerSessionId,
          text,
          digest,
          createdAtMs,
        }))
        .find((match): match is PendingPromptAnchorMatch => match !== null);
      if (!matchedAnchor) return false;
      ids.add(messageId);
      if (matchedAnchor.consumeAnchor) {
        pendingPromptAnchors = pendingPromptAnchors.filter((anchor) => anchor !== matchedAnchor.anchor);
      }
      await persist(providerSessionId);
      return true;
    },
    async hydrate() {
      ids.clear();
      pendingPromptAnchors = [];
      const providerSessionId = normalizeString(params.readProviderSessionId());
      if (!providerSessionId) return;
      let stored: unknown;
      try {
        stored = await params.ctx.storage.session.get(storageKeyForProviderSession(providerSessionId));
      } catch (error) {
        params.ctx.logger.debug('[OpenCodeServer] failed to read Happier-authored provider user ids', { error });
        return;
      }
      for (const id of readStoredProviderUserMessageIds(stored)) ids.add(id);
      pendingPromptAnchors = [
        ...readStoredPendingPromptAnchors(stored),
      ];
    },
    clearMemory() {
      ids.clear();
      pendingPromptAnchors = [];
    },
  };
}
