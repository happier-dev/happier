import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PiRpcBackend } from './PiRpcBackend';

function writeFakePi(dir: string, argvPath: string): string {
  const script = join(dir, 'fake-pi.js');
  writeFileSync(script, `
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv));
const rl = readline.createInterface({ input: process.stdin });
const out = value => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', line => {
  const command = JSON.parse(line);
  const base = { id: command.id, type: 'response', command: command.type, success: true };
  if (command.type === 'new_session') return out({ ...base, data: { cancelled: false } });
  if (command.type === 'get_state') return out({ ...base, data: { sessionId: 'pi-artifact', isStreaming: false, isCompacting: false, model: { id: 'm', provider: 'p' } } });
  if (command.type === 'get_available_models') return out({ ...base, data: { models: [] } });
  if (command.type === 'get_commands') return out({ ...base, data: { commands: [] } });
  out({ ...base, data: {} });
});
`);
  chmodSync(script, 0o755);
  return script;
}

describe('PiRpcBackend append-system-prompt artifact delivery', () => {
  let backend: PiRpcBackend | null = null;
  let dir: string | null = null;
  afterEach(async () => {
    await backend?.dispose();
    backend = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('passes a protected file path instead of prompt text and removes it on dispose', async () => {
    dir = mkdtempSync(join(tmpdir(), 'happier-pi-artifact-'));
    const argvPath = join(dir, 'argv.json');
    const secret = 'PRIVATE HAPPIER SYSTEM PROMPT';
    backend = new PiRpcBackend({
      cwd: dir,
      command: process.execPath,
      args: [writeFakePi(dir, argvPath)],
      appendSystemPromptText: secret,
    });

    await backend.startSession();
    const argv = JSON.parse(readFileSync(argvPath, 'utf8')) as string[];
    const flagIndex = argv.indexOf('--append-system-prompt');
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(argv).not.toContain(secret);
    const artifactPath = argv[flagIndex + 1]!;
    expect(statSync(artifactPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(artifactPath, 'utf8')).toBe(secret);
    await backend.dispose();
    backend = null;
    expect(() => statSync(artifactPath)).toThrow();
  });
});
