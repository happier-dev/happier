import { describe, expect, it } from 'vitest';

import { renderSupportReport } from './renderSupportReport';
import type { SupportReport } from '../types';

const report: SupportReport = {
  capturedAt: '2026-04-07T10:11:12.000Z',
  inventory: {
    invokedBinaryPath: '/opt/happier/bin/happier',
    invokedVersion: '1.2.3',
    nodeVersion: 'v22.0.0',
    platform: 'darwin',
    installations: [
      { id: 'cli', label: 'Happier CLI', version: '1.2.3', path: '/opt/happier/bin/happier' },
    ],
    services: [
      { id: 'daemon', label: 'Daemon', status: 'running', path: '/Library/LaunchDaemons/com.happier.cli.daemon.plist' },
    ],
    warnings: [
      { code: 'RING_MISMATCH', title: 'Daemon ring differs from invoked ring', severity: 'warning' },
    ],
    note: 'Please compare the live daemon against the CLI install.',
  },
};

describe('renderSupportReport', () => {
  it('renders the runtime, installation, service, and warning sections', () => {
    const output = renderSupportReport(report, {
      presentation: {
        banner: (title) => `banner:${title}`,
        bullets: (items) => items.map((item) => `* ${item}`).join('\n'),
        checklist: () => '',
        definitionList: (rows) => rows.map((row) => `${row.label}=${row.value}`).join('\n'),
        sectionTitle: (title) => `[${title}]`,
      },
    });

    expect(output).toContain('banner:Support diagnostics');
    expect(output).toContain('[Runtime]');
    expect(output).toContain('Binary=/opt/happier/bin/happier');
    expect(output).toContain('[Installations]');
    expect(output).toContain('Happier CLI (1.2.3)');
    expect(output).toContain('[Services]');
    expect(output).toContain('Daemon (running)');
    expect(output).toContain('[Warnings]');
    expect(output).toContain('RING_MISMATCH: Daemon ring differs from invoked ring');
    expect(output).toContain('[Note]');
  });
});
