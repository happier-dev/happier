import { describe, expect, it } from 'vitest';

import { runSupportCli } from './runSupportCli';
import type { SupportRuntimeInventory } from '../types';

const inventory: SupportRuntimeInventory = {
  invokedBinaryPath: '/opt/happier/bin/happier',
  invokedVersion: '1.2.3',
  nodeVersion: 'v22.0.0',
  platform: 'linux',
  installations: [],
  services: [],
  warnings: [],
};

describe('runSupportCli', () => {
  it('renders collect output through the shared presentation surface', async () => {
    const writes: string[] = [];
    const result = await runSupportCli(['collect'], {
      collectRuntimeInventory: () => inventory,
      stdout: { write: (text) => writes.push(text) },
      stderr: { write: () => {} },
      presentation: {
        banner: (title) => `banner:${title}`,
        bullets: (items) => items.map((item) => `* ${item}`).join('\n'),
        checklist: () => '',
        definitionList: (rows) => rows.map((row) => `${row.label}=${row.value}`).join('\n'),
        sectionTitle: (title) => `[${title}]`,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(writes.join('')).toContain('banner:Support diagnostics');
    expect(writes.join('')).toContain('[Runtime]');
  });

  it('prints collected support data as JSON when requested', async () => {
    const writes: string[] = [];
    const result = await runSupportCli(['collect', '--json'], {
      collectRuntimeInventory: () => inventory,
      stdout: { write: (text) => writes.push(text) },
      stderr: { write: () => {} },
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        inventory: expect.objectContaining({
          invokedBinaryPath: '/opt/happier/bin/happier',
        }),
      }),
    );
    expect(writes.join('')).toContain('"invokedBinaryPath"');
  });

  it('dispatches submit through the support submit flow', async () => {
    const writes: string[] = [];
    let capturedTitle = '';
    let capturedSummary = '';
    let capturedAppVersion = '';
    let capturedNote = '';
    const result = await runSupportCli([
      'submit',
      '--provider-url',
      'https://support.example.com',
      '--title',
      'Crash on launch',
      '--summary',
      'Daemon crashes on launch',
      '--note',
      'note for support bundle',
    ], {
      collectRuntimeInventory: () => inventory,
      submitSupportReport: async (input) => {
        capturedTitle = input.form.title;
        capturedSummary = input.form.summary;
        capturedAppVersion = input.form.environment.appVersion;
        capturedNote = input.report.inventory.note ?? '';
        return { reportId: 'support-1', issueNumber: 12, issueUrl: 'https://example.com/12' };
      },
      stdout: { write: (text) => writes.push(text) },
      stderr: { write: () => {} },
    });

    expect(result.exitCode).toBe(0);
    expect(capturedTitle).toBe('Crash on launch');
    expect(capturedSummary).toBe('Daemon crashes on launch');
    expect(capturedAppVersion).toBe('1.2.3');
    expect(capturedNote).toBe('note for support bundle');
    expect(writes.join('')).toContain('Submitted support report support-1');
  });
});
