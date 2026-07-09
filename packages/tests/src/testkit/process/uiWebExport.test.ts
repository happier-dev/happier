import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { spawnDetachedTestProcess } from './testSpawn';

type RunLoggedCommandMockParams = {
    stdoutPath: string;
    stderrPath?: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    abortSignal?: AbortSignal;
    timeoutMs?: number;
};

const { runLoggedCommandMock } = vi.hoisted(() => {
    return {
        runLoggedCommandMock: vi
            .fn<(params?: RunLoggedCommandMockParams) => Promise<void>>()
            .mockImplementation(async (_params?: RunLoggedCommandMockParams) => {
                throw new Error('RUN_LOGGED_COMMAND_CALLED');
            }),
    };
});

vi.mock('./spawnProcess', () => {
  return {
    runLoggedCommand: runLoggedCommandMock,
  };
});

import { __testables as uiWebExportTestables, resolveUiWebExportRootDir, startUiWebExport } from './uiWebExport';
import { buildUiWebExportCacheKey } from './uiWebExportCacheKey';
import { repoRootDir } from '../paths';

function buildLegacyExportCacheKeyForTest(env: NodeJS.ProcessEnv): string {
  const debug = String(env.EXPO_PUBLIC_DEBUG ?? '1').trim() || '1';
  const exportEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...env,
    CI: '1',
    NODE_ENV: 'production',
    EXPO_NO_TELEMETRY: '1',
    EXPO_PUBLIC_DEBUG: debug,
    EXPO_PUBLIC_POSTHOG_KEY: String(env.EXPO_PUBLIC_POSTHOG_KEY ?? 'phc-clear-export').trim() || 'phc-clear-export',
    EXPO_PUBLIC_HAPPIER_SERVER_URL: '',
    EXPO_PUBLIC_HAPPY_SERVER_URL: '',
    EXPO_PUBLIC_SERVER_URL: '',
    EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: '',
    EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON: '',
  };

  const relevantEntries = Object.entries(exportEnv)
    .filter(([key]) =>
      key.startsWith('EXPO_PUBLIC_')
      || key === 'APP_ENV'
      || key === 'APP_VARIANT'
      || key === 'HAPPIER_APP_VARIANT_OVERRIDE'
      || key === 'EAS_BUILD_PROFILE'
      || key === 'EXPO_UPDATES_CHANNEL'
      || key === 'NODE_ENV'
    )
    .sort(([left], [right]) => left.localeCompare(right));

  return JSON.stringify(relevantEntries);
}

function resolveOutputDirFromArgs(args: readonly string[] | undefined): string {
  const outputFlagIndex = args?.findIndex((value) => value === '--output-dir') ?? -1;
  const outputDir = outputFlagIndex >= 0 ? args?.[outputFlagIndex + 1] : null;
  if (typeof outputDir !== 'string' || !outputDir.trim()) {
    throw new Error('missing --output-dir');
  }
  return outputDir;
}

function isWorkspacePrebuildInvocation(params?: RunLoggedCommandMockParams): boolean {
  return Array.isArray(params?.args) && params?.args.includes('--input-type=module');
}

describe('uiWebExport (cache clearing)', () => {
    let namespace: string;
    let exportedRootDir: string;

  beforeEach(() => {
    uiWebExportTestables.resetSharedUiWebExportState();
    runLoggedCommandMock.mockReset();
    runLoggedCommandMock.mockImplementation(async (params?: RunLoggedCommandMockParams) => {
      if (isWorkspacePrebuildInvocation(params)) {
        return;
      }
      throw new Error('RUN_LOGGED_COMMAND_CALLED');
    });
  });

  beforeAll(async () => {
    namespace = `vitest-ui-web-export-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    exportedRootDir = resolveUiWebExportRootDir({ HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: namespace });
    const distDir = resolve(exportedRootDir, 'dist');
    await mkdir(distDir, { recursive: true });
    await writeFile(resolve(distDir, 'index.html'), '<!doctype html><html><head></head><body>ok</body></html>', 'utf8');
    await writeFile(resolve(distDir, 'metadata.json'), JSON.stringify({ version: 1 }), 'utf8');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: namespace,
    };
    const cacheKey = buildUiWebExportCacheKey(env);

    await writeFile(resolve(exportedRootDir, 'cache-key.json'), JSON.stringify({ cacheKey }), 'utf8');
    await writeFile(resolve(exportedRootDir, 'export-manifest.json'), JSON.stringify({ formatVersion: 1, createdAtMs: Date.now() }), 'utf8');
  });

  afterAll(async () => {
    await rm(exportedRootDir, { recursive: true, force: true }).catch(() => {});
  });

  it('fails export startup when expo export stalls after Starting Metro Bundler', async () => {
    runLoggedCommandMock.mockImplementation(async (params?: RunLoggedCommandMockParams) => {
      if (!params) {
        throw new Error('missing runLoggedCommand params');
      }
      if (isWorkspacePrebuildInvocation(params)) {
        return;
      }
      await writeFile(
        params.stdoutPath,
        ['Expo Autolinking module resolution enabled', 'Starting Metro Bundler'].join('\n'),
        'utf8',
      );
      await new Promise<never>((_, reject) => {
        if (params.abortSignal?.aborted) {
          const abortReason = params.abortSignal?.reason;
          reject(abortReason instanceof Error ? abortReason : new Error(String(abortReason ?? 'aborted')));
          return;
        }
        params.abortSignal?.addEventListener('abort', () => {
          const abortReason = params.abortSignal?.reason;
          reject(abortReason instanceof Error ? abortReason : new Error(String(abortReason ?? 'aborted')));
        }, { once: true });
      });
    });

    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    await expect(Promise.race([
      startUiWebExport({
        testDir,
        env: {
          ...process.env,
          EXPO_PUBLIC_DEBUG: '1',
          HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `stall-${Date.now()}`,
          HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS: '100',
          HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_POLL_MS: '5',
        },
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('startUiWebExport did not reject quickly')), 2_000);
      }),
    ])).rejects.toThrow(/classification=startup_stalled_after_metro_startup_no_staging_progress/);
  });

  it('fails export startup when expo export stalls before Starting Metro Bundler', async () => {
    runLoggedCommandMock.mockImplementation(async (params?: RunLoggedCommandMockParams) => {
      if (!params) {
        throw new Error('missing runLoggedCommand params');
      }
      if (isWorkspacePrebuildInvocation(params)) {
        return;
      }
      await new Promise<never>((_, reject) => {
        if (params.abortSignal?.aborted) {
          const abortReason = params.abortSignal?.reason;
          reject(abortReason instanceof Error ? abortReason : new Error(String(abortReason ?? 'aborted')));
          return;
        }
        params.abortSignal?.addEventListener('abort', () => {
          const abortReason = params.abortSignal?.reason;
          reject(abortReason instanceof Error ? abortReason : new Error(String(abortReason ?? 'aborted')));
        }, { once: true });
      });
    });

    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    await expect(Promise.race([
      startUiWebExport({
        testDir,
        env: {
          ...process.env,
          EXPO_PUBLIC_DEBUG: '1',
          HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `stall-before-${Date.now()}`,
          HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS: '100',
          HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_POLL_MS: '5',
        },
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('startUiWebExport did not reject quickly')), 2_000);
      }),
    ])).rejects.toThrow(/classification=startup_stalled_before_metro_startup/);
  });

  it('builds apps/ui workspace packages before starting expo export', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `workspace-preflight-${Date.now()}`,
    };

    await expect(
      startUiWebExport({
        testDir,
        env,
      }),
    ).rejects.toThrow(/RUN_LOGGED_COMMAND_CALLED/);

    const calls = runLoggedCommandMock.mock.calls as unknown as Array<[RunLoggedCommandMockParams | undefined]>;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(isWorkspacePrebuildInvocation(calls[0]?.[0])).toBe(true);
    expect(isWorkspacePrebuildInvocation(calls[1]?.[0])).toBe(false);
  });

  it('still runs export preflight when the shared CLI dist build lock is active', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    const lockPath = resolve(repoRootDir(), '.project', 'tmp', 'cli-dist-build.lock');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `shared-cli-dist-lock-${Date.now()}`,
      HAPPIER_E2E_UI_WEB_EXPORT_WORKSPACE_PREBUILD_TIMEOUT_MS: '50',
    };
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    }), 'utf8');

    try {
      runLoggedCommandMock.mockImplementation(async (params?: RunLoggedCommandMockParams) => {
        if (!params?.args) {
          throw new Error('missing runLoggedCommand args');
        }
        // First call should be workspace prebuild; let it succeed.
        if (params.args.includes('--input-type=module')) {
          return;
        }
        throw new Error('RUN_LOGGED_COMMAND_CALLED');
      });

      await expect(
        startUiWebExport({
          testDir,
          env,
        }),
      ).rejects.toThrow(/RUN_LOGGED_COMMAND_CALLED/);
    } finally {
      await rm(lockPath, { force: true }).catch(() => {});
    }

    // workspace prebuild + export
    expect(runLoggedCommandMock).toHaveBeenCalledTimes(2);
  });

  it('does not create the export lock until workspace build preflight finishes', async () => {
    let releasePreflight!: () => void;
    const preflightPromise = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });

    runLoggedCommandMock.mockImplementation(async (params?: RunLoggedCommandMockParams) => {
      if (!params?.args) {
        throw new Error('missing runLoggedCommand args');
      }
      if (params.args.includes('--input-type=module')) {
        await preflightPromise;
        return;
      }
      throw new Error('RUN_LOGGED_COMMAND_CALLED');
    });

    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    const namespace = `preflight-lock-${Date.now()}`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: namespace,
    };
    const lockPath = resolve(resolveUiWebExportRootDir(env), 'build.lock');

    const startPromise = startUiWebExport({
      testDir,
      env,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(lockPath)).toBe(false);

    releasePreflight();

    await expect(startPromise).rejects.toThrow(/RUN_LOGGED_COMMAND_CALLED/);
  });

  it('times out workspace build preflight with an actionable export log before opening the export lock', async () => {
    runLoggedCommandMock.mockImplementation(async (params?: RunLoggedCommandMockParams) => {
      if (!params?.args) {
        throw new Error('missing runLoggedCommand args');
      }
      if (!params.args.includes('--input-type=module')) {
        throw new Error('RUN_LOGGED_COMMAND_CALLED');
      }
      // Simulate a hung prebuild that times out.
      expect(params.timeoutMs).toBe(50);
      throw new Error(`node prebuild timed out after ${params.timeoutMs}ms`);
    });

    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    const namespace = `preflight-timeout-${Date.now()}`;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: namespace,
      HAPPIER_E2E_UI_WEB_EXPORT_WORKSPACE_PREBUILD_TIMEOUT_MS: '50',
    };
    const lockPath = resolve(resolveUiWebExportRootDir(env), 'build.lock');
    const stderrPath = resolve(testDir, 'ui.web.export.stderr.log');

    const startPromise = startUiWebExport({
      testDir,
      env,
    });
    const rejection = expect(Promise.race([
      startPromise,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('startUiWebExport did not reject quickly for workspace preflight timeout')), 4_000);
      }),
    ])).rejects.toThrow(/classification=workspace_preflight_timeout/);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(stderrPath)).toBe(true);
    await expect(readFile(stderrPath, 'utf8')).resolves.toContain('workspace build preflight started');
    await rejection;

    expect(existsSync(lockPath)).toBe(false);
    await expect(readFile(stderrPath, 'utf8')).resolves.toContain('workspace build preflight');
  });

  it('fails export startup promptly when a stalled exporter ignores the abort signal', async () => {
    runLoggedCommandMock.mockImplementation(async (params?: RunLoggedCommandMockParams) => {
      if (!params) {
        throw new Error('missing runLoggedCommand params');
      }
      if (isWorkspacePrebuildInvocation(params)) {
        return;
      }
      await writeFile(
        params.stdoutPath,
        ['Expo Autolinking module resolution enabled', 'Starting Metro Bundler'].join('\n'),
        'utf8',
      );
      await new Promise<void>(() => {
        // Simulate a hung exporter that never settles even after abort.
      });
    });

    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    await expect(Promise.race([
      startUiWebExport({
        testDir,
        env: {
          ...process.env,
          EXPO_PUBLIC_DEBUG: '1',
          HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `stall-ignores-abort-${Date.now()}`,
          HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS: '100',
          HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_POLL_MS: '5',
          HAPPIER_E2E_UI_WEB_EXPORT_ABORT_SETTLE_TIMEOUT_MS: '25',
        },
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('startUiWebExport did not reject quickly when exporter ignored abort')), 4_000);
      }),
    ])).rejects.toThrow(/classification=startup_stalled_after_metro_startup_no_staging_progress/);
  }, 10_000);

  it('fails export startup when logs keep moving but the staging dir stays partial', async () => {
    runLoggedCommandMock.mockImplementation(async (params?: RunLoggedCommandMockParams) => {
      if (!params?.args) {
        throw new Error('missing runLoggedCommand args');
      }
      if (isWorkspacePrebuildInvocation(params)) {
        return;
      }
      const outputDir = resolveOutputDirFromArgs(params.args);
      await mkdir(outputDir, { recursive: true });
      await mkdir(resolve(outputDir, 'monaco'), { recursive: true });
      await writeFile(resolve(outputDir, 'pierre-diff-worker.js'), 'worker', 'utf8');
      await writeFile(resolve(outputDir, 'pierre-diff-worker-wasm.js'), 'worker-wasm', 'utf8');
      await writeFile(
        params.stdoutPath,
        ['Expo Autolinking module resolution enabled', 'Starting Metro Bundler'].join('\n'),
        'utf8',
      );

      let counter = 0;
      await new Promise<never>((_, reject) => {
        const interval = setInterval(() => {
          counter += 1;
          void appendFile(params.stdoutPath, `\nprogress-heartbeat-${counter}`);
        }, 10);
        const cleanup = () => clearInterval(interval);
        if (params.abortSignal?.aborted) {
          cleanup();
          const abortReason = params.abortSignal?.reason;
          reject(abortReason instanceof Error ? abortReason : new Error(String(abortReason ?? 'aborted')));
          return;
        }
        params.abortSignal?.addEventListener('abort', () => {
          cleanup();
          const abortReason = params.abortSignal?.reason;
          reject(abortReason instanceof Error ? abortReason : new Error(String(abortReason ?? 'aborted')));
        }, { once: true });
      });
    });

    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    await expect(
      startUiWebExport({
        testDir,
        env: {
          ...process.env,
          EXPO_PUBLIC_DEBUG: '1',
          HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `partial-stall-${Date.now()}`,
          HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS: '250',
          HAPPIER_E2E_UI_WEB_EXPORT_HARD_TIMEOUT_MS: '250',
          HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS: '200',
          HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_POLL_MS: '10',
        },
      }),
    ).rejects.toThrow(/classification=startup_stalled_after_metro_startup_no_staging_progress/);
  }, 10_000);

  it('fails export startup when staging keeps growing without publish-required files', async () => {
    runLoggedCommandMock.mockImplementation(async (params?: RunLoggedCommandMockParams) => {
      if (!params?.args) {
        throw new Error('missing runLoggedCommand args');
      }
      if (isWorkspacePrebuildInvocation(params)) {
        return;
      }
      const outputDir = resolveOutputDirFromArgs(params.args);
      const monacoDir = resolve(outputDir, 'monaco');
      await mkdir(monacoDir, { recursive: true });
      await writeFile(
        params.stdoutPath,
        ['Expo Autolinking module resolution enabled', 'Starting Metro Bundler'].join('\n'),
        'utf8',
      );

      let counter = 0;
      await new Promise<never>((_, reject) => {
        let keepRunning = true;
        const pump = async () => {
          while (keepRunning) {
            counter += 1;
            await writeFile(resolve(monacoDir, `progress-${counter}.js`), `progress-${counter}`, 'utf8');
            await appendFile(params.stdoutPath, `\nprogress-heartbeat-${counter}`);
            await new Promise((resolveNext) => setTimeout(resolveNext, 0));
          }
        };
        void pump();
        const cleanup = () => {
          keepRunning = false;
        };
        if (params.abortSignal?.aborted) {
          cleanup();
          const abortReason = params.abortSignal?.reason;
          reject(abortReason instanceof Error ? abortReason : new Error(String(abortReason ?? 'aborted')));
          return;
        }
        params.abortSignal?.addEventListener('abort', () => {
          cleanup();
          const abortReason = params.abortSignal?.reason;
          reject(abortReason instanceof Error ? abortReason : new Error(String(abortReason ?? 'aborted')));
        }, { once: true });
      });
    });

    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    await expect(Promise.race([
      startUiWebExport({
        testDir,
        env: {
          ...process.env,
          EXPO_PUBLIC_DEBUG: '1',
          HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `growing-partial-${Date.now()}`,
          HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS: '200',
          HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS: '250',
          HAPPIER_E2E_UI_WEB_EXPORT_HARD_TIMEOUT_MS: '250',
          HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_POLL_MS: '5',
        },
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('startUiWebExport did not reject growing partial staging quickly')), 2_000);
      }),
    ])).rejects.toThrow(/classification=startup_stalled_after_metro_startup_no_staging_progress/);
  });

  it('times out export startup even when the command runner ignores aborts', async () => {
    runLoggedCommandMock.mockImplementation(async (params?: RunLoggedCommandMockParams) => {
      if (!params?.args) {
        throw new Error('missing runLoggedCommand args');
      }
      if (isWorkspacePrebuildInvocation(params)) {
        return;
      }
      const outputDir = resolveOutputDirFromArgs(params.args);
      const monacoDir = resolve(outputDir, 'monaco');
      await mkdir(outputDir, { recursive: true });
      await mkdir(monacoDir, { recursive: true });
      await writeFile(resolve(outputDir, 'index.html'), '<!doctype html><html><body>ok</body></html>', 'utf8');
      await writeFile(resolve(outputDir, 'metadata.json'), JSON.stringify({ version: 1 }), 'utf8');
      await writeFile(resolve(outputDir, 'pierre-diff-worker.js'), 'worker', 'utf8');
      await writeFile(resolve(outputDir, 'pierre-diff-worker-wasm.js'), 'worker-wasm', 'utf8');
      await writeFile(
        params.stdoutPath,
        ['Expo Autolinking module resolution enabled', 'Starting Metro Bundler'].join('\n'),
        'utf8',
      );

      let keepRunning = true;
      const keepProgressing = async () => {
        let counter = 0;
        while (keepRunning) {
          counter += 1;
          try {
            await mkdir(monacoDir, { recursive: true });
            await writeFile(resolve(monacoDir, `progress-${counter}.js`), `progress-${counter}`, 'utf8');
            await appendFile(params.stdoutPath, `\nprogress-heartbeat-${counter}`);
          } catch {
            keepRunning = false;
            break;
          }
          await new Promise((resolveNext) => setTimeout(resolveNext, 0));
        }
      };
      void keepProgressing();
      params.abortSignal?.addEventListener('abort', () => {
        keepRunning = false;
      }, { once: true });

      await new Promise<void>(() => {
        // Intentionally ignore the abort signal for process completion so this test proves
        // the export layer enforces its own timeout instead of depending on the inner runner.
      });
    });

    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    await expect(
      startUiWebExport({
        testDir,
        env: {
          ...process.env,
          EXPO_PUBLIC_DEBUG: '1',
          HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `ignored-abort-${Date.now()}`,
          HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS: '25',
          HAPPIER_E2E_UI_WEB_EXPORT_HARD_TIMEOUT_MS: '25',
          HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS: '200',
          HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_POLL_MS: '5',
        },
      }),
    ).rejects.toThrow(/classification=timed_out_after_metro_publish_phase_output_present/);
  }, 10_000);

  it('passes a Metro cache version bust through to the Expo export process', async () => {
    let capturedEnv: NodeJS.ProcessEnv | null = null;
    runLoggedCommandMock.mockImplementation(async (params?: RunLoggedCommandMockParams) => {
      if (!params?.args || !params.env) {
        throw new Error('missing runLoggedCommand params');
      }
      if (isWorkspacePrebuildInvocation(params)) {
        return;
      }
      capturedEnv = params.env;
      const outputDir = resolveOutputDirFromArgs(params.args);
      await mkdir(outputDir, { recursive: true });
      await writeFile(resolve(outputDir, 'index.html'), '<!doctype html><html><body>ok</body></html>', 'utf8');
      await writeFile(resolve(outputDir, 'metadata.json'), JSON.stringify({ version: 1 }), 'utf8');
      await writeFile(resolve(outputDir, 'pierre-diff-worker.js'), 'worker', 'utf8');
      await writeFile(resolve(outputDir, 'pierre-diff-worker-wasm.js'), 'worker-wasm', 'utf8');
      await writeFile(
        params.stdoutPath,
        ['Expo Autolinking module resolution enabled', 'Starting Metro Bundler'].join('\n'),
        'utf8',
      );
    });

    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    const ui = await startUiWebExport({
      testDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `cache-bust-${Date.now()}`,
      },
    });

    try {
      if (!capturedEnv) {
        throw new Error('expected export env to be captured');
      }
      const exportEnv: NodeJS.ProcessEnv = capturedEnv;
      expect(exportEnv.HAPPIER_UI_METRO_CACHE_VERSION_BUST ?? '').toMatch(/^[a-f0-9]{16,}$/u);
    } finally {
      await ui.stop();
    }
  });

  it('does not reclaim a stale export lock while staging is still progressing', async () => {
    const helper = (uiWebExportTestables as Record<string, unknown>).shouldReclaimUiWebExportLock;
    expect(helper).toBeTypeOf('function');

    const rootDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-lock-'));
    const lockPath = resolve(rootDir, 'build.lock');
    const stagingDir = resolve(rootDir, `dist-staging-${process.pid}-12345`);

    try {
      await mkdir(resolve(stagingDir, 'nested'), { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          createdAtMs: Date.now() - 10_000,
        }),
        'utf8',
      );
      await writeFile(resolve(stagingDir, 'nested', 'chunk.js'), 'chunk', 'utf8');

      await expect(
        (helper as (lockPath: string, staleAfterMs: number) => Promise<boolean>)(lockPath, 1_000),
      ).resolves.toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('reclaims a stale export lock when only unrelated staging directories are progressing', async () => {
    const helper = (uiWebExportTestables as Record<string, unknown>).shouldReclaimUiWebExportLock;
    expect(helper).toBeTypeOf('function');

    const rootDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-lock-'));
    const lockPath = resolve(rootDir, 'build.lock');
    const ownerStagingDir = resolve(rootDir, `dist-staging-99999-${Date.now() - 60_000}`);
    const unrelatedStagingDir = resolve(rootDir, `dist-staging-${process.pid}-${Date.now()}`);

    try {
      await mkdir(resolve(ownerStagingDir, 'nested'), { recursive: true });
      await mkdir(resolve(unrelatedStagingDir, 'nested'), { recursive: true });
      await writeFile(resolve(ownerStagingDir, 'nested', 'stale-chunk.js'), 'stale', 'utf8');
      await writeFile(resolve(unrelatedStagingDir, 'nested', 'fresh-chunk.js'), 'fresh', 'utf8');
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          createdAtMs: Date.now() - 10_000,
          stagingDir: ownerStagingDir,
        }),
        'utf8',
      );

      // Keep unrelated staging fresh while the owner staging stays stale.
      const staleTime = new Date(Date.now() - 60_000);
      const freshTime = new Date();
      await utimes(ownerStagingDir, staleTime, staleTime);
      await utimes(resolve(ownerStagingDir, 'nested'), staleTime, staleTime);
      await utimes(resolve(ownerStagingDir, 'nested', 'stale-chunk.js'), staleTime, staleTime);
      await utimes(resolve(unrelatedStagingDir, 'nested', 'fresh-chunk.js'), freshTime, freshTime);

      await expect(
        (helper as (lockPath: string, staleAfterMs: number) => Promise<boolean>)(lockPath, 1_000),
      ).resolves.toBe(true);
    } finally {
      await rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('reclaims a stale export lock and terminates orphaned expo export processes for the owner staging dir', async () => {
    const helper = (uiWebExportTestables as Record<string, unknown>).shouldReclaimUiWebExportLock;
    expect(helper).toBeTypeOf('function');

    const rootDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-lock-'));
    const lockPath = resolve(rootDir, 'build.lock');
    const ownerStagingDir = resolve(rootDir, `dist-staging-99999-${Date.now()}`);

    const orphan = spawnDetachedTestProcess(process.execPath, [
      '-e',
      'setInterval(() => {}, 1_000)',
      'expo',
      'export',
      '--output-dir',
      ownerStagingDir,
    ]);

    try {
      await mkdir(resolve(ownerStagingDir, 'nested'), { recursive: true });
      await writeFile(resolve(ownerStagingDir, 'nested', 'chunk.js'), 'chunk', 'utf8');
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 99999,
          createdAtMs: Date.now() - 10_000,
          stagingDir: ownerStagingDir,
        }),
        'utf8',
      );

      await expect(
        (helper as (lockPath: string, staleAfterMs: number) => Promise<boolean>)(lockPath, 1_000),
      ).resolves.toBe(true);

      await expect.poll(() => {
        try {
          process.kill(orphan.pid!, 0);
          return 'alive';
        } catch (error: any) {
          return error?.code === 'ESRCH' ? 'dead' : 'unknown';
        }
      }, { timeout: 5_000, interval: 50 }).toBe('dead');
    } finally {
      try {
        process.kill(-orphan.pid!, 'SIGKILL');
      } catch {
        // ignore cleanup when the orphan is already gone
      }
      try {
        process.kill(orphan.pid!, 'SIGKILL');
      } catch {
        // ignore cleanup when the orphan is already gone
      }
      await rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('does not remove a successor export lock when a reclaimed owner finishes later', async () => {
    const helper = (uiWebExportTestables as Record<string, unknown>).withUiWebExportLock;
    expect(helper).toBeTypeOf('function');

    const rootDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-successor-lock-'));
    const lockPath = resolve(rootDir, 'build.lock');
    const successorRaw = JSON.stringify({
      pid: process.pid,
      createdAtMs: Date.now(),
      owner: 'successor',
    });

    try {
      await (helper as (
        lockPath: string,
        fn: () => Promise<void>,
        options: { timeoutMs?: number; staleAfterMs?: number },
      ) => Promise<void>)(
        lockPath,
        async () => {
          await rm(lockPath, { force: true });
          await writeFile(lockPath, successorRaw, 'utf8');
        },
        {
          timeoutMs: 5_000,
          staleAfterMs: 1,
        },
      );

      expect(readFileSync(lockPath, 'utf8')).toBe(successorRaw);
    } finally {
      await rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('rejects a completed export when the staging dir is missing publish-required files', async () => {
    runLoggedCommandMock.mockImplementation(async (params?: RunLoggedCommandMockParams) => {
      if (!params?.args) {
        throw new Error('missing runLoggedCommand args');
      }
      if (isWorkspacePrebuildInvocation(params)) {
        return;
      }
      const outputDir = resolveOutputDirFromArgs(params.args);
      await mkdir(outputDir, { recursive: true });
      await writeFile(resolve(outputDir, 'index.html'), '<!doctype html><html><body>partial</body></html>', 'utf8');
    });

    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    await expect(
      startUiWebExport({
        testDir,
        env: {
          ...process.env,
          EXPO_PUBLIC_DEBUG: '1',
          HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `partial-success-${Date.now()}`,
        },
      }),
    ).rejects.toThrow(/metadata\.json|publish-required|incomplete export/i);
  });

  it('classifies a frozen partial export failure during export', async () => {
    runLoggedCommandMock.mockImplementation(async (params?: RunLoggedCommandMockParams) => {
      if (!params?.args) {
        throw new Error('missing runLoggedCommand args');
      }
      if (isWorkspacePrebuildInvocation(params)) {
        return;
      }
      const outputDir = resolveOutputDirFromArgs(params.args);
      await mkdir(resolve(outputDir, 'monaco'), { recursive: true });
      await writeFile(resolve(outputDir, 'monaco', 'chunk.js'), 'chunk', 'utf8');
      await writeFile(
        params.stdoutPath,
        ['Expo Autolinking module resolution enabled', 'Starting Metro Bundler', 'Web apps/ui/index.ts ▓▓▓▓ 63.5% (133/210)'].join('\n'),
        'utf8',
      );
      await writeFile(
        params.stderrPath ?? params.stdoutPath,
        'Error: export process exited after partial staging output was written',
        'utf8',
      );

      throw new Error('command exited with code 1');
    });

    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    await expect(
      startUiWebExport({
        testDir,
        env: {
          ...process.env,
          EXPO_PUBLIC_DEBUG: '1',
          HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `frozen-partial-${Date.now()}`,
        },
      }),
    ).rejects.toThrow(/classification=expo_export_frozen_partial_output/);
  });

  it('classifies an unresolved web import failure during export', async () => {
    runLoggedCommandMock.mockImplementation(async (params?: RunLoggedCommandMockParams) => {
      if (!params) {
        throw new Error('missing runLoggedCommand params');
      }
      if (isWorkspacePrebuildInvocation(params)) {
        return;
      }

      await writeFile(
        params.stdoutPath,
        ['Expo Autolinking module resolution enabled', 'Starting Metro Bundler'].join('\n'),
        'utf8',
      );
      await writeFile(
        params.stderrPath ?? params.stdoutPath,
        [
          'Error: Unable to resolve module ../presentation/buildDesktopActivityOverlaySnapshot from /Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/activity/adapters/desktop/runtime/DesktopActivityOverlayRuntime.tsx:',
          '',
          'None of these files exist:',
          '  * sources/activity/adapters/desktop/presentation/buildDesktopActivityOverlaySnapshot(.web.ts|.ts|.web.tsx|.tsx|.web.mjs|.mjs|.web.js|.js|.web.jsx|.jsx|.web.json|.json|.web.cjs|.cjs|.web.scss|.scss|.web.sass|.sass|.web.css|.css)',
        ].join('\n'),
        'utf8',
      );

      throw new Error('command exited with code 1');
    });

    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    await expect(
      startUiWebExport({
        testDir,
        env: {
          ...process.env,
          EXPO_PUBLIC_DEBUG: '1',
          HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `unresolved-module-${Date.now()}`,
        },
      }),
    ).rejects.toThrow(/classification=expo_export_unresolved_module_import/);
  });

  it('classifies a missing source file ENOENT as an unresolved import even when partial staging exists', async () => {
    runLoggedCommandMock.mockImplementation(async (params?: RunLoggedCommandMockParams) => {
      if (!params?.args) {
        throw new Error('missing runLoggedCommand args');
      }
      if (isWorkspacePrebuildInvocation(params)) {
        return;
      }

      const outputDir = resolveOutputDirFromArgs(params.args);
      await mkdir(resolve(outputDir, 'monaco'), { recursive: true });
      await writeFile(resolve(outputDir, 'monaco', 'chunk.js'), 'chunk', 'utf8');
      await writeFile(
        params.stdoutPath,
        ['Expo Autolinking module resolution enabled', 'Starting Metro Bundler', 'Web apps/ui/index.ts ▓▓▓▓ 63.5% (133/210)'].join('\n'),
        'utf8',
      );
      await writeFile(
        params.stderrPath ?? params.stdoutPath,
        [
          "SyntaxError: sources/components/settings/remoteHosts/buildRemoteSshManageHostSystemTaskSpec.ts: ENOENT: no such file or directory, open '/Users/leeroy/Documents/Development/happier/dev/apps/ui/sources/components/settings/remoteHosts/buildRemoteSshManageHostSystemTaskSpec.ts'",
          '',
          'Web Bundling failed',
        ].join('\n'),
        'utf8',
      );

      throw new Error('command exited with code 1');
    });

    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    await expect(
      startUiWebExport({
        testDir,
        env: {
          ...process.env,
          EXPO_PUBLIC_DEBUG: '1',
          HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `enoent-unresolved-module-${Date.now()}`,
        },
      }),
    ).rejects.toThrow(/classification=expo_export_unresolved_module_import/);
  });

  it('reuses the persisted export when cache clear is not requested', async () => {
    const distDir = resolve(exportedRootDir, 'dist');
    await mkdir(distDir, { recursive: true });
    await writeFile(resolve(distDir, 'index.html'), '<!doctype html><html><head></head><body>ok</body></html>', 'utf8');
    await writeFile(resolve(distDir, 'metadata.json'), JSON.stringify({ version: 1 }), 'utf8');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: namespace,
    };
    const cacheKey = buildUiWebExportCacheKey(env);
    await writeFile(resolve(exportedRootDir, 'cache-key.json'), JSON.stringify({ cacheKey }), 'utf8');
    await writeFile(resolve(exportedRootDir, 'export-manifest.json'), JSON.stringify({ formatVersion: 1, createdAtMs: Date.now() }), 'utf8');

    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    const ui = await startUiWebExport({
      testDir,
      env,
    });
    await ui.stop();
  });

  it('creates a nested testDir before opening export stdout and stderr logs', async () => {
    runLoggedCommandMock.mockImplementation(async (params?: RunLoggedCommandMockParams) => {
      if (!params?.args || !params.stderrPath) {
        throw new Error('missing runLoggedCommand params');
      }
      if (isWorkspacePrebuildInvocation(params)) {
        return;
      }
      await writeFile(params.stdoutPath, 'Expo Autolinking module resolution enabled\nStarting Metro Bundler\n', 'utf8');
      await writeFile(params.stderrPath, '', 'utf8');
      const outputDir = resolveOutputDirFromArgs(params.args);
      await mkdir(resolve(outputDir, '_expo/static/js/web'), { recursive: true });
      await writeFile(
        resolve(outputDir, 'index.html'),
        '<!doctype html><html><head><script src="/_expo/static/js/web/index.js"></script></head><body>nested</body></html>',
        'utf8',
      );
      await writeFile(resolve(outputDir, 'metadata.json'), JSON.stringify({ version: 1 }), 'utf8');
      await writeFile(resolve(outputDir, '_expo/static/js/web/index.js'), 'globalThis.__HAPPIER_E2E__ = true;', 'utf8');
    });

    const rootDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    const testDir = resolve(rootDir, 'nested', 'suite');
    const ui = await startUiWebExport({
      testDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `nested-testdir-${Date.now()}`,
      },
    });

    try {
      // workspace prebuild + export
      expect(runLoggedCommandMock).toHaveBeenCalledTimes(2);
    } finally {
      await ui.stop();
      await rm(rootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('reuses the canonical shared persisted export when an explicit namespace is requested', async () => {
    const explicitNamespace = `vitest-ui-web-export-explicit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const explicitRootDir = resolveUiWebExportRootDir({ HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: explicitNamespace });
    const uniqueUpdatesChannel = `vitest-ui-web-export-channel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const sharedRootDir = resolveUiWebExportRootDir({ EXPO_UPDATES_CHANNEL: uniqueUpdatesChannel });
    const sharedDistDir = resolve(sharedRootDir, 'dist');
    await rm(explicitRootDir, { recursive: true, force: true });
    await mkdir(sharedDistDir, { recursive: true });
    await writeFile(resolve(sharedDistDir, 'index.html'), '<!doctype html><html><head></head><body>shared</body></html>', 'utf8');
    await writeFile(resolve(sharedDistDir, 'metadata.json'), JSON.stringify({ version: 1 }), 'utf8');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_UPDATES_CHANNEL: uniqueUpdatesChannel,
      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: explicitNamespace,
    };
    const cacheKey = buildUiWebExportCacheKey(env);
    await writeFile(resolve(sharedRootDir, 'cache-key.json'), JSON.stringify({ cacheKey }), 'utf8');
    await writeFile(resolve(sharedRootDir, 'export-manifest.json'), JSON.stringify({ formatVersion: 1, createdAtMs: Date.now() }), 'utf8');

    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    const ui = await startUiWebExport({
      testDir,
      env,
    });

    try {
      expect(runLoggedCommandMock).not.toHaveBeenCalled();
    } finally {
      await ui.stop();
      await rm(resolve(sharedRootDir, 'dist'), { recursive: true, force: true }).catch(() => {});
      await rm(resolve(sharedRootDir, 'cache-key.json'), { force: true }).catch(() => {});
      await rm(resolve(sharedRootDir, 'export-manifest.json'), { force: true }).catch(() => {});
      await rm(explicitRootDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('retries expo export with --clear when Metro cache deserialization fails', async () => {
    runLoggedCommandMock
      .mockImplementationOnce(async () => {
        // workspace prebuild
      })
      .mockImplementationOnce(async (params?: RunLoggedCommandMockParams) => {
        if (!params?.stderrPath) {
          throw new Error('missing runLoggedCommand params');
        }
        await writeFile(params.stdoutPath, 'Expo Autolinking module resolution enabled\nStarting Metro Bundler\n', 'utf8');
        await writeFile(
          params.stderrPath,
          'Error while reading cache, falling back to a full crawl:\n Error: Unable to deserialize cloned data.\n',
          'utf8',
        );
        throw new Error('expo export failed after Metro cache corruption');
      })
      .mockImplementationOnce(async (params?: RunLoggedCommandMockParams) => {
        if (!params?.args) {
          throw new Error('missing runLoggedCommand args');
        }
        expect(params.args).toContain('--clear');
        const outputDir = resolveOutputDirFromArgs(params.args);
        await mkdir(resolve(outputDir, '_expo/static/js/web'), { recursive: true });
        await writeFile(
          resolve(outputDir, 'index.html'),
          '<!doctype html><html><head><script src="/_expo/static/js/web/index.js"></script></head><body>rebuilt</body></html>',
          'utf8',
        );
        await writeFile(resolve(outputDir, 'metadata.json'), JSON.stringify({ version: 1 }), 'utf8');
        await writeFile(resolve(outputDir, '_expo/static/js/web/index.js'), 'globalThis.__HAPPIER_E2E__ = true;', 'utf8');
      });

    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    const ui = await startUiWebExport({
      testDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `cache-clear-retry-${Date.now()}`,
        HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS: '25',
        HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_POLL_MS: '5',
        EXPO_UPDATES_CHANNEL: `cache-clear-retry-${Date.now()}`,
      },
    });

    try {
      // workspace prebuild + 2 export attempts
      expect(runLoggedCommandMock).toHaveBeenCalledTimes(3);
    } finally {
      await ui.stop();
    }
  });

  it('retries expo export when Metro cache cleanup briefly hits ENOTEMPTY', async () => {
    runLoggedCommandMock
      .mockImplementationOnce(async () => {
        // workspace prebuild
      })
      .mockImplementationOnce(async (params?: RunLoggedCommandMockParams) => {
        if (!params?.stdoutPath) {
          throw new Error('missing runLoggedCommand params');
        }
        await writeFile(
          params.stdoutPath,
          ['Expo Autolinking module resolution enabled', 'Starting Metro Bundler'].join('\n'),
          'utf8',
        );
        const error = new Error('directory not empty') as NodeJS.ErrnoException;
        error.code = 'ENOTEMPTY';
        throw error;
      })
      .mockImplementationOnce(async (params?: RunLoggedCommandMockParams) => {
        if (!params?.args) {
          throw new Error('missing runLoggedCommand args');
        }
        const outputDir = resolveOutputDirFromArgs(params.args);
        await mkdir(resolve(outputDir, '_expo/static/js/web'), { recursive: true });
        await writeFile(
          resolve(outputDir, 'index.html'),
          '<!doctype html><html><head><script src="/_expo/static/js/web/index.js"></script></head><body>rebuilt</body></html>',
          'utf8',
        );
        await writeFile(resolve(outputDir, 'metadata.json'), JSON.stringify({ version: 1 }), 'utf8');
        await writeFile(resolve(outputDir, '_expo/static/js/web/index.js'), 'globalThis.__HAPPIER_E2E__ = true;', 'utf8');
      });

    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    const ui = await startUiWebExport({
      testDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `cache-clear-enotempty-retry-${Date.now()}`,
        HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS: '1000',
        HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_POLL_MS: '5',
        EXPO_UPDATES_CHANNEL: `cache-clear-enotempty-retry-${Date.now()}`,
      },
    });

    try {
      // workspace prebuild + 2 export attempts
      expect(runLoggedCommandMock).toHaveBeenCalledTimes(3);
    } finally {
      await ui.stop();
    }
  });

  it('retries removing a path when recursive cleanup briefly hits ENOTEMPTY', async () => {
    const helper = (uiWebExportTestables as Record<string, unknown>).removePathWithRetries;
    expect(helper).toBeTypeOf('function');

    let callCount = 0;
    const removePath = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        const error = new Error('directory not empty') as NodeJS.ErrnoException;
        error.code = 'ENOTEMPTY';
        throw error;
      }
    });

    await expect((helper as (path: string, options: Readonly<{ timeoutMs?: number; intervalMs?: number; removePath?: (path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>; }>) => Promise<void>)(
      '/tmp/happier-uiwebexport-cleanup',
      {
        timeoutMs: 1_000,
        intervalMs: 1,
        removePath,
      },
    )).resolves.toBeUndefined();
    expect(removePath).toHaveBeenCalledTimes(2);
  });

  it('retries expo export with --clear when a corrupted startup attempt never resolves after abort', async () => {
    runLoggedCommandMock
      .mockImplementationOnce(async () => {
        // workspace prebuild
      })
      .mockImplementationOnce(async (params?: RunLoggedCommandMockParams) => {
        if (!params) {
          throw new Error('missing runLoggedCommand params');
        }
        await writeFile(
          params.stdoutPath,
          ['Expo Autolinking module resolution enabled', 'Starting Metro Bundler'].join('\n'),
          'utf8',
        );
        if (params.stderrPath) {
          await writeFile(
            params.stderrPath,
            'Error while reading cache, falling back to a full crawl:\n Error: Unable to deserialize cloned data.\n',
            'utf8',
          );
        }
        await new Promise<void>(() => {
          // Simulate a hung exporter that ignores the abort signal for completion.
        });
      })
      .mockImplementationOnce(async (params?: RunLoggedCommandMockParams) => {
        if (!params?.args) {
          throw new Error('missing runLoggedCommand args');
        }
        expect(params.args).toContain('--clear');
        const outputDir = resolveOutputDirFromArgs(params.args);
        await mkdir(resolve(outputDir, '_expo/static/js/web'), { recursive: true });
        await writeFile(
          resolve(outputDir, 'index.html'),
          '<!doctype html><html><head><script src="/_expo/static/js/web/index.js"></script></head><body>rebuilt</body></html>',
          'utf8',
        );
        await writeFile(resolve(outputDir, 'metadata.json'), JSON.stringify({ version: 1 }), 'utf8');
        await writeFile(resolve(outputDir, '_expo/static/js/web/index.js'), 'globalThis.__HAPPIER_E2E__ = true;', 'utf8');
      });

    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    const ui = await startUiWebExport({
      testDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `cache-clear-live-retry-${Date.now()}`,
        HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS: '1000',
        HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_POLL_MS: '5',
        EXPO_UPDATES_CHANNEL: `cache-clear-live-retry-${Date.now()}`,
      },
    });

    try {
      // workspace prebuild + 2 export attempts
      expect(runLoggedCommandMock).toHaveBeenCalledTimes(3);
    } finally {
      await ui.stop();
    }
  });

  it('does not fail a long export while stdout keeps making forward progress', async () => {
    runLoggedCommandMock.mockImplementation(async (params?: RunLoggedCommandMockParams) => {
      if (!params?.args) {
        throw new Error('missing runLoggedCommand args');
      }
      if (isWorkspacePrebuildInvocation(params)) {
        return;
      }
      const outputDir = resolveOutputDirFromArgs(params.args);
      await mkdir(resolve(outputDir, '_expo/static/js/web'), { recursive: true });
      await writeFile(
        params.stdoutPath,
        ['Expo Autolinking module resolution enabled', 'Starting Metro Bundler'].join('\n'),
        'utf8',
      );

      for (let i = 1; i <= 8; i += 1) {
        await new Promise((resolveNext) => setTimeout(resolveNext, 15));
        await appendFile(params.stdoutPath, `\nprogress-heartbeat-${i}`);
      }

      await writeFile(
        resolve(outputDir, 'index.html'),
        '<!doctype html><html><head><script src="/_expo/static/js/web/index.js"></script></head><body>rebuilt</body></html>',
        'utf8',
      );
      await writeFile(resolve(outputDir, 'metadata.json'), JSON.stringify({ version: 1 }), 'utf8');
      await writeFile(resolve(outputDir, '_expo/static/js/web/index.js'), 'globalThis.__HAPPIER_E2E__ = true;', 'utf8');
    });

    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    const ui = await startUiWebExport({
      testDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `long-progress-${Date.now()}`,
        HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS: '40',
        HAPPIER_E2E_UI_WEB_EXPORT_HARD_TIMEOUT_MS: '1000',
        HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS: '200',
        HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_POLL_MS: '5',
      },
    });

    try {
      // workspace prebuild + export
      expect(runLoggedCommandMock).toHaveBeenCalledTimes(2);
    } finally {
      await ui.stop();
    }
  });

  it('rebuilds a persisted export when the published dist is missing required files', async () => {
    const incompleteNamespace = `vitest-ui-web-export-incomplete-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const incompleteRootDir = resolveUiWebExportRootDir({ HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: incompleteNamespace });
    const incompleteDistDir = resolve(incompleteRootDir, 'dist');

    await mkdir(incompleteDistDir, { recursive: true });
    await writeFile(resolve(incompleteDistDir, 'index.html'), '<!doctype html><html><head></head><body>incomplete</body></html>', 'utf8');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: incompleteNamespace,
    };
    const cacheKey = buildUiWebExportCacheKey(env);

    await writeFile(resolve(incompleteRootDir, 'cache-key.json'), JSON.stringify({ cacheKey }), 'utf8');
    await writeFile(resolve(incompleteRootDir, 'export-manifest.json'), JSON.stringify({ formatVersion: 1, createdAtMs: Date.now() }), 'utf8');

    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    await expect(
      startUiWebExport({
        testDir,
        env,
      }),
    ).rejects.toThrow(/RUN_LOGGED_COMMAND_CALLED/);

    await rm(incompleteRootDir, { recursive: true, force: true }).catch(() => {});
  });

  it('forces a rebuild when HAPPIER_E2E_EXPO_CLEAR=1 even if the persisted export matches', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    await expect(
      startUiWebExport({
        testDir,
        env: {
          ...process.env,
          EXPO_PUBLIC_DEBUG: '1',
          HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: namespace,
          HAPPIER_E2E_EXPO_CLEAR: '1',
        },
      }),
    ).rejects.toThrow(/RUN_LOGGED_COMMAND_CALLED/);
  });

  it('rebuilds a persisted export cache created without source fingerprinting', async () => {
    const legacyNamespace = `vitest-ui-web-export-legacy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const legacyRootDir = resolveUiWebExportRootDir({ HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: legacyNamespace });
    const legacyDistDir = resolve(legacyRootDir, 'dist');

    await mkdir(legacyDistDir, { recursive: true });
    await writeFile(resolve(legacyDistDir, 'index.html'), '<!doctype html><html><head></head><body>legacy</body></html>', 'utf8');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: legacyNamespace,
    };
    const legacyCacheKey = buildLegacyExportCacheKeyForTest(env);

    await writeFile(resolve(legacyRootDir, 'cache-key.json'), JSON.stringify({ cacheKey: legacyCacheKey }), 'utf8');
    await writeFile(resolve(legacyRootDir, 'export-manifest.json'), JSON.stringify({ formatVersion: 1, createdAtMs: Date.now() }), 'utf8');

    const testDir = mkdtempSync(join(tmpdir(), 'happier-uiwebexport-test-'));
    await expect(
      startUiWebExport({
        testDir,
        env,
      }),
    ).rejects.toThrow(/RUN_LOGGED_COMMAND_CALLED/);

    await rm(legacyRootDir, { recursive: true, force: true }).catch(() => {});
  });
});
