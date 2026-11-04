import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { AcpCatalogRecordV1Schema, type AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { warmDaemonAccountCatalogs } from './warmDaemonAccountCatalogs';
import { settleDaemonOptionalCapability } from './optionalCapabilities';

afterEach(() => {
  vi.restoreAllMocks();
  resetActiveAccountSettingsSnapshotForTests();
});

describe('daemon Account catalog startup readiness', () => {
  it('reports unavailable when the real settings warmup cannot reach Home', async () => {
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'daemon-catalog-unreachable' })).toString('base64url')}.signature`, encryption: null };
    // Only HTTP fails; the best-effort settings owner and its boolean outcome stay real.
    vi.spyOn(axios, 'get').mockRejectedValue(Object.assign(new Error('Home unavailable'), { code: 'ECONNREFUSED' }));
    const outcomes: unknown[] = [];
    await expect(settleDaemonOptionalCapability('account_catalogs', warmDaemonAccountCatalogs({
      credentials, signal: new AbortController().signal, logger: { debug() {} },
    }), result => outcomes.push(result))).resolves.toMatchObject({ status: 'unavailable', capability: 'account_catalogs' });
    expect(outcomes).toEqual([expect.objectContaining({ status: 'unavailable', capability: 'account_catalogs' })]);
  });

  it('keeps ACP reads behind a pending settings read and joins the real hydrated catalogs', async () => {
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'daemon-catalog-warm' })).toString('base64url')}.signature`, encryption: null };
    let releaseSettings!: () => void;
    const settingsResponse = new Promise<void>(resolve => { releaseSettings = resolve; });
    let settingsRequested!: () => void;
    const requested = new Promise<void>(resolve => { settingsRequested = resolve; });
    const reads: string[] = [];
    // HTTP alone is substituted; bootstrap, Account publication and ACP admission stay real.
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      reads.push(path);
      if (path === '/v2/account/settings') {
        settingsRequested();
        await settingsResponse;
        return { status: 200, data: { version: 7, content: { t: 'plain', v: {} } } };
      }
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (path.startsWith('/v1/account/entity-rows/')) return { status: 200, data: {
        status: 'present', revision: 1, content: { t: 'plain', v: path.endsWith('/acp')
          ? { v: 1, definitions: [] } : { v: 1, channels: [] } },
      } };
      throw new Error(`Unexpected daemon catalog boundary: ${path}`);
    });
    let ready = false;
    const warmup = warmDaemonAccountCatalogs({ credentials, signal: new AbortController().signal,
      logger: { debug() {} } }).then(() => { ready = true; });
    try {
      await requested;
      expect(ready).toBe(false);
      expect(getActiveAccountSettingsSnapshot()).toBeNull();
      expect(reads.filter(path => path === '/v1/account/entity-rows/acp')).toHaveLength(0);
      releaseSettings();
      await warmup;
      expect(ready).toBe(true);
      expect(getActiveAccountSettingsSnapshot()).toMatchObject({ source: 'network', settingsVersion: 7,
        acpCatalog: { status: 'ready', revision: 1, record: { v: 1, definitions: [] } } });
    } finally {
      releaseSettings();
      await warmup;
    }
  });

  it('composes admitted declarations while warming but executes startup plugins only after Account readiness', async () => {
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'daemon-plugin-readiness' })).toString('base64url')}.signature`, encryption: null };
    let releaseSettings!: () => void;
    const settingsResponse = new Promise<void>(resolve => { releaseSettings = resolve; });
    let releaseAcp!: () => void;
    const acpResponse = new Promise<void>(resolve => { releaseAcp = resolve; });
    let requestedAcp!: () => void;
    const acpRequested = new Promise<void>(resolve => { requestedAcp = resolve; });
    let acpReads = 0;
    const acpRecord = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{ id: 'review', name: 'review', title: 'Review',
      launch: { kind: 'command', command: 'custom-acp', args: ['acp'] }, env: {},
      capabilities: { supportsLoadSession: true, supportsModes: 'unknown', supportsModels: 'unknown',
        supportsConfigOptions: 'unknown', promptImageSupport: 'no' }, createdAt: 1, updatedAt: 2 }] });
    vi.spyOn(axios, 'get').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v2/account/settings') {
        await settingsResponse;
        return { status: 200, data: { version: 9, content: { t: 'plain', v: {} } } };
      }
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 9, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
      if (path === '/v1/account/entity-rows/acp') {
        acpReads += 1;
        requestedAcp();
        await acpResponse;
        return { status: 200, data: { status: 'present', revision: 3, content: { t: 'plain', v: acpRecord } } };
      }
      if (path === '/v1/account/entity-rows/notification-channels') return { status: 200, data: {
        status: 'present', revision: 2, content: { t: 'plain', v: { v: 1, channels: [] } },
      } };
      throw new Error(`Unexpected daemon activation boundary: ${path}`);
    });
    const warmup = warmDaemonAccountCatalogs({ credentials, signal: new AbortController().signal, logger: { debug() {} } });
    const plugin = definePlugin({ id: 'acme.account-ready', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
      activation: { events: [{ kind: 'startup' }] } });
    let activations = 0;
    let settingsAtActivation: number | undefined;
    let acpAtActivation: AcpCatalogSnapshotV1 | undefined;
    let joinedReadiness!: () => void;
    const readinessJoined = new Promise<'waiting'>(resolve => { joinedReadiness = () => resolve('waiting'); });
    const fixture = createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true,
      plugins: [{ manifest: plugin.manifest, files: { 'daemon.mjs': 'export function activate() {}' },
        instantiateCommittedModule: () => ({ ...plugin, activate: async (...args: Parameters<typeof plugin.activate>) => {
          activations += 1;
          settingsAtActivation = getActiveAccountSettingsSnapshot()?.settingsVersion;
          acpAtActivation = getActiveAccountSettingsSnapshot()?.acpCatalog;
          return await plugin.activate(...args);
        } }) }],
      runtimeOptions: { awaitAccountSettingsReadiness: async () => { joinedReadiness(); await warmup; } },
    });
    try {
      expect(await Promise.race([readinessJoined, fixture.then(() => 'activated')])).toBe('waiting');
      expect(activations).toBe(0);
      expect(acpReads).toBe(0);
      releaseSettings();
      await acpRequested;
      expect(activations).toBe(0);
      releaseAcp();
      const admitted = await fixture;
      expect(admitted.registry.activatedPluginIds.has(plugin.manifest.id)).toBe(true);
      expect(activations).toBe(1);
      expect(settingsAtActivation).toBe(9);
      expect(acpAtActivation).toMatchObject({ status: 'ready', revision: 3,
        record: { definitions: [{ id: 'review', launch: { command: 'custom-acp' } }] } });
    } finally {
      releaseSettings();
      releaseAcp();
      await warmup;
      await (await fixture).dispose();
    }
  });
});
