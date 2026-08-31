import type { PromptBlockV1 } from '@happier-dev/protocol';

import { trimIdent } from '@/utils/trimIdent';

const CLAUDE_ASK_USER_QUESTION_ISOLATION = trimIdent(`
  RELIABILITY RULES (IMPORTANT):
  - Tool-use sequencing is strict. If you use "AskUserQuestion", do NOT include any other tool_use in the same assistant turn. Wait for the user's answer before calling other tools.
`);

const CLAUDE_DISABLE_TODOS = trimIdent(`
  Do not create TODO items, TODO lists, or task lists in your output. If you would normally create TODOs, instead proceed with the work directly or ask the user for clarification.
`);

export function resolveCodingProviderBehaviorBlocks(args: Readonly<{
  providerId: string | null | undefined;
  disableTodos?: boolean;
}>): PromptBlockV1[] {
  const providerId = typeof args.providerId === 'string' ? args.providerId.trim() : '';
  if (!providerId) return [];

  const blocks: PromptBlockV1[] = [];

  if (providerId === 'claude') {
    blocks.push({
      id: 'provider.claude.ask_user_question_isolation',
      scope: 'provider_behavior',
      text: CLAUDE_ASK_USER_QUESTION_ISOLATION,
    });
    if (args.disableTodos === true) {
      blocks.push({
        id: 'provider.claude.disable_todos',
        scope: 'provider_behavior',
        text: CLAUDE_DISABLE_TODOS,
      });
    }
  }

  return blocks;
}
