import { randomUUID } from 'node:crypto';
import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import type { ToolNormalizationSourceV3 } from '@happier-dev/protocol/tools/v2/meta';
import type { ExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import type { ExecutionRunLaunchOrigin } from '@happier-dev/protocol';
import { EXECUTION_RUN_KIND_BY_INTENT } from '@happier-dev/protocol/execution/runs/startRequest';

/** Explicit Session starts retain one way back to their Run even when its profile keeps the sidechain private. */
export function shouldPublishExecutionRunTranscriptMarker(
  profile: Pick<ExecutionRunIntentProfile, 'transcriptMaterialization'>,
  input: Readonly<{ sessionId: string | null; launchOrigin?: ExecutionRunLaunchOrigin }>,
): boolean {
  return input.sessionId !== null
    && (profile.transcriptMaterialization === 'full' || input.launchOrigin?.kind === 'session');
}

export type ExecutionRunTranscriptPublisher = (
  provider: ACPProvider,
  body: ACPMessageData,
  opts?: { meta?: Record<string, unknown>; toolNormalizationSource?: ToolNormalizationSourceV3 },
) => Promise<void>;

/** Commits Run observations through their parent Session's existing custody boundary. */
export function createCommittedExecutionRunTranscriptPublisher(params: Readonly<{
  enqueueAgentMessageCommitted: NonNullable<TranscriptSessionPort['enqueueAgentMessageCommitted']>;
  readParentToolNormalizationSource: () => ToolNormalizationSourceV3 | null;
}>): ExecutionRunTranscriptPublisher {
  return async (provider, body, opts) => {
    const localId = 'id' in body && typeof body.id === 'string' ? body.id : randomUUID();
    const toolNormalizationSource = opts?.toolNormalizationSource ?? params.readParentToolNormalizationSource();
    let meta = opts?.meta;
    const envelope = meta?.happier;
    if (body.type === 'tool-result' && envelope && typeof envelope === 'object' && !Array.isArray(envelope)) {
      const happier = envelope as Record<string, unknown>;
      if (happier.kind === EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary
        && happier.payload !== undefined
        && (happier.payload === body.output || JSON.stringify(happier.payload) === JSON.stringify(body.output))) {
        // The result body owns the captured comparison; retain its structured renderer marker.
        const marker = { ...happier };
        delete marker.payload;
        meta = { ...meta, happier: marker };
      }
    }
    const admission = await params.enqueueAgentMessageCommitted(provider, body, {
      localId,
      ...(toolNormalizationSource ? { toolNormalizationSource } : {}),
      ...(meta ? { meta } : {}),
      provenance: { kind: 'non_dependent', source: 'sidechain' },
    });
    if (!admission.persisted) throw createExecutionRunTranscriptCustodyError();
  };
}

export function createExecutionRunTranscriptCustodyError(): Error & { code: string } {
  return Object.assign(
    new Error('Stable execution-run transcript fact was not admitted to durable custody'),
    { code: 'execution_run_transcript_custody_unavailable' },
  );
}

export function isExecutionRunTranscriptCustodyError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'execution_run_transcript_custody_unavailable',
  );
}
