import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PI_BROKER_DAEMON_STATE_PATH_ENV,
  PI_BROKER_LOAD_NONCE_ENV,
  PI_BROKER_SELECTIONS_ENV,
  PI_BROKER_SELECTION_IDENTITY_ENV,
  ensurePiBrokerExtensionAsset,
  serializePiBrokerSelections,
  verifyPiBrokerReadyForConnectedSession,
} from './index.js';

async function writeDaemonStateFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'happier-pi-preflight-daemon-'));
  const file = join(dir, 'daemon.state.json');
  await writeFile(file, JSON.stringify({ httpPort: 52777, controlToken: 'master' }), 'utf8');
  return file;
}

describe('verifyPiBrokerReadyForConnectedSession (fail-closed preflight)', () => {
  const roots: string[] = [];
  beforeEach(() => { roots.length = 0; });
  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  const brokeredAnthropicSelectionsEnv = serializePiBrokerSelections({
    anthropic: { serviceId: 'claude-subscription', profileId: 'c', accountId: null, planType: null },
  });

  it('is a strict no-op for native sessions (no selection identity)', async () => {
    await expect(verifyPiBrokerReadyForConnectedSession({})).resolves.toEqual({ ready: true });
  });

  it('is a strict no-op for direct-API-key connected sessions (no brokered provider)', async () => {
    await expect(verifyPiBrokerReadyForConnectedSession({
      [PI_BROKER_SELECTION_IDENTITY_ENV]: 'pi|connected|broker:1|',
      [PI_BROKER_SELECTIONS_ENV]: serializePiBrokerSelections({}),
    })).resolves.toEqual({ ready: true });
  });

  it('fails closed when the daemon bridge is unreachable', async () => {
    await expect(verifyPiBrokerReadyForConnectedSession({
      [PI_BROKER_SELECTION_IDENTITY_ENV]: 'pi|connected|broker:1|anthropic:c:',
      [PI_BROKER_SELECTIONS_ENV]: brokeredAnthropicSelectionsEnv,
      [PI_BROKER_DAEMON_STATE_PATH_ENV]: '/nonexistent/daemon.state.json',
    })).resolves.toEqual({ ready: false, reason: 'broker_daemon_bridge_unreachable' });
  });

  it('fails closed when the broker extension file is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-preflight-'));
    roots.push(root);
    const agentDir = join(root, 'pi-agent-dir');
    const result = await verifyPiBrokerReadyForConnectedSession({
      PI_CODING_AGENT_DIR: agentDir,
      [PI_BROKER_SELECTION_IDENTITY_ENV]: 'pi|connected|broker:1|anthropic:c:',
      [PI_BROKER_SELECTIONS_ENV]: brokeredAnthropicSelectionsEnv,
      [PI_BROKER_DAEMON_STATE_PATH_ENV]: await writeDaemonStateFile(),
    });
    expect(result).toEqual({ ready: false, reason: 'broker_extension_file_missing' });
  });

  it('fails closed when the extension exists + daemon reachable but the load handshake never arrives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-preflight-'));
    roots.push(root);
    const agentDir = join(root, 'pi-agent-dir');
    await ensurePiBrokerExtensionAsset(agentDir);
    const result = await verifyPiBrokerReadyForConnectedSession({
      PI_CODING_AGENT_DIR: agentDir,
      [PI_BROKER_SELECTION_IDENTITY_ENV]: 'pi|connected|broker:1|anthropic:c:',
      [PI_BROKER_SELECTIONS_ENV]: brokeredAnthropicSelectionsEnv,
      [PI_BROKER_DAEMON_STATE_PATH_ENV]: await writeDaemonStateFile(),
      [PI_BROKER_LOAD_NONCE_ENV]: 'pi-spawn-1',
    }, { handshakeWaitMs: 0, verifyLoadHandshake: async () => false });
    expect(result).toEqual({ ready: false, reason: 'broker_extension_not_loaded' });
  });

  it('is ready when the extension exists, the daemon is reachable, and the handshake is observed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-preflight-'));
    roots.push(root);
    const agentDir = join(root, 'pi-agent-dir');
    await ensurePiBrokerExtensionAsset(agentDir);
    const result = await verifyPiBrokerReadyForConnectedSession({
      PI_CODING_AGENT_DIR: agentDir,
      [PI_BROKER_SELECTION_IDENTITY_ENV]: 'pi|connected|broker:1|anthropic:c:',
      [PI_BROKER_SELECTIONS_ENV]: brokeredAnthropicSelectionsEnv,
      [PI_BROKER_DAEMON_STATE_PATH_ENV]: await writeDaemonStateFile(),
      [PI_BROKER_LOAD_NONCE_ENV]: 'pi-spawn-1',
    }, {
      verifyLoadHandshake: async (selectionIdentity, loadNonce) =>
        selectionIdentity === 'pi|connected|broker:1|anthropic:c:' && loadNonce === 'pi-spawn-1',
    });
    expect(result).toEqual({ ready: true });
  });

  it('fails closed when a brokered Pi process has no spawn load nonce', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-pi-preflight-'));
    roots.push(root);
    const agentDir = join(root, 'pi-agent-dir');
    await ensurePiBrokerExtensionAsset(agentDir);
    const result = await verifyPiBrokerReadyForConnectedSession({
      PI_CODING_AGENT_DIR: agentDir,
      [PI_BROKER_SELECTION_IDENTITY_ENV]: 'pi|connected|broker:1|anthropic:c:',
      [PI_BROKER_SELECTIONS_ENV]: brokeredAnthropicSelectionsEnv,
      [PI_BROKER_DAEMON_STATE_PATH_ENV]: await writeDaemonStateFile(),
    }, { verifyLoadHandshake: async () => true });
    expect(result).toEqual({ ready: false, reason: 'broker_load_nonce_missing' });
  });
});
