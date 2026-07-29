import type { ExecutionRunReplaySeedRequest } from '@happier-dev/protocol';
import type { ExecutionRunIntentProfile } from '../ExecutionRunIntentProfile';
import { configuration } from '@/configuration';
import { readCredentials } from '@/persistence';
import { resolveReplaySeedDraft } from '@/session/replay/resolveReplaySeedDraft';

function isVoiceSessionReplay(value: unknown): value is ExecutionRunReplaySeedRequest {
  return Boolean(
    value
    && typeof value === 'object'
    && 'kind' in value
    && value.kind === 'voice_session.v1',
  );
}

export const VoiceAgentProfile: ExecutionRunIntentProfile = {
  intent: 'voice_agent',
  transcriptMaterialization: 'none',
  buildPrompt: (params) => params.instructions,
  prepareStartParams: async ({ request, cwd }) => {
    if (!isVoiceSessionReplay(request.replay)) {
      return undefined;
    }
    const replay = request.replay;

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
      return undefined;
    }

    const replayStrategy =
      replay.strategy === 'summary_plus_recent' ? 'summary_plus_recent' : 'recent_messages';
    const replaySeed = await resolveReplaySeedDraft({
      credentials,
      cwd,
      source: {
        kind: 'voice_session.v1',
        previousSessionId: replay.previousSessionId,
        transcriptEpoch: replay.transcriptEpoch,
      },
      strategy: replayStrategy,
      recentMessagesCount: replay.recentMessagesCount ?? 16,
      maxSeedChars:
        typeof replay.maxSeedChars === 'number'
          ? replay.maxSeedChars
          : configuration.replaySeedMaxChars,
      candidateLimit: configuration.replaySeedCandidateLimit,
      summaryRunner: replay.summaryRunner ?? null,
    }).catch(() => null);

    if (!replaySeed?.seedDraft) {
      return undefined;
    }

    const initialContext = [String(request.initialContext ?? '').trim(), replaySeed.seedDraft]
      .filter((value) => value.length > 0)
      .join('\n\n');

    return {
      initialContext,
      ...(
        request.bootstrapMode === 'ready_handshake'
        && typeof request.initialContextMode !== 'string'
          ? { initialContextMode: 'first_turn' as const }
          : {}
      ),
    };
  },
  computeSidechainStreamText: ({ fullText }) => fullText,
  listAvailableActionIds: ({ controllerKind }) =>
    controllerKind === 'voice_agent'
      ? ['voice_agent.welcome', 'voice_agent.commit']
      : [],
  onBoundedComplete: ({ start, rawText, finishedAtMs }) => {
    const summary = rawText.trim().length > 0 ? rawText.trim() : 'Voice agent completed.';
    return {
      status: 'succeeded',
      summary,
      toolResultOutput: {
        status: 'succeeded',
        summary,
        runId: start.runId,
        callId: start.callId,
        sidechainId: start.sidechainId,
        backendId: start.backendId,
        intent: start.intent,
        startedAtMs: start.startedAtMs,
        finishedAtMs,
      },
    };
  },
};
