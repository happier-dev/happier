import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOrganizationPolicyV1 } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import { planDaemonServiceInstall } from './plan';
import { resolveDaemonServiceIrohRelayConfig } from './resolveDaemonServiceIrohRelayConfig';

describe('organization daemon relay config', () => {
  it('forced disabled relays override process lists', () => {
    const organizationPolicy = parseOrganizationPolicyV1('{"schemaVersion":1,"organization":"Example","relays":{"policy":"disabled"}}');
    expect(resolveDaemonServiceIrohRelayConfig({ organizationPolicy, processEnv: { HAPPIER_IROH_RELAY_URLS: 'https://outside.example' } })).toEqual({ relayPolicy: 'disabled', relayUrls: [], explicitlyConfigured: true });
  });
  it('forced automatic relay list survives process disable and absent restores the process choice', () => {
    const organizationPolicy = parseOrganizationPolicyV1('{"schemaVersion":1,"organization":"Example","relays":{"policy":"automatic","urls":["https://relay.example"]}}');
    expect(resolveDaemonServiceIrohRelayConfig({ organizationPolicy, processEnv: { HAPPIER_IROH_RELAY_POLICY: 'disabled' } })).toEqual({ relayPolicy: 'automatic', relayUrls: ['https://relay.example'], explicitlyConfigured: true });
    expect(resolveDaemonServiceIrohRelayConfig({ organizationPolicy: { status: 'absent' }, processEnv: { HAPPIER_IROH_RELAY_POLICY: 'disabled' } }).relayPolicy).toBe('disabled');
  });

  it('applies Home machineRelayUrls at lowest precedence with explicitlyConfigured=false and fails closed on invalid lists', () => {
    expect(resolveDaemonServiceIrohRelayConfig({
      organizationPolicy: { status: 'absent' },
      processEnv: {},
      homeMachineRelayUrls: ['https://relay-b.example', 'https://relay-a.example'],
    })).toEqual({
      relayPolicy: 'automatic',
      relayUrls: ['https://relay-a.example', 'https://relay-b.example'],
      explicitlyConfigured: false,
    });

    // Local processEnv (disabled, explicit automatic, or explicit URLs) overrides Home defaults.
    expect(resolveDaemonServiceIrohRelayConfig({
      organizationPolicy: { status: 'absent' },
      processEnv: { HAPPIER_IROH_RELAY_POLICY: 'disabled' },
      homeMachineRelayUrls: ['https://relay-home.example'],
    })).toEqual({ relayPolicy: 'disabled', relayUrls: [], explicitlyConfigured: true });

    expect(resolveDaemonServiceIrohRelayConfig({
      organizationPolicy: { status: 'absent' },
      processEnv: { HAPPIER_IROH_RELAY_POLICY: 'automatic' },
      homeMachineRelayUrls: ['https://relay-home.example'],
    })).toEqual({ relayPolicy: 'automatic', relayUrls: [], explicitlyConfigured: true });

    expect(resolveDaemonServiceIrohRelayConfig({
      organizationPolicy: { status: 'absent' },
      processEnv: { HAPPIER_IROH_RELAY_URLS: 'https://relay-local.example' },
      homeMachineRelayUrls: ['https://relay-home.example'],
    })).toEqual({ relayPolicy: 'automatic', relayUrls: ['https://relay-local.example'], explicitlyConfigured: true });

    // Installed service config overrides Home defaults.
    const tempDir = mkdtempSync(join(tmpdir(), 'happier-relay-precedence-'));
    try {
      const installedPath = join(tempDir, 'happier-daemon.default.service');
      const installedPlan = planDaemonServiceInstall({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        targetMode: 'default-following',
        instanceId: 'default',
        userHomeDir: '/home/test',
        happierHomeDir: '/home/test/.happier',
        serverUrl: 'https://api.happier.dev',
        webappUrl: 'https://app.happier.dev',
        publicServerUrl: 'https://api.happier.dev',
        nodePath: '/usr/bin/happier',
        entryPath: '',
        irohRelayConfig: resolveDaemonServiceIrohRelayConfig({
          organizationPolicy: { status: 'absent' },
          processEnv: { HAPPIER_IROH_RELAY_POLICY: 'disabled' },
        }),
      });
      writeFileSync(installedPath, installedPlan.files[0]?.content ?? '', 'utf8');
      expect(resolveDaemonServiceIrohRelayConfig({
        organizationPolicy: { status: 'absent' },
        processEnv: {},
        installedService: { platform: 'linux', path: installedPath },
        homeMachineRelayUrls: ['https://relay-home.example'],
      })).toEqual({ relayPolicy: 'disabled', relayUrls: [], explicitlyConfigured: true });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    // Invalid Home machineRelayUrls fail closed to direct-only instead of throwing.
    for (const invalid of [
      ['ftp://relay.example'],
      ['https://user:pass@relay.example'],
      ['https://relay.example', 'https://relay.example/'],
      ['https://relay.example\r\n'],
      Array.from({ length: 65 }, (_, i) => `https://relay-${i}.example`),
    ]) {
      expect(resolveDaemonServiceIrohRelayConfig({
        organizationPolicy: { status: 'absent' },
        processEnv: {},
        homeMachineRelayUrls: invalid,
      })).toEqual({ relayPolicy: 'automatic', relayUrls: [], explicitlyConfigured: false });
    }
  });
});
