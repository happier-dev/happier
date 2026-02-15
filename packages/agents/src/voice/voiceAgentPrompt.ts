export type VoicePromptVerbosity = 'short' | 'balanced';

export const DEFAULT_VOICE_ASSISTANT_NAME = 'Happier Voice';

import { listVoiceActionBlockSpecs, listVoiceToolActionSpecs } from '@happier-dev/protocol';

export function buildVoiceAgentBasePrompt(params?: Readonly<{
  assistantName?: string;
  verbosity?: VoicePromptVerbosity;
}>): string {
  const assistantName = params?.assistantName?.trim() || DEFAULT_VOICE_ASSISTANT_NAME;
  const verbosity: VoicePromptVerbosity = params?.verbosity ?? 'short';

  const brevityRule =
    verbosity === 'short'
      ? '- Default to one sentence. Be direct.\n'
      : '- be concise but include enough detail to be helpful.\n';

  // Keep this backend-agnostic: do not mention Claude/Codex/OpenCode by name.
  return [
    `${assistantName} is a voice interface for an AI coding assistant running inside Happier.`,
    '',
    'Core behavior:',
    brevityRule.trimEnd(),
    '- Ask one clarifying question if the user request is ambiguous.',
    '- Do not take irreversible actions unless the user explicitly asked you to.',
    '- Do not include tool arguments or local file paths unless the conversation context explicitly includes them.',
    '',
    'Session semantics:',
    '- You can talk with the user freely.',
    '- Only write into the active coding session when the user clearly wants you to send something to the coding assistant.',
    '',
    'Permissions:',
    '- If a permission request arrives, explain what it is in plain language and ask the user to approve or deny.',
    '- Only approve/deny after the user explicitly answers.',
  ].join('\n');
}

export function buildElevenLabsVoiceAgentPrompt(params?: Readonly<{
  assistantName?: string;
  verbosity?: VoicePromptVerbosity;
  initialConversationContextPlaceholder?: string;
  sessionIdPlaceholder?: string;
  disabledActionIds?: readonly string[];
}>): string {
  const ctx = params?.initialConversationContextPlaceholder ?? '{{initialConversationContext}}';
  const sessionId = params?.sessionIdPlaceholder ?? '{{sessionId}}';
  const disabled = new Set((params?.disabledActionIds ?? []).map((v) => String(v ?? '').trim()).filter(Boolean));

  const toolLines = listVoiceToolActionSpecs().flatMap((spec) => {
    if (disabled.has(spec.id)) return [];
    const toolNameRaw = spec.bindings?.voiceClientToolName;
    const toolName = typeof toolNameRaw === 'string' ? toolNameRaw.trim() : '';
    if (!toolName) return [];
    const desc = (spec.description ?? spec.title ?? toolName).trim();
    const argsExample = spec.examples?.voice?.argsExample ?? '{}';
    return [`- ${toolName}: ${desc} Call with ${argsExample}.`];
  });

  return [
    buildVoiceAgentBasePrompt(params),
    '',
    `Active sessionId (always use this for tool calls): ${sessionId}`,
    '',
    'Tools:',
    '- Tool results are JSON strings. If ok=false, explain the error briefly and ask the user what to do next.',
    '- Always include sessionId in tool args when the tool accepts it.',
    ...toolLines,
    '',
    'Conversation context (may be empty):',
    ctx,
    '',
  ].join('\n');
}

export function buildLocalVoiceAgentSystemPrompt(params?: Readonly<{
  assistantName?: string;
  verbosity?: VoicePromptVerbosity;
  actionsTag?: string;
  sessionId?: string;
  disabledActionIds?: readonly string[];
}>): string {
  const tag = params?.actionsTag?.trim() || 'voice_actions';
  const sessionId = params?.sessionId?.trim() || '';
  const disabled = new Set((params?.disabledActionIds ?? []).map((v) => String(v ?? '').trim()).filter(Boolean));

  const actionLines = listVoiceActionBlockSpecs().flatMap((spec) => {
    if (disabled.has(spec.id)) return [];
    const toolNameRaw = spec.bindings?.voiceClientToolName;
    const toolName = typeof toolNameRaw === 'string' ? toolNameRaw.trim() : '';
    if (!toolName) return [];
    const desc = (spec.description ?? spec.title ?? toolName).trim();
    const argsExample = spec.examples?.voice?.argsExample ?? '{}';
    return [`- ${toolName}: ${desc} Args: ${argsExample}.`];
  });

  return [
    buildVoiceAgentBasePrompt(params),
    '',
    ...(sessionId ? [`Active sessionId: ${sessionId}`, ''] : []),
    'Output contract:',
    '- Your reply is spoken to the user.',
    `- If you need to trigger an action, append a <${tag}>...</${tag}> block at the end of your reply.`,
    `- The <${tag}> block MUST contain a single JSON object (no code fences, no extra text).`,
    '- Do not read the JSON aloud; keep all spoken text above the block.',
    '- If you have no actions to trigger, omit the block entirely.',
    '- After actions run, you may receive a follow-up user message that starts with "VOICE_TOOL_RESULTS_JSON:". Parse the JSON after that prefix (next line) as { toolResults: [...] } and use it to confirm success or explain errors.',
    '',
    `Action JSON schema inside <${tag}> (no code fences):`,
    '{"actions":[{"t":"...","args":{}}]}',
    '',
    'Available actions:',
    ...actionLines,
    '',
    'Rules:',
    '- Never include tool arguments in the action payload unless the user explicitly asked for them.',
  ].join('\n');
}
