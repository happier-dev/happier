const DEFAULT_READ_ONLY_TOOL_NAMES = new Set([
  'fetch',
  'read',
  'read-file',
  'read_file',
  'readfile',
  'read-notebook',
  'read_notebook',
  'readnotebook',
  'read-text-file',
  'read_text_file',
  'readtextfile',
  'search',
  'grep',
  'glob',
  'tool-search',
  'tool_search',
  'toolsearch',
  'ls',
  'list',
  'web-fetch',
  'web_fetch',
  'webfetch',
  'web-search',
  'web_search',
  'websearch',
  'todo-read',
  'todo_read',
  'todoread',
]);

export function isDefaultReadOnlyToolName(toolName: string): boolean {
  return DEFAULT_READ_ONLY_TOOL_NAMES.has(String(toolName ?? '').trim().toLowerCase());
}

export function isDefaultWriteLikeToolName(toolName: string): boolean {
  return !isDefaultReadOnlyToolName(toolName);
}
