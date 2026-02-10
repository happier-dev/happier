import { trimIdent } from '@/utils/trimIdent';

/**
 * Instruction to reduce out-of-order tool execution around approval gates.
 *
 * In some backends (notably Codex MCP), a model may emit multiple `exec_command`
 * tool calls in a single turn. If one tool call is approval-gated (e.g. a write),
 * later dependent reads can execute before the write is approved/executed.
 *
 * This instruction nudges models to request commands sequentially and to wait
 * for approval/completion before issuing dependent commands.
 */
export const EXEC_SEQUENCING_INSTRUCTION = trimIdent(`
  Tool execution ordering:
  - When you need to run multiple \`exec_command\` calls, run them sequentially.
  - Do not enqueue multiple \`exec_command\` calls at once.
  - If any command may require user approval (especially writes), wait for the user decision and the command result before issuing the next command.
  - If a dependent read runs before its prerequisite write and fails, rerun the read after the write succeeds.
`);

