import { buildLocalVoiceAgentSystemPrompt } from '@happier-dev/agents';
import { buildPromptPlanV1, renderPromptPlanV1 } from '@happier-dev/protocol/prompts/promptPlanV1';
import type { PromptBlockV1 } from '@happier-dev/protocol';

import { listDisabledActionIdsForSurfaceFromEnv } from '../../../settings/actionsSettings';
import type { VoiceAgentTurn, VoiceAgentStartParams } from './voiceAgentTypes';

function renderConversationHistory(history: readonly VoiceAgentTurn[]): string {
  return [
    'Conversation (reference context only; do not repeat previous requests, actions, or tool effects):',
    ...history.map((turn) => `${turn.role === 'context' ? 'Context' : turn.role === 'user' ? 'User' : 'Voice agent'}: ${turn.text}`),
  ].join('\n');
}

function resolveDisabledVoicePromptActionIds(disabledActionIds?: readonly string[]): readonly string[] {
  return Array.from(
    new Set([
      ...listDisabledActionIdsForSurfaceFromEnv('voice'),
      ...((disabledActionIds ?? []).map((value) => String(value ?? '').trim()).filter(Boolean)),
    ]),
  );
}

export function buildVoiceAgentBootstrapPrompt(params: Readonly<{
  verbosity: 'short' | 'balanced';
  initialContext: string;
  mode: 'ready_handshake' | 'welcome';
  welcomeText?: string;
  disabledActionIds?: readonly string[];
  memoryRecallGuidanceEnabled?: boolean;
  systemAppendBlocks?: readonly string[];
  voicePolicy?: VoiceAgentStartParams['voicePolicy'];
}>): string {
  const disabledActionIds = resolveDisabledVoicePromptActionIds(params.disabledActionIds);
  const blocks: PromptBlockV1[] = [
    {
      id: 'voice.bootstrap.system',
      scope: 'session' as const,
      text: buildLocalVoiceAgentSystemPrompt({
        ...params.voicePolicy,
        verbosity: params.verbosity,
        disabledActionIds,
        memoryRecallGuidanceEnabled: params.memoryRecallGuidanceEnabled,
        extraSystemAppendBlocks: params.systemAppendBlocks,
      }),
    },
  ];
  const initialContext = String(params.initialContext ?? '').trim();
  if (initialContext) {
    blocks.push({
      id: 'voice.bootstrap.initial_context',
      scope: 'bootstrap',
      text: ['Initial context:', initialContext].join('\n'),
    });
  }

  if (params.mode === 'welcome') {
    const welcomeText = params.welcomeText ?? params.voicePolicy?.welcome?.text;
    if (typeof welcomeText === 'string') {
      blocks.push({
        id: 'voice.bootstrap.welcome',
        scope: 'bootstrap',
        text: [
          'Start this session by greeting the user with exactly this message:',
          welcomeText,
          '',
          'Then, wait for the user to speak again.',
          'Do NOT call any tools until the user asks you to do something.',
        ].join('\n'),
      });
    } else {
      blocks.push({
        id: 'voice.bootstrap.welcome',
        scope: 'bootstrap',
        text: [
          'Start this session with a short friendly greeting and ask what we are working on today.',
          '',
          'Then, wait for the user to speak again.',
          'Do NOT call any tools until the user asks you to do something.',
        ].join('\n'),
      });
    }
    return renderPromptPlanV1(buildPromptPlanV1({ modality: 'voice', blocks }));
  }

  blocks.push({
    id: 'voice.bootstrap.ready',
    scope: 'bootstrap',
    text: [
      'Warm-up step: reply with exactly READY (all caps) and nothing else.',
      'Do NOT call any tools and do NOT add any other text.',
    ].join('\n'),
  });
  return renderPromptPlanV1(buildPromptPlanV1({ modality: 'voice', blocks }));
}

export function buildVoiceAgentUserTurnPrompt(params: Readonly<{ userText: string }>): string {
  const userText = String(params.userText ?? '').trim();
  return `User: ${userText}\nVoice agent:`;
}

export function buildVoiceAgentSeededUserTurnPrompt(params: Readonly<{
  verbosity: 'short' | 'balanced';
  initialContext: string;
  userText: string;
  disabledActionIds?: readonly string[];
  memoryRecallGuidanceEnabled?: boolean;
  systemAppendBlocks?: readonly string[];
  history?: readonly VoiceAgentTurn[];
  voicePolicy?: VoiceAgentStartParams['voicePolicy'];
  welcomeAlreadyDelivered?: boolean;
}>): string {
  const disabledActionIds = resolveDisabledVoicePromptActionIds(params.disabledActionIds);
  return renderPromptPlanV1(buildPromptPlanV1({
    modality: 'voice',
    blocks: [
      {
        id: 'voice.seeded.system',
        scope: 'session',
        text: buildLocalVoiceAgentSystemPrompt({
          ...params.voicePolicy,
          ...(params.welcomeAlreadyDelivered && params.voicePolicy ? {
            welcome: { ...params.voicePolicy.welcome, enabled: false },
          } : {}),
          verbosity: params.verbosity,
          disabledActionIds,
          memoryRecallGuidanceEnabled: params.memoryRecallGuidanceEnabled,
          extraSystemAppendBlocks: params.systemAppendBlocks,
        }),
      },
      {
        id: 'voice.seeded.initial_context',
        scope: 'bootstrap',
        text: ['Initial context:', String(params.initialContext ?? '').trim()].join('\n'),
      },
      ...(params.history?.length
        ? [{ id: 'voice.seeded.conversation', scope: 'bootstrap' as const, text: renderConversationHistory(params.history) }]
        : []),
      {
        id: 'voice.seeded.user_turn',
        scope: 'turn',
        text: [`User: ${String(params.userText ?? '').trim()}`, 'Voice agent:'].join('\n'),
      },
    ],
  }));
}

export function buildVoiceAgentCommitPrompt(params: Readonly<{
  initialContext: string;
  history: VoiceAgentTurn[];
  maxChars: number;
}>): string {
  const conversationText = params.history.length > 0 ? renderConversationHistory(params.history) : '';

  return renderPromptPlanV1(buildPromptPlanV1({
    modality: 'voice',
    blocks: [
      {
        id: 'voice.commit.instructions',
        scope: 'bootstrap',
        text: [
          'You are preparing a single instruction message for an AI coding agent.',
          `Return ONLY the instruction text (no preamble), max ${params.maxChars} chars.`,
        ].join('\n'),
      },
      {
        id: 'voice.commit.initial_context',
        scope: 'bootstrap',
        text: ['Initial context:', params.initialContext].join('\n'),
      },
      ...(conversationText
        ? [{
            id: 'voice.commit.conversation',
            scope: 'bootstrap' as const,
            text: conversationText,
          }]
        : []),
      {
        id: 'voice.commit.footer',
        scope: 'bootstrap',
        text: 'Instruction:',
      },
    ],
  }));
}
