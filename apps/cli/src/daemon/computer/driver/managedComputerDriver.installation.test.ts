import { describe, expect, it, vi } from 'vitest';
import { native } from './nativeComputerBoundary.testkit';
import { createComputerRoutes } from '../routes';
import { createMachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';

const { download } = vi.hoisted(() => ({ download: vi.fn(async () => { throw new Error('Installation was not admitted'); }) }));
// The network download is the external boundary; discovery and install policy stay real.
vi.mock('@happier-dev/cli-common/agents', async importOriginal => ({
  ...await importOriginal<typeof import('@happier-dev/cli-common/agents')>(), downloadGitHubReleaseAsset: download,
}));

describe.skipIf(process.platform !== 'linux')('computer driver first-use policy', () => {
  it.each(['present_user', 'account_automation'] as const)('does not download a missing driver on %s picker entry', async authority => {
    const routes = createComputerRoutes({ machineId: 'machine', registry: createMachineLiveStreamCaptureRegistry(), defaultDisplayId: ':73' });
    try {
      expect(await routes.dispatch('computer.targets.list', { machineId: 'machine' },
        { authority, defaultSessionId: 'first-use', bypassApprovals: true }))
        .toMatchObject({ ok: false, errorCode: 'computer_provider_unavailable' });
      expect(download).not.toHaveBeenCalled();
      expect(native.instances).toHaveLength(0);
    } finally { await routes.dispose(); }
  });
});
