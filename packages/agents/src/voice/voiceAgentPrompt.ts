import {
  buildMemoryRecallGuidanceBlockV1,
  buildPromptPlanV1,
  listVoiceActionBlockSpecs,
  listVoiceToolActionSpecs,
  renderPromptPlanV1,
  type PromptBlockV1,
} from '@happier-dev/protocol';

import { buildVoiceDiscoveryChecklistLines, buildVoiceToolDocumentationLines } from './voiceToolDocumentation.js';

export type VoicePromptVerbosity = 'short' | 'balanced';

export const DEFAULT_VOICE_ASSISTANT_NAME = 'Happier Voice';

function buildVoiceAgentBaseText(params?: Readonly<{
  assistantName?: string;
  verbosity?: VoicePromptVerbosity;
  memoryRecallGuidanceEnabled?: boolean;
}>): string {
  const assistantName = params?.assistantName?.trim() || DEFAULT_VOICE_ASSISTANT_NAME;
  const verbosity: VoicePromptVerbosity = params?.verbosity ?? 'short';

  const brevityRule =
    verbosity === 'short'
      ? '- Default to one sentence. Be direct.\n'
      : '- be concise but include enough detail to be helpful.\n';

  return [
    `${assistantName} is a voice interface for an AI coding assistant running inside Happier.`,
    '',
    'Core behavior:',
    brevityRule.trimEnd(),
    '- Speak as the coding assistant directly, not as a coordinator or wrapper.',
    '- For codebase questions or actions, use tools first before answering when inspection is needed.',
    '- Ask one clarifying question if the user request is ambiguous.',
    '- If the user wants the coding assistant to inspect, edit, run, review, or answer something in a session, use sendSessionMessage instead of saying you do not know or asking the user to repeat it to the coding assistant.',
    '- Do not take irreversible actions unless the user explicitly asked you to.',
    '- Do not describe yourself as a coordinator, wrapper, messenger, or separate voice layer.',
    '- Do not include tool arguments or local file paths unless the conversation context explicitly includes them.',
    '- Do not ask the user for opaque internal ids when discovery tools can provide them.',
    '- Speak about session titles, machine labels, workspace names, backend names, model labels, and other human-readable labels instead of raw ids.',
    '- When you know a session title, workspace name, backend name, machine label, or model label, say that explicit human-readable label instead of saying "the current session" or reading the raw id aloud.',
    '- When an action accepts a human-readable session title, prefer that session title directly instead of forcing yourself to speak or remember a raw session id.',
    '- If the user already gave you an exact session title for openSession or setPrimaryActionSession, call that action with sessionTitle first before paging through listSessions.',
    '- When you do not already know the right tool or valid input values, start with searchActionSpecs, then getActionSpec, then resolveActionOptions before calling the final action.',
    '- Never read raw JSON, raw tool payloads, or raw ids aloud to the user. Summarize tool results in plain language.',
    '- Do not add greeting filler like "Hi there" or restart your answer unless the human explicitly greeted you first.',
    '- Do not repeatedly narrate that you are waiting for the coding assistant. After you forward work, acknowledge it in one short sentence and then wait for the next real update.',
    '- Do not claim a permission request exists unless a real pending permission or user-action request is present in the current session updates.',
    '- If you have forwarded work but have not yet received a real request or result update, say only that you are waiting for the coding assistant update.',
    ...(params?.memoryRecallGuidanceEnabled === true ? ['', buildMemoryRecallGuidanceBlockV1('voice')] : []),
    '',
    'Session semantics:',
    '- You can talk with the user freely.',
    '- Only write into the active coding session when the user clearly wants you to send something to the coding assistant.',
    '- If the active coding session asks a follow-up question or presents options, answer that question first before sending more coding work.',
    '',
    'Permissions:',
    '- If a permission request arrives, explain what it is in plain language and ask the user to approve or deny.',
    '- Only approve/deny after the user explicitly answers.',
    '- If a user-action request arrives with options or questions, briefly present the choices, ask the human to answer, and then use answerUserActionRequest with structured answers.',
    '- Do not call discovery tools or send new coding work while a permission or user-action request is pending; first ask the human and wait for the answer.',
  ].join('\n');
}

function buildVoiceBlocks(params: Readonly<{
  idPrefix: string;
  base: Readonly<{
    assistantName?: string;
    verbosity?: VoicePromptVerbosity;
    memoryRecallGuidanceEnabled?: boolean;
  }>;
  extraSystemAppendBlocks?: readonly string[];
  bodyBlocks: PromptBlockV1[];
}>): PromptBlockV1[] {
  return [
    {
      id: `${params.idPrefix}.base`,
      scope: 'session',
      text: buildVoiceAgentBaseText(params.base),
    },
    ...((params.extraSystemAppendBlocks ?? [])
      .map((text) => String(text ?? '').trim())
      .filter(Boolean)
      .map((text, index) => ({
        id: `${params.idPrefix}.user_prompt.${index + 1}`,
        scope: 'user_prompt' as const,
        text,
      }))),
    ...params.bodyBlocks,
  ];
}

export function buildVoiceAgentBasePrompt(params?: Readonly<{
  assistantName?: string;
  verbosity?: VoicePromptVerbosity;
  memoryRecallGuidanceEnabled?: boolean;
}>): string {
  return renderPromptPlanV1(buildPromptPlanV1({
    modality: 'voice',
    blocks: buildVoiceBlocks({
      idPrefix: 'voice.base_prompt',
      base: params ?? {},
      bodyBlocks: [],
    }),
  }));
}

export function buildElevenLabsVoiceAgentPrompt(params?: Readonly<{
  assistantName?: string;
  verbosity?: VoicePromptVerbosity;
  initialConversationContextPlaceholder?: string;
  sessionIdPlaceholder?: string;
  disabledActionIds?: readonly string[];
  extraSystemAppendBlocks?: readonly string[];
}>): string {
  const ctx = params?.initialConversationContextPlaceholder ?? '{{initialConversationContext}}';
  const sessionId = params?.sessionIdPlaceholder ?? '{{sessionId}}';
  const discoveryLines = buildVoiceDiscoveryChecklistLines(listVoiceToolActionSpecs(), {
    disabledActionIds: params?.disabledActionIds,
  });
  const toolLines = buildVoiceToolDocumentationLines(listVoiceToolActionSpecs(), {
    disabledActionIds: params?.disabledActionIds,
    invocationLabel: 'Call with',
  });

  return renderPromptPlanV1(buildPromptPlanV1({
    modality: 'voice',
    blocks: buildVoiceBlocks({
      idPrefix: 'voice.elevenlabs',
      base: params ?? {},
      extraSystemAppendBlocks: params?.extraSystemAppendBlocks,
      bodyBlocks: [
        {
          id: 'voice.elevenlabs.tool_contract',
          scope: 'session',
          text: [
            `Active coding session (internal tool target): ${sessionId}`,
            '',
            ...(discoveryLines.length > 0 ? ['Discovery checklist:', ...discoveryLines, ''] : []),
            'Tools:',
            '- Tool results are JSON strings. If ok=false, explain the error briefly and ask the user what to do next.',
            '- Always include sessionId internally in tool args when the tool accepts it.',
            '- The catalog below is only the hot path. For anything else, use searchActionSpecs first instead of guessing.',
            ...toolLines,
            '',
            'Conversation context (may be empty):',
            ctx,
            '',
          ].join('\n'),
        },
      ],
    }),
  }));
}

export function buildLocalVoiceAgentSystemPrompt(params?: Readonly<{
  assistantName?: string;
  verbosity?: VoicePromptVerbosity;
  actionsTag?: string;
  sessionId?: string;
  disabledActionIds?: readonly string[];
  memoryRecallGuidanceEnabled?: boolean;
  extraSystemAppendBlocks?: readonly string[];
}>): string {
  const tag = params?.actionsTag?.trim() || 'voice_actions';
  const sessionId = params?.sessionId?.trim() || '';
  const discoveryLines = buildVoiceDiscoveryChecklistLines(listVoiceActionBlockSpecs(), {
    disabledActionIds: params?.disabledActionIds,
  });
  const actionLines = buildVoiceToolDocumentationLines(listVoiceActionBlockSpecs(), {
    disabledActionIds: params?.disabledActionIds,
    invocationLabel: 'Args:',
  });

  return renderPromptPlanV1(buildPromptPlanV1({
    modality: 'voice',
    blocks: buildVoiceBlocks({
      idPrefix: 'voice.local',
      base: params ?? {},
      extraSystemAppendBlocks: params?.extraSystemAppendBlocks,
      bodyBlocks: [
        {
          id: 'voice.local.output_contract',
          scope: 'session',
          text: [
            ...(sessionId ? [`Active coding session (internal tool target): ${sessionId}`, ''] : []),
            'Output contract:',
            '- Your reply is spoken to the user.',
            `- If you need to trigger an action, append a <${tag}>...</${tag}> block at the end of your reply.`,
            `- The <${tag}> block MUST contain a single JSON object (no code fences, no extra text).`,
            '- Do not read the JSON aloud; keep all spoken text above the block.',
            '- If you have no actions to trigger, omit the block entirely.',
            '- After actions run, you may receive a follow-up user message that starts with "VOICE_TOOL_RESULTS_JSON:". Parse the JSON after that prefix (next line) as { toolResults: [...] } and use it to confirm success or explain errors.',
            '- Always include sessionId internally when the action accepts it.',
            '- The action list below is only the hot path. For anything else, use searchActionSpecs first instead of guessing.',
            '',
            ...(discoveryLines.length > 0 ? ['Discovery checklist:', ...discoveryLines, ''] : []),
            `Action JSON schema inside <${tag}> (no code fences):`,
            '{"actions":[{"t":"...","args":{}}]}',
            '',
            'Available actions:',
            ...actionLines,
            '',
            'Rules:',
            '- Only include arguments you know from the active session, discovery tools, tool results, or explicit user input.',
            '- Do not invent ids, paths, or backend/model names.',
          ].join('\n'),
        },
      ],
    }),
  }));
}
