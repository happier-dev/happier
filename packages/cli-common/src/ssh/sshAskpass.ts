import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SSH_PASSWORD_ENV = 'HAPPIER_SSH_PASSWORD';

const ASKPASS_SCRIPT_PATH = join(tmpdir(), 'happier-ssh-askpass.sh');

export function ensureSshAskpassScriptPath(): string {
  const directory = join(tmpdir(), 'happier');
  mkdirSync(directory, { recursive: true });
  if (!existsSync(ASKPASS_SCRIPT_PATH)) {
    writeFileSync(
      ASKPASS_SCRIPT_PATH,
      `#!/bin/sh
printf "%s\\n" "$${SSH_PASSWORD_ENV}"
`,
      {
        encoding: 'utf8',
        mode: 0o700,
      },
    );
  }

  try {
    chmodSync(ASKPASS_SCRIPT_PATH, 0o700);
  } catch {
    // best effort
  }

  return ASKPASS_SCRIPT_PATH;
}

export function buildSshAskpassEnv(password: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    [SSH_PASSWORD_ENV]: String(password ?? ''),
    SSH_ASKPASS: ensureSshAskpassScriptPath(),
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY ?? ':0',
  };
}
