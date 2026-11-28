import { describe, expect, it } from 'vitest';

import { normalizeEditInput } from './edit';
import { normalizeBashInput } from './execute';
import { normalizeReadInput } from './read';
import { normalizeWriteInput } from './write';
import { canonicalizeToolNameV2 } from '../index';

// Input shapes `agy acp` 1.5.18 sends for run_command, view_file and replace_file_content.
describe('agy tool inputs', () => {
  it('reads the shell command from CommandLine', () => {
    expect(normalizeBashInput({ CommandLine: 'npm test', WaitMsBeforeAsync: 500, IsDaemon: false }))
      .toMatchObject({ command: 'npm test' });
  });

  it('reads the file path from Path', () => {
    expect(normalizeReadInput({ Path: '/repo/a.ts', StartLine: 1, EndLine: 20 })).toMatchObject({ file_path: '/repo/a.ts' });
  });

  it('reads the edited path and replaced text from Path, Target and Replacement', () => {
    expect(normalizeEditInput({ Path: '/repo/a.ts', Target: 'const a = 1;', Replacement: 'const a = 2;' }))
      .toMatchObject({ file_path: '/repo/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' });
  });

  it('treats an edit that sends the whole file as Content as a write of that file', () => {
    const input = { Path: '/repo/b.ts', Content: 'export {};\n', Overwrite: true };
    expect(canonicalizeToolNameV2({ protocol: 'acp', toolName: 'edit', toolInput: input })).toBe('Write');
    expect(normalizeWriteInput(input)).toMatchObject({ file_path: '/repo/b.ts', content: 'export {};\n' });
  });
});
