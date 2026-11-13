import { afterEach, describe, expect, it, vi } from 'vitest';

import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isSupportedHerdrVersion, resolveHerdrRuntimeBinary } from './runtimeBinary';

afterEach(() => vi.unstubAllEnvs());

describe('Herdr runtime binary', () => {
  it('probes the executable selected by admitted context rather than later ambient configuration', async () => {
    vi.stubEnv('HERDR_BIN_PATH', '/nonexistent-provider-binary');
    await expect(resolveHerdrRuntimeBinary({ actionTimeoutMs: 1000,
      processEnv: { ...process.env, HERDR_BIN_PATH: process.execPath },
    })).resolves.toBe(process.execPath);
  });
  it('preserves a completed version probe when the host event loop stalls past its deadline', async () => {
    // The real executable supplies a stable version banner and exits immediately. Its output
    // is supported by the same semver contract; no internal deadline logic is replaced.
    vi.stubEnv('HERDR_BIN_PATH', process.execPath);
    expect(isSupportedHerdrVersion(process.version)).toBe(true);
    const pending = resolveHerdrRuntimeBinary({ actionTimeoutMs: 200 });
    const until = Date.now() + 1_500;
    while (Date.now() < until) { /* Reproduce a stalled daemon timers phase. */ }
    await expect(pending).resolves.toBe(process.execPath);
  });
});

describe('Herdr minimum version', () => {
  it('requires stable releases at or after 0.9.2', () => {
    expect(isSupportedHerdrVersion('0.9.1-preview.2026-09-28-80c0c07250d2')).toBe(false);
    expect(isSupportedHerdrVersion('0.9.1-preview.2026-09-29-abcdef123456')).toBe(false);
    expect(isSupportedHerdrVersion('0.9.1-preview.2026-09-27-abcdef123456')).toBe(false);
    expect(isSupportedHerdrVersion('herdr 0.9.1')).toBe(false);
    expect(isSupportedHerdrVersion('0.8.9')).toBe(false);
    expect(isSupportedHerdrVersion('1.0.0')).toBe(true);
    expect(isSupportedHerdrVersion('1.0.0-preview.1')).toBe(false);
    expect(isSupportedHerdrVersion('0.9.2')).toBe(true);
    expect(isSupportedHerdrVersion('0.10.0')).toBe(true);
  });
});

it.skipIf(process.platform === 'win32')('probes each hosted Session binary with its admitted environment', async () => {
  vi.stubEnv('HERDR_BIN_PATH', '/nonexistent-host-herdr');
  await Promise.all(['first', 'second'].map(sessionId => withTempDir('herdr-session-probe-', async dir => {
    const capture = join(dir, 'probe.json');
    const binary = await writeExecutableShim({ dir, fileName: 'herdr', contents:
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ session: process.env.HERDR_SESSION_BASE })); console.log('herdr 0.9.3');\n` });
    await runAddedHostedSession({ environment: { ...process.env, HERDR_BIN_PATH: binary, HERDR_SESSION_BASE: sessionId },
      workingDirectory: dir, end() {} }, async () => {
      await expect(resolveHerdrRuntimeBinary({ actionTimeoutMs: 1000 })).resolves.toBe(binary);
    });
    expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual({ session: sessionId });
  })));
});
