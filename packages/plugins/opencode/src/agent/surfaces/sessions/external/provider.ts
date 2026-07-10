import type {
  ExternalSessionSurfaceV1,
  ExternalSessionTranscriptPageV1,
  RuntimeDescriptorV1,
} from '@happier-dev/plugin-sdk/sessions';

import {
  getOpenCodeExternalSessionActivity as readOpenCodeExternalSessionActivity,
  getOpenCodeExternalSessionWorkingDirectory,
  listOpenCodeSessionCandidates,
} from './candidates.js';
import { validateOpenCodeExternalSessionsSource } from './client.js';
import {
  resolveOpenCodeExternalSessionIdentity,
  resolveOpenCodeLinkedExternalSessionIdentity,
} from './identity.js';
import { pageOpenCodeTranscript } from './pageTranscript.js';
import { readAfterOpenCodeTranscript } from './readAfterTranscript.js';

function ok<T>(value: T) {
  return { ok: true as const, value };
}

function providerError(message: string) {
  return {
    ok: false as const,
    code: 'agent_unavailable' as const,
    message,
    retryable: true,
  };
}

function sourceInvalid(message: string) {
  return {
    ok: false as const,
    code: 'source_invalid' as const,
    message,
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

async function safeTranscriptPage(operation: () => Promise<ExternalSessionTranscriptPageV1>) {
  try {
    return ok(await operation());
  } catch (error) {
    return providerError(error instanceof Error ? error.message : 'OpenCode external-session transcript operation failed');
  }
}

export const openCodeExternalSessionSurface: ExternalSessionSurfaceV1 = {
  resolveSource: async ({ source }) => {
    const validation = validateOpenCodeExternalSessionsSource({ source });
    return validation.ok ? ok({ source: validation.source }) : sourceInvalid(validation.error);
  },
  listCandidates: async ({ source, cursor, limit, searchTerm }) => {
    try {
      return ok(await listOpenCodeSessionCandidates({ source, cursor, limit, searchTerm }));
    } catch (error) {
      return providerError(error instanceof Error ? error.message : 'OpenCode external-session listing failed');
    }
  },
  getActivity: async ({ source, providerSessionId }) => {
    try {
      return ok(await readOpenCodeExternalSessionActivity({ source, providerSessionId }));
    } catch (error) {
      return providerError(error instanceof Error ? error.message : 'OpenCode external-session activity lookup failed');
    }
  },
  pageTranscript: async ({ source, providerSessionId, direction, cursor, maxBytes, maxItems }) =>
    await safeTranscriptPage(async () => await pageOpenCodeTranscript({
      source,
      providerSessionId,
      direction,
      cursor,
      maxBytes,
      maxItems,
    })),
  readAfterTranscript: async ({ source, providerSessionId, cursor, maxBytes, maxItems }) =>
    await safeTranscriptPage(async () => await readAfterOpenCodeTranscript({
      source,
      providerSessionId,
      cursor,
      maxBytes,
      maxItems,
    })),
  resolveLinkIdentity: async ({ providerSessionId, source, runtimeDescriptor, metadata }) => {
    const metadataRuntimeDescriptor = metadata?.runtimeDescriptorV1 as RuntimeDescriptorV1 | undefined;
    return ok(resolveOpenCodeExternalSessionIdentity({
      providerSessionId,
      source,
      runtimeDescriptor: runtimeDescriptor ?? metadataRuntimeDescriptor,
      metadata,
    }));
  },
  resolveLinkedIdentity: async ({ metadata, providerSessionId, source }) =>
    ok(resolveOpenCodeLinkedExternalSessionIdentity({ metadata, providerSessionId, source })),
  resolveTakeoverLaunch: async ({ linkedSessionId, providerSessionId, source }) => {
    const directory = await getOpenCodeExternalSessionWorkingDirectory({ source, providerSessionId });
    if (!directory) {
      return {
        ok: false as const,
        code: 'takeover_not_available' as const,
        message: 'OpenCode external-session takeover requires a working directory.',
      };
    }
    const baseUrl =
      source.kind === 'opencodeServer' && typeof source.baseUrl === 'string'
        ? source.baseUrl.trim()
        : '';
    return ok({
      providerSessionId,
      source,
      launch: {
        directory,
        environmentVariables: mergeExternalSessionEnvironmentVariables([
          {
            HAPPIER_OPENCODE_BACKEND_MODE: 'server',
            ...(baseUrl ? { HAPPIER_OPENCODE_SERVER_URL: baseUrl } : {}),
            ...(baseUrl ? { HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1' } : {}),
            HAPPIER_OPENCODE_LINKED_SESSION_ID: linkedSessionId,
          },
        ]),
      },
    });
  },
};

export const resolveOpenCodeExternalSessionSource = openCodeExternalSessionSurface.resolveSource;
export const listOpenCodeExternalSessionCandidates = openCodeExternalSessionSurface.listCandidates;
export const getOpenCodeExternalSessionActivity = openCodeExternalSessionSurface.getActivity;
export const pageOpenCodeExternalSessionTranscript = openCodeExternalSessionSurface.pageTranscript;
export const readOpenCodeExternalSessionAfterTranscript = openCodeExternalSessionSurface.readAfterTranscript;
export const resolveOpenCodeExternalSessionLinkIdentity = openCodeExternalSessionSurface.resolveLinkIdentity;
export const resolveLinkedOpenCodeExternalSessionIdentity = openCodeExternalSessionSurface.resolveLinkedIdentity;
export const resolveOpenCodeExternalSessionTakeoverLaunch = openCodeExternalSessionSurface.resolveTakeoverLaunch;
