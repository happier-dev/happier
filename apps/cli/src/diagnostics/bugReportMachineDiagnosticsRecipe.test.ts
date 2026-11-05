import { describe, expect, it } from 'vitest';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { configuration } from '@/configuration';
import { collectBugReportMachineDiagnosticsSnapshot } from './bugReportMachineDiagnostics';

describe('selected bug report machine diagnostics', () => {
  it('includes the doctor snapshot when machine diagnostics are requested', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-requested-doctor-' }, async () => {
      const result = await collectBugReportMachineDiagnosticsSnapshot();
      expect(result.doctorSnapshot?.server.serverUrl).toBe(configuration.serverUrl);
      expect(result.doctorSnapshot?.accountId).toBeNull();
    });
  });
});
