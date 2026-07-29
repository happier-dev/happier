import { describe, expect, it } from 'vitest';

import { resolveHappierServiceRuntimeTarget } from './resolveServiceRuntimeTarget.js';
import type { HappierInstallation, HappierService } from './types.js';

const baseService: HappierService = {
  id: 'daemon:stable:cloud',
  serviceType: 'daemon',
  platform: 'darwin',
  backend: 'launchd',
  label: 'com.happier.cli.daemon.cloud',
  verification: 'verified',
  ring: 'stable',
  instanceId: 'cloud',
  scope: 'user',
  definitionPath: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.cloud.plist',
  executablePath: null,
  installed: true,
  running: false,
};

describe('resolveHappierServiceRuntimeTarget', () => {
  it('matches service executables back to managed installations first', () => {
    const installations: HappierInstallation[] = [
      {
        id: 'managed:stable:/Users/tester/.happier/cli/current',
        source: 'firstPartyManaged',
        components: ['happier-cli', 'happier-daemon'],
        ring: 'stable',
        version: '1.2.3',
        path: '/Users/tester/.happier/cli/current',
        realPath: '/Users/tester/.happier/cli/versions/1.2.3',
        shimName: 'happier',
        onPath: true,
        managedRoot: '/Users/tester/.happier/cli',
      },
    ];

    const target = resolveHappierServiceRuntimeTarget({
      service: {
        ...baseService,
        executablePath: '/Users/tester/.happier/cli/current/happier',
      },
      installations,
    });

    expect(target).toEqual({
      id: 'installation:managed:stable:/Users/tester/.happier/cli/current',
      kind: 'installation',
      label: '/Users/tester/.happier/cli/current',
      path: '/Users/tester/.happier/cli/current',
      executablePath: '/Users/tester/.happier/cli/current/happier',
      installationId: 'managed:stable:/Users/tester/.happier/cli/current',
      installationPath: '/Users/tester/.happier/cli/current',
    });
  });

  it('classifies stack runtime and source checkout targets when no installation matches', () => {
    const stackRuntimeTarget = resolveHappierServiceRuntimeTarget({
      service: {
        ...baseService,
        id: 'daemon:stack',
        executablePath: '/Users/tester/.happier/stacks/main/cli/tools/js-runtime/current/bin/happier-js-runtime',
      },
      installations: [],
    });
    const sourceCheckoutTarget = resolveHappierServiceRuntimeTarget({
      service: {
        ...baseService,
        id: 'daemon:source',
        executablePath: '/Users/tester/Documents/Development/happier/dev/apps/cli/package-dist/index.mjs',
      },
      installations: [],
    });

    expect(stackRuntimeTarget).toEqual({
      id: 'stack-runtime:/Users/tester/.happier/stacks/main/cli',
      kind: 'stack-runtime',
      label: 'Stack runtime (main)',
      path: '/Users/tester/.happier/stacks/main/cli',
      executablePath: '/Users/tester/.happier/stacks/main/cli/tools/js-runtime/current/bin/happier-js-runtime',
      installationId: null,
      installationPath: null,
    });
    expect(sourceCheckoutTarget).toEqual({
      id: 'source-checkout:/Users/tester/Documents/Development/happier/dev',
      kind: 'source-checkout',
      label: 'Source checkout (dev)',
      path: '/Users/tester/Documents/Development/happier/dev',
      executablePath: '/Users/tester/Documents/Development/happier/dev/apps/cli/package-dist/index.mjs',
      installationId: null,
      installationPath: null,
    });
  });

  it('recognizes managed js runtime targets on windows-style paths', () => {
    const target = resolveHappierServiceRuntimeTarget({
      service: {
        ...baseService,
        platform: 'win32',
        backend: 'schtasks-user',
        executablePath: 'C:\\Users\\tester\\AppData\\Local\\happier\\tools\\js-runtime\\current\\bin\\happier-js-runtime.exe',
      },
      installations: [],
    });

    expect(target).toEqual({
      id: 'managed-js-runtime:C:/Users/tester/AppData/Local/happier/tools/js-runtime/current',
      kind: 'managed-js-runtime',
      label: 'Managed JS runtime',
      path: 'C:/Users/tester/AppData/Local/happier/tools/js-runtime/current',
      executablePath: 'C:/Users/tester/AppData/Local/happier/tools/js-runtime/current/bin/happier-js-runtime.exe',
      installationId: null,
      installationPath: null,
    });
  });

  it('matches Windows installation roots without case-sensitive path identity', () => {
    const installations: HappierInstallation[] = [{
      id: 'managed:stable:C:/Users/Tester/AppData/Local/happier/cli/current',
      source: 'firstPartyManaged',
      components: ['happier-cli', 'happier-daemon'],
      ring: 'stable',
      version: '1.2.3',
      path: 'C:\\Users\\Tester\\AppData\\Local\\happier\\cli\\current',
      realPath: 'C:\\Users\\Tester\\AppData\\Local\\happier\\cli\\versions\\1.2.3',
      shimName: 'happier.exe',
      onPath: true,
      managedRoot: 'C:\\Users\\Tester\\AppData\\Local\\happier\\cli',
    }];

    expect(resolveHappierServiceRuntimeTarget({
      service: {
        ...baseService,
        platform: 'win32',
        backend: 'schtasks-user',
        executablePath: 'c:\\users\\tester\\appdata\\local\\happier\\cli\\current\\happier.exe',
      },
      installations,
    })).toMatchObject({
      kind: 'installation',
      installationId: installations[0]?.id,
    });
  });
});
