#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import process, { stdout } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { ensureUiWorkspacePackagesBuilt } from '../ensureWorkspacePackagesBuilt.mjs';
import {
    ensureDir,
    nowStamp,
    runTauriMcpCli,
    writeTextArtifact,
} from './tauriMcpCli.mjs';
import {
    resolveDefaultDriverSessionPort,
    resolveCandidateDriverSessionPorts,
    startTargetedDriverSession,
} from './tauriDriverSessionSelection.mjs';
import { appendTauriQaHmrOptOut } from './tauriQaPathing.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(dirname(scriptDir));
const repoRoot = dirname(dirname(packageRoot));

const selectorWaitMs = 8_000;
const cliSelectorWaitTimeoutMs = 20_000;
const cliInteractTimeoutMs = 20_000;
const proofChannelTransientRetryAttempts = 3;
const proofChannelTransientRetryDelayMs = 250;

function readString(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function isTransientWebviewConnectionError(error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message.includes('Not connected to plugin') || message.includes('reconnection failed');
}

function buildDesktopSidebarChromeStepPlan() {
    return [
        {
            id: 'authenticated_sidebar_expanded',
            title: 'Authenticated shell / expanded sidebar host',
            path: '/settings',
            selectors: [
                '[data-testid="desktop-sidebar-chrome"]',
                '[data-testid="desktop-window-controls-host"]',
                '[data-testid="desktop-update-indicator-host"]',
            ],
            screenshot: '01-authenticated-sidebar-expanded.png',
            domStructure: '01-authenticated-sidebar-expanded.structure.yml',
            domAccessibility: '01-authenticated-sidebar-expanded.a11y.yml',
            notes: ['ensure the authenticated desktop shell is visible with the expanded sidebar host before capture'],
        },
        {
            id: 'authenticated_sidebar_collapsed',
            title: 'Authenticated shell / collapsed sidebar host',
            path: '/settings',
            selectors: [
                '[data-testid="desktop-collapsed-shell-chrome"]',
                '[data-testid="desktop-window-controls-host"]',
                '[data-testid="desktop-update-indicator-host"]',
            ],
            screenshot: '02-authenticated-sidebar-collapsed.png',
            domStructure: '02-authenticated-sidebar-collapsed.structure.yml',
            domAccessibility: '02-authenticated-sidebar-collapsed.a11y.yml',
            notes: ['collapse the desktop sidebar before capture if the host is not already active'],
        },
        {
            id: 'authenticated_focus_mode',
            title: 'Authenticated shell / focus-mode fallback host',
            path: '/settings',
            selectors: [
                '[data-testid="desktop-focus-mode-shell-chrome"]',
                '[data-testid="desktop-window-controls-host"]',
            ],
            screenshot: '03-authenticated-focus-mode.png',
            domStructure: '03-authenticated-focus-mode.structure.yml',
            domAccessibility: '03-authenticated-focus-mode.a11y.yml',
            notes: ['enable editor focus mode before capture if the fallback host is not already visible'],
        },
        {
            id: 'unauthenticated_shell',
            title: 'Unauthenticated shell host',
            path: '/',
            selectors: [
                '[data-testid="desktop-unauth-shell-chrome"]',
                '[data-testid="desktop-window-controls-host"]',
                '[data-testid="desktop-update-indicator-host"]',
            ],
            screenshot: '04-unauthenticated-shell.png',
            domStructure: '04-unauthenticated-shell.structure.yml',
            domAccessibility: '04-unauthenticated-shell.a11y.yml',
            notes: ['capture the desktop pre-auth shell before signing in if the app is still unauthenticated'],
        },
        {
            id: 'narrow_desktop_fallback',
            title: 'Authenticated shell / narrow desktop fallback host',
            path: '/settings',
            selectors: [
                '[data-testid="desktop-narrow-shell-chrome"]',
                '[data-testid="desktop-window-controls-host"]',
                '[data-testid="desktop-update-indicator-host"]',
            ],
            screenshot: '05-narrow-desktop-fallback.png',
            domStructure: '05-narrow-desktop-fallback.structure.yml',
            domAccessibility: '05-narrow-desktop-fallback.a11y.yml',
            notes: ['resize the desktop window narrow enough to force the fallback host before capture'],
        },
    ];
}

function resolveDesktopSidebarChromeArtifactRoot({ date = new Date(), runId = nowStamp() } = {}) {
    return join(
        repoRoot,
        '.project',
        'logs',
        'desktop-sidebar-chrome-qa',
        `tauri-desktop-sidebar-chrome-${date.toISOString().slice(0, 10)}-${runId}`,
    );
}

function buildPath(pathname) {
    return appendTauriQaHmrOptOut(pathname);
}

export function buildTauriDesktopSidebarChromeQaPlan({ env = process.env } = {}) {
    const driverSessionPort = resolveDefaultDriverSessionPort({ env });
    const artifactRootRaw = readString(
        env.HAPPIER_TAURI_QA_OUTDIR,
        resolveDesktopSidebarChromeArtifactRoot({ date: new Date(), runId: nowStamp() }),
    );
    const artifactRoot = isAbsolute(artifactRootRaw) ? artifactRootRaw : join(repoRoot, artifactRootRaw);
    const stepPlan = buildDesktopSidebarChromeStepPlan();

    return {
        repoRoot,
        packageRoot,
        artifactRoot,
        driverSessionPort,
        timeouts: {
            selectorWaitMs,
            cliSelectorWaitTimeoutMs,
            cliInteractTimeoutMs,
        },
        commandRunner: {
            command: 'yarn',
            baseArgs: ['-s', 'tauri:mcp:cli'],
        },
        driverSession: {
            command: 'yarn',
            baseArgs: ['-s', 'tauri:mcp:cli'],
            args: ['driver-session', 'start', '--port', String(driverSessionPort)],
        },
        steps: stepPlan,
        chromePolicyProbe: {
            command: 'desktop_get_window_chrome_policy',
            artifact: '00-window-chrome-policy.json',
        },
        manual: [
            'Sign in or seed a post-auth desktop shell before the authenticated captures if the app is still on onboarding.',
            'Manually collapse the sidebar, enable focus mode, and resize the window narrow for the host-specific captures when prompted by the step notes.',
            'If the update indicator is intentionally absent for the current build/runtime, record that absence in the run artifacts before treating the step as complete.',
        ],
    };
}

function resolveDesktopSidebarChromeMcpCliEnv(env = process.env, appIdentifier = null) {
    const resolvedEnv = { ...env };
    const explicitIdentifier = readString(resolvedEnv.HAPPIER_STACK_TAURI_IDENTIFIER);
    if (explicitIdentifier && !readString(resolvedEnv.HAPPIER_TAURI_MCP_APP_IDENTIFIER)) {
        resolvedEnv.HAPPIER_TAURI_MCP_APP_IDENTIFIER = explicitIdentifier;
    }
    const identifier = String(appIdentifier ?? '').trim();
    if (identifier) {
        resolvedEnv.HAPPIER_TAURI_MCP_APP_IDENTIFIER = identifier;
    }
    return resolvedEnv;
}

async function runDesktopSidebarChromeMcpCli(args, { appIdentifier = null, env = process.env, timeoutMs } = {}) {
    return runTauriMcpCli(args, {
        cwd: packageRoot,
        env: resolveDesktopSidebarChromeMcpCliEnv(env, appIdentifier),
        timeoutMs,
    });
}

async function isSelectorPresent(
    selector,
    {
        appIdentifier,
        env,
        timeoutMs = 1_200,
        attempts = proofChannelTransientRetryAttempts,
        delayMs = proofChannelTransientRetryDelayMs,
        wait = delay,
        runCli = runDesktopSidebarChromeMcpCli,
    } = {},
) {
    const normalizedAttempts = Math.max(1, Number(attempts) || 1);
    const normalizedDelayMs = Math.max(0, Number(delayMs) || 0);

    for (let attempt = 1; attempt <= normalizedAttempts; attempt += 1) {
        try {
            // eslint-disable-next-line no-await-in-loop
            await runCli(
                [
                    'webview-wait-for',
                    '--type',
                    'selector',
                    '--strategy',
                    'css',
                    '--value',
                    String(selector),
                    '--timeout',
                    String(timeoutMs),
                    '--app-identifier',
                    String(appIdentifier),
                ],
                { appIdentifier, env, timeoutMs: Math.max(10_000, timeoutMs + 5_000) },
            );
            return true;
        } catch (error) {
            if (!isTransientWebviewConnectionError(error)) {
                return false;
            }
            if (attempt < normalizedAttempts) {
                // eslint-disable-next-line no-await-in-loop
                await wait(normalizedDelayMs);
            }
        }
    }

    return false;
}

async function waitForAnySelector(step, { appIdentifier, env } = {}) {
    for (const selector of step.selectors) {
        // eslint-disable-next-line no-await-in-loop
        if (await isSelectorPresent(selector, { appIdentifier, env, timeoutMs: selectorWaitMs })) {
            return selector;
        }
    }
    return null;
}

async function navigateWebviewToPath(pathname, { appIdentifier, env } = {}) {
    const nextPath = buildPath(pathname);
    const script = `(() => {
        window.history.pushState({}, '', ${JSON.stringify(nextPath)});
        window.dispatchEvent(new PopStateEvent('popstate'));
        return window.location.pathname + window.location.search;
    })()`;
    await runDesktopSidebarChromeMcpCli(
        [
            'webview-execute-js',
            '--script',
            script,
            '--app-identifier',
            String(appIdentifier),
            '--json',
        ],
        { appIdentifier, env, timeoutMs: cliInteractTimeoutMs },
    );
}

async function captureStep(step, { artifactRoot, appIdentifier, env } = {}) {
    const screenshotPath = join(artifactRoot, step.screenshot);
    const structurePath = join(artifactRoot, step.domStructure);
    const a11yPath = join(artifactRoot, step.domAccessibility);

    await runDesktopSidebarChromeMcpCli(
        [
            'webview-screenshot',
            '--format',
            'png',
            '--file-path',
            screenshotPath,
            '--app-identifier',
            String(appIdentifier),
        ],
        { appIdentifier, env, timeoutMs: cliInteractTimeoutMs },
    );

    const structure = await runDesktopSidebarChromeMcpCli(
        [
            'webview-dom-snapshot',
            '--type',
            'structure',
            '--app-identifier',
            String(appIdentifier),
        ],
        { appIdentifier, env, timeoutMs: cliInteractTimeoutMs },
    );
    await writeTextArtifact(structurePath, String(structure.stdout ?? ''));

    const accessibility = await runDesktopSidebarChromeMcpCli(
        [
            'webview-dom-snapshot',
            '--type',
            'accessibility',
            '--app-identifier',
            String(appIdentifier),
        ],
        { appIdentifier, env, timeoutMs: cliInteractTimeoutMs },
    );
    await writeTextArtifact(a11yPath, String(accessibility.stdout ?? ''));

    return {
        a11yPath,
        screenshotPath,
        structurePath,
    };
}

async function appendWarning(artifactRoot, text) {
    const warningsPath = join(artifactRoot, '98-warnings.md');
    const existing = readString(await readFile(warningsPath, 'utf8').catch(() => ''));
    const next = existing ? `${existing.trimEnd()}\n${text.trim()}\n` : `${text.trim()}\n`;
    await writeTextArtifact(warningsPath, next);
}

async function captureDesktopWindowChromePolicy(plan, { artifactRoot, appIdentifier, env } = {}) {
    const output = await runDesktopSidebarChromeMcpCli(
        [
            'ipc-execute-command',
            '--command',
            plan.chromePolicyProbe.command,
            '--app-identifier',
            String(appIdentifier),
            '--json',
        ],
        { appIdentifier, env, timeoutMs: cliInteractTimeoutMs },
    );
    const artifactPath = join(artifactRoot, plan.chromePolicyProbe.artifact);
    await writeTextArtifact(artifactPath, String(output.stdout ?? ''));
    return artifactPath;
}

function printUsage() {
    return [
        'Usage: node ./apps/ui/scripts/qa/tauriDesktopSidebarChromeMcpQa.mjs [--json]',
        '',
        'Plan preview:',
        '  --json   Print the deterministic capture plan without driving the app',
        '',
        'Run mode (default):',
        '  - assumes `yarn --cwd apps/ui tauri:qa --desktop-sidebar-chrome` is already running',
        '  - opens an MCP driver session',
        '  - captures screenshots + DOM snapshots for the desktop shell chrome hosts that are currently visible',
        '  - records missing hosts as warnings so manual state transitions are explicit in the artifact set',
    ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
    const json = argv.includes('--json');
    const help = argv.includes('--help') || argv.includes('-h');
    const plan = buildTauriDesktopSidebarChromeQaPlan({ env: process.env });

    if (help) {
        process.stdout.write(printUsage() + '\n');
        return;
    }

    if (json) {
        stdout.write(JSON.stringify({ ok: true, plan }, null, 2) + '\n');
        return;
    }

    await ensureUiWorkspacePackagesBuilt({ env: process.env });
    await ensureDir(plan.artifactRoot);

    const candidatePorts = resolveCandidateDriverSessionPorts({
        preferredPort: plan.driverSessionPort,
        env: process.env,
    });
    const targetedDriverSession = await startTargetedDriverSession({
        candidatePorts,
        runCliJson: (args, options = {}) =>
            runDesktopSidebarChromeMcpCli([...args, '--json'], {
                env: options.env ?? process.env,
                timeoutMs: options.timeoutMs,
            }),
        appendAttempt: async () => {},
    });
    const resolvedAppIdentifier = String(targetedDriverSession.resolvedAppIdentifier);
    let chromePolicyArtifactPath = null;

    try {
        chromePolicyArtifactPath = await captureDesktopWindowChromePolicy(plan, {
            artifactRoot: plan.artifactRoot,
            appIdentifier: resolvedAppIdentifier,
            env: process.env,
        });
    } catch (error) {
        await appendWarning(
            plan.artifactRoot,
            `- chrome-policy: unable to capture ${plan.chromePolicyProbe.command}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    const results = [];

    for (const step of plan.steps) {
        if (step.path) {
            // eslint-disable-next-line no-await-in-loop
            await navigateWebviewToPath(step.path, {
                appIdentifier: resolvedAppIdentifier,
                env: process.env,
            }).catch(async (error) => {
                await appendWarning(
                    plan.artifactRoot,
                    `- ${step.id}: unable to navigate to ${step.path}: ${error instanceof Error ? error.message : String(error)}`,
                );
            });
        }

        // eslint-disable-next-line no-await-in-loop
        const matchedSelector = await waitForAnySelector(step, {
            appIdentifier: resolvedAppIdentifier,
            env: process.env,
        });

        if (!matchedSelector) {
            // eslint-disable-next-line no-await-in-loop
            await appendWarning(
                plan.artifactRoot,
                `- ${step.id}: none of the expected selectors were visible (${step.selectors.join(', ')})`,
            );
            results.push({
                id: step.id,
                matchedSelector: null,
                ok: false,
            });
            continue;
        }

        // eslint-disable-next-line no-await-in-loop
        const artifacts = await captureStep(step, {
            artifactRoot: plan.artifactRoot,
            appIdentifier: resolvedAppIdentifier,
            env: process.env,
        });
        results.push({
            artifacts,
            id: step.id,
            matchedSelector,
            ok: true,
        });
    }

    await writeTextArtifact(
        join(plan.artifactRoot, '99-summary.json'),
        `${JSON.stringify({
            chromePolicyArtifactPath,
            ok: results.some((entry) => entry.ok),
            results,
        }, null, 2)}\n`,
    );

    if (!results.some((entry) => entry.ok)) {
        throw new Error('No desktop sidebar chrome QA steps captured successfully.');
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        process.stderr.write(
            `[tauri-desktop-sidebar-chrome-qa] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
        );
        process.exit(1);
    });
}
