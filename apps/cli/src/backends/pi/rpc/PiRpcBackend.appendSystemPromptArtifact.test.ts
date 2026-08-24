import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentMessage } from '@/agent/core';
import { PiRpcBackend } from './PiRpcBackend';

let backend: PiRpcBackend | null = null;
let tempDir: string | null = null;

/**
 * Fake pi RPC process that records its argv into a file and answers the session-open
 * protocol. The recorded argv is the assertion surface for spawn-flag delivery.
 */
function writeFakePiRpcArgvRecorderScript(dir: string, argvOutPath: string, sessionId: string): string {
  const scriptPath = join(dir, 'fake-pi-rpc-argv-recorder.js');
  const script = `
const { writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(argvOutPath)}, JSON.stringify(process.argv), 'utf8');
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
rl.on('line', (line) => {
  let command;
  try { command = JSON.parse(line); } catch { return; }
  switch (command.type) {
    case 'new_session':
      out({ id: command.id, type: 'response', command: 'new_session', success: true, data: { cancelled: false } });
      break;
    case 'get_state':
      out({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: ${JSON.stringify(sessionId)}${', isStreaming: false, isCompacting: false, model: { id: \'m\', provider: \'p\', name: \'M\' }' } } });
      break;
    default:
      out({ id: command.id, type: 'response', command: command.type, success: true });
  }
});
`;
  writeFileSync(scriptPath, script, 'utf8');
  return scriptPath;
}

afterEach(async () => {
  if (backend) {
    await backend.dispose();
    backend = null;
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('PiRpcBackend append-system-prompt artifact delivery', () => {
  it('serializes concurrent first-process preparation into one spawn', async () => {
    const candidate = new PiRpcBackend({
      cwd: '/tmp',
      command: process.execPath,
      args: [],
      appendSystemPromptText: 'SERIALIZE-ME',
    });
    backend = candidate;
    const priv = candidate as unknown as {
      process: unknown;
      ensureProcess(): Promise<void>;
      spawnRpcProcess(params: Readonly<{ args: string[] }>): void;
    };
    const spawnSpy = vi.spyOn(priv, 'spawnRpcProcess').mockImplementation(() => {
      priv.process = { pid: 1 };
    });

    await Promise.all([priv.ensureProcess(), priv.ensureProcess()]);

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    priv.process = null;
  });

  it('does not spawn when disposal wins during asynchronous artifact preparation', async () => {
    const candidate = new PiRpcBackend({ cwd: '/tmp', command: process.execPath, args: [] });
    backend = candidate;
    const priv = candidate as unknown as {
      ensureProcess(): Promise<void>;
      resolveProtectedSpawnArtifactArgs(): Promise<string[]>;
      spawnRpcProcess(params: Readonly<{ args: string[] }>): void;
    };
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
    vi.spyOn(priv, 'resolveProtectedSpawnArtifactArgs').mockImplementation(async () => {
      await preparation;
      return [];
    });
    const spawnSpy = vi.spyOn(priv, 'spawnRpcProcess').mockImplementation(() => undefined);

    const ensuring = priv.ensureProcess();
    await candidate.dispose();
    backend = null;
    releasePreparation();

    await expect(ensuring).rejects.toThrow('disposed');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('passes a protected file path in argv instead of the literal prompt text', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'happier-pi-rpc-artifact-'));
    const argvOutPath = join(tempDir, 'argv.json');
    const scriptPath = writeFakePiRpcArgvRecorderScript(tempDir, argvOutPath, 'pi-session-artifact-1');
    const secretPromptText = 'PROMPT-STACK-PRIVATE-CONTENT-DO-NOT-LEAK-INTO-ARGV';

    backend = new PiRpcBackend({
      cwd: tempDir,
      command: process.execPath,
      args: [scriptPath],
      appendSystemPromptText: secretPromptText,
    });

    await backend.startSession();

    const argv = JSON.parse(readFileSync(argvOutPath, 'utf8')) as string[];
    const flagIndex = argv.indexOf('--append-system-prompt');
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    const flagValue = argv[flagIndex + 1];
    // The flag value must be a path to an existing protected file, never the literal text.
    expect(argv).not.toContain(secretPromptText);
    expect(flagValue).not.toBe(secretPromptText);
    const stats = statSync(flagValue);
    expect(stats.mode & 0o777).toBe(0o600);
    expect(readFileSync(flagValue, 'utf8')).toBe(secretPromptText);
  });

  it('omits the flag entirely when no append text is configured', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'happier-pi-rpc-artifact-'));
    const argvOutPath = join(tempDir, 'argv.json');
    const scriptPath = writeFakePiRpcArgvRecorderScript(tempDir, argvOutPath, 'pi-session-artifact-2');

    backend = new PiRpcBackend({
      cwd: tempDir,
      command: process.execPath,
      args: [scriptPath],
    });

    await backend.startSession();

    const argv = JSON.parse(readFileSync(argvOutPath, 'utf8')) as string[];
    expect(argv).not.toContain('--append-system-prompt');
  });

  it('removes the artifact file on dispose', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'happier-pi-rpc-artifact-'));
    const argvOutPath = join(tempDir, 'argv.json');
    const scriptPath = writeFakePiRpcArgvRecorderScript(tempDir, argvOutPath, 'pi-session-artifact-3');

    backend = new PiRpcBackend({
      cwd: tempDir,
      command: process.execPath,
      args: [scriptPath],
      appendSystemPromptText: 'DISPOSE-ME',
    });

    await backend.startSession();
    const argv = JSON.parse(readFileSync(argvOutPath, 'utf8')) as string[];
    const artifactPath = argv[argv.indexOf('--append-system-prompt') + 1];
    expect(statSync(artifactPath).isFile()).toBe(true);

    await backend!.dispose();
    backend = null;
    expect(() => statSync(artifactPath)).toThrow();
  });
});
