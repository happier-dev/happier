import { describe, it } from 'vitest';
import { exercisePublicPackagePlanApply } from '@/testkit/machines/nativeSoftwareInstallFlow';

describe('Machine setup Apply settlement', () => {
  it.skipIf(process.platform === 'win32').each(['plain', 'e2ee'] as const)('settles a %s reviewed Apply through the installed daemon and native package effect', async mode => {
    await exercisePublicPackagePlanApply('native-confirm', true, undefined, undefined, undefined, mode);
  });
});
