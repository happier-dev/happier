import type { PromptPlanV1, SessionPromptPreviewV1Response } from '@happier-dev/protocol';

type ResolvedCodingPromptRecord = Readonly<{
  text: string;
  blocks: readonly Readonly<{ id: string; scope: string; chars: number }>[];
  launchForm: 'fresh' | 'retained';
  providerId: string | null;
}>;

/**
 * The last coding prompt this runner resolved for its provider launch. A session runner process
 * hosts one session and every coding-prompt resolution in it is that session's, so the preview is
 * the actual prompt rather than a reconstruction.
 */
let lastResolved: ResolvedCodingPromptRecord | null = null;

export function recordResolvedCodingPrompt(params: Readonly<{
  plan: PromptPlanV1;
  text: string;
  launchForm: 'fresh' | 'retained';
  providerId?: string | null;
}>): void {
  lastResolved = {
    text: params.text,
    blocks: params.plan.blocks.map((block) => ({ id: block.id, scope: block.scope, chars: block.text.length })),
    launchForm: params.launchForm,
    providerId: params.providerId ?? lastResolved?.providerId ?? null,
  };
}

/** `session.promptPreview.get.v1`, answered by this runner from its own last resolution. */
export function buildSessionPromptPreviewV1(sessionId: string):
  | SessionPromptPreviewV1Response
  | Readonly<{ ok: false; errorCode: 'prompt_not_resolved'; error: string }> {
  if (!lastResolved) {
    return { ok: false, errorCode: 'prompt_not_resolved', error: 'This runner has not resolved a coding prompt yet' };
  }
  const providerNotes: string[] = [];
  if (lastResolved.providerId === 'claude') {
    providerNotes.push('Claude remote launches append this prompt a second time (second rendering).');
  }
  if (lastResolved.launchForm === 'retained') {
    providerNotes.push('Retained form: a resumed or reset provider launch rebuilds from session metadata without account settings.');
  }
  return {
    ok: true,
    sessionId,
    text: lastResolved.text,
    blocks: lastResolved.blocks.map((block) => ({ ...block })),
    launchForm: lastResolved.launchForm,
    providerNotes,
  };
}
