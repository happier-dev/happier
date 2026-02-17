import { buildLocalVoiceAgentSystemPrompt } from '@happier-dev/agents';

import { listDisabledActionIdsForSurfaceFromEnv } from '@/settings/actionsSettings';

type VoiceAgentTurn = { role: 'user' | 'assistant'; text: string };

export function buildVoiceAgentBootstrapPrompt(params: Readonly<{
  verbosity: 'short' | 'balanced';
  initialContext: string;
  mode: 'ready_handshake' | 'welcome';
  welcomeText?: string;
}>): string {
  const lines: string[] = [];
  lines.push(
    buildLocalVoiceAgentSystemPrompt({
      verbosity: params.verbosity,
      disabledActionIds: listDisabledActionIdsForSurfaceFromEnv('voice_tool'),
    }),
  );
  lines.push('');
  const initialContext = String(params.initialContext ?? '').trim();
  if (initialContext) {
    lines.push('Initial context:');
    lines.push(initialContext);
    lines.push('');
  }

  if (params.mode === 'welcome') {
    const welcomeText = String(params.welcomeText ?? '').trim();
    if (welcomeText) {
      lines.push('Start this session by greeting the user with exactly this message:');
      lines.push(welcomeText);
      lines.push('');
    } else {
      lines.push('Start this session with a short friendly greeting and ask what we are working on today.');
      lines.push('');
    }
    lines.push('Then, wait for the user to speak again.');
    lines.push('Do NOT call any tools until the user asks you to do something.');
    return lines.join('\n');
  }

  lines.push('Warm-up step: reply with exactly READY (all caps) and nothing else.');
  lines.push('Do NOT call any tools and do NOT add any other text.');
  return lines.join('\n');
}

export function buildVoiceAgentUserTurnPrompt(params: Readonly<{ userText: string }>): string {
  const userText = String(params.userText ?? '').trim();
  return `User: ${userText}\nVoice agent:`;
}

export function buildVoiceAgentSeededUserTurnPrompt(params: Readonly<{
  verbosity: 'short' | 'balanced';
  initialContext: string;
  userText: string;
}>): string {
  const lines: string[] = [];
  lines.push(
    buildLocalVoiceAgentSystemPrompt({
      verbosity: params.verbosity,
      disabledActionIds: listDisabledActionIdsForSurfaceFromEnv('voice_tool'),
    }),
  );
  lines.push('');
  lines.push('Initial context:');
  lines.push(String(params.initialContext ?? '').trim());
  lines.push('');
  lines.push(`User: ${String(params.userText ?? '').trim()}`);
  lines.push('Voice agent:');
  return lines.join('\n');
}

export function buildVoiceAgentCommitPrompt(params: Readonly<{
  initialContext: string;
  history: VoiceAgentTurn[];
  maxChars: number;
}>): string {
  const lines: string[] = [];
  lines.push('You are preparing a single instruction message for an AI coding agent.');
  lines.push(`Return ONLY the instruction text (no preamble), max ${params.maxChars} chars.`);
  lines.push('');
  lines.push('Initial context:');
  lines.push(params.initialContext);
  lines.push('');
  if (params.history.length > 0) {
    lines.push('Conversation:');
    for (const turn of params.history) {
      lines.push(`${turn.role === 'user' ? 'User' : 'Voice agent'}: ${turn.text}`);
    }
    lines.push('');
  }
  lines.push('Instruction:');
  return lines.join('\n');
}
