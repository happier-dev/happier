import { describe, expect, it } from 'vitest';

import { buildHappierRuntimeWarnings } from './buildHappierRuntimeWarnings.js';
import type { HappierInstallationInventory, HappierServiceInventory } from '../types.js';

describe('buildHappierRuntimeWarnings', () => {
  it('emits service-side warnings for pinned conflicts and orphan daemon services', () => {
    const installations: HappierInstallationInventory = {
      activeInvocation: {
        path: '/opt/happier/bin/happier',
        realPath: '/opt/happier/bin/happier',
        invokerName: 'happier',
        ring: 'stable',
        version: '1.2.3',
        installationId: 'managed:stable:/opt/happier/cli/current',
      },
      installations: [
        {
          id: 'managed:stable:/opt/happier/cli/current',
          source: 'firstPartyManaged',
          components: ['happier-cli', 'happier-daemon'],
          ring: 'stable',
          version: '1.2.3',
          path: '/opt/happier/cli/current',
          realPath: '/opt/happier/cli/current',
          shimName: 'happier',
          onPath: true,
          managedRoot: '/opt/happier/cli',
        },
      ],
    };
    const services: HappierServiceInventory = {
      services: [
        {
          id: 'service:stable:cloud:1',
          serviceType: 'daemon',
          platform: 'linux',
          backend: 'systemd-user',
          label: 'happier-daemon.cloud',
          verification: 'verified',
          targetMode: 'pinned',
          ring: 'stable',
          instanceId: 'cloud',
          scope: 'user',
          definitionPath: '/tmp/happier-daemon.cloud.service',
          executablePath: '/opt/happier/cli/current/happier',
          installed: true,
          running: true,
          serverUrl: 'https://cloud.example.test',
          publicServerUrl: 'https://cloud.example.test',
        },
        {
          id: 'service:stable:cloud:2',
          serviceType: 'daemon',
          platform: 'linux',
          backend: 'systemd-user',
          label: 'happier-daemon',
          verification: 'verified',
          targetMode: 'pinned',
          ring: 'stable',
          instanceId: 'cloud',
          scope: 'user',
          definitionPath: '/tmp/happier-daemon.service',
          executablePath: '/opt/happier/cli/current/happier',
          installed: true,
          running: false,
          serverUrl: 'https://cloud.example.test',
          publicServerUrl: 'https://cloud.example.test',
        },
        {
          id: 'service:preview:preview',
          serviceType: 'daemon',
          platform: 'linux',
          backend: 'systemd-user',
          label: 'happier-daemon.preview.preview',
          verification: 'verified',
          targetMode: 'pinned',
          ring: 'preview',
          instanceId: 'preview',
          scope: 'user',
          definitionPath: '/tmp/happier-daemon.preview.preview.service',
          executablePath: '/tmp/orphaned/happier',
          installed: true,
          running: true,
          serverUrl: 'https://preview.example.test',
          publicServerUrl: 'https://preview.example.test',
        },
      ],
    };

    const warnings = buildHappierRuntimeWarnings({ installations, services });
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'CONFLICTING_PINNED_DAEMON_SERVICES_FOR_SERVER',
        repairCommands: ['happier service repair --dry-run', 'happier service list --json'],
      }),
      expect.objectContaining({ code: 'ORPHAN_DAEMON_SERVICE' }),
    ]));
  });

  it('does not treat pinned and default-following services as the same tuple', () => {
    const installations: HappierInstallationInventory = {
      activeInvocation: null,
      installations: [],
    };
    const services: HappierServiceInventory = {
      services: [
        {
          id: 'service:default',
          serviceType: 'daemon',
          platform: 'linux',
          backend: 'systemd-user',
          label: 'happier-daemon.default',
          verification: 'verified',
          targetMode: 'default-following',
          ring: null,
          instanceId: null,
          scope: 'user',
          definitionPath: '/tmp/happier-daemon.default.service',
          executablePath: '/opt/happier/bin/happier',
          installed: true,
          running: true,
        },
        {
          id: 'service:pinned',
          serviceType: 'daemon',
          platform: 'linux',
          backend: 'systemd-user',
          label: 'happier-daemon.cloud',
          verification: 'verified',
          targetMode: 'pinned',
          ring: 'stable',
          instanceId: 'cloud',
          scope: 'user',
          definitionPath: '/tmp/happier-daemon.cloud.service',
          executablePath: '/opt/happier/bin/happier',
          installed: true,
          running: false,
        },
      ],
    };

    expect(buildHappierRuntimeWarnings({ installations, services })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DEFAULT_AND_PINNED_DAEMON_SERVICE_CONFLICT' }),
    ]));
  });

  it('emits duplicate-default and legacy-pinned warnings separately', () => {
    const installations: HappierInstallationInventory = {
      activeInvocation: null,
      installations: [],
    };
    const services: HappierServiceInventory = {
      services: [
        {
          id: 'service:default:1',
          serviceType: 'daemon',
          platform: 'linux',
          backend: 'systemd-user',
          label: 'happier-daemon.default.1',
          verification: 'verified',
          targetMode: 'default-following',
          ring: null,
          instanceId: null,
          scope: 'user',
          definitionPath: '/tmp/happier-daemon.default.1.service',
          executablePath: '/opt/happier/bin/happier',
          installed: true,
          running: true,
        },
        {
          id: 'service:default:2',
          serviceType: 'daemon',
          platform: 'linux',
          backend: 'systemd-user',
          label: 'happier-daemon.default.2',
          verification: 'verified',
          targetMode: 'default-following',
          ring: null,
          instanceId: null,
          scope: 'user',
          definitionPath: '/tmp/happier-daemon.default.2.service',
          executablePath: '/opt/happier/bin/happier',
          installed: true,
          running: false,
        },
        {
          id: 'service:pinned:legacy',
          serviceType: 'daemon',
          platform: 'linux',
          backend: 'systemd-user',
          label: 'happier-daemon.cloud',
          verification: 'verified',
          targetMode: 'pinned',
          ring: 'stable',
          instanceId: 'cloud',
          scope: 'user',
          definitionPath: '/tmp/happier-daemon.cloud.service',
          executablePath: '/opt/happier/bin/happier',
          installed: true,
          running: false,
          serverUrl: 'https://api.happier.dev',
          publicServerUrl: 'https://api.happier.dev',
        },
      ],
    };

    expect(buildHappierRuntimeWarnings({ installations, services })).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DUPLICATE_DEFAULT_FOLLOWING_DAEMON_SERVICE' }),
      expect.objectContaining({ code: 'LEGACY_PINNED_DAEMON_SERVICE' }),
    ]));
  });
});
