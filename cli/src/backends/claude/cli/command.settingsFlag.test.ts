import { describe, expect, it, vi } from 'vitest';

import { stripHappyInternalSettingsFlag } from './command';

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('stripHappyInternalSettingsFlag', () => {
  it('removes --settings and its value and warns', () => {
    const warn = vi.fn<(msg: string) => void>();
    const args = ['--resume', '--settings', '/tmp/happy.json', '--foo', 'bar'];

    const out = stripHappyInternalSettingsFlag(args, { warn });

    expect(out).toEqual(['--resume', '--foo', 'bar']);
    expect(args).toEqual(['--resume', '--settings', '/tmp/happy.json', '--foo', 'bar']);

    const warnings = warn.mock.calls.map(([msg]) => stripAnsi(String(msg))).join('\n');
    expect(warnings).toContain('--settings');
    expect(warnings).toContain('/tmp/happy.json');
  });

  it('removes --settings when value is missing', () => {
    const warn = vi.fn<(msg: string) => void>();
    const args = ['--settings'];

    const out = stripHappyInternalSettingsFlag(args, { warn });

    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

