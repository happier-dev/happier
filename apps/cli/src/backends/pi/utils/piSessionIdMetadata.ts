import type { Metadata } from '@/api/types';
import {
  buildPiAgentRuntimeDescriptorV1,
  readAgentRuntimeDescriptorV1ForProvider,
} from '@happier-dev/protocol';
import { basename, isAbsolute } from 'node:path';

import {
  buildPiResumeSearchRoots,
  doesPiSessionFileNameMatchSessionId,
  findPiSessionFileForId,
  pathExistsAsFile,
  resolvePiSessionIdFromResumeReference,
} from '@/backends/pi/utils/piSessionFiles';

function normalizeOptionalAbsolutePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return isAbsolute(trimmed) ? trimmed : null;
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

type PiSessionIdMetadataLastPublishedState = {
  value: string | null;
  sessionFile?: string | null;
};

const PI_SESSION_FILE_RESOLVE_RETRY_DELAYS_MS = [0, 250, 1_000, 2_500] as const;

function readPiResumeSessionFileSurfaces(
  metadata: Metadata,
  vendorSessionId: string,
): Readonly<{
  coherent: boolean;
  sessionFile: string | null;
  metadataHasSessionFile: boolean;
  descriptorHasSessionFile: boolean;
}> {
  const metadataHasSessionFile = Object.prototype.hasOwnProperty.call(metadata, 'piSessionFile');
  const metadataSessionFile = normalizeOptionalAbsolutePath(
    (metadata as Metadata & { piSessionFile?: unknown }).piSessionFile,
  );
  if (metadataHasSessionFile && metadataSessionFile === null) {
    return { coherent: false, sessionFile: null, metadataHasSessionFile, descriptorHasSessionFile: false };
  }

  const descriptor = readAgentRuntimeDescriptorV1ForProvider(metadata.agentRuntimeDescriptorV1, 'pi');
  const descriptorOwnsResumeIdentity = Boolean(
    descriptor
    && descriptor.provider.resumeStrategy === 'sessionFileAbsolutePreferred'
    && normalizeOptionalString(descriptor.provider.vendorSessionId) === vendorSessionId,
  );
  const descriptorHasSessionFile = descriptorOwnsResumeIdentity
    && Object.prototype.hasOwnProperty.call(descriptor?.provider, 'sessionFile');
  const descriptorSessionFile = descriptorOwnsResumeIdentity
    ? normalizeOptionalAbsolutePath(descriptor?.provider.sessionFile)
    : null;
  if (descriptorHasSessionFile && descriptorSessionFile === null) {
    return { coherent: false, sessionFile: null, metadataHasSessionFile, descriptorHasSessionFile };
  }
  if (metadataSessionFile && descriptorSessionFile && metadataSessionFile !== descriptorSessionFile) {
    return { coherent: false, sessionFile: null, metadataHasSessionFile, descriptorHasSessionFile };
  }

  return {
    coherent: true,
    sessionFile: metadataSessionFile ?? descriptorSessionFile,
    metadataHasSessionFile,
    descriptorHasSessionFile,
  };
}

function readDurablePiResumeIdentity(
  metadata: Metadata | null | undefined,
  vendorSessionId: string,
): Readonly<{ sessionFile: string | null }> | null {
  if (!metadata || normalizeOptionalString(metadata.piSessionId) !== vendorSessionId) return null;

  const descriptor = readAgentRuntimeDescriptorV1ForProvider(metadata.agentRuntimeDescriptorV1, 'pi');
  if (
    !descriptor
    || descriptor.provider.resumeStrategy !== 'sessionFileAbsolutePreferred'
    || normalizeOptionalString(descriptor.provider.vendorSessionId) !== vendorSessionId
  ) {
    return null;
  }

  const sessionFileSurfaces = readPiResumeSessionFileSurfaces(metadata, vendorSessionId);
  if (
    !sessionFileSurfaces.coherent
    || sessionFileSurfaces.metadataHasSessionFile !== sessionFileSurfaces.descriptorHasSessionFile
  ) {
    return null;
  }

  return { sessionFile: sessionFileSurfaces.sessionFile };
}

export async function maybeUpdatePiSessionIdMetadata(params: {
  getPiSessionId: () => string | null;
  getPiSessionFile: () => string | null;
  updateHappySessionMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
  lastPublished: PiSessionIdMetadataLastPublishedState;
}): Promise<void> {
  const raw = params.getPiSessionId();
  const next = typeof raw === 'string' ? raw.trim() : '';
  const nextSessionFile = normalizeOptionalAbsolutePath(params.getPiSessionFile());
  if (!next) return;

  const lastPublishedSessionFile = normalizeOptionalAbsolutePath(params.lastPublished.sessionFile);
  if (params.lastPublished.value === next && lastPublishedSessionFile === nextSessionFile) return;

  await params.updateHappySessionMetadata((metadata) => {
    const nextMetadata = {
      ...metadata,
      piSessionId: next,
      agentRuntimeDescriptorV1: buildPiAgentRuntimeDescriptorV1({
        resumeStrategy: 'sessionFileAbsolutePreferred',
        vendorSessionId: next,
        ...(nextSessionFile ? { sessionFile: nextSessionFile } : {}),
      }),
    };

    if (nextSessionFile) {
      return {
        ...nextMetadata,
        piSessionFile: nextSessionFile,
      };
    }

    const withoutSessionFile = { ...nextMetadata } as Metadata & { piSessionFile?: string };
    delete withoutSessionFile.piSessionFile;
    return withoutSessionFile;
  });
  params.lastPublished.value = next;
  params.lastPublished.sessionFile = nextSessionFile;
}

export async function resolvePiSessionFileForRuntimeSession(params: Readonly<{
  vendorSessionReference: string | null;
  cwd: string;
  processEnv?: NodeJS.ProcessEnv;
  candidatePersistedSessionFile?: string | null;
}>): Promise<string | null> {
  const vendorSessionReference = normalizeOptionalString(params.vendorSessionReference);
  const candidatePersistedSessionFile = normalizeOptionalAbsolutePath(params.candidatePersistedSessionFile);

  if (vendorSessionReference && isAbsolute(vendorSessionReference) && await pathExistsAsFile(vendorSessionReference)) {
    return vendorSessionReference;
  }

  const sessionId = resolvePiSessionIdFromResumeReference(vendorSessionReference ?? '');
  if (!sessionId) {
    return null;
  }

  if (
    candidatePersistedSessionFile &&
    doesPiSessionFileNameMatchSessionId(basename(candidatePersistedSessionFile), sessionId) &&
    await pathExistsAsFile(candidatePersistedSessionFile)
  ) {
    return candidatePersistedSessionFile;
  }

  const roots = buildPiResumeSearchRoots({
    cwd: params.cwd,
    env: params.processEnv ?? process.env,
    candidatePersistedSessionFile,
  });
  return await findPiSessionFileForId({ sessionId, roots });
}

export async function publishPiSessionIdMetadata(params: Readonly<{
  operation: 'create' | 'resume';
  session: Readonly<{
    updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
    getMetadataSnapshot?: () => Metadata | null;
  }>;
  getPiSessionId: () => string | null;
  cwd: string;
  processEnv?: NodeJS.ProcessEnv;
  lastPublished: PiSessionIdMetadataLastPublishedState;
}>): Promise<void> {
  const currentSessionReference = normalizeOptionalString(params.getPiSessionId());
  const metadataSnapshot = params.operation === 'resume'
    ? params.session.getMetadataSnapshot?.()
    : null;

  const candidateDurableResumeIdentity = currentSessionReference && params.operation === 'resume'
    ? readDurablePiResumeIdentity(metadataSnapshot, currentSessionReference)
    : null;
  const durableResumeSessionId = currentSessionReference
    ? resolvePiSessionIdFromResumeReference(currentSessionReference)
    : null;
  const durableResumeIdentity = candidateDurableResumeIdentity
    && (
      candidateDurableResumeIdentity.sessionFile === null
      || (
        durableResumeSessionId !== null
        && doesPiSessionFileNameMatchSessionId(
          basename(candidateDurableResumeIdentity.sessionFile),
          durableResumeSessionId,
        )
        && await pathExistsAsFile(candidateDurableResumeIdentity.sessionFile)
      )
    )
    ? candidateDurableResumeIdentity
    : null;
  if (currentSessionReference && durableResumeIdentity) {
    params.lastPublished.value = currentSessionReference;
    params.lastPublished.sessionFile = durableResumeIdentity.sessionFile;
  } else {
    const persistedSessionFileSurfaces = currentSessionReference && metadataSnapshot
      ? readPiResumeSessionFileSurfaces(metadataSnapshot, currentSessionReference)
      : null;
    const persistedResumeSessionFile = currentSessionReference && params.operation === 'resume'
      ? await resolvePiSessionFileForRuntimeSession({
        vendorSessionReference: currentSessionReference,
        cwd: params.cwd,
        processEnv: params.processEnv,
        candidatePersistedSessionFile: persistedSessionFileSurfaces?.coherent
          ? persistedSessionFileSurfaces.sessionFile
          : null,
      })
      : null;
    await maybeUpdatePiSessionIdMetadata({
      getPiSessionId: () => currentSessionReference,
      getPiSessionFile: () => persistedResumeSessionFile,
      updateHappySessionMetadata: (updater) => params.session.updateMetadata(updater),
      lastPublished: params.lastPublished,
    });
  }

  if (!currentSessionReference) return;

  const scheduleResolveAttempt = (attemptIndex: number): void => {
    const delayMs = PI_SESSION_FILE_RESOLVE_RETRY_DELAYS_MS[attemptIndex];
    if (delayMs === undefined) return;

    const runAttempt = () => {
      if (params.lastPublished.value !== currentSessionReference) return;

      const metadataSnapshot = params.session.getMetadataSnapshot?.();
      const candidatePersistedSessionFile = normalizeOptionalAbsolutePath(
        (metadataSnapshot as (Metadata & { piSessionFile?: string }) | null | undefined)?.piSessionFile,
      );

      void resolvePiSessionFileForRuntimeSession({
        vendorSessionReference: currentSessionReference,
        cwd: params.cwd,
        processEnv: params.processEnv,
        candidatePersistedSessionFile,
      }).then((resolvedSessionFile) => {
        if (resolvedSessionFile) {
          if (params.lastPublished.value !== currentSessionReference) return;
          void maybeUpdatePiSessionIdMetadata({
            getPiSessionId: () => currentSessionReference,
            getPiSessionFile: () => resolvedSessionFile,
            updateHappySessionMetadata: (updater) => params.session.updateMetadata(updater),
            lastPublished: params.lastPublished,
          }).catch(() => {
            scheduleResolveAttempt(attemptIndex + 1);
          });
          return;
        }

        scheduleResolveAttempt(attemptIndex + 1);
      }).catch(() => {
        // Best-effort: missing/removed session files should not fail ACP runtime startup.
        scheduleResolveAttempt(attemptIndex + 1);
      });
    };

    if (delayMs <= 0) {
      runAttempt();
      return;
    }

    const timeout = setTimeout(runAttempt, delayMs);
    timeout.unref?.();
  };

  scheduleResolveAttempt(0);
}
