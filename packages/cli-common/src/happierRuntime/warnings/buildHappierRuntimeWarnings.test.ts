import { describe, expect, it } from 'vitest';

import { buildHappierRuntimeWarnings } from './buildHappierRuntimeWarnings.js';
import type { HappierInstallationInventory, HappierServiceInventory } from '../types.js';

describe('buildHappierRuntimeWarnings', () => {
  it('emits service-side warnings for duplicate tuples and orphan daemon services', () => {
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
      expect.objectContaining({ code: 'DUPLICATE_SERVICE_TUPLE' }),
      expect.objectContaining({ code: 'ORPHAN_DAEMON_SERVICE' }),
    ]));
  });
});
