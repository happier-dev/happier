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
      {
        id: 'cli',
        label: 'Happier CLI',
        version: '1.2.3',
        path: '/opt/happier/cli/current',
        realPath: '/opt/happier/cli/versions/1.2.3',
        status: 'on-path',
        ring: 'stable',
        shimName: 'happier',
      },
        ],
        services: [
      {
        id: 'daemon',
        label: 'Daemon',
        status: 'running',
        targetMode: 'default-following',
        ring: 'stable',
        path: '/Library/LaunchDaemons/com.happier.cli.daemon.plist',
        executablePath: '/opt/happier/cli/current/happier',
        linkedInstallationPath: '/opt/happier/cli/current',
        serverUrl: 'http://127.0.0.1:24512',
        publicServerUrl: 'https://relay.example.test',
      },
      {
        id: 'stack-runtime-service',
        label: 'Daemon service: com.happier.cli.daemon.stack_main_id_default',
        status: 'installed',
        targetMode: 'pinned',
        ring: 'stable',
        path: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.stack_main_id_default.plist',
        executablePath: '/Users/tester/.happier/stacks/main/cli/tools/js-runtime/current/bin/happier-js-runtime',
        linkedRuntimeTargetLabel: 'Stack runtime (main)',
        linkedRuntimeTargetPath: '/Users/tester/.happier/stacks/main/cli',
        serverUrl: 'http://127.0.0.1:34567',
        publicServerUrl: 'https://stack.example.test',
      },
        ],
        runtimeTargets: [
      {
        id: 'stack-runtime:/Users/tester/.happier/stacks/main/cli',
        kind: 'runtime-target',
        label: 'Stack runtime (main)',
        category: 'stack-runtime',
        path: '/Users/tester/.happier/stacks/main/cli',
        executablePath: '/Users/tester/.happier/stacks/main/cli/tools/js-runtime/current/bin/happier-js-runtime',
        linkedServiceLabels: ['Daemon service: com.happier.cli.daemon.stack_main_id_default'],
      },
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
    expect(output).toContain('[Runtime]\nBinary=/opt/happier/bin/happier');
    expect(output).toContain('Binary=/opt/happier/bin/happier');
    expect(output).toContain('[Installations]');
    expect(output).toContain('\n\n[Installations]\nHappier CLI (1.2.3)');
    expect(output).toContain('Happier CLI (1.2.3)');
    expect(output).toContain('Location=/opt/happier/cli/current');
    expect(output).toContain('Resolved=/opt/happier/cli/versions/1.2.3');
    expect(output).toContain('PATH=happier');
    expect(output).toContain('[Services]');
    expect(output).toContain('\n\n[Services]\nDaemon (running)');
    expect(output).toContain('Daemon (running)');
    expect(output).toContain('Mode=default background service');
    expect(output).toContain('Definition=/Library/LaunchDaemons/com.happier.cli.daemon.plist');
    expect(output).toContain('Executable=/opt/happier/cli/current/happier');
    expect(output).toContain('Installation=/opt/happier/cli/current');
    expect(output).toContain('Relay=https://relay.example.test');
    expect(output).toContain('Daemon service: com.happier.cli.daemon.stack_main_id_default (installed)');
    expect(output).toContain('Mode=legacy pinned background service');
    expect(output).toContain('Runtime=Stack runtime (main)');
    expect(output).toContain('Target=/Users/tester/.happier/stacks/main/cli');
    expect(output).toContain('[Additional Runtimes]');
    expect(output).toContain('\n\n[Additional Runtimes]\nStack runtime (main)');
    expect(output).toContain('Type=stack-runtime');
    expect(output).toContain('Location=/Users/tester/.happier/stacks/main/cli');
    expect(output).toContain('Services=Daemon service: com.happier.cli.daemon.stack_main_id_default');
    expect(output).not.toContain(' — ring:');
    expect(output).toContain('[Warnings]');
    expect(output).toContain('RING_MISMATCH: Daemon ring differs from invoked ring');
    expect(output).toContain('[Note]');
  });
});
