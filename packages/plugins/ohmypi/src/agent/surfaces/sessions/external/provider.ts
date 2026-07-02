import { stat } from 'node:fs/promises';

import type {
  ExternalSessionFailureCodeV1,
  ExternalSessionResolvedIdentityV1,
  ExternalSessionSurfaceV1,
  ExternalSessionTranscriptPageV1,
  SessionStateUpdateV1,
} from '@happier-dev/agents';
import type { ExternalSessionsSource, RuntimeDescriptorV1 } from '@happier-dev/protocol';

import { listOhMyPiSessionCandidates as listOhMyPiJsonlSessionCandidates } from './candidates.js';
import { resolveOhMyPiSessionFile } from './files.js';
import {
  acquireOhMyPiSessionFollowLease,
  pageOhMyPiSessionTranscript,
  readAfterOhMyPiSessionTranscript,
} from './transcript.js';
import {
  resolveConfiguredOhMyPiAgentDir,
  resolveOhMyPiAgentDir,
  validateOhMyPiExternalSessionSource,
} from './source.js';
import { readOhMyPiSessionSnapshot } from '../../../transcripts/snapshot.js';

function ok<T>(value: T) {
  return { ok: true as const, value };
}

function failed(code: ExternalSessionFailureCodeV1, message: string, retryable?: boolean) {
  return {
    ok: false as const,
    code,
    message,
    ...(typeof retryable === 'boolean' ? { retryable } : {}),
  };
}

function providerUnavailable(message: string) {
  return failed('provider_unavailable', message, true);
}

function buildProviderSessionIdUpdate(providerSessionId: string): SessionStateUpdateV1<'identity.providerSessionId'> {
  return {
    fieldId: 'identity.providerSessionId',
    value: providerSessionId,
  };
}

function mergeExternalSessionEnvironmentVariables(values: Array<Record<string, string> | null>): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  for (const value of values) {
    for (const [key, raw] of Object.entries(value ?? {})) {
      const normalized = String(raw ?? '').trim();
      if (!normalized) continue;
      merged[key] = normalized;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function resolveMetadataDirectory(metadata: Readonly<Record<string, unknown>>): string | null {
  const keys = ['path', 'directory', 'workingDirectory', 'cwd'];
  for (const key of keys) {
    const value = metadata[key];
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized) return normalized;
  }
  return null;
}

function resolveOhMyPiExternalSessionIdentity(params: Readonly<{
  providerSessionId: string;
  source: ExternalSessionsSource;
  runtimeDescriptor?: RuntimeDescriptorV1 | null;
}>): ExternalSessionResolvedIdentityV1 {
  const sessionStateUpdates = [buildProviderSessionIdUpdate(params.providerSessionId)];
  const metadataPatch = { ohMyPiSessionId: params.providerSessionId };
  return {
    providerSessionId: params.providerSessionId,
    source: params.source,
    runtimeDescriptor: params.runtimeDescriptor ?? null,
    vendorMetadata: metadataPatch,
    externalSessionMetadata: metadataPatch,
    sessionStateUpdates,
  };
}

async function safeTranscriptPage(operation: () => Promise<ExternalSessionTranscriptPageV1>) {
  try {
    return ok(await operation());
  } catch (error) {
    return providerUnavailable(error instanceof Error ? error.message : 'OhMyPi external-session transcript operation failed');
  }
}

export function createOhMyPiExternalSessionSurface(params: Readonly<{
  env?: NodeJS.ProcessEnv;
}> = {}): ExternalSessionSurfaceV1 {
  const env = params.env ?? process.env;
  const validateSourceForOperation = (source: ExternalSessionsSource) => {
    const validation = validateOhMyPiExternalSessionSource({ source, env });
    return validation.ok
      ? { ok: true as const, source: validation.source }
      : failed('source_invalid', validation.error);
  };

  const surface: ExternalSessionSurfaceV1 = {
    resolveSource: ({ source }) => {
      const validation = validateOhMyPiExternalSessionSource({ source, env });
      return validation.ok ? ok({ source: validation.source }) : failed('source_invalid', validation.error);
    },
    listCandidates: async ({ source, cursor, limit, searchTerm }) => {
      const validation = validateSourceForOperation(source);
      if (!validation.ok) return validation;
      try {
        return ok(await listOhMyPiJsonlSessionCandidates({
          source: validation.source,
          env,
          cursor,
          limit,
          searchTerm,
        }));
      } catch (error) {
        return providerUnavailable(error instanceof Error ? error.message : 'OhMyPi external-session listing failed');
      }
    },
    getActivity: async ({ source, providerSessionId }) => {
      const validation = validateSourceForOperation(source);
      if (!validation.ok) return validation;
      const resolved = await resolveOhMyPiSessionFile({
        source: validation.source,
        env,
        remoteSessionId: providerSessionId,
      });
      if (!resolved) return ok({ lastActivityAtMs: null, isRunning: false });
      try {
        const file = await stat(resolved.filePath);
        return ok({
          lastActivityAtMs: file.isFile() ? Math.trunc(file.mtimeMs) : null,
          isRunning: false,
        });
      } catch {
        return ok({ lastActivityAtMs: null, isRunning: false });
      }
    },
    pageTranscript: async ({ source, providerSessionId, direction, cursor, maxBytes, maxItems }) => {
      const validation = validateSourceForOperation(source);
      if (!validation.ok) return validation;
      return await safeTranscriptPage(async () => await pageOhMyPiSessionTranscript({
        source: validation.source,
        env,
        providerSessionId,
        direction,
        cursor,
        maxBytes,
        maxItems,
      }));
    },
    readAfterTranscript: async ({ source, providerSessionId, cursor, maxBytes, maxItems }) => {
      const validation = validateSourceForOperation(source);
      if (!validation.ok) return validation;
      return await safeTranscriptPage(async () => await readAfterOhMyPiSessionTranscript({
        source: validation.source,
        env,
        providerSessionId,
        cursor,
        maxBytes,
        maxItems,
      }));
    },
    resolveFollowTranscriptPath: async ({ source, providerSessionId }) => {
      const validation = validateSourceForOperation(source);
      if (!validation.ok) return validation;
      const resolved = await resolveOhMyPiSessionFile({
        source: validation.source,
        env,
        remoteSessionId: providerSessionId,
      });
      return resolved
        ? ok({ path: resolved.filePath, sourceId: providerSessionId })
        : failed('follow_not_supported', 'OhMyPi external-session transcript file is unavailable.');
    },
    acquireFollowLease: async ({ source, providerSessionId, runtime }) => {
      const validation = validateSourceForOperation(source);
      if (!validation.ok) return validation;
      try {
        const lease = await acquireOhMyPiSessionFollowLease({
          source: validation.source,
          env,
          providerSessionId,
          runtime,
        });
        return lease
          ? ok(lease)
          : failed('follow_not_supported', 'OhMyPi external-session file-follow is unavailable.');
      } catch (error) {
        return providerUnavailable(error instanceof Error ? error.message : 'OhMyPi external-session file-follow failed');
      }
    },
    resolveLinkIdentity: ({ providerSessionId, source, runtimeDescriptor, metadata }) => {
      const validation = validateSourceForOperation(source);
      if (!validation.ok) return validation;
      const metadataRuntimeDescriptor = metadata?.runtimeDescriptorV1 as RuntimeDescriptorV1 | undefined;
      return ok(resolveOhMyPiExternalSessionIdentity({
        providerSessionId,
        source: validation.source,
        runtimeDescriptor: runtimeDescriptor ?? metadataRuntimeDescriptor ?? null,
      }));
    },
    resolveLinkedIdentity: ({ metadata, providerSessionId, source }) => {
      if (source.kind !== 'ohMyPiAgentDir') {
        return failed('source_invalid', 'provider/source mismatch');
      }
      const canonicalSource = {
        ...source,
        agentDir: resolveConfiguredOhMyPiAgentDir(env),
      };
      return ok({
        ...resolveOhMyPiExternalSessionIdentity({
          providerSessionId,
          source: canonicalSource,
          runtimeDescriptor: null,
        }),
        externalSessionMetadata: {
          ...metadata,
          ohMyPiSessionId: providerSessionId,
        },
      });
    },
    resolveTakeoverLaunch: async ({ providerSessionId, source, metadata }) => {
      const validation = validateSourceForOperation(source);
      if (!validation.ok) return validation;
      const agentDir = resolveOhMyPiAgentDir({ source: validation.source, env });
      const resolved = await resolveOhMyPiSessionFile({
        source: validation.source,
        env,
        remoteSessionId: providerSessionId,
      });
      const directory = resolveMetadataDirectory(metadata) ?? (
        resolved
          ? (await readOhMyPiSessionSnapshot({
            sessionFilePath: resolved.filePath,
            sessionId: providerSessionId,
          })).workingDirectory
          : null
      );
      if (!directory) {
        return failed('takeover_not_available', 'OhMyPi external-session takeover requires a working directory.');
      }
      return ok({
        providerSessionId,
        source: validation.source,
        launch: {
          directory,
          environmentVariables: mergeExternalSessionEnvironmentVariables([
            { PI_CODING_AGENT_DIR: agentDir },
          ]),
          sessionStateUpdates: [buildProviderSessionIdUpdate(providerSessionId)],
        },
      });
    },
  };
  return surface;
}

export const ohMyPiExternalSessionSurface = createOhMyPiExternalSessionSurface();
export const resolveOhMyPiExternalSessionSource = ohMyPiExternalSessionSurface.resolveSource;
export const listOhMyPiExternalSessionCandidates = ohMyPiExternalSessionSurface.listCandidates;
export const getOhMyPiExternalSessionActivity = ohMyPiExternalSessionSurface.getActivity;
export const pageOhMyPiExternalSessionTranscript = ohMyPiExternalSessionSurface.pageTranscript;
export const readOhMyPiExternalSessionAfterTranscript = ohMyPiExternalSessionSurface.readAfterTranscript;
export const resolveOhMyPiExternalSessionFollowTranscriptPath = ohMyPiExternalSessionSurface.resolveFollowTranscriptPath;
export const acquireOhMyPiExternalSessionFollowLease = ohMyPiExternalSessionSurface.acquireFollowLease;
export const resolveOhMyPiExternalSessionLinkIdentity = ohMyPiExternalSessionSurface.resolveLinkIdentity;
export const resolveLinkedOhMyPiExternalSessionIdentity = ohMyPiExternalSessionSurface.resolveLinkedIdentity;
export const resolveOhMyPiExternalSessionTakeoverLaunch = ohMyPiExternalSessionSurface.resolveTakeoverLaunch;
