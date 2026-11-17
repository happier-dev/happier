import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIRST_PARTY_INSTALL_HOME_ENV_KEY, resolveFirstPartyInstallLayout } from '@happier-dev/cli-common/firstPartyRuntime';
import type { AgentLaunchPayload } from './agentLaunchFrame';
import { resolveAgentLaunchRuntimeCustody } from './agentLaunchAccountSettings';

const payload = (environment: Record<string, string>): AgentLaunchPayload => ({ v: 1, executable: '/bin/true', args: [],
  cwd: '/', runtimeHome: '/member/runtime', environment, selectedMaterials: [] });

describe('agent launch runtime custody', () => {
  it('identifies a machine-wide managed install from the frame when the RunAs member HOME is unrelated', () => {
    const installHome = mkdtempSync(join(tmpdir(), 'happier-machine-install-'));
    const memberHome = mkdtempSync(join(tmpdir(), 'happier-member-home-'));
    // sudo scrubs the daemon environment; only the member's own HOME remains.
    const memberEnv = { HOME: memberHome, HAPPIER_HOME_DIR: memberHome };
    const layout = resolveFirstPartyInstallLayout({ componentId: 'happier-cli', channel: 'stable',
      processEnv: { ...memberEnv, [FIRST_PARTY_INSTALL_HOME_ENV_KEY]: installHome } });
    try {
      mkdirSync(join(layout.versionsDir, 'version-a', 'package-dist'), { recursive: true });
      writeFileSync(join(layout.installRoot, 'current.version'), 'version-a\n', 'utf8');
      const authority = { moduleUrl: pathToFileURL(join(layout.currentPath, 'package-dist', 'chunk.js')).href,
        currentExecPath: join(layout.currentPath, 'happier'), argv: [join(layout.currentPath, 'happier'), 'agent-launch'],
        processEnv: memberEnv };
      expect(resolveAgentLaunchRuntimeCustody(payload({ [FIRST_PARTY_INSTALL_HOME_ENV_KEY]: installHome }), authority)).toMatchObject({
        root: realpathSync(join(layout.versionsDir, 'version-a')),
        packagedRuntime: { kind: 'cli_version_root', versionRootId: 'version-a' },
      });
    } finally {
      rmSync(installHome, { recursive: true, force: true });
      rmSync(memberHome, { recursive: true, force: true });
    }
  });
});
