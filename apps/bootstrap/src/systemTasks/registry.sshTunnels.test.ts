import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeSystemTask } from '@happier-dev/cli-common/systemTasks';
import { SSH_TUNNEL_SYSTEM_TASK_KIND_IDS, SSH_TUNNEL_SYSTEM_TASK_KINDS } from '@happier-dev/protocol/ssh/tunnels';
import { afterEach, expect, it, vi } from 'vitest';
import { createHsetupSystemTaskRegistry } from './registry.js';

let root: string | undefined;
afterEach(() => { vi.unstubAllEnvs(); if (root) rmSync(root, { recursive: true, force: true }); });

it('routes desktop tunnel tasks to the installed CLI owner and preserves its result and refusal', async () => {
  root = mkdtempSync(join(tmpdir(), 'hsetup-tunnels-'));
  const cli = join(root, 'happier');
  // The installed executable is the process boundary; real hsetup registration and execution stay active.
  writeFileSync(cli, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const spec = JSON.parse(input);
  if (process.argv.slice(2).join(' ') !== 'daemon system-task --json') process.exit(2);
  const result = process.env.L12_TUNNEL_REFUSAL
    ? { protocolVersion: 1, taskId: 'cli', ok: false, error: { code: 'ssh_tunnel_host_key_untrusted', message: 'Host key requires approval.' } }
    : { protocolVersion: 1, taskId: 'cli', ok: true, data: { kind: spec.kind, params: spec.params } };
  process.stdout.write(JSON.stringify(result));
});
`);
  chmodSync(cli, 0o755);
  vi.stubEnv('HAPPIER_BOOTSTRAP_CLI_PATH', cli);
  const registry = createHsetupSystemTaskRegistry();
  for (const kind of SSH_TUNNEL_SYSTEM_TASK_KIND_IDS) {
    const result = await executeSystemTask({ registry, taskId: 'desktop', spec: { protocolVersion: 1, kind, params: { leaseId: 'lease-1' } } });
    expect(result).toEqual({ protocolVersion: 1, taskId: 'desktop', ok: true, data: { kind, params: { leaseId: 'lease-1' } } });
  }
  vi.stubEnv('L12_TUNNEL_REFUSAL', '1');
  const refusal = await executeSystemTask({ registry, taskId: 'desktop', spec: { protocolVersion: 1, kind: SSH_TUNNEL_SYSTEM_TASK_KINDS.ensure, params: {} } });
  expect(refusal).toMatchObject({ ok: false, error: { code: 'ssh_tunnel_host_key_untrusted' } });
});
