import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { projectAgentPreflightSessionControlsCatalogEntry } from '@/plugins/projection/registry/agentCatalogEntryHooks';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';

import { probeAgentConfigOptionsBestEffort } from './agentConfigOptionsProbe';
import { probeAgentModelsBestEffort } from './agentModelsProbe';
import { probeAgentModesBestEffort } from './agentModesProbe';
import { invokeCliPreflightMethod } from './agentPreflight';
import { preflightCatalogEntryFixture } from './preflightSessionControlsProbeAdapter.testkit';

afterAll(async () => { await pluginReloadController.shutdown(); });

it.each(['models', 'modes', 'configOptions', 'preflight'] as const)(
  'runs %s probes with each hosted Session environment and directory', async kind => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-hosted-probe-')));
    try {
      const directories = [join(root, 'first'), join(root, 'second')];
      await Promise.all(directories.map(directory => mkdir(directory)));
      const script = join(root, 'observe.cjs');
      await writeFile(script, 'process.stdout.write(JSON.stringify({ home: process.env.HOME, cwd: process.cwd() }));');
      const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
      const executable = writeExecutableShimSync({ dir: root,
        fileName: process.platform === 'win32' ? 'observe.cmd' : 'observe',
        contents: process.platform === 'win32'
          ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
          : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
      });
      const projected = projectAgentPreflightSessionControlsCatalogEntry({
        agentId: 'opencode',
        systemTools: [{ id: 'observe', title: 'Observe native context', executableNames: [executable] }],
        preflightSessionControls: {
          models: { command: { toolId: 'observe', args: [] },
            parseOutput: result => [{ id: 'observed', name: result.stdout.trim() }] },
          probeModes: async context => {
            const result = await context.runDeclaredSystemToolCommand({ toolId: 'observe', args: [] });
            return [{ id: 'observed', name: result.stdout.trim() }];
          },
          probeConfigOptions: async context => {
            const result = await context.runDeclaredSystemToolCommand({ toolId: 'observe', args: [] });
            const observed = result.stdout.trim();
            return [{ id: 'observed', name: 'Native context', type: 'select' as const,
              currentValue: observed, options: [{ value: observed, name: observed }] }];
          },
        },
        retirementSignal: new AbortController().signal,
        isCurrent: () => true,
      });
      const adapter = await projected.getPreflightSessionControlsProbeAdapter?.();
      if (!adapter) throw new Error('Missing native preflight adapter');
      const catalogEntry = preflightCatalogEntryFixture('opencode', adapter);
      const observations = await Promise.all(directories.map(directory => runAddedHostedSession({
        environment: { ...process.env, HOME: directory, USERPROFILE: directory },
        workingDirectory: directory,
        end: () => undefined,
      }, async () => {
        const params = { agentId: 'opencode', catalogEntry, cwd: '' };
        switch (kind) {
          case 'models': return await probeAgentModelsBestEffort({ ...params, bypassCache: true });
          case 'modes': return await probeAgentModesBestEffort(params);
          case 'configOptions': return await probeAgentConfigOptionsBestEffort(params);
          case 'preflight': return await invokeCliPreflightMethod('opencode', 'probeModels', { bypassCache: true },
            { agentCatalogEntry: catalogEntry, accountContext: { credentials: null, accountSettings: null } }, {});
        }
      })));
      for (const [index, observation] of observations.entries()) {
        const expected = JSON.stringify({ home: directories[index], cwd: directories[index] });
        if (kind === 'preflight') expect(observation).toMatchObject({ ok: true,
          result: { source: 'dynamic', availableModels: expect.arrayContaining([{ id: 'observed', name: expected }]) } });
        else if (kind === 'models') expect(observation).toMatchObject({ source: 'dynamic',
          availableModels: expect.arrayContaining([{ id: 'observed', name: expected }]) });
        else if (kind === 'modes') expect(observation).toMatchObject({ source: 'dynamic',
          availableModes: expect.arrayContaining([{ id: 'observed', name: expected }]) });
        else expect(observation).toMatchObject({ source: 'dynamic',
          configOptions: expect.arrayContaining([expect.objectContaining({ id: 'observed', currentValue: expected })]) });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000,
);
