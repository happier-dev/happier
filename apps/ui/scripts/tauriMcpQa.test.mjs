import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

test('tauri MCP QA plan includes wizard QA as the default run mode', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');

    const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--json'], {
        cwd: dirname(scriptsDir),
        env: { ...process.env },
        encoding: 'utf8',
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(typeof payload.plan.runWizard, 'boolean');
    assert.equal(payload.plan.runWizard, true);
    assert.equal(typeof payload.plan.keepRunning, 'boolean');
    assert.equal(payload.plan.keepRunning, false);
    assert.equal(typeof payload.plan.logDir, 'string');
    assert.match(payload.plan.logDir, /bootstrap-qa[\\/]tauri-qa-/);
    assert.equal(typeof payload.plan.wizardQa, 'object');
    assert.equal(payload.plan.wizardQa?.script, 'scripts/qa/tauriOnboardingWizardMcpQa.mjs');
});

test('tauri MCP QA --serve disables wizard one-shot mode', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');

    const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--json', '--serve'], {
        cwd: dirname(scriptsDir),
        env: { ...process.env },
        encoding: 'utf8',
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.plan.keepRunning, true);
    assert.equal(payload.plan.runWizard, false);
});

test('tauri MCP QA can switch the one-shot capture scenario to activity-surfaces', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');

    const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--json', '--activity-surfaces'], {
        cwd: dirname(scriptsDir),
        env: { ...process.env },
        encoding: 'utf8',
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.plan.keepRunning, false);
    assert.equal(payload.plan.runWizard, false);
    assert.equal(payload.plan.qaScenario?.id, 'activity-surfaces');
    assert.equal(payload.plan.qaScenario?.script, 'scripts/qa/tauriActivitySurfacesMcpQa.mjs');
});

test('tauri MCP QA can switch the one-shot capture scenario to desktop-sidebar-chrome', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');

    const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--json', '--desktop-sidebar-chrome'], {
        cwd: dirname(scriptsDir),
        env: { ...process.env },
        encoding: 'utf8',
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.plan.keepRunning, false);
    assert.equal(payload.plan.runWizard, false);
    assert.equal(payload.plan.qaScenario?.id, 'desktop-sidebar-chrome');
    assert.equal(payload.plan.qaScenario?.script, 'scripts/qa/tauriDesktopSidebarChromeMcpQa.mjs');
});

test('tauri MCP QA desktop-sidebar-chrome scenario defaults to the canonical stack-owned desktop QA target when no stack env is provided', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    const plan = await module.resolveTauriMcpQaPlan({
        argv: ['--desktop-sidebar-chrome'],
        env: { ...process.env },
    });

    assert.equal(plan.requestedScenario, 'desktop-sidebar-chrome');
    assert.equal(plan.qaScenario?.id, 'desktop-sidebar-chrome');
    assert.equal(plan.qaScenario?.envOverrides?.HAPPIER_STACK_STACK, 'desktop-sidebar-chrome-qa');
    assert.equal(plan.qaScenario?.envOverrides?.HAPPIER_STACK_TAURI_IDENTIFIER, 'com.happier.stack.desktop-sidebar-chrome-qa');
    assert.equal(plan.tauriDev.env?.HAPPIER_STACK_STACK, 'desktop-sidebar-chrome-qa');
    assert.equal(plan.tauriDev.env?.HAPPIER_STACK_TAURI_IDENTIFIER, 'com.happier.stack.desktop-sidebar-chrome-qa');
    assert.equal(plan.tauriConfig.identifier, 'com.happier.stack.desktop-sidebar-chrome-qa');
  });

test('tauri MCP QA activity-surfaces scenario defaults to the canonical stack-owned desktop QA target when no stack env is provided', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    const plan = await module.resolveTauriMcpQaPlan({
        argv: ['--activity-surfaces'],
        env: { ...process.env },
    });

    assert.equal(plan.requestedScenario, 'activity-surfaces');
    assert.equal(plan.qaScenario?.id, 'activity-surfaces');
    assert.equal(plan.qaScenario?.envOverrides?.HAPPIER_STACK_STACK, 'activity-surfaces-qa');
    assert.equal(plan.qaScenario?.envOverrides?.HAPPIER_STACK_TAURI_IDENTIFIER, 'com.happier.stack.activity-surfaces-qa');
    assert.equal(plan.tauriDev.env?.HAPPIER_STACK_STACK, 'activity-surfaces-qa');
    assert.equal(plan.tauriDev.env?.HAPPIER_STACK_TAURI_IDENTIFIER, 'com.happier.stack.activity-surfaces-qa');
    assert.equal(plan.tauriConfig.identifier, 'com.happier.stack.activity-surfaces-qa');
});

test('tauri MCP QA activity-surfaces scenario injects the stack runtime server URL from runtime state when stack env overrides are synthesized', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    const plan = await module.resolveTauriMcpQaPlan({
        argv: ['--activity-surfaces'],
        env: { ...process.env },
        runtimeStateOverride: {
            ports: {
                server: 3009,
            },
            expo: {
                port: 8081,
                webPort: 8081,
            },
        },
    });

  assert.match(plan.devUrl, /[?&]server=http%3A%2F%2F127\.0\.0\.1%3A3009/);
  assert.equal(plan.tauriDev.env?.HAPPIER_TAURI_WEB_RUNTIME_SERVER_URL, 'http://127.0.0.1:3009');
  assert.equal(plan.tauriDev.env?.HAPPIER_SERVER_URL, 'http://127.0.0.1:3009');
  assert.equal(plan.qaScenario?.envOverrides?.HAPPIER_STACK_TAURI_WAIT_FOR_EXPO, '0');
});

test('tauri MCP QA activity-surfaces scenario merges stack env file values into the Tauri launcher env', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    const fixtureDir = await mkdtemp(join(tmpdir(), 'tauri-mcp-qa-stack-env-'));
    const stackEnvPath = join(fixtureDir, 'activity-surfaces.env');
    await writeFile(
        stackEnvPath,
        [
            'HAPPIER_STACK_CLI_HOME_DIR=/tmp/happier-stack/cli',
            'HAPPIER_STACK_SERVER_PORT=3009',
            'HAPPIER_STACK_RUNTIME_MODE=require',
        ].join('\n') + '\n',
        'utf8',
    );

    const plan = await module.resolveTauriMcpQaPlan({
        argv: ['--activity-surfaces'],
        env: {
            ...process.env,
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_ENV_FILE: stackEnvPath,
        },
        runtimeStateOverride: {
            ports: {
                server: 3009,
            },
            expo: {
                port: 8081,
                webPort: 8081,
            },
        },
    });

    assert.equal(plan.tauriDev.env?.HAPPIER_STACK_ENV_FILE, stackEnvPath);
    assert.equal(plan.tauriDev.env?.HAPPIER_STACK_CLI_HOME_DIR, '/tmp/happier-stack/cli');
    assert.equal(plan.tauriDev.env?.HAPPIER_HOME_DIR, '/tmp/happier-stack/cli');
    assert.equal(plan.tauriDev.env?.HAPPIER_STACK_SERVER_PORT, '3009');
});

test('tauri MCP QA prefers the stack runtime server over a stale loopback HAPPIER_SERVER_URL', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    const plan = await module.resolveTauriMcpQaPlan({
      env: {
        ...process.env,
        HAPPIER_SERVER_URL: 'http://127.0.0.1:53288',
        HAPPIER_STACK_SERVER_PORT: '24610',
      },
    });

    assert.equal(plan.tauriDev.env?.HAPPIER_TAURI_WEB_RUNTIME_SERVER_URL, 'http://127.0.0.1:24610');
    assert.equal(plan.tauriDev.env?.HAPPIER_SERVER_URL, 'http://127.0.0.1:24610');
  });

test('tauri MCP QA bootstraps the web app with the stack server query parameter', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    const plan = await module.resolveTauriMcpQaPlan({
      env: {
        ...process.env,
        HAPPIER_STACK_SERVER_PORT: '24610',
      },
    });

    assert.match(plan.devUrl, /[?&]server=http%3A%2F%2F127\.0\.0\.1%3A24610/);
  });

test('tauri MCP QA injects the stack server runtime URL into the Tauri launcher env', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    const plan = await module.resolveTauriMcpQaPlan({
        env: {
            ...process.env,
            HAPPIER_STACK_SERVER_PORT: '24610',
        },
    });

    assert.equal(plan.tauriDev.env?.HAPPIER_TAURI_WEB_RUNTIME_SERVER_URL, 'http://127.0.0.1:24610');
    assert.equal(plan.tauriDev.env?.HAPPIER_TAURI_WEB_RUNTIME_SERVER_CONTEXT, 'stack');
    assert.equal(plan.tauriDev.env?.HAPPIER_SERVER_URL, 'http://127.0.0.1:24610');
});

test('tauri MCP QA derives a stack-scoped Tauri identifier and product name from the stack name when explicit overrides are absent', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    const plan = await module.resolveTauriMcpQaPlan({
        env: {
            ...process.env,
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_SERVER_PORT: '24610',
        },
    });

    assert.equal(plan.tauriConfig.identifier, 'com.happier.stack.activity-surfaces-qa');
    assert.equal(plan.tauriConfig.productName, 'Happier (activity-surfaces-qa)');
});

test('tauri MCP QA waits for an attachable Tauri app and returns the resolved session target', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    const waits = [];
    let attempts = 0;
    const result = await module.waitForAttachableTauriApp({
        env: {
            ...process.env,
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.activity-surfaces-qa',
        },
        maxAttempts: 3,
        retryDelayMs: 25,
        wait: async (delayMs) => {
            waits.push(delayMs);
        },
        startDriverSession: async () => {
            attempts += 1;
            if (attempts < 3) {
                return null;
            }
            return {
                driverSessionPort: 9223,
                resolvedAppIdentifier: 'com.happier.stack.activity-surfaces-qa',
            };
        },
    });

    assert.deepEqual(result, {
        driverSessionPort: 9223,
        resolvedAppIdentifier: 'com.happier.stack.activity-surfaces-qa',
    });
    assert.deepEqual(waits, [25, 25]);
});

test('tauri MCP QA retries attachability probes when the driver-session helper throws before the app is ready', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    const waits = [];
    let attempts = 0;

    const result = await module.waitForAttachableTauriApp({
        env: {
            ...process.env,
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.activity-surfaces-qa',
        },
        maxAttempts: 3,
        retryDelayMs: 25,
        wait: async (delayMs) => {
            waits.push(delayMs);
        },
        startDriverSession: async () => {
            attempts += 1;
            if (attempts < 3) {
                throw new Error('Unable to resolve a connected Tauri app identifier from driver-session status. Tried ports: 9223, 9224, 9225');
            }
            return {
                driverSessionPort: 9223,
                resolvedAppIdentifier: 'com.happier.stack.activity-surfaces-qa',
            };
        },
    });

    assert.deepEqual(result, {
        driverSessionPort: 9223,
        resolvedAppIdentifier: 'com.happier.stack.activity-surfaces-qa',
    });
    assert.deepEqual(waits, [25, 25]);
});

test('tauri MCP QA attachability wait fails closed after exhausting the configured retries', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    const waits = [];
    await assert.rejects(
        () =>
            module.waitForAttachableTauriApp({
                env: {
                    ...process.env,
                    HAPPIER_STACK_STACK: 'activity-surfaces-qa',
                    HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.activity-surfaces-qa',
                },
                maxAttempts: 2,
                retryDelayMs: 10,
                wait: async (delayMs) => {
                    waits.push(delayMs);
                },
                startDriverSession: async () => null,
            }),
        /Timed out waiting for an attachable Tauri app/,
    );

    assert.deepEqual(waits, [10]);
});

test('tauri MCP QA attachability wait reports the last probe failure after exhausting thrown startup retries', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    const waits = [];

    await assert.rejects(
        () =>
            module.waitForAttachableTauriApp({
                env: {
                    ...process.env,
                    HAPPIER_STACK_STACK: 'activity-surfaces-qa',
                    HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.activity-surfaces-qa',
                },
                maxAttempts: 2,
                retryDelayMs: 10,
                wait: async (delayMs) => {
                    waits.push(delayMs);
                },
                startDriverSession: async () => {
                    throw new Error('Unable to resolve a connected Tauri app identifier from driver-session status. Tried ports: 9223, 9224, 9225');
                },
            }),
        /Timed out waiting for an attachable Tauri app after 2 attempts\..*Unable to resolve a connected Tauri app identifier/ms,
    );

    assert.deepEqual(waits, [10]);
});

test('tauri MCP QA can reuse an already attachable app for one-shot activity-surfaces capture', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    const attachableApp = await module.resolveReusableAttachableTauriApp({
        plan: {
            runSelectedScenario: true,
            qaScenario: {
                id: 'activity-surfaces',
            },
        },
        env: {
            ...process.env,
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.activity-surfaces-qa',
        },
        waitForAttachableApp: async (options = {}) => {
            assert.equal(options.maxAttempts, 1);
            assert.equal(options.retryDelayMs, 0);
            return {
                driverSessionPort: 9223,
                resolvedAppIdentifier: 'com.happier.stack.activity-surfaces-qa',
            };
        },
    });

    assert.deepEqual(attachableApp, {
        driverSessionPort: 9223,
        resolvedAppIdentifier: 'com.happier.stack.activity-surfaces-qa',
    });
});

test('tauri MCP QA falls back to local bootstrap when no attachable one-shot app is already running', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    const attachableApp = await module.resolveReusableAttachableTauriApp({
        plan: {
            runSelectedScenario: true,
            qaScenario: {
                id: 'activity-surfaces',
            },
        },
        env: {
            ...process.env,
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.activity-surfaces-qa',
        },
        waitForAttachableApp: async () => {
            throw new Error('Timed out waiting for an attachable Tauri app after 1 attempts.');
        },
    });

    assert.equal(attachableApp, null);
});

test('tauri MCP QA prepares a fresh launcher log root before resolving attachable apps', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    assert.equal(typeof module.ensureTauriMcpQaLaunchArtifacts, 'function');

    const calls = [];
    const result = await module.ensureTauriMcpQaLaunchArtifacts({
        plan: {
            logDir: '/tmp/happier-activity-surfaces-launcher-root',
        },
        ensureDirImpl: async (dirPath) => {
            calls.push(dirPath);
        },
    });

    assert.equal(result, '/tmp/happier-activity-surfaces-launcher-root');
    assert.deepEqual(calls, ['/tmp/happier-activity-surfaces-launcher-root']);
});

test('tauri MCP QA skips reusing an attachable app for the canonical activity-surfaces one-shot launcher path', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    assert.equal(typeof module.shouldReuseAttachableTauriApp, 'function');

    assert.equal(
        module.shouldReuseAttachableTauriApp({
            plan: {
                runSelectedScenario: true,
                qaScenario: {
                    id: 'activity-surfaces',
                },
            },
        }),
        false,
    );

    assert.equal(
        module.shouldReuseAttachableTauriApp({
            plan: {
                runSelectedScenario: true,
                qaScenario: {
                    id: 'wizard',
                },
            },
        }),
        true,
    );
});

test('tauri MCP QA uses a wider attach wait window after starting the canonical activity-surfaces launcher fresh', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    assert.equal(typeof module.resolveTauriMcpQaAttachWaitOptions, 'function');

    assert.deepEqual(
        module.resolveTauriMcpQaAttachWaitOptions({
            plan: {
                runSelectedScenario: true,
                qaScenario: {
                    id: 'activity-surfaces',
                },
            },
        }),
        {
            maxAttempts: 90,
            retryDelayMs: 1_000,
        },
    );

    assert.deepEqual(
        module.resolveTauriMcpQaAttachWaitOptions({
            plan: {
                runSelectedScenario: true,
                qaScenario: {
                    id: 'wizard',
                },
            },
        }),
        {},
    );
});

test('tauri MCP QA bootstraps Expo when the web runtime is missing in serve mode', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);
    const packageRoot = dirname(scriptsDir);

    const waitPorts = [];
    const bootstrapCalls = [];
    let waitAttempts = 0;

    const result = await module.ensureTauriExpoRuntime({
        plan: {
            devUrl: 'http://localhost:8081?server=http%3A%2F%2F127.0.0.1%3A3009',
            keepRunning: true,
            tauriDev: {
                env: {
                    HAPPIER_TAURI_WEB_RUNTIME_SERVER_URL: 'http://127.0.0.1:3009',
                },
            },
        },
        env: {
            ...process.env,
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.activity-surfaces-qa',
        },
        waitForExpoMetroRunningImpl: async ({ port }) => {
            waitPorts.push(port);
            waitAttempts += 1;
            if (waitAttempts === 1) {
                return { ok: false, reason: 'timeout', probes: 3 };
            }
            return { ok: true, probes: 1 };
        },
        ensureDevExpoServerImpl: async (options) => {
            bootstrapCalls.push(options);
            return {
                ok: true,
                skipped: false,
                pid: 1234,
                port: 8081,
                proc: { pid: 1234 },
            };
        },
        getDefaultAutostartPathsImpl: () => ({ baseDir: '/tmp/happier-autostart' }),
        getStackRuntimeStatePathImpl: () => '/tmp/happier-stack.runtime.json',
        resolveStackEnvPathImpl: () => ({ envPath: '/tmp/happier-stack.env', baseDir: '/tmp/happier-stack' }),
        bootstrapWhenMissing: true,
        wait: async () => {},
    });

    assert.deepEqual(waitPorts, [8081, 8081]);
    assert.equal(result.ok, true);
    assert.equal(result.bootstrapped, true);
    assert.equal(bootstrapCalls.length, 1);
    assert.equal(bootstrapCalls[0].uiDir, packageRoot);
    assert.equal(bootstrapCalls[0].baseEnv.HAPPIER_STACK_EXPO_DEV_PORT, '8081');
    assert.equal(bootstrapCalls[0].baseEnv.HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY, 'stable');
    assert.equal(bootstrapCalls[0].baseEnv.HAPPIER_STACK_EXPO_HOST, 'localhost');
    assert.equal(bootstrapCalls[0].stackName, 'activity-surfaces-qa');
});

test('tauri MCP QA re-probes the actual bootstrapped Expo port after bootstrap changes the port', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    const waitPorts = [];
    let waitAttempts = 0;

    const result = await module.ensureTauriExpoRuntime({
        plan: {
            devUrl: 'http://localhost:8081?server=http%3A%2F%2F127.0.0.1%3A3009',
            keepRunning: true,
            tauriDev: {
                env: {
                    HAPPIER_TAURI_WEB_RUNTIME_SERVER_URL: 'http://127.0.0.1:3009',
                },
            },
        },
        env: {
            ...process.env,
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.activity-surfaces-qa',
        },
        waitForExpoMetroRunningImpl: async ({ port }) => {
            waitPorts.push(port);
            waitAttempts += 1;
            if (waitAttempts === 1) {
                return { ok: false, reason: 'timeout', probes: 3 };
            }
            return { ok: port === 8099, probes: 1 };
        },
        ensureDevExpoServerImpl: async () => ({
            ok: true,
            skipped: false,
            pid: 1234,
            port: 8099,
            proc: { pid: 1234 },
        }),
        getDefaultAutostartPathsImpl: () => ({ baseDir: '/tmp/happier-autostart' }),
        resolveStackEnvPathImpl: () => ({ envPath: '/tmp/happier-stack.env', baseDir: '/tmp/happier-stack' }),
        bootstrapWhenMissing: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.expoPort, 8099);
    assert.deepEqual(waitPorts, [8081, 8099]);
});

test('tauri MCP QA rewrites the launch plan to the resolved Expo port after bootstrap changes the port', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    assert.equal(typeof module.alignTauriMcpQaPlanToExpoPort, 'function');

    const alignedPlan = module.alignTauriMcpQaPlanToExpoPort({
        plan: {
            devUrl: 'http://localhost:8081?server=http%3A%2F%2F127.0.0.1%3A3009',
            configPath: 'src-tauri/tauri.conf.json',
            tauriConfig: {
                build: {
                    devUrl: 'http://localhost:8081?server=http%3A%2F%2F127.0.0.1%3A3009',
                    beforeDevCommand: '',
                    beforeBuildCommand: '',
                },
            },
            tauriDev: {
                command: '/usr/bin/node',
                args: ['tauri', 'dev'],
                cwd: '/tmp/ui',
                env: {
                    HAPPIER_STACK_STACK: 'activity-surfaces-qa',
                    HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.activity-surfaces-qa',
                },
            },
        },
        expoPort: 8099,
        rootDir: '/tmp/repo',
    });

    assert.equal(alignedPlan.devUrl, 'http://localhost:8099/?server=http%3A%2F%2F127.0.0.1%3A3009');
    assert.equal(alignedPlan.tauriConfig.build.devUrl, 'http://localhost:8099/?server=http%3A%2F%2F127.0.0.1%3A3009');
    assert.equal(alignedPlan.tauriDev.cwd, '/tmp/ui');
    assert.equal(alignedPlan.tauriDev.env.HAPPIER_STACK_STACK, 'activity-surfaces-qa');
    assert.ok(Array.isArray(alignedPlan.tauriDev.args));
    assert.match(JSON.stringify(alignedPlan.tauriDev.args), /8099/);
});

test('tauri MCP QA retries Expo bootstrap with restart when a stable port is occupied by an unhealthy runtime', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    const waitPorts = [];
    const bootstrapCalls = [];
    let waitAttempts = 0;

    const result = await module.ensureTauriExpoRuntime({
        plan: {
            devUrl: 'http://localhost:8081?server=http%3A%2F%2F127.0.0.1%3A3009',
            keepRunning: true,
            tauriDev: {
                env: {
                    HAPPIER_TAURI_WEB_RUNTIME_SERVER_URL: 'http://127.0.0.1:3009',
                },
            },
        },
        env: {
            ...process.env,
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.activity-surfaces-qa',
        },
        waitForExpoMetroRunningImpl: async ({ port }) => {
            waitPorts.push(port);
            waitAttempts += 1;
            if (waitAttempts === 1) {
                return { ok: false, reason: 'timeout', probes: 3 };
            }
            return { ok: true, probes: 1 };
        },
        ensureDevExpoServerImpl: async (options) => {
            bootstrapCalls.push(options);
            if (bootstrapCalls.length === 1) {
                throw new Error(
                    '[expo] stable expo port 8081 is already in use; refusing to bump the expo port. Stop the process using it or run with --restart after ensuring the previous stack process is stopped.'
                );
            }
            return {
                ok: true,
                skipped: false,
                pid: 1234,
                port: 8081,
                proc: { pid: 1234 },
            };
        },
        getDefaultAutostartPathsImpl: () => ({ baseDir: '/tmp/happier-autostart' }),
        resolveStackEnvPathImpl: () => ({ envPath: '/tmp/happier-stack.env', baseDir: '/tmp/happier-stack' }),
        bootstrapWhenMissing: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.expoPort, 8081);
    assert.deepEqual(waitPorts, [8081, 8081]);
    assert.equal(bootstrapCalls.length, 2);
    assert.equal(bootstrapCalls[0].restart, false);
    assert.equal(bootstrapCalls[1].restart, true);
});

test('tauri MCP QA reuses an already-running Expo runtime without bootstrapping another one', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    const waitPorts = [];
    const bootstrapCalls = [];

    const result = await module.ensureTauriExpoRuntime({
        plan: {
            devUrl: 'http://localhost:8081?server=http%3A%2F%2F127.0.0.1%3A3009',
            keepRunning: true,
            tauriDev: {
                env: {
                    HAPPIER_TAURI_WEB_RUNTIME_SERVER_URL: 'http://127.0.0.1:3009',
                },
            },
        },
        env: {
            ...process.env,
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.activity-surfaces-qa',
        },
        waitForExpoMetroRunningImpl: async ({ port }) => {
            waitPorts.push(port);
            return { ok: true, probes: 1 };
        },
        ensureDevExpoServerImpl: async (options) => {
            bootstrapCalls.push(options);
            return {
                ok: true,
                skipped: false,
                pid: 1234,
                port: 8081,
                proc: { pid: 1234 },
            };
        },
        getDefaultAutostartPathsImpl: () => ({ baseDir: '/tmp/happier-autostart' }),
        resolveStackEnvPathImpl: () => ({ envPath: '/tmp/happier-stack.env', baseDir: '/tmp/happier-stack' }),
        bootstrapWhenMissing: true,
    });

    assert.deepEqual(waitPorts, [8081]);
    assert.equal(result.ok, true);
    assert.equal(result.bootstrapped, false);
    assert.equal(bootstrapCalls.length, 0);
});

test('tauri MCP QA bootstraps Expo for the canonical activity-surfaces one-shot lane when the runtime is missing', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    const shouldBootstrap = module.resolveExpoBootstrapPolicy({
        plan: {
            keepRunning: false,
            qaScenario: {
                id: 'activity-surfaces',
            },
        },
    });

    assert.equal(shouldBootstrap, true);
});

test('tauri MCP QA keeps the default wizard one-shot lane non-bootstrapping', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    const shouldBootstrap = module.resolveExpoBootstrapPolicy({
        plan: {
            keepRunning: false,
            qaScenario: {
                id: 'wizard',
            },
        },
    });

    assert.equal(shouldBootstrap, false);
});

test('tauri MCP QA treats runtime-served devUrl as non-Expo (skips Metro gating)', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    assert.equal(typeof module.planExpectsExpoWebRuntime, 'function');

    assert.equal(
        module.planExpectsExpoWebRuntime({
            plan: {
                devUrl: 'http://happier-activity-surfaces-qa.localhost:3009',
            },
            env: {
                ...process.env,
                HAPPIER_STACK_TAURI_DEV_PORT: '8081',
            },
        }),
        false,
    );
});
