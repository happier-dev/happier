import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { projectAgentCliRuntimeSpec } from '@happier-dev/agents/cli/runtime';
import { planAgentCliInstallForRuntime } from '@happier-dev/cli-common/agents';

import { createAgentInstallJobOwner } from '@/capabilities/installJobs/agentInstallJobOwner';
import { museCliSupport } from './cli.js';

describe('Muse setup through the shared Machine installer', () => {
  it('installs Muse through the ordinary vendor recipe on every supported platform', () => {
    const runtimeSpec = projectAgentCliRuntimeSpec('muse', museCliSupport)!;
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const result = planAgentCliInstallForRuntime({ runtimeSpec, platform });
      expect(result).toMatchObject({ ok: true, plan: {
        installMode: 'vendor_recipe', managedInstall: null,
      } });
    }
  });
  it.each(['linux', 'darwin', 'win32'] as const)(
    'admits the one Muse install identity on %s and requires vendor-recipe consent',
    async platform => {
      const root = await mkdtemp(join(tmpdir(), 'happier-muse-install-'));
      const executed: string[] = [];
      // Only OS execution is replaced; registry projection, install admission,
      // platform support, consent and job settlement remain the real owners.
      const owner = createAgentInstallJobOwner({
        platform,
        env: { HOME: root, HAPPIER_HOME_DIR: root, LOCALAPPDATA: root, PATH: '' },
        readTrackedSessions: () => [],
        installerDeps: {
          async execFileWithDeadline(command) {
            executed.push(command);
            throw new Error('Unapproved vendor recipe reached the OS boundary');
          },
        },
      });
      try {
        const started = owner.start({ agentId: 'muse', intent: 'install', consent: { vendorRecipe: false } });
        expect(started, 'Selected Muse must have an installable declaration in the canonical registry').toMatchObject({ ok: true });
        if (!started.ok) return;
        await expect.poll(() => owner.read({ jobId: started.jobId, cursor: 0 })).toMatchObject({
          ok: true,
          done: true,
          outcome: { kind: 'failed', code: 'consent_required', stepId: 'cli.muse' },
        });
        expect(owner.list()).toMatchObject({ jobs: [{ agentId: 'muse' }] });
        expect(executed).toEqual([]);
      } finally {
        await owner.shutdown();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
