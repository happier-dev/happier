import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function createFakeTailscaleCli(scenario = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-tailscale-'));
  const cliPath = join(rootDir, 'fake-tailscale');
  const statePath = join(rootDir, 'scenario.json');
  const logPath = join(rootDir, 'invocations.log');

  writeFileSync(statePath, JSON.stringify({
    statusJsons: scenario.statusJsons ?? [
      {
        BackendState: 'Running',
        AuthURL: '',
        HaveNodeKey: true,
        Self: {
          DNSName: 'relay.tailf00.ts.net.',
        },
        CurrentTailnet: {
          Name: 'example-tailnet',
        },
        TailscaleIPs: ['100.64.0.10'],
      },
    ],
    loginOutputs: scenario.loginOutputs ?? [],
    serveStatuses: scenario.serveStatuses ?? [],
    serveEnableOutputs: scenario.serveEnableOutputs ?? [],
  }, null, 2));

  writeFileSync(cliPath, `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');

const statePath = process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH;
const logPath = process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH;
const argv = process.argv.slice(2);
appendFileSync(logPath, JSON.stringify(argv) + '\\n');

const state = JSON.parse(readFileSync(statePath, 'utf8'));

function shift(list, fallback) {
  const values = Array.isArray(list) ? [...list] : [];
  const next = values.length > 0 ? values.shift() : fallback;
  return { next, rest: values };
}

if (argv[0] === 'status' && argv[1] === '--json') {
  const { next, rest } = shift(state.statusJsons, {
    BackendState: 'Running',
    AuthURL: '',
    HaveNodeKey: true,
    Self: { DNSName: 'relay.tailf00.ts.net.' },
    CurrentTailnet: { Name: 'example-tailnet' },
    TailscaleIPs: ['100.64.0.10'],
  });
  state.statusJsons = rest;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.stdout.write(JSON.stringify(next) + '\\n');
  process.exit(0);
}

if (argv[0] === 'login' && (argv[1] === '--qr' || argv.length === 1)) {
  const { next, rest } = shift(state.loginOutputs, {
    exitCode: 0,
    stdout: 'logged in',
    stderr: '',
  });
  state.loginOutputs = rest;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  if (next.stdout) process.stdout.write(String(next.stdout));
  if (next.stderr) process.stderr.write(String(next.stderr));
  process.exit(Number(next.exitCode ?? 0));
}

if (argv[0] === 'serve' && argv[1] === 'status') {
  const { next, rest } = shift(state.serveStatuses, '');
  state.serveStatuses = rest;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.stdout.write(String(next ?? ''));
  process.exit(0);
}

if (argv[0] === 'serve' && argv[1] === '--bg') {
  const { next, rest } = shift(state.serveEnableOutputs, {
    exitCode: 0,
    stdout: '',
    stderr: '',
  });
  state.serveEnableOutputs = rest;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  if (next.stdout) process.stdout.write(String(next.stdout));
  if (next.stderr) process.stderr.write(String(next.stderr));
  process.exit(Number(next.exitCode ?? 0));
}

process.stderr.write('Unexpected fake tailscale args: ' + argv.join(' ') + '\\n');
process.exit(1);
`);
  chmodSync(cliPath, 0o755);
  writeFileSync(logPath, '');

  return {
    cliPath,
    cleanup() {
      rmSync(rootDir, { recursive: true, force: true });
    },
    readInvocations() {
      const raw = readFileSync(logPath, 'utf8').trim();
      if (!raw) {
        return [];
      }
      return raw.split('\n').map((line) => JSON.parse(line));
    },
  };
}
