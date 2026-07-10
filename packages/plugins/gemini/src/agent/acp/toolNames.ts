import {
  CHANGE_TITLE_TOOL_NAME_ALIASES,
  type AcpToolNameInferenceV1,
} from '@happier-dev/plugin-sdk/experimental/acp';

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
      name: 'think',
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
} satisfies AcpToolNameInferenceV1);

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
