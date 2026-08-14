import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PI_BROKER_LOAD_NONCE_ENV,
  PI_BROKER_SELECTIONS_ENV,
  PI_BROKER_SELECTION_IDENTITY_ENV,
  buildPiBrokerMarker,
  ensurePiBrokerExtensionAsset,
  isPiBrokerMarker,
  parsePiBrokerSelections,
  resolvePiBrokerExtensionPath,
  serializePiBrokerSelections,
  verifyPiBrokerReadyForConnectedSession,
} from './index';

describe('piBrokerExtensionEnv markers + selections', () => {
  it('builds + recognises a versioned broker marker (never a real refresh token)', () => {
    const marker = buildPiBrokerMarker('anthropic', '1');
    expect(marker).toBe('happier-pi-broker:anthropic:1');
    expect(isPiBrokerMarker(marker)).toBe(true);
    expect(isPiBrokerMarker('sk-ant-ort-real')).toBe(false);
  });

  it('round-trips selections and rejects malformed/service-mismatched entries', () => {
    const serialized = serializePiBrokerSelections({
      anthropic: { serviceId: 'claude-subscription', profileId: 'c', accountId: 'a', planType: null },
      openai: { serviceId: 'openai-codex', profileId: 'x', accountId: null, planType: 'pro' },
    });
    const parsed = parsePiBrokerSelections(serialized);
    expect(parsed.anthropic).toMatchObject({ serviceId: 'claude-subscription', profileId: 'c' });
    expect(parsed.openai).toMatchObject({ serviceId: 'openai-codex', profileId: 'x', planType: 'pro' });
    // Wrong service id for the provider slot ⇒ dropped.
    expect(parsePiBrokerSelections(JSON.stringify({ anthropic: { serviceId: 'openai-codex', profileId: 'c' } })).anthropic).toBeUndefined();
    expect(parsePiBrokerSelections('not json')).toEqual({});
  });
});

describe('verifyPiBrokerReadyForConnectedSession (fail-closed preflight)', () => {
  let agentDir: string;
  let brokerStatePath: string;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-broker-verify-'));
    agentDir = join(root, 'pi-agent-dir');
    brokerStatePath = join(root, 'connected-service-broker.state.json');
    await writeFile(brokerStatePath, JSON.stringify({
      httpPort: 5,
      connectedServiceBrokerRefreshToken: 'scoped',
    }), 'utf8');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const brokeredEnv = (overrides: Record<string, string> = {}): Record<string, string> => ({
    PI_CODING_AGENT_DIR: agentDir,
    [PI_BROKER_SELECTION_IDENTITY_ENV]: 'pi|connected|broker:1|anthropic:c:',
    [PI_BROKER_SELECTIONS_ENV]: serializePiBrokerSelections({
      anthropic: { serviceId: 'claude-subscription', profileId: 'c', accountId: null, planType: null },
    }),
    [PI_BROKER_LOAD_NONCE_ENV]: 'pi-spawn-ready',
    HAPPIER_PI_BROKER_STATE_PATH: brokerStatePath,
    ...overrides,
  });

  it('is ready when the extension file exists, the bridge is reachable, and the handshake is observed', async () => {
    await ensurePiBrokerExtensionAsset(agentDir);
    const readiness = await verifyPiBrokerReadyForConnectedSession(brokeredEnv(), {
      deadlineMs: Date.now() + 60_000,
      verifyLoadHandshake: async (selectionIdentity, loadNonce) =>
        selectionIdentity === 'pi|connected|broker:1|anthropic:c:' && loadNonce === 'pi-spawn-ready',
    });
    expect(readiness).toEqual({ ready: true });
  });

  it('is a strict no-op (ready) for native sessions (no selection identity)', async () => {
    const readiness = await verifyPiBrokerReadyForConnectedSession(
      { PI_CODING_AGENT_DIR: agentDir },
      { deadlineMs: Date.now() + 60_000 },
    );
    expect(readiness).toEqual({ ready: true });
  });

  it('fails closed when the extension file is missing', async () => {
    const readiness = await verifyPiBrokerReadyForConnectedSession(brokeredEnv(), {
      deadlineMs: Date.now() + 60_000,
      verifyLoadHandshake: async () => true,
    });
    expect(readiness).toEqual({ ready: false, reason: 'broker_extension_file_missing' });
  });

  it('fails closed when the daemon bridge is unreachable', async () => {
    await ensurePiBrokerExtensionAsset(agentDir);
    const readiness = await verifyPiBrokerReadyForConnectedSession(
      brokeredEnv({ HAPPIER_PI_BROKER_STATE_PATH: join(agentDir, 'missing.json') }),
      { deadlineMs: Date.now() + 60_000, verifyLoadHandshake: async () => true },
    );
    expect(readiness).toEqual({ ready: false, reason: 'broker_daemon_bridge_unreachable' });
  });

  it('fails closed when broker state has no scoped capability', async () => {
    await ensurePiBrokerExtensionAsset(agentDir);
    await writeFile(brokerStatePath, JSON.stringify({ httpPort: 5 }), 'utf8');
    const readiness = await verifyPiBrokerReadyForConnectedSession(
      brokeredEnv(),
      { deadlineMs: Date.now() + 60_000, verifyLoadHandshake: async () => true },
    );
    expect(readiness).toEqual({ ready: false, reason: 'broker_daemon_bridge_unreachable' });
  });

  it('fails closed with broker_extension_not_loaded when the handshake never arrives', async () => {
    await ensurePiBrokerExtensionAsset(agentDir);
    const readiness = await verifyPiBrokerReadyForConnectedSession(brokeredEnv(), {
      deadlineMs: Date.now(),
      verifyLoadHandshake: async () => false,
    });
    expect(readiness).toEqual({ ready: false, reason: 'broker_extension_not_loaded' });
  });

  it('allows a handshake after four seconds when it remains inside the session-open deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    await ensurePiBrokerExtensionAsset(agentDir);
    const options = {
      deadlineMs: Date.now() + 60_000,
      verifyLoadHandshake: async (
        _selectionIdentity: string,
        _loadNonce: string,
        _providers: readonly string[],
        _pluginVersion: string,
        deadlineMs: number,
      ) => {
        vi.setSystemTime(Date.now() + 4_500);
        return Date.now() <= deadlineMs;
      },
    };

    await expect(verifyPiBrokerReadyForConnectedSession(brokeredEnv(), options)).resolves.toEqual({ ready: true });
  });

  it('fails closed when the owning session-open signal is cancelled during the handshake', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    await ensurePiBrokerExtensionAsset(agentDir);
    const options = {
      deadlineMs: Date.now() + 60_000,
      signal: controller.signal,
      verifyLoadHandshake: async () => {
        controller.abort('session-open-cancelled');
        return true;
      },
    };

    await expect(verifyPiBrokerReadyForConnectedSession(brokeredEnv(), options)).resolves.toEqual({
      ready: false,
      reason: 'broker_readiness_cancelled',
    });
  });

  it('fails closed when the spawned Pi process stops owning the handshake wait', async () => {
    vi.useFakeTimers();
    let processActive = true;
    await ensurePiBrokerExtensionAsset(agentDir);
    const options = {
      deadlineMs: Date.now() + 60_000,
      isProcessActive: () => processActive,
      verifyLoadHandshake: async () => {
        processActive = false;
        return true;
      },
    };

    await expect(verifyPiBrokerReadyForConnectedSession(brokeredEnv(), options)).resolves.toEqual({
      ready: false,
      reason: 'broker_process_exited',
    });
  });

  it('fails closed when the shared session-open deadline expires before the handshake', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    await ensurePiBrokerExtensionAsset(agentDir);
    const options = {
      deadlineMs: Date.now() + 100,
      verifyLoadHandshake: async () => {
        vi.setSystemTime(Date.now() + 101);
        return true;
      },
    };

    await expect(verifyPiBrokerReadyForConnectedSession(brokeredEnv(), options)).resolves.toEqual({
      ready: false,
      reason: 'broker_extension_not_loaded',
    });
  });
});

describe('ensurePiBrokerExtensionAsset (idempotent write)', () => {
  it('writes the extension into <agentDir>/extensions/ and is write-if-changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-broker-asset-'));
    const agentDir = join(root, 'pi-agent-dir');
    const extensionDir = join(agentDir, 'extensions');
    await mkdir(extensionDir, { recursive: true });
    await Promise.all([
      writeFile(join(extensionDir, 'happier-pi-broker-1.js'), 'stale v1', 'utf8'),
      writeFile(join(extensionDir, 'happier-pi-broker-2.js'), 'stale v2', 'utf8'),
      writeFile(join(extensionDir, 'unrelated-extension.js'), 'unrelated', 'utf8'),
    ]);
    const path = await ensurePiBrokerExtensionAsset(agentDir);
    expect(path).toBe(resolvePiBrokerExtensionPath(agentDir));
    expect((await readdir(extensionDir)).sort()).toEqual([
      'happier-pi-broker.js',
      'unrelated-extension.js',
    ]);
    const content = await readFile(path, 'utf8');
    expect(content).toContain('HappierPiAuthBrokerExtension');
    expect(content).toContain('registerProvider');
    // Idempotent: a second call does not change the bytes.
    const path2 = await ensurePiBrokerExtensionAsset(agentDir);
    expect(await readFile(path2, 'utf8')).toBe(content);
  });
});
