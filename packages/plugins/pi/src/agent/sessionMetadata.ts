import { isAbsolute } from 'node:path';

import { applyRuntimeDescriptorSessionMetadata } from '@happier-dev/plugin-sdk/sessions';

import {
  buildPiAgentRuntimeDescriptorV1,
  type PiAgentRuntimeDescriptorV1,
} from '../protocol/runtimeDescriptorV1.js';

export type PiSessionMetadataRecord = Readonly<Record<string, unknown>>;

export type PublishedPiSessionMetadata = Readonly<{
  sessionId: string;
  sessionFile: string | null;
}>;

export type PiSessionMetadataPublisher<TMetadata extends Record<string, unknown>> = (
  updater: (metadata: TMetadata) => TMetadata,
) => Promise<void> | void;

function normalizeOptionalAbsolutePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return isAbsolute(trimmed) ? trimmed : null;
}

function shouldSkipPublication(
  previous: PublishedPiSessionMetadata | null,
  next: PublishedPiSessionMetadata,
): boolean {
  if (previous?.sessionId !== next.sessionId) return false;
  if (next.sessionFile === null) return true;
  return previous.sessionFile === next.sessionFile;
}

function buildPiSessionMetadata<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  params: Readonly<{
    sessionId: string;
    sessionFile: string | null;
    descriptor: PiAgentRuntimeDescriptorV1;
  }>,
): TMetadata {
  const next = applyRuntimeDescriptorSessionMetadata({
    ...metadata,
    piSessionId: params.sessionId,
  }, params.descriptor) as TMetadata & {
    piSessionId: string;
    piSessionFile?: string;
  };
  if (params.sessionFile === null) {
    delete next.piSessionFile;
  } else {
    next.piSessionFile = params.sessionFile;
  }
  return next;
}

export function maybeUpdatePiSessionIdMetadata<TMetadata extends Record<string, unknown>>(params: {
  getPiSessionId: () => string | null;
  getPiSessionFile: () => string | null;
  updateHappySessionMetadata: PiSessionMetadataPublisher<TMetadata>;
  lastPublished: { value: PublishedPiSessionMetadata | null };
}): void {
  const raw = params.getPiSessionId();
  const nextSessionId = typeof raw === 'string' ? raw.trim() : '';
  if (!nextSessionId) return;

  const nextSessionFile = normalizeOptionalAbsolutePath(params.getPiSessionFile());
  const nextPublished = { sessionId: nextSessionId, sessionFile: nextSessionFile };
  if (shouldSkipPublication(params.lastPublished.value, nextPublished)) return;

  const prev = params.lastPublished.value;
  params.lastPublished.value = nextPublished;

  const descriptor = buildPiAgentRuntimeDescriptorV1({
    resumeStrategy: 'sessionFileAbsolutePreferred',
    providerSessionId: nextSessionId,
    ...(nextSessionFile ? { sessionFile: nextSessionFile } : {}),
  });

  try {
    const res = params.updateHappySessionMetadata((metadata) => buildPiSessionMetadata(metadata, {
      sessionId: nextSessionId,
      sessionFile: nextSessionFile,
      descriptor,
    }));
    void Promise.resolve(res).catch(() => {
      if (params.lastPublished.value === nextPublished) {
        params.lastPublished.value = prev;
      }
    });
  } catch {
    if (params.lastPublished.value === nextPublished) {
      params.lastPublished.value = prev;
    }
  }
}
