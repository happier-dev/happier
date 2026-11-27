import { mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { expect, it } from 'vitest';

import { startProjectDaemonFixture } from '../../src/testkit/daemon/projectDaemon';
import { createIsolatedFakeClaudeControlShim, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { repoRootDir } from '../../src/testkit/paths';
import { renderBundledDeclarationAsset } from '../../../../apps/cli/src/plugins/projection/registry/builtIn/declarationAssets';
import { decodeIndexedBundledDeclarationManifest } from '../../../../apps/cli/src/plugins/projection/registry/builtIn/declarationAssetFormat.mjs';

it('starts source Sessions before and after rewriting a bundled Agent declaration under the same daemon', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'bundled-declaration-drift-'));
  const root = repoRootDir();
  const manifestPath = join(root, 'apps/cli/assets/bundled-plugin-manifests/claude.json');
  const replacement = join(testDir, 'claude.json');
  const preload = join(testDir, 'bundled-declaration.cjs');
  const fixture = await startProjectDaemonFixture({
    testDir,
    dbProvider: 'sqlite',
    daemonAuthentication: 'existing-terminal',
    personActionSurface: 'coreAction',
  });
  try {
    const account = await fixture.createAccount('declaration-drift-owner');
    const native = await createIsolatedFakeClaudeControlShim({
      testDir: join(testDir, 'native'),
      captureEnvironmentKeys: [],
      logFullStdin: true,
    });
    const original = await readFile(manifestPath);
    await writeFile(replacement, original);
    // Redirect just this declaration's filesystem reads in the fixture daemon
    // and its child runners. The shared checkout's generated assets stay intact.
    await writeFile(preload, `
      const fs = require('node:fs');
      const read = fs.openSync;
      fs.openSync = (path, ...options) => read(path === ${JSON.stringify(manifestPath)}
        ? ${JSON.stringify(replacement)} : path, ...options);
      require('node:module').syncBuiltinESMExports();
    `);
    const machine = await fixture.enrollDaemon(account, {
      env: {
        HAPPIER_CLAUDE_PATH: native.executablePath,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require="${preload}"`].filter(Boolean).join(' '),
      },
      cliLaunchSpec: {
        command: process.execPath,
        args: ['--import', join(root, 'packages/cli-common/registerSourceRuntime.mjs'), join(root, 'apps/cli/src/index.ts')],
        cwd: root,
      },
    });

    for (const phase of ['original declaration', 'rewritten declaration']) {
      if (phase === 'rewritten declaration') {
        const changed = decodeIndexedBundledDeclarationManifest(original) as {
          contributes: { agents: { title: string }[] };
        };
        changed.contributes.agents[0]!.title += ' (rewritten)';
        const next = `${replacement}.next`;
        await writeFile(next, renderBundledDeclarationAsset(JSON.stringify(changed)));
        await rename(next, replacement);
      }
      const spawned = await account.executeAsPerson('session.spawn_new', {
        executionTarget: machine.target,
        directory: { kind: 'path', path: machine.workspaceDir },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        connectedServices: { v: 2, bindingsByServiceId: {} },
        terminal: { mode: 'plain' },
      });
      if (!spawned.ok) throw new Error(`${phase}: ${spawned.errorCode} (${spawned.error})`);
      const session = SessionSpawnNewActionResultV1Schema.parse(spawned.result);
      if (session.type !== 'success') throw new Error(`${phase}: ${session.type}`);
      const prompt = `Confirm the source Session is ready with the ${phase}.`;
      expect(await account.execute('session.message.send', { sessionId: session.sessionId, message: prompt }), phase)
        .toMatchObject({ ok: true });
      await waitForFakeClaudeUserText(native.logPath, text => text.includes(prompt));
    }
  } finally {
    await fixture.stop();
  }
}, 0);
