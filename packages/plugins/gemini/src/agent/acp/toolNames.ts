import { formatMcpToolWireNameV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import {
  CHANGE_TITLE_TOOL_NAME_ALIASES,
} from '@happier-dev/plugin-sdk/sessions';
import type { AgentAcpRuntimeDefinition, AgentAcpToolNameResolver, AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

// Gemini CLI 0.63.0's generateValidName and Turn.handlePendingFunctionCall:
// the function name is carried before `__` in the call id, independently of
// the ACP display title. Its MCP name shaping is not reversible for every name.
function geminiMcpFunctionName(server: string, tool: string): string {
  const qualified = `${server}_${tool}`;
  const name = (qualified.startsWith('mcp_') ? qualified : `mcp_${qualified}`).replace(/[^a-zA-Z0-9_\-.:]/g, '_');
  return name.length > 63 ? `${name.slice(0, 30)}...${name.slice(-30)}` : name;
}

export function buildGeminiAcpToolNameResolver(
  request: Pick<AgentSessionOpenRequest, 'mcpServers' | 'mcpToolPolicy'>,
): AgentAcpToolNameResolver {
  const keys = Object.keys(request.mcpServers ?? {});
  const named = keys.flatMap(server => Object.keys(request.mcpToolPolicy?.[server]?.tools ?? {})
    .map(tool => ({ native: geminiMcpFunctionName(server, tool), canonical: formatMcpToolWireNameV1(server, tool) })));
  return ({ toolName, toolCallId }) => {
    switch (toolName) {
      case 'GeminiPatch': return 'Patch';
      case 'GeminiDiff': return 'Diff';
      case 'GeminiReasoning': return 'Reasoning';
    }
    if (toolName.toLowerCase() === 'think') return 'Reasoning';
    const encodedName = /^(.+)__(?:\1_\d+_\d+|synth_.+_\d+_\d+)$/.exec(toolCallId)?.[1];
    const matching = named.filter(({ native }) => encodedName ? encodedName === native : toolCallId.startsWith(`${native}__`));
    const longest = Math.max(0, ...matching.map(({ native }) => native.length));
    const exact = matching.filter(({ native }) => native.length === longest);
    if (exact.length > 1) throw new Error('Gemini MCP tool identity is ambiguous');
    if (exact.length === 1) return exact[0]!.canonical;
    const candidates = keys.flatMap(server => {
      const prefix = geminiMcpFunctionName(server, '');
      if (!toolCallId.startsWith(prefix)) return [];
      // Gemini's synthesized correlation repeats the native function name
      // (or uses synth_<prompt>_<time>_<counter> with context management).
      const boundary = encodedName?.length ?? toolCallId.indexOf('__', prefix.length);
      if (boundary < prefix.length) return [];
      if (!encodedName && toolCallId.slice(boundary + 2).includes('__')) {
        throw new Error('Gemini MCP tool identity is lossy');
      }
      const tool = toolCallId.slice(prefix.length, boundary);
      if (!tool || tool.includes('...')) throw new Error('Gemini MCP tool identity is lossy');
      return [formatMcpToolWireNameV1(server, tool)];
    });
    if (candidates.length > 1) throw new Error('Gemini MCP server identity is ambiguous');
    return candidates[0] ?? null;
  };
}

export const GEMINI_TOOL_NAME_INFERENCE = Object.freeze({
  preferLongestPattern: true,
  unknownToolNames: ['other', 'unknown', 'unknown tool', 'Unknown tool'],
  patterns: [
    {
      name: 'change_title',
      patterns: CHANGE_TITLE_TOOL_NAME_ALIASES,
      inputFields: ['title'],
    },
    {
      name: 'save_memory',
      patterns: ['save_memory', 'save-memory'],
      inputFields: ['memory', 'content'],
    },
    {
      name: 'Reasoning',
      patterns: ['think'],
      inputFields: ['thought', 'thinking'],
    },
    {
      name: 'read',
      patterns: ['read', 'read_file'],
      inputFields: ['filePath', 'file_path', 'path', 'locations'],
    },
    {
      name: 'write',
      patterns: ['write', 'write_file'],
      inputFields: ['filePath', 'file_path', 'path', 'content'],
    },
    {
      name: 'edit',
      patterns: ['edit', 'replace'],
      inputFields: ['oldText', 'newText', 'old_string', 'new_string', 'oldString', 'newString'],
    },
    {
      name: 'execute',
      patterns: ['run_shell_command', 'shell', 'exec', 'bash'],
      inputFields: ['command', 'cmd'],
    },
    {
      name: 'glob',
      patterns: ['glob'],
      inputFields: ['pattern', 'glob'],
    },
    {
      name: 'TodoWrite',
      patterns: ['write_todos', 'todo_write', 'todowrite'],
      inputFields: ['todos', 'items'],
    },
  ],
} satisfies NonNullable<AgentAcpRuntimeDefinition['toolNameInference']>);

export function hasGeminiChangeTitlePromptInstruction(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  const changeTitlePattern = GEMINI_TOOL_NAME_INFERENCE.patterns.find((pattern) => pattern.name === 'change_title');
  return (
    changeTitlePattern?.patterns.some((alias) => normalized.includes(alias.toLowerCase()))
    || normalized.includes('change title')
    || normalized.includes('set title')
    || false
  );
}
