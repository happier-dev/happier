import { readSessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';

import { resolveTranscriptToolVisibility } from '@/components/sessions/transcript/resolveTranscriptToolVisibility';
import type { TranslationKeyNoParams } from '@/text';

import type { SessionActionTarget } from './sessionActionTypes';

export type SessionToolCallsMenuState = Readonly<{
  /** What the transcript shows now: the same precedence the transcript owner applies. */
  showToolCalls: boolean;
  /** The Session's own explicit choice; `null` follows the Bot/Account default. */
  override: boolean | null;
  /** The row's description: the state, never a restatement of the title. */
  subtitleKey: TranslationKeyNoParams;
}>;

/**
 * The Show tool calls menu row of one Session (60s4, lab `b-tools M/Mo`, `b-promote A`): checked from the
 * effective visibility, described by where that visibility comes from, and Use default offered only while
 * the Session carries its own choice. Precedence stays with `resolveTranscriptToolVisibility`.
 */
export function resolveSessionToolCallsMenuState(
  params: Readonly<{
    target: Pick<SessionActionTarget, 'session' | 'toolCallsOverride'>;
    accountShowToolCalls: boolean | null | undefined;
  }>,
): SessionToolCallsMenuState {
  const override =
    typeof params.target.toolCallsOverride === 'boolean'
      ? params.target.toolCallsOverride
      : null;
  const isBot =
    readSessionBotV1(params.target.session.metadata?.bot)?.kind === 'bot';
  const { showToolCalls } = resolveTranscriptToolVisibility({
    sessionOverride: override ?? undefined,
    isBot,
    accountShowToolCalls: params.accountShowToolCalls ?? undefined,
  });
  const subtitleKey: TranslationKeyNoParams =
    override !== null
      ? override
        ? 'bots.menu.toolsOnHere'
        : 'bots.menu.toolsOffHere'
      : isBot
        ? 'bots.menu.toolsBotDefault'
        : 'bots.menu.toolsAccountDefault';
  return { showToolCalls, override, subtitleKey };
}
