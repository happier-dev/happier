import { describe, expect, it } from 'vitest';

import type { CliSessionRowModel } from '@/cli/output/session/buildCliSessionRowModel';
import { renderSessionListTable } from './renderSessionListTable';
import { resolveSessionSelectorColumnLayout } from './sessionTableLayout';

describe('renderSessionListTable', () => {
  it('does not exceed the provided terminal width (columns)', () => {
    const nowMs = 1_700_000_000_000;
    const rows: CliSessionRowModel[] = [
      {
        id: 'sess_12345678901234567890',
        agentId: 'claude',
        createdAt: nowMs - 10_000,
        updatedAt: nowMs - 1_000,
        active: false,
        activeAt: 0,
        archivedAt: null,
        tag: 'tag',
        title: 'A very long title that should be truncated when the terminal is narrow',
        path: '/a/very/long/path/that/should/be/truncated/when/the/terminal/is/narrow',
        isSystem: false,
        systemPurpose: null,
        vendorResume: { eligible: false, reasonCode: 'agent_unsupported' },
        encryptionMode: 'e2ee',
      },
    ];

    const columns = 60;
    const lines = renderSessionListTable({ rows, columns, nowMs });
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(columns);
    }
  });

  it('allocates enough width for selector column headers to stay on one line', () => {
    const layout = resolveSessionSelectorColumnLayout(120);

    expect(layout).not.toBeNull();
    expect(layout?.updatedWidth).toBeGreaterThanOrEqual('Updated'.length);
  });
});
