import { describe, expect, it } from 'vitest';

import { normalizeReadResult } from './read';

type NormalizedReadFile = {
  content?: string;
  startLine?: number;
  numLines?: number;
  totalLines?: number;
};

function expectFile(value: Record<string, unknown>): NormalizedReadFile {
  const file = value.file;
  expect(file && typeof file === 'object' && !Array.isArray(file)).toBe(true);
  return file as NormalizedReadFile;
}

describe('normalizeReadResult (Kilo ACP shapes)', () => {
  it('maps { output } wrappers to { file.content }', () => {
    const normalized = normalizeReadResult({
      output: ['<file>', '00001| hi', '', '(End of file - total 1 lines)', '</file>'].join('\n'),
      metadata: { exit: 0 },
    });

    const file = expectFile(normalized);
    expect(file.content).toBe('hi');
    expect(file.startLine).toBe(1);
    expect(file.totalLines).toBe(1);
  });

  it('falls back to metadata.output when output is absent', () => {
    const normalized = normalizeReadResult({
      metadata: { output: ['<file>', '00002| from metadata', '</file>'].join('\n') },
    });

    const file = expectFile(normalized);
    expect(file.content).toBe('from metadata');
    expect(file.startLine).toBe(2);
  });

  it('prefers output over metadata.output when both are present', () => {
    const normalized = normalizeReadResult({
      output: ['<file>', '00001| preferred', '</file>'].join('\n'),
      metadata: { output: ['<file>', '00001| ignored', '</file>'].join('\n') },
    });

    const file = expectFile(normalized);
    expect(file.content).toBe('preferred');
  });
});
