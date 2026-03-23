import { buildHappierToolsShellBridgeCommand } from '@/agent/tools/happierTools/runtime/buildHappierToolsShellBridgeCommand';

export function buildHappierToolsPromptAppendix(params: Readonly<{
  sessionId: string;
  directory: string;
  memoryRecallGuidance?: Readonly<{
    enabled?: boolean;
    machineId?: string | null;
  }>;
}>): string {
  const listCommand = buildHappierToolsShellBridgeCommand([
    'list',
    '--session-id',
    params.sessionId,
    '--directory',
    params.directory,
    '--json',
  ]);
  const renameCommand = buildHappierToolsShellBridgeCommand([
    'call',
    '--session-id',
    params.sessionId,
    '--directory',
    params.directory,
    '--source',
    'happier',
    '--tool',
    'change_title',
    '--args-json',
    '{"title":"Short descriptive title"}',
    '--json',
  ]);
  const memoryMachineId = typeof params.memoryRecallGuidance?.machineId === 'string'
    ? params.memoryRecallGuidance.machineId.trim()
    : '';
  const memorySearchCommand = buildHappierToolsShellBridgeCommand([
    'call',
    '--session-id',
    params.sessionId,
    '--directory',
    params.directory,
    '--source',
    'happier',
    '--tool',
    'memory_search',
    '--args-json',
    JSON.stringify({
      machineId: memoryMachineId || '<machine-id>',
      query: {
        v: 1,
        query: 'topic from user',
        scope: { type: 'global' },
        mode: 'auto',
      },
    }),
    '--json',
  ]);
  const memoryWindowCommand = buildHappierToolsShellBridgeCommand([
    'call',
    '--session-id',
    params.sessionId,
    '--directory',
    params.directory,
    '--source',
    'happier',
    '--tool',
    'memory_get_window',
    '--args-json',
    JSON.stringify({
      machineId: memoryMachineId || '<machine-id>',
      sessionId: '<session-id-from-hit>',
      seqFrom: '<seq-from-hit>',
      seqTo: '<seq-to-hit>',
    }),
    '--json',
  ]);
  const memoryGuidance = params.memoryRecallGuidance?.enabled === true
    ? `For recall questions about earlier conversations, use the Happier memory bridge tools before provider-native memory files, workspace search, or guesses from model memory.

Use \`${memorySearchCommand}\` first. ${memoryMachineId ? `Use machineId \`${memoryMachineId}\` for this session's daemon memory index.` : 'Fill in the current daemon machine id before running the command.'}

If \`memory_search\` returns a hit that you need to verify, use \`${memoryWindowCommand}\` with the returned \`sessionId\`, \`seqFrom\`, and \`seqTo\`.

Do not use provider-native memory files or ad-hoc workspace search as a substitute for \`memory_search\`. If \`memory_search\` returns no hits, say that plainly.`
    : '';

  return `Happier tools are available through the CLI bridge for this provider. They are not exposed as native tools in the provider tool inventory.

Based on the user's message, use the Happier tools bridge to set or update a short descriptive session title.

At the start of the session (and again if the task changes significantly), use the Happier tools bridge to rename the session before replying when that would help keep the session organized.

Before your first substantive reply in the session, execute the CLI bridge command to rename the session unless the user explicitly told you not to use tools.

Required first action for this session: derive a short descriptive title from the user's message and execute the rename command.

Before using provider-native tools for workspace inspection or analysis, execute the bridge rename command first.

Do not inspect the workspace first and then rename the session afterward unless the user explicitly forbids tool usage for that turn.

Only after the rename command succeeds should you inspect the workspace, use provider-native tools, or provide the substantive answer.

Do not merely describe the command or say that you plan to rename the session later; execute the CLI bridge command first when the title update is allowed.

Use \`${listCommand}\` when you need to discover the available built-in Happier tools and custom configured tools.

Use \`${renameCommand}\` to rename the session.

${memoryGuidance ? `${memoryGuidance}

` : ''}For any other Happier or custom tool, call the same CLI bridge form with \`call --source <source> --tool <tool> --args-json '<json>' --json\`. When a custom tool is written as \`<source>/<tool>\`, pass the part before the slash to \`--source\` and the part after the slash to \`--tool\`.

Never violate the user's explicit constraints on tool usage. If the user says to avoid tools or to use exactly one tool, follow that instruction even if it means skipping the title update for that turn.

Do not claim these Happier tools are unavailable without first using the CLI bridge to list or call them.

Prefer this exact CLI bridge command form over ad-hoc shell equivalents when the capability exists there.`;
}
