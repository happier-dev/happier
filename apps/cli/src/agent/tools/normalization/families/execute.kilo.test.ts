import { describe, expect, it } from 'vitest';

import { normalizeBashResult } from './execute';

describe('normalizeBashResult (Kilo ACP shapes)', () => {
  it('maps { output, metadata.exit } to canonical { stdout, exit_code }', () => {
    const normalized = normalizeBashResult({
      output: 'TRACE_OK\n',
      metadata: { exit: 0, output: 'TRACE_OK\n', truncated: false },
    });

    expect(normalized.stdout).toBe('TRACE_OK\n');
    expect(normalized.exit_code).toBe(0);
  });

  it('prefers top-level output over metadata.output when both exist', () => {
    const normalized = normalizeBashResult({
      output: 'from-output',
      metadata: { output: 'from-metadata', exit: 7 },
    });

    expect(normalized.stdout).toBe('from-output');
    expect(normalized.exit_code).toBe(7);
  });

  it('extracts tagged return-code/output envelopes from stdout', () => {
    const normalized = normalizeBashResult(
      '<return-code>23</return-code>\n<output>\nhello\nworld\n</output>',
    );
    expect(normalized.exit_code).toBe(23);
    expect(normalized.stdout).toBe('hello\nworld');
  });
});
