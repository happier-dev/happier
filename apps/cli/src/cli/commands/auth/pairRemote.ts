import spawn from 'cross-spawn';

import { approveTerminalAuthRequest } from '@/auth/terminalAuthApproval';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';

function takeFlagValue(args: string[], name: string): { value: string | null; rest: string[] } {
  const rest: string[] = [];
  let value: string | null = null;

  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i] ?? '');
    if (a === name) {
      const next = String(args[i + 1] ?? '');
      if (!next || next.startsWith('--')) {
        throw new Error(`Missing value for ${name}`);
      }
      value = next;
      i += 1;
      continue;
    }
    if (a.startsWith(`${name}=`)) {
      const v = a.slice(`${name}=`.length);
      if (!v) throw new Error(`Missing value for ${name}`);
      value = v;
      continue;
    }
    rest.push(a);
  }

  return { value, rest };
}

function runSshJson(params: Readonly<{ target: string; remoteArgs: string[] }>): any {
  const result = spawn.sync('ssh', [params.target, ...params.remoteArgs], { stdio: 'pipe' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : String(result.stderr ?? '');
    throw new Error(`ssh exited with code ${result.status}: ${stderr}`.trim());
  }
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf8') : String(result.stdout ?? '');
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  throw new Error('Remote command did not return valid JSON');
}

export async function handleAuthPairRemote(argsRaw: string[]): Promise<void> {
  let args = await applyServerSelectionFromArgs(argsRaw);

  const json = args.includes('--json');
  if (!json) {
    console.error('Missing required flag: --json');
    process.exit(2);
  }

  const ssh = takeFlagValue(args, '--ssh');
  args = ssh.rest;
  if (!ssh.value) {
    console.error('Missing required flag: --ssh <user@host>');
    process.exit(2);
  }

  const request = runSshJson({ target: ssh.value, remoteArgs: ['happier', 'auth', 'request', '--json'] });
  const publicKey = typeof request?.publicKey === 'string' ? request.publicKey : '';
  if (!publicKey) {
    console.error('Remote `happier auth request --json` output did not include "publicKey".');
    process.exit(1);
  }

  try {
    await approveTerminalAuthRequest({ publicKey });
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Failed to approve auth request.');
    process.exit(1);
  }

  runSshJson({
    target: ssh.value,
    remoteArgs: ['happier', 'auth', 'wait', '--public-key', publicKey, '--json'],
  });

  console.log(JSON.stringify({ success: true, ssh: ssh.value, publicKey }));
}

