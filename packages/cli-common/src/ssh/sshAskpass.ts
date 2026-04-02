import { chmodSync, mkdtempSync, openSync, writeFileSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SSH_PASSWORD_ENV = 'HAPPIER_SSH_PASSWORD';

const cachedAskpassScriptPaths = new Map<string, string>();

export function ensureSshAskpassScriptPath(platformOverride?: NodeJS.Platform): string {
  const platform = String(platformOverride ?? process.platform).trim() || process.platform;
  const cached = cachedAskpassScriptPaths.get(platform);
  if (cached) {
    return cached;
  }

  const directory = mkdtempSync(join(tmpdir(), 'happier-ssh-askpass-'));
  const scriptPath = join(directory, platform === 'win32' ? 'askpass.cmd' : 'askpass.sh');
  const fd = openSync(scriptPath, 'wx', 0o700);
  try {
    if (platform === 'win32') {
      writeFileSync(
        fd,
        `@echo off\r\necho %${SSH_PASSWORD_ENV}%\r\n`,
        { encoding: 'utf8' },
      );
    } else {
      writeFileSync(
        fd,
        `#!/bin/sh
printf "%s\\n" "$${SSH_PASSWORD_ENV}"
`,
        { encoding: 'utf8' },
      );
    }
  } finally {
    closeSync(fd);
  }

  chmodSync(scriptPath, 0o700);
  cachedAskpassScriptPaths.set(platform, scriptPath);
  return scriptPath;
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
