import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AcpBackend } from '../AcpBackend';
import { writeAcpTestAgentScript } from '../testkit/subprocessHarness';
import { withTempDir } from '@/testkit/fs/tempDir';

function writeCapabilityAgentScript(params: {
  dir: string;
  declareLoadSession: boolean;
  failLoad?: boolean;
}): { scriptPath: string; callsPath: string } {
  const callsPath = join(params.dir, 'calls.jsonl');
  const scriptPath = writeAcpTestAgentScript({
    dir: params.dir,
    fileName: 'fake-acp-load-capability.mjs',
    source: `
      import { appendFileSync } from 'node:fs';
      import readline from 'node:readline';
      const callsPath = ${JSON.stringify(callsPath)};
      const rl = readline.createInterface({ input: process.stdin });
      const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
      rl.on('line', (line) => {
        const request = JSON.parse(line);
        appendFileSync(callsPath, request.method + '\\n');
        if (request.method === 'initialize') {
          send({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              protocolVersion: 1,
              authMethods: [],
              agentCapabilities: { loadSession: ${params.declareLoadSession} },
            },
          });
          return;
        }
        if (request.method === 'session/new') {
          send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'fresh-session' } });
          return;
        }
        if (request.method === 'session/load') {
          ${params.failLoad
            ? "send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'upstream load failed' } });"
            : "send({ jsonrpc: '2.0', id: request.id, result: {} });"}
          return;
        }
        send({ jsonrpc: '2.0', id: request.id, result: {} });
      });
    `,
  });
  return { scriptPath, callsPath };
}

function readCalls(path: string): string[] {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

describe('AcpBackend session load capability', () => {
  it('does not apply configured resume policy to fresh session creation', async () => {
    await withTempDir('happier-acp-load-fresh-', async (dir) => {
      const { scriptPath, callsPath } = writeCapabilityAgentScript({ dir, declareLoadSession: false });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        declaredSessionLoadSupport: false,
      });
      try {
        await expect(backend.startSession()).resolves.toEqual({ sessionId: 'fresh-session' });
        expect(readCalls(callsPath)).toContain('session/new');
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);

  it('fails before session/load when the configured catalog declaration and handshake disagree', async () => {
    await withTempDir('happier-acp-load-mismatch-', async (dir) => {
      const { scriptPath, callsPath } = writeCapabilityAgentScript({ dir, declareLoadSession: false });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        declaredSessionLoadSupport: true,
      });
      try {
        await expect(backend.loadSession('existing-session')).rejects.toThrow(/did not negotiate loadSession/i);
        expect(readCalls(callsPath)).not.toContain('session/load');
        expect(readCalls(callsPath)).not.toContain('session/new');
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);

  it('loads exactly once and never creates a new session when both policy owners allow resume', async () => {
    await withTempDir('happier-acp-load-success-', async (dir) => {
      const { scriptPath, callsPath } = writeCapabilityAgentScript({ dir, declareLoadSession: true });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        declaredSessionLoadSupport: true,
      });
      try {
        await expect(backend.loadSession('existing-session')).resolves.toEqual({ sessionId: 'existing-session' });
        expect(readCalls(callsPath).filter((method) => method === 'session/load')).toHaveLength(1);
        expect(readCalls(callsPath)).not.toContain('session/new');
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);

  it('propagates an upstream load failure without falling back to session/new', async () => {
    await withTempDir('happier-acp-load-failure-', async (dir) => {
      const { scriptPath, callsPath } = writeCapabilityAgentScript({ dir, declareLoadSession: true, failLoad: true });
      const backend = new AcpBackend({
        agentName: 'test',
        cwd: dir,
        command: process.execPath,
        args: [scriptPath],
        declaredSessionLoadSupport: true,
      });
      try {
        await expect(backend.loadSession('existing-session')).rejects.toThrow(/upstream load failed/i);
        expect(readCalls(callsPath)).not.toContain('session/new');
      } finally {
        await backend.dispose();
      }
    });
  }, 20_000);
});
