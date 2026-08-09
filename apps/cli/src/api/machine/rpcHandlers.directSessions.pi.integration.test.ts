import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

vi.mock('@/configuration', () => ({
  configuration: {
    activeServerDir: '/tmp/happier-test-active-server',
    happyHomeDir: '/tmp/happier-test-home',
    logsDir: '/tmp',
    isDaemonProcess: false,
  },
}));

vi.mock('@/persistence', () => ({
  readCredentials: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/session/transport/http/sessionsHttp', async () => {
  const actual = await vi.importActual<typeof import('@/session/transport/http/sessionsHttp')>('@/session/transport/http/sessionsHttp');
  return {
    ...actual,
    fetchSessionById: vi.fn().mockResolvedValue(null),
    commitSessionStoredMessage: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: vi.fn().mockResolvedValue(undefined),
}));

import { registerMachineDirectSessionsRpcHandlers } from './rpcHandlers.directSessions';

const SESSION_ID = '019f4a42-4617-767a-8e7c-189b454a0352';

function freshAgentDir(): string {
  return mkdtempSync(join(tmpdir(), 'pi-rpc-int-'));
}

function writeSession(agentDir: string, lines: readonly object[]): void {
  const sessionsDir = join(agentDir, 'sessions', '--proj--');
  mkdirSync(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, `2024-12-03T14-00-00-000Z_${SESSION_ID}.jsonl`);
  writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}

const header = { type: 'session', id: SESSION_ID, timestamp: '2024-12-03T14:00:00.000Z', cwd: '/proj', version: 3 };

function msg(id: string, parentId: string | null, role: string, text: string, ts: string): object {
  return { type: 'message', id, parentId, timestamp: ts, message: { role, content: [{ type: 'text', text }], timestamp: Date.parse(ts) } };
}

/**
 * Exercises the daemon→pi direct-session RPC wiring with the REAL catalog + REAL pi providerOps
 * against a fixture pi session on disk. This proves the full local stack — request schema
 * validation, validateDirectMachineSource, getDirectSessionProviderOps('pi'), provider discovery /
 * paging / readAfter — without a server or auth. Discriminating: the fixture has an abandoned
 * sibling branch so active-branch selection must come through the RPC layer too.
 */
describe('registerMachineDirectSessionsRpcHandlers: pi integration', () => {
  let agentDir: string;
  let registered: Map<string, (params: unknown) => Promise<unknown>>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    agentDir = freshAgentDir();
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);

    // Active branch is m1→m2→m3→m4 (leaf). m_alt is a sibling of m2 off m1; appended before the
    // leaf so the last-in-file leaf rule still resolves to m4, excluding the abandoned branch.
    writeSession(agentDir, [
      header,
      msg('m1', null, 'user', 'one', '2024-12-03T14:00:01.000Z'),
      msg('m2', 'm1', 'assistant', 'two', '2024-12-03T14:00:02.000Z'),
      msg('m_alt', 'm1', 'assistant', 'alt branch', '2024-12-03T14:00:02.500Z'),
      msg('m3', 'm2', 'user', 'three', '2024-12-03T14:00:03.000Z'),
      msg('m4', 'm3', 'assistant', 'four', '2024-12-03T14:00:04.000Z'),
    ]);

    registered = new Map();
    const rpcHandlerManager = {
      registerHandler: (method: string, handler: (params: unknown) => Promise<unknown>) => {
        registered.set(method, handler);
      },
    } as unknown as Parameters<typeof registerMachineDirectSessionsRpcHandlers>[0]['rpcHandlerManager'];
    registerMachineDirectSessionsRpcHandlers({ rpcHandlerManager });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lists pi sessions through the daemon RPC wiring', async () => {
    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST)!;
    const res = (await handler({
      machineId: 'm1',
      providerId: 'pi',
      source: { kind: 'piAgentDir' },
    })) as { ok: boolean; candidates?: { remoteSessionId: string }[]; errorCode?: string; error?: string };

    expect(res.ok).toBe(true);
    expect(res.candidates?.some((c) => c.remoteSessionId === SESSION_ID)).toBe(true);
  });

  it('pages the pi active branch through the daemon RPC wiring, excluding the abandoned sibling', async () => {
    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE)!;
    const res = (await handler({
      machineId: 'm1',
      providerId: 'pi',
      source: { kind: 'piAgentDir' },
      remoteSessionId: SESSION_ID,
      direction: 'older',
      maxItems: 10,
    })) as { ok: boolean; items?: { id: string; createdAtMs: number }[]; errorCode?: string };

    expect(res.ok).toBe(true);
    expect(res.items).toHaveLength(4);
    // active branch only — m_alt excluded
    expect(res.items!.map((i) => i.id.slice(-2))).toEqual(['m1', 'm2', 'm3', 'm4']);
    // chronological
    for (let i = 1; i < res.items!.length; i += 1) {
      expect(res.items![i]!.createdAtMs).toBeGreaterThanOrEqual(res.items![i - 1]!.createdAtMs);
    }
  });

  it('readAfter returns the tail after a forward cursor through the daemon RPC wiring', async () => {
    const pageHandler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_PAGE)!;
    const firstPage = (await pageHandler({
      machineId: 'm1',
      providerId: 'pi',
      source: { kind: 'piAgentDir' },
      remoteSessionId: SESSION_ID,
      direction: 'older',
      maxItems: 2,
    })) as { ok: boolean; items?: unknown[]; tailCursor?: string | null };

    // tailCursor points at the end of the file; a static session has nothing after it.
    const readAfterHandler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSION_TRANSCRIPT_READ_AFTER)!;
    const res = (await readAfterHandler({
      machineId: 'm1',
      providerId: 'pi',
      source: { kind: 'piAgentDir' },
      remoteSessionId: SESSION_ID,
      cursor: firstPage.tailCursor,
    })) as { ok: boolean; items?: unknown[]; errorCode?: string };

    expect(res.ok).toBe(true);
    expect(res.items).toEqual([]);
  });

  it('rejects a client-supplied agentDir that does not match the daemon-configured dir', async () => {
    const handler = registered.get(RPC_METHODS.DAEMON_DIRECT_SESSIONS_CANDIDATES_LIST)!;
    const res = (await handler({
      machineId: 'm1',
      providerId: 'pi',
      source: { kind: 'piAgentDir', agentDir: '/etc/passwd' },
    })) as { ok: boolean; errorCode?: string };

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('invalid_request');
  });
});
