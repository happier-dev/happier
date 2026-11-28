import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PermissionMode } from '@/api/types';
import type { SessionId } from '@/agent/core';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

import { createCatalogDefinedAcpBackend } from './createCatalogDefinedAcpBackend';

// Wire vector: agy 1.5.18 `agy acp`, probed 2026-11-26 on an account without Auto. Auto is
// advertised only on eligible accounts; `session/set_mode` rejects unadvertised ids.
const AGY_MODES = [
  { id: 'default', name: 'Default', description: 'Ask before edits and commands, per your permission settings.' },
  { id: 'accept-edits', name: 'Accept edits', description: 'Approve file edits in the workspace without asking.' },
  { id: 'plan', name: 'Plan', description: 'Plan carefully before executing a task.' },
];
const AGY_AUTO_MODE = { id: 'auto', name: 'Auto', description: 'Approve workspace edits and run sandboxed commands.' };

function writeAgyAcpAgentScript(dir: string, withAuto: boolean): { scriptPath: string; setModesPath: string } {
  const setModesPath = join(dir, 'set-modes.jsonl');
  const availableModes = withAuto ? [...AGY_MODES, AGY_AUTO_MODE] : AGY_MODES;
  const scriptPath = writeAcpTestAgentScript({
    dir,
    fileName: 'fake-agy-acp.mjs',
    source: `
      import { appendFileSync } from 'node:fs';
      import { createInterface } from 'node:readline';
      const modes = { currentModeId: 'default', availableModes: ${JSON.stringify(availableModes)} };
      const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
      const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\\n');
      for await (const line of createInterface({ input: process.stdin })) {
        const { id, method, params = {} } = JSON.parse(line);
        if (id == null) continue;
        if (method === 'initialize') send(id, { protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true } });
        else if (method === 'session/new') send(id, { sessionId: 'agy-fixture-session', modes });
        else if (method === 'session/load') send(id, { modes });
        else if (method === 'session/set_mode') {
          appendFileSync(${JSON.stringify(setModesPath)}, JSON.stringify(params.modeId) + '\\n');
          if (params.modeId === 'auto' && !modes.availableModes.some((mode) => mode.id === 'auto')) {
            fail(id, -32602, 'Auto mode is not available: it needs the OS terminal sandbox and may not be rolled out to you yet');
          } else if (!modes.availableModes.some((mode) => mode.id === params.modeId)) {
            fail(id, -32602, 'Unknown mode: ' + params.modeId);
          } else { modes.currentModeId = params.modeId; send(id, {}); }
        } else send(id, {});
      }
    `,
  });
  return { scriptPath, setModesPath };
}

function readSetModeIds(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string);
  } catch {
    return [];
  }
}

describe('catalog-defined Antigravity ACP backend permission modes', () => {
  it.each([
    { permissionMode: 'default', withAuto: false, expected: [] },
    { permissionMode: 'default', withAuto: true, expected: [] },
    { permissionMode: 'read-only', withAuto: false, expected: ['default'] },
    { permissionMode: 'safe-yolo', withAuto: false, expected: ['accept-edits'] },
    { permissionMode: 'safe-yolo', withAuto: true, expected: ['auto'] },
    { permissionMode: 'yolo', withAuto: false, expected: ['accept-edits'] },
    { permissionMode: 'yolo', withAuto: true, expected: ['auto'] },
    { permissionMode: 'plan', withAuto: false, expected: ['plan'] },
  ] as const satisfies ReadonlyArray<{ permissionMode: PermissionMode; withAuto: boolean; expected: readonly string[] }>)(
    'applies Happier $permissionMode as agy modes $expected (auto advertised: $withAuto) on create and resume',
    async ({ permissionMode, withAuto, expected }) => {
      await withTempDir('happier-agy-permission-', async (dir) => {
        for (const resume of [false, true]) {
          const { scriptPath, setModesPath } = writeAgyAcpAgentScript(dir, withAuto);
          const backend = createCatalogDefinedAcpBackend('agy', {
            cwd: dir,
            permissionMode,
            launch: { command: process.execPath, args: [scriptPath] },
          });
          try {
            if (resume) await backend.loadSession?.('agy-fixture-session' as SessionId);
            else await backend.startSession();
            expect(readSetModeIds(setModesPath)).toEqual(expected);
          } finally {
            await backend.dispose();
          }
          rmSync(setModesPath, { force: true });
        }
      });
    },
    20_000,
  );

  it('takes a permission change in the running session unless it must return to the agent\'s own policy', async () => {
    await withTempDir('happier-agy-live-permission-', async (dir) => {
      const { scriptPath, setModesPath } = writeAgyAcpAgentScript(dir, true);
      let permissionMode: PermissionMode = 'default';
      const backend = createCatalogDefinedAcpBackend('agy', {
        cwd: dir,
        getPermissionMode: () => permissionMode,
        launch: { command: process.execPath, args: [scriptPath] },
      }) as ReturnType<typeof createCatalogDefinedAcpBackend> & {
        setSessionMode: (sessionId: SessionId, modeId: string) => Promise<void>;
        clearSessionModeOverride: (sessionId: SessionId) => Promise<void>;
        applyPermissionModeInPlace: (sessionId: SessionId) => Promise<boolean>;
      };
      try {
        const { sessionId } = await backend.startSession();
        expect(await backend.applyPermissionModeInPlace(sessionId)).toBe(true);
        permissionMode = 'yolo';
        expect(await backend.applyPermissionModeInPlace(sessionId)).toBe(true);
        await backend.setSessionMode(sessionId, 'plan');
        permissionMode = 'read-only';
        // Plan stays the agent mode; the permission setting applies again in Build.
        expect(await backend.applyPermissionModeInPlace(sessionId)).toBe(true);
        await backend.clearSessionModeOverride(sessionId);
        permissionMode = 'default';
        expect(await backend.applyPermissionModeInPlace(sessionId)).toBe(false);
        expect(readSetModeIds(setModesPath)).toEqual(['auto', 'plan', 'plan', 'default']);
      } finally {
        await backend.dispose();
      }
    });
  });

  it('switches agy between Plan and the permission-derived Build mode, ignoring persisted approval overrides', async () => {
    await withTempDir('happier-agy-agent-mode-', async (dir) => {
      const { scriptPath, setModesPath } = writeAgyAcpAgentScript(dir, true);
      let permissionMode: PermissionMode = 'yolo';
      const backend = createCatalogDefinedAcpBackend('agy', {
        cwd: dir,
        getPermissionMode: () => permissionMode,
        launch: { command: process.execPath, args: [scriptPath] },
      }) as ReturnType<typeof createCatalogDefinedAcpBackend> & {
        setSessionMode: (sessionId: SessionId, modeId: string) => Promise<void>;
        clearSessionModeOverride: (sessionId: SessionId) => Promise<void>;
      };
      try {
        const { sessionId } = await backend.startSession();
        await backend.setSessionMode(sessionId, 'plan');
        await backend.clearSessionModeOverride(sessionId);
        // A raw agy approval mode persisted as a mode override resolves through the permission selector.
        permissionMode = 'read-only';
        await backend.setSessionMode(sessionId, 'accept-edits');
        expect(readSetModeIds(setModesPath)).toEqual(['auto', 'plan', 'auto', 'default']);
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);
});
