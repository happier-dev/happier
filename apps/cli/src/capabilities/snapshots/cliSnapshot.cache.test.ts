import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';

import { createProbeTempDir, writeExecutableScript } from '@/capabilities/probes/agentModelsProbe.testkit';
import { writePnpmNodeBridge } from '@/testkit/fs/executableShim';
import type { DetectCliRequest } from './cliSnapshot';

describe('detectCliSnapshotOnDaemonPath (cache)', () => {
  const previousOpenCodePath = process.env.HAPPIER_OPENCODE_PATH;

  beforeEach(() => {
    // Some CLI unit lanes provide a default OpenCode stub for machine-agnostic tests.
    // Cache behavior tests need full control over PATH vs overrides, so clear the global
    // override by default and let individual tests set it when needed.
    delete process.env.HAPPIER_OPENCODE_PATH;
  });

  afterEach(() => {
    if (previousOpenCodePath === undefined) {
      delete process.env.HAPPIER_OPENCODE_PATH;
    } else {
      process.env.HAPPIER_OPENCODE_PATH = previousOpenCodePath;
    }
  });

  it('returns a timed-out auth status instead of hanging when a CLI auth probe never settles', async () => {
    vi.resetModules();

    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        codex: {
          id: 'codex',
          getCliAuthSpec: async () => ({
            binaryNames: ['codex'],
            detectAuthStatus: async () => await new Promise<never>(() => {}),
          }),
        },
      },
    }));

    const fixture = await createProbeTempDir('happier-cli-snapshot-cache-auth-timeout');
    const binDir = resolve(join(fixture.dir, 'bin'));
    await mkdir(binDir, { recursive: true });

    const codexPath = resolve(join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex'));
    await writeExecutableScript(
      codexPath,
      process.platform === 'win32'
        ? '@echo off\r\necho codex 0.0.0-test\r\n'
        : '#!/bin/sh\necho "codex 0.0.0-test"\n',
    );

    const prevPath = process.env.PATH;
    const prevProbeTimeout = process.env.HAPPIER_CLI_SNAPSHOT_PROBE_TIMEOUT_MS;
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;
    process.env.HAPPIER_CLI_SNAPSHOT_PROBE_TIMEOUT_MS = '25';

    try {
      const { detectCliSnapshotOnDaemonPath } = await import('./cliSnapshot');

      const startedAt = Date.now();
      const snapshot = await detectCliSnapshotOnDaemonPath({ includeLoginStatus: true, bypassCache: true });

      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(snapshot.clis.codex.available).toBe(true);
      expect(snapshot.clis.codex.isLoggedIn).toBeNull();
      expect(snapshot.clis.codex.authStatus).toMatchObject({
        state: 'unknown',
        reason: 'timeout',
      });
    } finally {
      process.env.PATH = prevPath;
      if (typeof prevProbeTimeout === 'string') process.env.HAPPIER_CLI_SNAPSHOT_PROBE_TIMEOUT_MS = prevProbeTimeout;
      else delete process.env.HAPPIER_CLI_SNAPSHOT_PROBE_TIMEOUT_MS;
      await fixture.cleanup();
    }
  }, 20_000);

  it('only probes auth for requested CLI names when the request is provider-scoped', async () => {
    vi.resetModules();

    const codexAuthProbe = vi.fn(async () => ({
      state: 'logged_in' as const,
      method: 'oauth_cli' as const,
      source: 'command' as const,
    }));
    const opencodeAuthProbe = vi.fn(async () => ({
      state: 'logged_in' as const,
      method: 'oauth_cli' as const,
      source: 'command' as const,
    }));

    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        codex: {
          id: 'codex',
          getCliAuthSpec: async () => ({
            binaryNames: ['codex'],
            detectAuthStatus: codexAuthProbe,
          }),
        },
        opencode: {
          id: 'opencode',
          getCliAuthSpec: async () => ({
            binaryNames: ['opencode'],
            detectAuthStatus: opencodeAuthProbe,
          }),
        },
      },
    }));

    const fixture = await createProbeTempDir('happier-cli-snapshot-cache-scoped-auth');
    const binDir = resolve(join(fixture.dir, 'bin'));
    await mkdir(binDir, { recursive: true });

    await writeExecutableScript(
      resolve(join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex')),
      process.platform === 'win32'
        ? '@echo off\r\necho codex 0.0.0-test\r\n'
        : '#!/bin/sh\necho "codex 0.0.0-test"\n',
    );
    await writeExecutableScript(
      resolve(join(binDir, process.platform === 'win32' ? 'opencode.cmd' : 'opencode')),
      process.platform === 'win32'
        ? '@echo off\r\necho opencode 0.0.0-test\r\n'
        : '#!/bin/sh\necho "opencode 0.0.0-test"\n',
    );

    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;

    try {
      const { detectCliSnapshotOnDaemonPath } = await import('./cliSnapshot');

      const snapshot = await detectCliSnapshotOnDaemonPath({
        includeLoginStatus: true,
        bypassCache: true,
        requestedCliNames: ['codex'],
      } as DetectCliRequest & { requestedCliNames: readonly string[] });

      expect(snapshot.clis.codex.isLoggedIn).toBe(true);
      expect(codexAuthProbe).toHaveBeenCalledTimes(1);
      expect(opencodeAuthProbe).not.toHaveBeenCalled();
    } finally {
      process.env.PATH = prevPath;
      await fixture.cleanup();
    }
  }, 20_000);

  it('allows slower successful auth probes to complete before the snapshot timeout', async () => {
    vi.resetModules();

    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        codex: {
          id: 'codex',
          getCliAuthSpec: async () => ({
            binaryNames: ['codex'],
            detectAuthStatus: async () => {
              await new Promise((resolve) => setTimeout(resolve, 1_700));
              return {
                state: 'logged_in',
                method: 'oauth_cli',
                source: 'command',
              };
            },
          }),
        },
      },
    }));

    const fixture = await createProbeTempDir('happier-cli-snapshot-cache-auth-slow-success');
    const binDir = resolve(join(fixture.dir, 'bin'));
    await mkdir(binDir, { recursive: true });

    const codexPath = resolve(join(binDir, process.platform === 'win32' ? 'codex.cmd' : 'codex'));
    await writeExecutableScript(
      codexPath,
      process.platform === 'win32'
        ? '@echo off\r\necho codex 0.0.0-test\r\n'
        : '#!/bin/sh\necho "codex 0.0.0-test"\n',
    );

    const prevPath = process.env.PATH;
    const prevCi = process.env.CI;
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;
    delete process.env.CI;

    try {
      const { detectCliSnapshotOnDaemonPath } = await import('./cliSnapshot');

      const snapshot = await detectCliSnapshotOnDaemonPath({ includeLoginStatus: true, bypassCache: true });

      expect(snapshot.clis.codex.available).toBe(true);
      expect(snapshot.clis.codex.isLoggedIn).toBe(true);
      expect(snapshot.clis.codex.authStatus).toMatchObject({
        state: 'logged_in',
        method: 'oauth_cli',
        source: 'command',
      });
    } finally {
      process.env.PATH = prevPath;
      if (typeof prevCi === 'string') process.env.CI = prevCi;
      else delete process.env.CI;
      await fixture.cleanup();
    }
  }, 20_000);

  it('caches snapshots and avoids re-probing CLI versions within TTL', async () => {
    vi.resetModules();

    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        opencode: { id: 'opencode' },
      },
    }));

    const fixture = await createProbeTempDir('happier-cli-snapshot-cache');
    const binDir = resolve(join(fixture.dir, 'bin'));
    await mkdir(binDir, { recursive: true });

    const countFile = resolve(join(fixture.dir, 'count.txt'));
    await writeFile(countFile, '', 'utf8');

    const opencodePath = resolve(join(binDir, 'opencode'));
    await writeExecutableScript(
      opencodePath,
      `#!/usr/bin/env node
const fs = require("fs");
const countFile = process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE;
if (countFile) fs.appendFileSync(countFile, "1");
process.stdout.write("opencode 1.2.3\\n");
process.exit(0);
`,
    );

    const prevPath = process.env.PATH;
    const prevCountFile = process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE;
    const prevPnpmBin = process.env.HAPPIER_PNPM_BIN;
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;
    process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE = countFile;
    process.env.HAPPIER_PNPM_BIN = await writePnpmNodeBridge({ dir: fixture.dir, pathLookup: prevPath });
    try {
      const { detectCliSnapshotOnDaemonPath } = await import('./cliSnapshot');

      await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false });
      const afterFirst = (await readFile(countFile, 'utf8')).length;

      await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false });
      const afterSecond = (await readFile(countFile, 'utf8')).length;

      expect(afterSecond).toBe(afterFirst);

      // Different request params should not share the cached entry.
      await detectCliSnapshotOnDaemonPath({ includeLoginStatus: true });
      const afterThird = (await readFile(countFile, 'utf8')).length;
      expect(afterThird).toBeGreaterThan(afterSecond);
    } finally {
      process.env.PATH = prevPath;
      if (typeof prevCountFile === 'string') process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE = prevCountFile;
      else delete process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE;
      if (typeof prevPnpmBin === 'string') process.env.HAPPIER_PNPM_BIN = prevPnpmBin;
      else delete process.env.HAPPIER_PNPM_BIN;
      await fixture.cleanup();
    }
  }, 20_000);

  it('invalidates cache when HAPPIER_*_PATH override changes', async () => {
    vi.resetModules();

    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        opencode: { id: 'opencode' },
      },
    }));

    const fixture = await createProbeTempDir('happier-cli-snapshot-cache-override');
    const binDir = resolve(join(fixture.dir, 'bin'));
    const altBinDir = resolve(join(fixture.dir, 'alt-bin'));
    await mkdir(binDir, { recursive: true });
    await mkdir(altBinDir, { recursive: true });

    const countFile = resolve(join(fixture.dir, 'count.txt'));
    await writeFile(countFile, '', 'utf8');

    const opencodePath = resolve(join(binDir, 'opencode'));
    const altOpencodePath = resolve(join(altBinDir, 'opencode'));
    const script = `#!/usr/bin/env node
const fs = require("fs");
const countFile = process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE;
if (countFile) fs.appendFileSync(countFile, "1");
process.stdout.write("opencode 1.2.3\\n");
process.exit(0);
`;
    await writeExecutableScript(opencodePath, script);
    await writeExecutableScript(altOpencodePath, script);

    const prevPath = process.env.PATH;
    const prevCountFile = process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE;
    const prevOverride = process.env.HAPPIER_OPENCODE_PATH;
    const prevPnpmBin = process.env.HAPPIER_PNPM_BIN;

    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;
    process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE = countFile;
    process.env.HAPPIER_PNPM_BIN = await writePnpmNodeBridge({ dir: fixture.dir, pathLookup: prevPath });

    try {
      const { detectCliSnapshotOnDaemonPath } = await import('./cliSnapshot');

      // First call with no override
      await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false });
      const afterFirst = (await readFile(countFile, 'utf8')).length;

      // Second call with no override should use cache
      await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false });
      const afterSecond = (await readFile(countFile, 'utf8')).length;
      expect(afterSecond).toBe(afterFirst);

      // Set override - should invalidate cache and re-probe
      process.env.HAPPIER_OPENCODE_PATH = altOpencodePath;
      await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false });
      const afterThird = (await readFile(countFile, 'utf8')).length;
      expect(afterThird).toBeGreaterThan(afterSecond);

      // Fourth call with same override should use cache
      await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false });
      const afterFourth = (await readFile(countFile, 'utf8')).length;
      expect(afterFourth).toBe(afterThird);
    } finally {
      process.env.PATH = prevPath;
      if (typeof prevCountFile === 'string') process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE = prevCountFile;
      else delete process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE;
      if (typeof prevOverride === 'string') process.env.HAPPIER_OPENCODE_PATH = prevOverride;
      else delete process.env.HAPPIER_OPENCODE_PATH;
      if (typeof prevPnpmBin === 'string') process.env.HAPPIER_PNPM_BIN = prevPnpmBin;
      else delete process.env.HAPPIER_PNPM_BIN;
      await fixture.cleanup();
    }
  }, 20_000);

  it('invalidates cache when HAPPIER_HOME_DIR changes', async () => {
    vi.resetModules();

    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        opencode: { id: 'opencode' },
      },
    }));

    const fixture = await createProbeTempDir('happier-cli-snapshot-cache-homedir');
    const binDir = resolve(join(fixture.dir, 'bin'));
    await mkdir(binDir, { recursive: true });

    const countFile = resolve(join(fixture.dir, 'count.txt'));
    await writeFile(countFile, '', 'utf8');

    const opencodePath = resolve(join(binDir, 'opencode'));
    await writeExecutableScript(
      opencodePath,
      `#!/usr/bin/env node
const fs = require("fs");
const countFile = process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE;
if (countFile) fs.appendFileSync(countFile, "1");
process.stdout.write("opencode 1.2.3\\n");
process.exit(0);
`,
    );

    const prevPath = process.env.PATH;
    const prevCountFile = process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE;
    const prevHomeDir = process.env.HAPPIER_HOME_DIR;
    const prevPnpmBin = process.env.HAPPIER_PNPM_BIN;

    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;
    process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE = countFile;
    process.env.HAPPIER_HOME_DIR = '/tmp/happier-home-1';
    process.env.HAPPIER_PNPM_BIN = await writePnpmNodeBridge({ dir: fixture.dir, pathLookup: prevPath });

    try {
      const { detectCliSnapshotOnDaemonPath } = await import('./cliSnapshot');

      await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false });
      const afterFirst = (await readFile(countFile, 'utf8')).length;

      await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false });
      const afterSecond = (await readFile(countFile, 'utf8')).length;
      expect(afterSecond).toBe(afterFirst);

      // Change HAPPIER_HOME_DIR - should invalidate cache
      process.env.HAPPIER_HOME_DIR = '/tmp/happier-home-2';
      await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false });
      const afterThird = (await readFile(countFile, 'utf8')).length;
      expect(afterThird).toBeGreaterThan(afterSecond);
    } finally {
      process.env.PATH = prevPath;
      if (typeof prevCountFile === 'string') process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE = prevCountFile;
      else delete process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE;
      if (typeof prevHomeDir === 'string') process.env.HAPPIER_HOME_DIR = prevHomeDir;
      else delete process.env.HAPPIER_HOME_DIR;
      if (typeof prevPnpmBin === 'string') process.env.HAPPIER_PNPM_BIN = prevPnpmBin;
      else delete process.env.HAPPIER_PNPM_BIN;
      await fixture.cleanup();
    }
  }, 20_000);

  it('invalidates cache when HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON changes', async () => {
    vi.resetModules();

    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        opencode: { id: 'opencode' },
      },
    }));

    const fixture = await createProbeTempDir('happier-cli-snapshot-cache-prefs');
    const binDir = resolve(join(fixture.dir, 'bin'));
    await mkdir(binDir, { recursive: true });

    const countFile = resolve(join(fixture.dir, 'count.txt'));
    await writeFile(countFile, '', 'utf8');

    const opencodePath = resolve(join(binDir, 'opencode'));
    await writeExecutableScript(
      opencodePath,
      `#!/usr/bin/env node
const fs = require("fs");
const countFile = process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE;
if (countFile) fs.appendFileSync(countFile, "1");
process.stdout.write("opencode 1.2.3\\n");
process.exit(0);
`,
    );

    const prevPath = process.env.PATH;
    const prevCountFile = process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE;
    const prevPrefs = process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON;
    const prevPnpmBin = process.env.HAPPIER_PNPM_BIN;

    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;
    process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE = countFile;
    process.env.HAPPIER_PNPM_BIN = await writePnpmNodeBridge({ dir: fixture.dir, pathLookup: prevPath });

    try {
      const { detectCliSnapshotOnDaemonPath } = await import('./cliSnapshot');

      await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false });
      const afterFirst = (await readFile(countFile, 'utf8')).length;

      await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false });
      const afterSecond = (await readFile(countFile, 'utf8')).length;
      expect(afterSecond).toBe(afterFirst);

      // Change source preferences - should invalidate cache
      process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON = JSON.stringify({ opencode: 'managed-first' });
      await detectCliSnapshotOnDaemonPath({ includeLoginStatus: false });
      const afterThird = (await readFile(countFile, 'utf8')).length;
      expect(afterThird).toBeGreaterThan(afterSecond);
    } finally {
      process.env.PATH = prevPath;
      if (typeof prevCountFile === 'string') process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE = prevCountFile;
      else delete process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE;
      if (typeof prevPrefs === 'string') process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON = prevPrefs;
      else delete process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON;
      if (typeof prevPnpmBin === 'string') process.env.HAPPIER_PNPM_BIN = prevPnpmBin;
      else delete process.env.HAPPIER_PNPM_BIN;
      await fixture.cleanup();
    }
  }, 20_000);

  it('invalidates cache when auth environment changes login status', async () => {
    vi.resetModules();

    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        claude: {
          id: 'claude',
          getCliAuthSpec: async () => ({
            binaryNames: ['claude'],
            detectAuthStatus: async () => {
              const apiKey = typeof process.env.ANTHROPIC_API_KEY === 'string'
                ? process.env.ANTHROPIC_API_KEY.trim()
                : '';
              return apiKey
                ? { state: 'logged_in', method: 'api_key_env', source: 'env' }
                : { state: 'logged_out', reason: 'missing_credentials' };
            },
          }),
        },
      },
    }));

    const fixture = await createProbeTempDir('happier-cli-snapshot-cache-auth-env');
    const binDir = resolve(join(fixture.dir, 'bin'));
    await mkdir(binDir, { recursive: true });

    const countFile = resolve(join(fixture.dir, 'count.txt'));
    await writeFile(countFile, '', 'utf8');

    const claudePath = resolve(join(binDir, 'claude'));
    await writeExecutableScript(
      claudePath,
      `#!/usr/bin/env node
const fs = require("fs");
const countFile = process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE;
if (countFile) fs.appendFileSync(countFile, "1");
process.stdout.write("claude 1.2.3\\n");
process.exit(0);
`,
    );

    const prevPath = process.env.PATH;
    const prevCountFile = process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE;
    const prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;
    process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE = countFile;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const { detectCliSnapshotOnDaemonPath } = await import('./cliSnapshot');

      const first = await detectCliSnapshotOnDaemonPath({ includeLoginStatus: true });
      const afterFirst = (await readFile(countFile, 'utf8')).length;
      expect(first.clis.claude.isLoggedIn).toBe(false);

      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      const second = await detectCliSnapshotOnDaemonPath({ includeLoginStatus: true });
      const afterSecond = (await readFile(countFile, 'utf8')).length;

      expect(second.clis.claude.isLoggedIn).toBe(true);
      expect(afterSecond).toBeGreaterThan(afterFirst);
    } finally {
      process.env.PATH = prevPath;
      if (typeof prevCountFile === 'string') process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE = prevCountFile;
      else delete process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE;
      if (typeof prevAnthropicKey === 'string') process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
      else delete process.env.ANTHROPIC_API_KEY;
      await fixture.cleanup();
    }
  }, 20_000);

  it('invalidates cache when HOME changes auth-file lookup', async () => {
    vi.resetModules();

    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        claude: {
          id: 'claude',
          getCliAuthSpec: async () => ({
            binaryNames: ['claude'],
            detectAuthStatus: async () => {
              const homeDir = typeof process.env.HOME === 'string' ? process.env.HOME.trim() : '';
              if (!homeDir) return { state: 'logged_out', reason: 'missing_credentials' };
              try {
                await readFile(resolve(join(homeDir, '.claude', '.credentials.json')), 'utf8');
                return { state: 'logged_in', method: 'credentials_file', source: 'file' };
              } catch {
                return { state: 'logged_out', reason: 'missing_credentials' };
              }
            },
          }),
        },
      },
    }));

    const fixture = await createProbeTempDir('happier-cli-snapshot-cache-auth-home');
    const binDir = resolve(join(fixture.dir, 'bin'));
    const homeA = resolve(join(fixture.dir, 'home-a'));
    const homeB = resolve(join(fixture.dir, 'home-b'));
    await mkdir(binDir, { recursive: true });
    await mkdir(homeA, { recursive: true });
    await mkdir(resolve(join(homeB, '.claude')), { recursive: true });
    await writeFile(resolve(join(homeB, '.claude', '.credentials.json')), JSON.stringify({ accessToken: 'token' }), 'utf8');

    const countFile = resolve(join(fixture.dir, 'count.txt'));
    await writeFile(countFile, '', 'utf8');

    const claudePath = resolve(join(binDir, 'claude'));
    await writeExecutableScript(
      claudePath,
      `#!/usr/bin/env node
const fs = require("fs");
const countFile = process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE;
if (countFile) fs.appendFileSync(countFile, "1");
process.stdout.write("claude 1.2.3\\n");
process.exit(0);
`,
    );

    const prevPath = process.env.PATH;
    const prevCountFile = process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE;
    const prevHome = process.env.HOME;
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ''}`;
    process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE = countFile;
    process.env.HOME = homeA;

    try {
      const { detectCliSnapshotOnDaemonPath } = await import('./cliSnapshot');

      const first = await detectCliSnapshotOnDaemonPath({ includeLoginStatus: true });
      const afterFirst = (await readFile(countFile, 'utf8')).length;
      expect(first.clis.claude.isLoggedIn).toBe(false);

      process.env.HOME = homeB;
      const second = await detectCliSnapshotOnDaemonPath({ includeLoginStatus: true });
      const afterSecond = (await readFile(countFile, 'utf8')).length;

      expect(second.clis.claude.isLoggedIn).toBe(true);
      expect(afterSecond).toBeGreaterThan(afterFirst);
    } finally {
      process.env.PATH = prevPath;
      if (typeof prevCountFile === 'string') process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE = prevCountFile;
      else delete process.env.HAPPIER_TEST_CLI_SNAPSHOT_COUNT_FILE;
      if (typeof prevHome === 'string') process.env.HOME = prevHome;
      else delete process.env.HOME;
      await fixture.cleanup();
    }
  }, 20_000);
});
