import { describe, expect, it } from 'vitest';

import { canonicalizeToolNameV2 } from './index';

function canonicalize(toolName: string, toolInput?: unknown, callId?: string): string {
  return canonicalizeToolNameV2({ protocol: 'acp', toolName, toolInput, callId });
}

describe('canonicalizeToolNameV2 mappings', () => {
  it.each([
    'execute',
    'bash',
    'shell',
    'execute_command',
    'exec_command',
    'CodexBash',
    'GeminiBash',
  ])('normalizes `%s` to Bash', (toolName) => {
    expect(canonicalize(toolName)).toBe('Bash');
  });

  it.each([
    { toolName: 'glob', expected: 'Glob' },
    { toolName: 'grep', expected: 'Grep' },
    { toolName: 'ls', expected: 'LS' },
    { toolName: 'search', expected: 'CodeSearch' },
    { toolName: 'read_file', expected: 'Read' },
    { toolName: 'write_file', expected: 'Write' },
    { toolName: 'write_to_file', expected: 'Write' },
    { toolName: 'apply_diff', expected: 'Patch' },
    { toolName: 'apply_patch', expected: 'Patch' },
    { toolName: 'list_files', expected: 'LS' },
    { toolName: 'ls_files', expected: 'LS' },
    { toolName: 'search_code', expected: 'CodeSearch' },
    { toolName: 'code_search', expected: 'CodeSearch' },
  ])('normalizes `$toolName` to `$expected`', ({ toolName, expected }) => {
    expect(canonicalize(toolName)).toBe(expected);
  });

  it('normalizes find inputs with query-like payloads to CodeSearch', () => {
    expect(canonicalize('find', { query: 'foo' })).toBe('CodeSearch');
    expect(canonicalize('find', { q: 'foo' })).toBe('CodeSearch');
    expect(canonicalize('find', { text: 'foo' })).toBe('CodeSearch');
  });

  it('normalizes find inputs with query payloads that look like globs to Glob', () => {
    expect(canonicalize('find', { query: '**/*.ts' })).toBe('Glob');
    expect(canonicalize('find', { q: '*.json' })).toBe('Glob');
  });

  it('normalizes find inputs with filesystem-like payloads to Glob', () => {
    expect(canonicalize('find', { pattern: '**/*.ts', path: '.' })).toBe('Glob');
    expect(canonicalize('find', { pattern: 'package.json', directory: '/tmp' })).toBe('Glob');
    expect(canonicalize('find')).toBe('Glob');
  });

  it.each(['TaskCreate', 'TaskList', 'TaskUpdate', 'task'])('normalizes `%s` to Task', (toolName) => {
    expect(canonicalize(toolName)).toBe('Task');
  });

  it('infers Patch for delete-like inputs that include changes', () => {
    expect(canonicalize('delete', { changes: { 'foo.txt': { before: 'a', after: 'b' } } })).toBe('Patch');
  });

  it('infers MultiEdit for Edit inputs that carry edits[]', () => {
    expect(
      canonicalize('edit', {
        edits: [{ file_path: 'a.txt', old_string: 'a', new_string: 'b' }],
      }),
    ).toBe('MultiEdit');
  });

  it('infers Patch for Edit inputs that include changes', () => {
    expect(canonicalize('edit', { changes: { 'a.txt': { before: 'a', after: 'b' } } })).toBe('Patch');
  });

  it('infers Write for Edit inputs that contain full-file content', () => {
    expect(canonicalize('edit', { file_content: 'hello', file_path: 'a.txt' })).toBe('Write');
  });

  it('infers TodoWrite for write-like tool calls that carry todos', () => {
    expect(canonicalize('write', { title: 'Write todos' }, 'write_todos_1')).toBe('TodoWrite');
    expect(
      canonicalize('write', {
        todos: [{ id: 't1', content: 'x', status: 'pending', priority: 'low' }],
      }),
    ).toBe('TodoWrite');
  });

  it.each([
    { input: { url: 'https://example.com' }, expected: 'WebFetch' },
    { input: { query: 'who is the president' }, expected: 'WebSearch' },
  ])('normalizes fetch input to `$expected`', ({ input, expected }) => {
    expect(canonicalize('fetch', input)).toBe(expected);
  });

  it('detects Workspace Indexing Permission prompts emitted as Unknown tool', () => {
    expect(canonicalize('Unknown tool', { title: 'Workspace Indexing Permission' })).toBe('WorkspaceIndexingPermission');
  });
});
