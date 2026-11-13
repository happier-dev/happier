import { describe, it } from 'vitest';
import { exercisePublicPackagePlanApply } from '@/testkit/machines/nativeSoftwareInstallFlow';

describe('ApiMachine own Session Account read custody', () => {
  it.skipIf(process.platform === 'win32')('installs the whole native software recipe once after in-flow confirmation under the default Ask policy', async () => {
    await exercisePublicPackagePlanApply('native-confirm');
  });
  it.skipIf(process.platform === 'win32')('installs once after the exact native review satisfies saved Require without another Ask', async () => {
    await exercisePublicPackagePlanApply('native-confirm', true);
  });
});
