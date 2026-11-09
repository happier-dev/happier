import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { projectPath } from '@/projectPath';

import {
  DAEMON_PUBLIC_RELEASE_CHANNEL_LABELS,
  DAEMON_STARTUP_SOURCE_VALUES,
  DaemonPublicReleaseChannelLabelSchema,
  DaemonStartupSourceSchema,
  resolveDaemonStartupSourceFromEnv,
  resolveDaemonStartupSourceServiceManagedState,
} from './daemonOwnershipMetadata';

describe('daemon ownership scalar import demand', () => {
  it('validates ownership scalars without loading publication or installation-signing authorities', async () => {
    const cliRoot = projectPath();
    const { build } = createRequire(join(cliRoot, 'package.json'))('esbuild') as typeof import('esbuild');
    const entryPoint = 'src/daemon/ownership/daemonOwnershipMetadata.ts';
    const { metafile } = await build({
      absWorkingDir: cliRoot, entryPoints: [entryPoint], outdir: 'unused-ownership-graph',
      platform: 'node', format: 'esm', bundle: true, write: false, metafile: true,
      conditions: ['happier-source'], logLevel: 'silent',
    });
    const inputs = metafile!.inputs;
    const eager = new Set<string>();
    const visit = (path: string) => {
      if (eager.has(path)) return;
      eager.add(path);
      for (const dependency of inputs[path]!.imports) {
        if (!dependency.external && dependency.kind !== 'dynamic-import') visit(dependency.path);
      }
    };
    visit(entryPoint);
    const eagerAuthorities = [...eager].filter(path => /\/machines\/(?:machinePublishedContentV1|identity\/installationIdentity)\.ts$/.test(path.replaceAll('\\', '/')));
    console.info(JSON.stringify({ eagerAuthorities: eagerAuthorities.length, eagerInputs: eager.size }));
    expect(eagerAuthorities).toEqual([]);

    for (const channel of DAEMON_PUBLIC_RELEASE_CHANNEL_LABELS) {
      expect(DaemonPublicReleaseChannelLabelSchema.parse(channel)).toBe(channel);
    }
    for (const source of DAEMON_STARTUP_SOURCE_VALUES) {
      expect(DaemonStartupSourceSchema.parse(source)).toBe(source);
    }
    for (const invalid of [undefined, null, '', 'unsupported']) {
      expect(DaemonPublicReleaseChannelLabelSchema.safeParse(invalid).success).toBe(false);
      expect(DaemonStartupSourceSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe('resolveDaemonStartupSourceFromEnv', () => {
  it('defaults to manual when only service metadata env is present', () => {
    expect(
      resolveDaemonStartupSourceFromEnv({
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
      } as NodeJS.ProcessEnv),
    ).toBe('manual');
  });

  it('honors an explicit background-service startup source marker', () => {
    expect(
      resolveDaemonStartupSourceFromEnv({
        HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service',
        HAPPIER_DAEMON_SERVICE_INSTANCE_ID: 'cloud',
        HAPPIER_DAEMON_SERVICE_TARGET_MODE: 'default-following',
      } as NodeJS.ProcessEnv),
    ).toBe('background-service');
  });
});

describe('resolveDaemonStartupSourceServiceManagedState', () => {
  it('treats legacy daemon state without a service label as manual', () => {
    expect(resolveDaemonStartupSourceServiceManagedState(undefined, undefined)).toBe(false);
    expect(resolveDaemonStartupSourceServiceManagedState('unknown', undefined)).toBe(false);
  });

  it('treats legacy daemon state with a service label as service-managed', () => {
    expect(resolveDaemonStartupSourceServiceManagedState(undefined, 'com.happier.cli.daemon.default')).toBe(true);
    expect(resolveDaemonStartupSourceServiceManagedState('unknown', 'com.happier.cli.daemon.default')).toBe(true);
  });
});
