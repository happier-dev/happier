import { CHANGE_TITLE_INSTRUCTION } from '@/agent/runtime/changeTitleInstruction';
import { CHANGE_TITLE_TOOL_NAME_ALIASES } from '@happier-dev/protocol/tools/v2';

export function prepareClaudeSdkPrompt(params: Readonly<{
  didSendChangeTitleInstructionForSession: boolean;
  prompt: string;
}>): Readonly<{
  didSendChangeTitleInstructionForSession: boolean;
  prompt: string;
}> {
  const raw = typeof params.prompt === 'string' ? params.prompt : '';
  if (!raw.trim()) {
    return {
      didSendChangeTitleInstructionForSession: params.didSendChangeTitleInstructionForSession,
      prompt: raw,
    };
  }
  if (params.didSendChangeTitleInstructionForSession) {
    return {
      didSendChangeTitleInstructionForSession: true,
      prompt: raw,
    };
  }
  const lower = raw.toLowerCase();
  const alreadyMentionsChangeTitle = CHANGE_TITLE_TOOL_NAME_ALIASES.some((alias) => lower.includes(alias));
  return {
    didSendChangeTitleInstructionForSession: true,
    prompt: alreadyMentionsChangeTitle ? raw : `${raw}\n\n${CHANGE_TITLE_INSTRUCTION}`,
  };
}
