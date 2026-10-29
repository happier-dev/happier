import { isRecord } from '@happier-dev/plugin-sdk';
import { expandHomePath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';
import { readSessionInputPromptUserTextV1, type AgentExternalSessionCandidate,
  type AgentExternalSessionsInvocation } from '@happier-dev/plugin-sdk/sessions/external';

import { resolveCodexRuntimeHomeEnvironment } from '../../../auth/services/state/sharing/files.js';
import { homeEntries } from '../../../rollout/discovery/homeEntries.js';
import { createCodexNativeAppServerClient } from '../../../runtime/appServer/client.js';
import { readExactCodexProviderSessionId } from '../../../../protocol/runtimeDescriptorV1.js';
import { throwIfCodexExternalSessionInvocationStopped } from './invocationBounds.js';
import { assertCodexNativeProxyAvailable } from './nativeProxy.js';
import type { CodexExternalSessionSource } from './models.js';

/** Native name precedence is shared by discovery and selected-page hydration. */
export function readCodexNativeCandidateTitle(thread: unknown): string | undefined {
  if (!isRecord(thread)) return undefined;
  if (typeof thread.name === 'string' && thread.name.trim()) return thread.name.trim();
  if (typeof thread.preview !== 'string' || !thread.preview.trim()) return undefined;
  return readSessionInputPromptUserTextV1(thread.preview).replace(/\s+/g, ' ').trim() || undefined;
}

function reportNativeMetadataFailure(error: unknown, stage: 'connect' | 'read' | 'dispose'): void {
  // Default-on signal, without native text, paths, names or exception messages.
  const record = isRecord(error) ? error : null;
  const code = typeof record?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(record.code) ? record.code : undefined;
  console.warn('[codex] Native candidate metadata unavailable', {
    stage, errorClass: error instanceof TypeError ? 'TypeError' : error instanceof RangeError ? 'RangeError' : error instanceof Error ? 'Error' : 'Unknown', ...(code ? { code } : {}),
  });
}

/**
 * Browse owns the selected rows; Codex owns their fresh native names. One control-socket connection
 * serves the selected page and ends with the invocation. Native failures retain
 * the supplied rollout presentation rather than a previous native snapshot.
 */
export async function hydrateCodexCandidateMetadata(params: Readonly<{
  source: CodexExternalSessionSource;
  env: NodeJS.ProcessEnv;
  candidates: readonly AgentExternalSessionCandidate[];
  invocation: AgentExternalSessionsInvocation;
}>): Promise<readonly AgentExternalSessionCandidate[]> {
  const bounds = params.invocation;
  throwIfCodexExternalSessionInvocationStopped(bounds);
  if (params.candidates.length === 0) return params.candidates;
  let client: Awaited<ReturnType<typeof createCodexNativeAppServerClient>> | undefined;
  try {
    // Host source admission supplies one exact native home; use its existing
    // resolver and shared-state affinity, never a candidate-carried path.
    const [home] = await homeEntries({ source: params.source, env: params.env,
      signal: bounds.signal, deadlineAtMs: bounds.deadlineAtMs });
    if (!home) {
      reportNativeMetadataFailure(new Error('Admitted native home unavailable'), 'connect');
      return params.candidates;
    }
    const sourceEnvironment = { ...process.env, ...params.env };
    const processEnv = { ...sourceEnvironment, ...await resolveCodexRuntimeHomeEnvironment({
      env: sourceEnvironment, codexHome: home.codexHome, home: home.source.home, cwd: process.cwd(),
      expandHomePath: value => expandHomePath(value, resolveHomeDirFromEnvironment(sourceEnvironment)),
    }) };
    await assertCodexNativeProxyAvailable(processEnv, bounds.signal);
    client = await createCodexNativeAppServerClient({ exec: bounds.exec, logger: bounds.logger,
      processEnv, signal: bounds.signal, transport: { kind: 'daemonProxy' },
      initializeRequestOptions: { signal: bounds.signal, timeoutMs: null } });
    const candidates: AgentExternalSessionCandidate[] = [];
    for (const candidate of params.candidates) {
      throwIfCodexExternalSessionInvocationStopped(bounds);
      try {
        const result = await client.request('thread/read', {
          threadId: candidate.remoteSessionId, includeTurns: false,
        }, { signal: bounds.signal, timeoutMs: null });
        throwIfCodexExternalSessionInvocationStopped(bounds);
        const thread = isRecord(result) && isRecord(result.thread) ? result.thread : null;
        if (!thread || readExactCodexProviderSessionId(thread.id) !== candidate.remoteSessionId) {
          throw new Error('Codex native thread metadata identity mismatch');
        }
        const title = readCodexNativeCandidateTitle(thread);
        candidates.push(title ? { ...candidate, title } : candidate);
      } catch (error) {
        throwIfCodexExternalSessionInvocationStopped(bounds);
        reportNativeMetadataFailure(error, 'read');
        candidates.push(candidate);
      }
    }
    return candidates;
  } catch (error) {
    throwIfCodexExternalSessionInvocationStopped(bounds);
    reportNativeMetadataFailure(error, 'connect');
    return params.candidates;
  } finally {
    if (client) {
      try { await client.dispose(); }
      catch (error) { reportNativeMetadataFailure(error, 'dispose'); }
    }
  }
}
