import { systemPrompt } from '@/backends/claude/utils/systemPrompt';
import { trimIdent } from '@/utils/trimIdent';

const DISABLE_TODOS_APPEND = trimIdent(`
    Do not create TODO items, TODO lists, or task lists in your output. If you would normally create TODOs, instead proceed with the work directly or ask the user for clarification.
`);

export function getClaudeRemoteSystemPrompt(args: { disableTodos: boolean }): string {
    const base = systemPrompt();
    if (!args.disableTodos) return base;
    return `${base}\n\n${DISABLE_TODOS_APPEND}`;
}
