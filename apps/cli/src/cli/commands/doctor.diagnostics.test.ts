import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { configuration } from '@/configuration';
import { writeDaemonState } from '@/persistence';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { BugReportMachineDiagnosticsSnapshotSchema } from '@happier-dev/protocol/bugs/reports/machineDiagnostics';
import { handleDoctorCliCommand } from './doctor';

describe('doctor daemon diagnostics without a running daemon', () => {
  it('returns the selected redacted daemon tail and state without Account or session content', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-guest-diagnostics-' }, async () => {
      await mkdir(configuration.logsDir, { recursive: true });
      const daemonLogPath = join(configuration.logsDir, 'fixture-daemon.log');
      await writeFile(daemonLogPath, 'daemon failed to connect\nAuthorization: Bearer private-guest-token\n');
      await writeFile(join(configuration.logsDir, 'unrelated-session.log'), 'PRIVATE_SESSION_CONTENT');
      writeDaemonState({ pid: process.pid, httpPort: 1, startedAt: 1, startedWithCliVersion: 'fixture', daemonLogPath, machineId: 'guest-machine' });
      const output = captureConsoleJsonOutput<unknown>();
      try {
        await handleDoctorCliCommand({ args: ['doctor', '--json', '--include-daemon-log'], rawArgv: [], terminalRuntime: null });
        const result = BugReportMachineDiagnosticsSnapshotSchema.parse(output.json());
        const content = result.sessionDiagnostics?.logs.find(log => log.kind === 'daemon')?.artifact?.content;
        expect(content).toContain('daemon failed to connect');
        expect(content).not.toContain('private-guest-token');
        expect(result.daemonState?.startedWithCliVersion).toBe('fixture');
        expect(result.daemonState).toHaveProperty('machineId', 'guest-machine');
        expect(result.doctorSnapshot).toBeNull();
        expect(JSON.stringify(result)).not.toContain('PRIVATE_SESSION_CONTENT');
      } finally { output.restore(); }
    });
  });
});
