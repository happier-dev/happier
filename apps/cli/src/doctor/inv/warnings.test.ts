import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

describe('readDoctorWarnings', () => {
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    vi.resetModules();
  });

  it('reports duplicate Home identity profiles without claiming credentials moved', async () => {
    await withTempDir('happier-doctor-home-conflict-', async (homeDir) => {
      envScope.patch({ HAPPIER_HOME_DIR: homeDir });
      vi.resetModules();
      const { updateSettings } = await import('@/persistence');
      const descriptor = {
        v: 1 as const,
        homeServerIdentityId: 'srv_doctor_conflict',
        canonicalServerUrl: 'https://one.example.test',
        revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'https://one.example.test' }],
      };
      const profile = (id: string, serverUrl: string) => ({
        id,
        name: id,
        serverUrl,
        webappUrl: serverUrl,
        createdAt: 1,
        updatedAt: 1,
        homeConnectionDescriptor: {
          ...descriptor,
          canonicalServerUrl: serverUrl,
          endpoints: [{ kind: 'https' as const, url: serverUrl }],
        },
      });
      await updateSettings((current) => ({
        ...current,
        servers: {
          ...current.servers,
          one: profile('one', 'https://one.example.test'),
          two: profile('two', 'https://two.example.test'),
        },
      }));

      const { readDoctorWarnings } = await import('./warnings');
      const warnings = await readDoctorWarnings({});

      expect(warnings).toContainEqual({
        code: 'homeIdentityProfileConflict',
        severity: 'warning',
        message: expect.stringMatching(/srv_doctor_conflict.*one, two.*Credentials were not moved/u),
        repairCommands: ['happier server list'],
      });
    });
  });
});
