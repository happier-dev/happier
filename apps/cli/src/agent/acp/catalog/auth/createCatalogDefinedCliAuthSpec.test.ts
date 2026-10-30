import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { createCatalogDefinedCliAuthSpec } from './createCatalogDefinedCliAuthSpec';

describe('createCatalogDefinedCliAuthSpec', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  // FX 0.0.14 / 1a070af32cdf: output_contracts.zig StatusSnapshot.
  it.each([
    [{ kind: 'status', auth: 'Codex subscription', auth_refreshable: true }, { state: 'logged_in', method: 'oauth_cli' }],
    [{ kind: 'status', auth: 'AI_GATEWAY_API_KEY', auth_refreshable: false }, { state: 'logged_in', method: 'api_key_env' }],
    [{ kind: 'status', auth: 'missing', auth_refreshable: false }, { state: 'logged_out', reason: 'missing_credentials' }],
    [{ kind: 'status', auth: 'Codex subscription', auth_refreshable: true, auth_expired: true }, { state: 'logged_out', reason: 'expired' }],
    [{ kind: 'status', auth: 'host managed', auth_refreshable: false }, { state: 'unknown', reason: 'not_configured' }],
    [{ kind: 'status', auth: 'future-source', auth_refreshable: false }, { state: 'unknown', reason: 'probe_failed' }],
    [{ kind: 'other', auth: 'Codex subscription', auth_refreshable: true }, { state: 'unknown', reason: 'probe_failed' }],
    [{ kind: 'status', auth: 'Codex subscription', auth_refreshable: true, auth_expired: 'true' }, { state: 'unknown', reason: 'probe_failed' }],
    [null, { state: 'unknown', reason: 'probe_failed' }],
  ])('interprets fx status %j through the catalog auth consumer', async (payload, expected) => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-fx-auth-'));
    tempDirs.push(dir);
    const scriptPath = join(dir, 'fx.js');
    // A fake native executable is the system boundary; command resolution and parsing stay real.
    await writeFile(scriptPath, `#!/usr/bin/env node\nif (JSON.stringify(process.argv.slice(2)) !== '["status","--json"]') process.exit(64);\nprocess.stdout.write(${JSON.stringify(JSON.stringify(payload))});\n`, 'utf8');
    await chmod(scriptPath, 0o755);
    const detectAuthStatus = createCatalogDefinedCliAuthSpec('fx').detectAuthStatus;
    if (!detectAuthStatus) throw new Error('expected detectAuthStatus');
    await expect(detectAuthStatus({ resolvedPath: scriptPath })).resolves.toEqual({ ...expected, source: 'command' });
  });

  it('keeps a failed fx command unknown even if stdout claims a valid login', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-fx-auth-failed-'));
    tempDirs.push(dir);
    const scriptPath = join(dir, 'fx.js');
    await writeFile(scriptPath, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ kind: "status", auth: "fx login", auth_refreshable: true })); process.exit(1);\n', 'utf8');
    await chmod(scriptPath, 0o755);
    const detectAuthStatus = createCatalogDefinedCliAuthSpec('fx').detectAuthStatus;
    if (!detectAuthStatus) throw new Error('expected detectAuthStatus');
    await expect(detectAuthStatus({ resolvedPath: scriptPath })).resolves.toEqual({ state: 'unknown', reason: 'probe_failed', source: 'command' });
  });

  it('detects logged-in Kiro auth status from whoami json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-kiro-auth-'));
    tempDirs.push(dir);

    const scriptPath = join(dir, 'kiro-cli.js');
    await writeFile(
      scriptPath,
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ email: "agent@example.com" }));\n',
      'utf8',
    );
    await chmod(scriptPath, 0o755);

    const spec = createCatalogDefinedCliAuthSpec('kiro');
    const detectAuthStatus = spec.detectAuthStatus;
    expect(detectAuthStatus).toBeTypeOf('function');
    if (!detectAuthStatus) throw new Error('expected detectAuthStatus');

    await expect(detectAuthStatus({ resolvedPath: scriptPath })).resolves.toMatchObject({
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
      accountLabel: 'agent@example.com',
    });
  });

  it('marks Kiro as logged out when whoami exits non-zero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-kiro-auth-fail-'));
    tempDirs.push(dir);

    const scriptPath = join(dir, 'kiro-cli.js');
    await writeFile(
      scriptPath,
      '#!/usr/bin/env node\nprocess.exit(1);\n',
      'utf8',
    );
    await chmod(scriptPath, 0o755);

    const spec = createCatalogDefinedCliAuthSpec('kiro');
    const detectAuthStatus = spec.detectAuthStatus;
    expect(detectAuthStatus).toBeTypeOf('function');
    if (!detectAuthStatus) throw new Error('expected detectAuthStatus');

    await expect(detectAuthStatus({ resolvedPath: scriptPath })).resolves.toMatchObject({
      state: 'logged_out',
      reason: 'missing_credentials',
      source: 'command',
    });
  });

  it('detects logged-in Devin auth without exposing command output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-devin-auth-'));
    tempDirs.push(dir);

    const scriptPath = join(dir, 'devin.js');
    await writeFile(
      scriptPath,
      '#!/usr/bin/env node\nprocess.stdout.write("Authenticated as agent@example.com");\n',
      'utf8',
    );
    await chmod(scriptPath, 0o755);

    const spec = createCatalogDefinedCliAuthSpec('devin');
    const detectAuthStatus = spec.detectAuthStatus;
    expect(detectAuthStatus).toBeTypeOf('function');
    if (!detectAuthStatus) throw new Error('expected detectAuthStatus');

    await expect(detectAuthStatus({ resolvedPath: scriptPath })).resolves.toEqual({
      state: 'logged_in',
      method: 'oauth_cli',
      source: 'command',
    });
  });

  it('recognizes Devin 3000.10 logged-out output even though the command exits successfully', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-devin-auth-missing-'));
    tempDirs.push(dir);

    const scriptPath = join(dir, 'devin.js');
    await writeFile(
      scriptPath,
      '#!/usr/bin/env node\nprocess.stdout.write("Not logged in.\\n  Credentials path: /private/credentials.toml\\nRun `devin auth login` to authenticate.\\n");\n',
      'utf8',
    );
    await chmod(scriptPath, 0o755);

    const detectAuthStatus = createCatalogDefinedCliAuthSpec('devin').detectAuthStatus;
    if (!detectAuthStatus) throw new Error('expected detectAuthStatus');

    await expect(detectAuthStatus({ resolvedPath: scriptPath })).resolves.toEqual({
      state: 'logged_out',
      reason: 'missing_credentials',
      source: 'command',
    });
  });

  it('does not misreport a crashing Devin auth probe as logged out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-devin-auth-crash-'));
    tempDirs.push(dir);

    const scriptPath = join(dir, 'devin.js');
    await writeFile(scriptPath, '#!/usr/bin/env node\nprocess.stderr.write("panic"); process.exit(101);\n', 'utf8');
    await chmod(scriptPath, 0o755);

    const detectAuthStatus = createCatalogDefinedCliAuthSpec('devin').detectAuthStatus;
    if (!detectAuthStatus) throw new Error('expected detectAuthStatus');

    await expect(detectAuthStatus({ resolvedPath: scriptPath })).resolves.toEqual({
      state: 'unknown',
      reason: 'probe_failed',
      source: 'command',
    });
  });
});
