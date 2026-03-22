import { buildLocalVoiceAgentSystemPrompt } from '@happier-dev/agents';
import { buildPromptPlanV1, renderPromptPlanV1, type PromptBlockV1 } from '@happier-dev/protocol';

import { listDisabledActionIdsForSurfaceFromEnv } from '../../../settings/actionsSettings';

type VoiceAgentTurn = { role: 'user' | 'assistant'; text: string };

function resolveDisabledVoicePromptActionIds(disabledActionIds?: readonly string[]): readonly string[] {
  return Array.from(
    new Set([
      ...listDisabledActionIdsForSurfaceFromEnv('voice_tool'),
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
}>): string {
  const disabledActionIds = resolveDisabledVoicePromptActionIds(params.disabledActionIds);
  const blocks: PromptBlockV1[] = [
    {
      id: 'voice.bootstrap.system',
      scope: 'session' as const,
      text: buildLocalVoiceAgentSystemPrompt({
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
    const welcomeText = String(params.welcomeText ?? '').trim();
    if (welcomeText) {
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
}>): string {
  const disabledActionIds = resolveDisabledVoicePromptActionIds(params.disabledActionIds);
  return renderPromptPlanV1(buildPromptPlanV1({
    modality: 'voice',
    blocks: [
      {
        id: 'voice.seeded.system',
        scope: 'session',
        text: buildLocalVoiceAgentSystemPrompt({
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
  const conversationLines =
    params.history.length > 0
      ? [
          'Conversation:',
          ...params.history.map((turn) => `${turn.role === 'user' ? 'User' : 'Voice agent'}: ${turn.text}`),
        ]
      : [];

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
      ...(conversationLines.length > 0
        ? [{
            id: 'voice.commit.conversation',
            scope: 'bootstrap' as const,
            text: conversationLines.join('\n'),
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
