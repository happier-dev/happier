import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

import { repoRootDir } from '../paths';
import { startCliAuthLoginForTerminalConnect } from './cliTerminalConnect';

it('keeps pairing material available to approval while removing it from failed-login diagnostics and logs', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'terminal-connect-redaction-'));
  const script = join(testDir, 'failed-login.mjs');
  const terminalKey = 'fixture-terminal-key';
  const pairingSecret = 'fixture-pairing-secret';
  const connectUrl = `http://127.0.0.1:12345/terminal/connect#key=${terminalKey}&pairingSecret=${pairingSecret}&serverIdentityId=fixture-home`;
  await writeFile(script, `console.log(${JSON.stringify(connectUrl)}); process.exitCode = 1;`);
  let login: Awaited<ReturnType<typeof startCliAuthLoginForTerminalConnect>> | undefined;
  try {
    login = await startCliAuthLoginForTerminalConnect({
      testDir, cliHomeDir: join(testDir, 'home'), serverUrl: 'http://127.0.0.1:12345',
      webappUrl: 'http://127.0.0.1:12345', waitForConnectUrlReady: false,
      env: process.env, cliLaunchSpec: { command: process.execPath, args: [script] },
    });
    expect(login.connectUrl).toContain(`key=${terminalKey}`);
    expect(login.connectUrl).toContain(`pairingSecret=${pairingSecret}`);
    const failure = await login.waitForSuccess().then(() => null, error => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('Failed fixture login returned no error');
    const output = await readFile(join(testDir, 'cli.auth.login.stdout.log'), 'utf8');
    for (const text of [failure.message, output]) {
      expect(text).not.toContain(terminalKey);
      expect(text).not.toContain(pairingSecret);
      expect(text).toContain('serverIdentityId=fixture-home');
    }
  } finally {
    await login?.stop();
    await rm(testDir, { recursive: true, force: true });
  }
});

it('carries workspace source export resolution into source-mode terminal login children', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'terminal-connect-source-'));
  const script = join(testDir, 'source-login.mjs');
  const serverUrl = 'http://127.0.0.1:12345';
  const sourceModule = pathToFileURL(join(repoRootDir(), 'packages/protocol/src/actions/happierActionCall.ts')).href;
  // The CLI executable is the process boundary: this child exercises the same
  // real source graph that failed before the pairing URL could be consumed.
  await writeFile(script, `console.log('${serverUrl}/terminal/connect#key=fixture-source-key&serverIdentityId=fixture-home');\nawait import(${JSON.stringify(sourceModule)});\n`);
  let login: Awaited<ReturnType<typeof startCliAuthLoginForTerminalConnect>> | undefined;
  try {
    login = await startCliAuthLoginForTerminalConnect({
      testDir, cliHomeDir: join(testDir, 'home'), serverUrl, webappUrl: serverUrl,
      waitForConnectUrlReady: false,
      env: { ...process.env, NODE_OPTIONS: undefined, HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1' },
      cliLaunchSpec: { command: process.execPath, args: [script] },
    });
    await login.waitForSuccess();
  } finally {
    await login?.stop();
    await rm(testDir, { recursive: true, force: true });
  }
});
