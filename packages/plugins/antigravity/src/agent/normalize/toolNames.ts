function readActionAlias(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const action = (input as Readonly<Record<string, unknown>>).action;
  return typeof action === 'string' && action.trim() ? action.trim().toLowerCase() : null;
}

export function normalizeAntigravityToolName(params: Readonly<{
  sourceName: string;
  input?: unknown;
}>): string {
  const sourceName = params.sourceName.trim();
  const action = readActionAlias(params.input);
  if (sourceName === 'list_directory') return 'list_dir';
  if (sourceName === 'file_action') {
    if (action?.includes('view') || action?.includes('read')) return 'view_file';
    if (action?.includes('write') || action?.includes('create')) return 'write_to_file';
    if (action?.includes('grep') || action?.includes('search')) return 'grep_search';
    return 'edit_file';
  }
  if (sourceName === 'code_action') {
    if (action?.includes('write') || action?.includes('create')) return 'write_to_file';
    if (action?.includes('view') || action?.includes('read')) return 'view_file';
    if (action?.includes('grep') || action?.includes('search')) return 'grep_search';
    return 'edit_file';
  }
  return sourceName;
}
