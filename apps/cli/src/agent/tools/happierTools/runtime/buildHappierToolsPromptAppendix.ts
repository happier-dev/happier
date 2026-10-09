import { buildHappierToolsShellBridgeCommand } from '@/agent/tools/happierTools/runtime/buildHappierToolsShellBridgeCommand';
import type { CodingPromptSessionTitleUpdatesModeV1 } from '@happier-dev/protocol';
import { buildHappierSessionTitleGuidanceV1 } from '@happier-dev/protocol/prompts/systemPromptBaseV1';

export function buildHappierToolsPromptAppendix(params: Readonly<{
  sessionId: string;
  directory: string;
  sessionTitleUpdatesMode?: CodingPromptSessionTitleUpdatesModeV1;
  sessionTitleToolAvailable?: boolean;
  createdAsBot?: boolean;
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
  const explicitPluginActionExecuteCommand = buildHappierToolsShellBridgeCommand([
    'call',
    '--session-id',
    params.sessionId,
    '--directory',
    params.directory,
    '--source',
    'happier',
    '--tool',
    'action_execute',
    '--args-json',
    JSON.stringify({
      actionId: '<plugin-action-or-tool-id>',
      input: {},
    }),
    '--json',
  ]);
  const memoryGuidance = params.memoryRecallGuidance?.enabled === true
    ? `For recall questions about earlier conversations, use the Happier memory bridge tools before provider-native memory files, workspace search, or guesses from model memory.

Use \`${memorySearchCommand}\` first. ${memoryMachineId ? `Use machineId \`${memoryMachineId}\` for this session's daemon memory index.` : 'Fill in the current daemon machine id before running the command.'}

If \`memory_search\` returns a hit that you need to verify, use \`${memoryWindowCommand}\` with the returned \`sessionId\`, \`seqFrom\`, and \`seqTo\`.

Do not use provider-native memory files or ad-hoc workspace search as a substitute for \`memory_search\`. If \`memory_search\` returns no hits, say that plainly.`
    : '';

  const titleMode = params.sessionTitleUpdatesMode ?? 'ongoing';
  const titleGuidance = buildHappierSessionTitleGuidanceV1({
    settings: { codingPromptBehaviorV1: { sessionTitleUpdates: titleMode } },
    sessionTitleToolAvailable: params.sessionTitleToolAvailable,
    createdAsBot: params.createdAsBot,
    preferredToolName: 'change_title',
  });
  const renameCommandGuidance = titleGuidance
    ? `Use \`${renameCommand}\` to perform a title update when the title guidance above permits it.`
    : '';

  return `Happier tools are available through the CLI bridge for this provider. They are not exposed as native tools in the provider tool inventory.
${titleGuidance}

Use \`${listCommand}\` when you need to discover the available built-in Happier tools and custom configured tools.
${renameCommandGuidance}

If you just created or edited a plugin capability yourself and you already know its explicit action id or tool id, do not assume discovery surfaces have refreshed yet. In that case, execute it directly through \`${explicitPluginActionExecuteCommand}\` by replacing \`<plugin-action-or-tool-id>\` with the exact id.

${memoryGuidance ? `${memoryGuidance}

` : ''}For any other Happier or custom tool, call the same CLI bridge form with \`call --source <source> --tool <tool> --args-json '<json>' --json\`. Use the listed tool \`name\` verbatim for \`--tool\`; ActionSpec IDs (for example, \`subagents.delegate.start\`) are not tool names. If you start from an ActionSpec ID, invoke the listed \`action_execute\` tool and pass the ID as \`actionId\` in \`--args-json\`. When a custom tool is written as \`<source>/<tool>\`, pass the part before the slash to \`--source\` and the part after the slash to \`--tool\`.

Never violate the user's explicit constraints on tool usage. If the user says to avoid tools or to use exactly one tool, follow that instruction even if it means skipping the title update for that turn.

Do not claim these Happier tools are unavailable without first using the CLI bridge to list or call them.

Prefer this exact CLI bridge command form over ad-hoc shell equivalents when the capability exists there.`;
}
