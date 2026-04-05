#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { ensureUiWorkspacePackagesBuilt } from '../ensureWorkspacePackagesBuilt.mjs';
import {
    appendTextArtifact,
    ensureDir,
    nowStamp,
    runTauriMcpCli,
    runTauriMcpCliJson,
    todayStamp,
    writeTextArtifact,
} from './tauriMcpCli.mjs';
import { resolveCandidateDriverSessionPorts } from './tauriOnboardingWizardMcpQa.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(dirname(scriptDir));
const repoRoot = dirname(dirname(packageRoot));

const selectorWaitMs = 8_000;
const cliSelectorWaitTimeoutMs = 20_000;
const cliInteractTimeoutMs = 20_000;
const defaultTrackerPath = join(
    repoRoot,
    '.project',
    'plans',
    'todo',
    'activity-surfaces',
    'happier-activity-surfaces-qa-tracking-2026-04-05.md',
);

function readString(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function readNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function resolveActivitySurfacesQaArtifactRoot(rootDir, { date = new Date(), runId = nowStamp(date) } = {}) {
    return join(rootDir, '.project', 'logs', 'activity-surfaces-qa', `tauri-activity-surfaces-${todayStamp(date)}-${runId}`);
}

function buildStepPlan() {
    return [
        {
            id: 'settings_overlay',
            title: 'Settings / desktop overlay',
            selectors: [
                '[data-testid="settings-desktop-overlay-enabled"]',
                '[data-testid="settings-shell.sidebarPane"]',
            ],
            screenshot: '01-settings-overlay.png',
            domStructure: '01-settings-overlay.structure.yml',
            domAccessibility: '01-settings-overlay.a11y.yml',
            notes: ['capture the desktop overlay settings section inside the real settings screen'],
        },
        {
            id: 'overlay_route',
            title: 'Desktop overlay route',
            selectors: [
                '[data-testid="desktop-activity-overlay-hidden"]',
                '[data-testid="desktop-activity-overlay-loading"]',
                '[data-testid="desktop-activity-overlay-collapsed"]',
                '[data-testid="desktop-activity-overlay-expanded"]',
            ],
            screenshot: '02-overlay-route.png',
            domStructure: '02-overlay-route.structure.yml',
            domAccessibility: '02-overlay-route.a11y.yml',
            notes: ['capture whichever overlay state the runtime exposes after navigation'],
        },
        {
            id: 'overlay_collapsed',
            title: 'Desktop overlay collapsed',
            selectors: ['[data-testid="desktop-activity-overlay-collapsed"]'],
            screenshot: '03-overlay-collapsed.png',
            domStructure: '03-overlay-collapsed.structure.yml',
            domAccessibility: '03-overlay-collapsed.a11y.yml',
            notes: ['capture the interactive collapsed overlay surface when visible'],
        },
        {
            id: 'overlay_expanded',
            title: 'Desktop overlay expanded',
            selectors: ['[data-testid="desktop-activity-overlay-expanded"]'],
            screenshot: '04-overlay-expanded.png',
            domStructure: '04-overlay-expanded.structure.yml',
            domAccessibility: '04-overlay-expanded.a11y.yml',
            notes: ['capture the expanded overlay surface after the collapsed surface expands'],
        },
    ];
}

export function buildTauriActivitySurfacesQaPlan({ env = process.env } = {}) {
    const stackName = String(env.HAPPIER_STACK_STACK ?? '').trim();
    const runtimeState = stackName ? null : null;
    const defaultPort = Number(env.HAPPIER_STACK_TAURI_DEV_PORT ?? 8081);
    const devUrl = `http://127.0.0.1:${readNumber(defaultPort, 8081)}`;
    const trackerPathRaw = readString(env.HAPPIER_TAURI_QA_TRACKER_PATH, defaultTrackerPath);
    const artifactRootRaw = readString(
        env.HAPPIER_TAURI_QA_OUTDIR,
        resolveActivitySurfacesQaArtifactRoot(repoRoot, { date: new Date(), runId: nowStamp() }),
    );

    const trackerPath = isAbsolute(trackerPathRaw) ? trackerPathRaw : join(repoRoot, trackerPathRaw);
    const artifactRoot = isAbsolute(artifactRootRaw) ? artifactRootRaw : join(repoRoot, artifactRootRaw);
    const stepPlan = buildStepPlan();

    return {
        repoRoot,
        packageRoot,
        artifactRoot,
        trackerPath,
        driverSessionPort: readNumber(
            env.HAPPIER_TAURI_MCP_APP_IDENTIFIER ?? env.HAPPIER_TAURI_MCP_PORT ?? env.HAPPIER_TAURI_APP_PORT,
            9225,
        ),
        devUrl,
        runtimeState,
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
        },
        steps: stepPlan,
        manual: [
            'If the settings switch cannot be toggled through MCP, flip the desktop overlay switch once in the real settings screen and rerun.',
            'If the overlay stays hidden after enabling it, confirm the runtime has at least one active session and rerun the capture.',
        ],
    };
}

function buildActivitySurfacesPath(pathname) {
    const path = String(pathname ?? '').trim();
    if (!path.startsWith('/')) {
        throw new Error(`Expected an absolute pathname starting with "/": ${path}`);
    }
    return path;
}

async function navigateWebviewToPath(pathname, { appIdentifier, env }) {
    const path = buildActivitySurfacesPath(pathname);
    const script = `(() => {
        try {
            const origin = window.location && window.location.origin ? window.location.origin : '';
            const next = origin ? origin + ${JSON.stringify(path)} : ${JSON.stringify(path)};
            window.location.href = next;
            return next;
        } catch (error) {
            return { ok: false, error: String(error && error.message ? error.message : error) };
        }
    })()`;

    await runTauriMcpCli(
        ['webview-execute-js', '--script', script, '--app-identifier', String(appIdentifier), '--json'],
        { cwd: packageRoot, env },
    ).catch(() => {});
}

async function waitForAnySelector(step, { appIdentifier, env }) {
    for (const selector of step.selectors) {
        try {
            // eslint-disable-next-line no-await-in-loop
            await runTauriMcpCli(
                [
                    'webview-wait-for',
                    '--type',
                    'selector',
                    '--strategy',
                    'css',
                    '--value',
                    selector,
                    '--timeout',
                    String(selectorWaitMs),
                    '--app-identifier',
                    String(appIdentifier),
                ],
                { cwd: packageRoot, env, timeoutMs: cliSelectorWaitTimeoutMs },
            );
            return selector;
        } catch {
            // try the next selector
        }
    }

    throw new Error(`Unable to find a matching selector for step ${step.id}: ${step.selectors.join(', ')}`);
}

async function isSelectorPresent(selector, { appIdentifier, env, timeoutMs = 1_200 } = {}) {
    try {
        await runTauriMcpCli(
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
            { cwd: packageRoot, env, timeoutMs: Math.max(10_000, timeoutMs + 5_000) },
        );
        return true;
    } catch {
        return false;
    }
}

async function clickSelector(selector, { appIdentifier, env } = {}) {
    const rawSelector = String(selector);
    const normalizedSelector = rawSelector.replace(
        /^\[data-testid="([^"]+)"\]$/u,
        (_match, testId) => `[data-testid='${testId}']`,
    );
    await runTauriMcpCli(
        [
            'webview-wait-for',
            '--type',
            'selector',
            '--strategy',
            'css',
            '--value',
            normalizedSelector,
            '--timeout',
            String(selectorWaitMs),
            '--app-identifier',
            String(appIdentifier),
        ],
        { cwd: packageRoot, env, timeoutMs: cliSelectorWaitTimeoutMs },
    );
    await runTauriMcpCli(
        [
            'webview-interact',
            '--action',
            'click',
            '--selector',
            normalizedSelector,
            '--app-identifier',
            String(appIdentifier),
        ],
        { cwd: packageRoot, env, timeoutMs: cliInteractTimeoutMs },
    );
}

async function withRetries(label, fn, { attempts = 3, delayMs = 250 } = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            // eslint-disable-next-line no-await-in-loop
            return await fn({ attempt });
        } catch (error) {
            lastError = error;
            if (attempt < attempts) {
                // eslint-disable-next-line no-await-in-loop
                await delay(delayMs);
            }
        }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`${label} failed after ${attempts} attempts: ${message}`);
}

async function captureSnapshotArtifacts({ screenshotPath, structurePath, a11yPath, label, appIdentifier, env }) {
    await withRetries(
        `screenshot:${label}`,
        () => runTauriMcpCli(
            [
                'webview-screenshot',
                '--format',
                'png',
                '--file-path',
                screenshotPath,
                '--app-identifier',
                String(appIdentifier),
            ],
            { cwd: packageRoot, env },
        ),
        { attempts: 3, delayMs: 350 },
    );

    const structure = await withRetries(
        `dom-structure:${label}`,
        () => runTauriMcpCli(
            [
                'webview-dom-snapshot',
                '--type',
                'structure',
                '--app-identifier',
                String(appIdentifier),
            ],
            { cwd: packageRoot, env },
        ),
        { attempts: 2, delayMs: 250 },
    );
    await writeTextArtifact(structurePath, String(structure.stdout ?? ''));

    const accessibility = await withRetries(
        `dom-accessibility:${label}`,
        () => runTauriMcpCli(
            [
                'webview-dom-snapshot',
                '--type',
                'accessibility',
                '--app-identifier',
                String(appIdentifier),
            ],
            { cwd: packageRoot, env },
        ),
        { attempts: 2, delayMs: 250 },
    );
    await writeTextArtifact(a11yPath, String(accessibility.stdout ?? ''));

    return {
        screenshotPath,
        structurePath,
        a11yPath,
    };
}

async function captureStep(step, { artifactRoot, appIdentifier, env }) {
    return captureSnapshotArtifacts({
        screenshotPath: join(artifactRoot, step.screenshot),
        structurePath: join(artifactRoot, step.domStructure),
        a11yPath: join(artifactRoot, step.domAccessibility),
        label: step.id,
        appIdentifier,
        env,
    });
}

async function appendWarning(artifactRoot, text) {
    const warningPath = join(artifactRoot, '98-warnings.md');
    await appendTextArtifact(warningPath, `${text.trim()}\n`);
}

async function appendTrackerEvidence({ trackerPath, artifactRoot, stepArtifacts, driverSession, driverSessionStatus, backendState }) {
    const lines = [
        '',
        `- ${new Date().toISOString().slice(0, 10)}: Tauri activity-surfaces QA captured for \`/Users/leeroy/Documents/Development/happier/dev/.project/plans/2026-04-05-activity-surfaces-cross-platform-v2-plan.md\` under \`${artifactRoot.replaceAll('\\', '/')}\`:`,
        `  - driver session: \`${driverSession.replaceAll('\\', '/')}\``,
        ...(driverSessionStatus ? [`  - status: \`${driverSessionStatus.replaceAll('\\', '/')}\``] : []),
        `  - backend state: \`${backendState.replaceAll('\\', '/')}\``,
    ];

    for (const [stepId, artifacts] of Object.entries(stepArtifacts)) {
        lines.push(`  - ${stepId}:`);
        lines.push(`    - screenshot: \`${artifacts.screenshotPath.replaceAll('\\', '/')}\``);
        lines.push(`    - structure: \`${artifacts.structurePath.replaceAll('\\', '/')}\``);
        lines.push(`    - accessibility: \`${artifacts.a11yPath.replaceAll('\\', '/')}\``);
    }

    lines.push('');
    await appendTextArtifact(trackerPath, `${lines.join('\n')}\n`);
}

async function enableDesktopOverlayIfNeeded({ appIdentifier, env, artifactRoot }) {
    try {
        await runTauriMcpCli(
            [
                'webview-execute-js',
                '--script',
                `(() => {
                    try {
                        const row = document.querySelector('[data-testid="settings-desktop-overlay-enabled"]');
                        if (!row) return { ok: false, reason: 'missing-row' };
                        const switchEl = row.querySelector('[role="switch"], input[type="checkbox"], button');
                        if (!switchEl) return { ok: false, reason: 'missing-switch' };
                        const isChecked =
                            switchEl.getAttribute?.('aria-checked') === 'true'
                            || switchEl.checked === true
                            || switchEl.getAttribute?.('data-state') === 'checked';
                        if (!isChecked && typeof switchEl.click === 'function') {
                            switchEl.click();
                            return { ok: true, toggled: true };
                        }
                        return { ok: true, toggled: false };
                    } catch (error) {
                        return { ok: false, error: String(error && error.message ? error.message : error) };
                    }
                })()`,
                '--app-identifier',
                String(appIdentifier),
                '--json',
            ],
            { cwd: packageRoot, env },
        );
    } catch (error) {
        await appendWarning(artifactRoot, `- unable to auto-enable desktop overlay from settings: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function tryParseDriverSessionStatus(response) {
    const raw = readString(response?.text, '');
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
    } catch {
        return null;
    }
}

function resolveAppIdentifierFromDriverStatus(status) {
    const singlePort = Number(status?.port ?? 0);
    if (Number.isFinite(singlePort) && singlePort > 0) {
        return Math.floor(singlePort);
    }
    const defaultPort = Number(status?.defaultPort ?? 0);
    if (Number.isFinite(defaultPort) && defaultPort > 0) {
        return Math.floor(defaultPort);
    }
    const apps = Array.isArray(status?.apps) ? status.apps : [];
    const defaultApp = apps.find((app) => app && app.isDefault === true && Number.isFinite(Number(app.port ?? 0)) && Number(app.port) > 0);
    if (defaultApp) {
        return Math.floor(Number(defaultApp.port));
    }
    const first = apps.find((app) => Number.isFinite(Number(app?.port ?? 0)) && Number(app.port) > 0);
    if (first) {
        return Math.floor(Number(first.port));
    }
    return null;
}

async function startDriverSession(plan) {
    const candidatePorts = resolveCandidateDriverSessionPorts({ preferredPort: plan.driverSessionPort, env: process.env });
    const attemptsFile = join(plan.artifactRoot, '00-driver-session-attempts.jsonl');
    let usedDriverSessionPort = null;
    let driverSessionResponse = null;
    let driverSessionStatusResponse = null;

    for (const candidatePort of candidatePorts) {
        // eslint-disable-next-line no-await-in-loop
        await runTauriMcpCli(['driver-session', 'stop', '--port', String(candidatePort)], {
            cwd: plan.packageRoot,
            env: process.env,
        }).catch(() => {});

        try {
            // eslint-disable-next-line no-await-in-loop
            driverSessionResponse = await runTauriMcpCliJson(['driver-session', 'start', '--port', String(candidatePort)], {
                cwd: plan.packageRoot,
                env: process.env,
            });
            // eslint-disable-next-line no-await-in-loop
            driverSessionStatusResponse = await runTauriMcpCliJson(['driver-session', 'status', '--port', String(candidatePort)], {
                cwd: plan.packageRoot,
                env: process.env,
            });
            const parsed = tryParseDriverSessionStatus(driverSessionStatusResponse);
            const resolved = resolveAppIdentifierFromDriverStatus(parsed);
            if (resolved) {
                usedDriverSessionPort = candidatePort;
                // eslint-disable-next-line no-await-in-loop
                await appendTextArtifact(attemptsFile, `${JSON.stringify({ ok: true, port: candidatePort, appIdentifier: resolved })}\n`);
                break;
            }
            // eslint-disable-next-line no-await-in-loop
            await appendTextArtifact(attemptsFile, `${JSON.stringify({ ok: false, port: candidatePort, reason: 'no-app-identifier' })}\n`);
        } catch (error) {
            // eslint-disable-next-line no-await-in-loop
            await appendTextArtifact(attemptsFile, `${JSON.stringify({
                ok: false,
                port: candidatePort,
                reason: 'error',
                message: error instanceof Error ? error.message : String(error),
            })}\n`);
        }
    }

    if (!usedDriverSessionPort || !driverSessionResponse || !driverSessionStatusResponse) {
        throw new Error(`Unable to resolve a connected Tauri app identifier from driver-session status. Tried ports: ${candidatePorts.join(', ')}`);
    }

    const driverSessionCommand = ['yarn', '-s', 'tauri:mcp:cli', 'driver-session', 'start', '--port', String(usedDriverSessionPort)].join(' ');
    const driverSessionResponseFile = join(plan.artifactRoot, '00-driver-session.json');
    await writeTextArtifact(driverSessionResponseFile, `${JSON.stringify(driverSessionResponse, null, 2)}\n`);

    const driverSessionStatusCommand = ['yarn', '-s', 'tauri:mcp:cli', 'driver-session', 'status', '--port', String(usedDriverSessionPort)].join(' ');
    const driverSessionStatusResponseFile = join(plan.artifactRoot, '00-driver-session-status.json');
    await writeTextArtifact(driverSessionStatusResponseFile, `${JSON.stringify(driverSessionStatusResponse, null, 2)}\n`);

    const parsedStatus = tryParseDriverSessionStatus(driverSessionStatusResponse);
    const resolvedAppIdentifier = resolveAppIdentifierFromDriverStatus(parsedStatus);
    if (!resolvedAppIdentifier) {
        throw new Error('Unable to resolve a connected Tauri app identifier from driver-session status.');
    }

    return {
        resolvedAppIdentifier,
        driverSessionCommand,
        driverSessionResponseFile,
        driverSessionStatusCommand,
        driverSessionStatusResponseFile,
    };
}

async function main(argv = process.argv.slice(2)) {
    const plan = buildTauriActivitySurfacesQaPlan();
    const json = argv.includes('--json');
    const help = argv.includes('--help') || argv.includes('-h');

    if (help) {
        process.stdout.write([
            'Usage: node ./apps/ui/scripts/qa/tauriActivitySurfacesMcpQa.mjs [--json]',
            '',
            'Plan preview:',
            '  --json   Print the deterministic capture plan without driving the app',
            '',
            'Run mode (default):',
            '  - assumes `yarn --cwd apps/ui tauri:qa --serve` or another Tauri dev run is already running',
            '  - opens an MCP driver session',
            '  - captures the desktop overlay settings section and overlay window states',
            '  - appends evidence paths to the activity-surfaces QA tracker',
        ].join('\n') + '\n');
        return;
    }

    if (json) {
        process.stdout.write(JSON.stringify({ ok: true, plan }, null, 2) + '\n');
        return;
    }

    await ensureUiWorkspacePackagesBuilt({ env: process.env });
    await ensureDir(plan.artifactRoot);

    const driverSession = await startDriverSession(plan);
    const backendStateFile = join(plan.artifactRoot, '00-backend-state.json');
    const backendState = await runTauriMcpCli(
        ['ipc-get-backend-state', '--json', '--app-identifier', String(driverSession.resolvedAppIdentifier)],
        { cwd: plan.packageRoot, env: process.env },
    );
    await writeTextArtifact(backendStateFile, String(backendState.stdout ?? ''));

    const stepsById = Object.fromEntries(plan.steps.map((step) => [step.id, step]));
    const stepArtifacts = {};

    async function captureRequired(stepId) {
        const step = stepsById[stepId];
        if (!step) throw new Error(`Unknown step id: ${stepId}`);
        await waitForAnySelector(step, { appIdentifier: driverSession.resolvedAppIdentifier, env: process.env });
        const artifacts = await captureStep(step, {
            artifactRoot: plan.artifactRoot,
            appIdentifier: driverSession.resolvedAppIdentifier,
            env: process.env,
        });
        stepArtifacts[stepId] = artifacts;
        return artifacts;
    }

    async function captureBestEffort(stepId) {
        const step = stepsById[stepId];
        if (!step) throw new Error(`Unknown step id: ${stepId}`);
        try {
            // eslint-disable-next-line no-await-in-loop
            await waitForAnySelector(step, { appIdentifier: driverSession.resolvedAppIdentifier, env: process.env });
        } catch {
            return null;
        }
        const artifacts = await captureStep(step, {
            artifactRoot: plan.artifactRoot,
            appIdentifier: driverSession.resolvedAppIdentifier,
            env: process.env,
        });
        stepArtifacts[stepId] = artifacts;
        return artifacts;
    }

    await navigateWebviewToPath('/settings', {
        appIdentifier: driverSession.resolvedAppIdentifier,
        env: process.env,
    });
    await enableDesktopOverlayIfNeeded({
        appIdentifier: driverSession.resolvedAppIdentifier,
        env: process.env,
        artifactRoot: plan.artifactRoot,
    });
    await captureRequired('settings_overlay');

    await navigateWebviewToPath('/desktop/activity-overlay?desktopOverlayWindow=1', {
        appIdentifier: driverSession.resolvedAppIdentifier,
        env: process.env,
    });
    const overlayRouteArtifacts = await captureBestEffort('overlay_route');
    if (!overlayRouteArtifacts) {
        await appendWarning(plan.artifactRoot, '- overlay route was not visible after navigation; captured the hidden/loading fallback if present');
    }

    if (await isSelectorPresent('[data-testid="desktop-activity-overlay-collapsed"]', {
        appIdentifier: driverSession.resolvedAppIdentifier,
        env: process.env,
    })) {
        try {
            await clickSelector('[data-testid="desktop-activity-overlay-collapsed"]', {
                appIdentifier: driverSession.resolvedAppIdentifier,
                env: process.env,
            });
        } catch (error) {
            await appendWarning(plan.artifactRoot, `- collapsed overlay click failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        // give the runtime a brief beat to publish the expanded state
        await delay(600);
    } else if (!overlayRouteArtifacts) {
        await appendWarning(plan.artifactRoot, '- collapsed overlay surface was not available; expanded capture skipped');
    }

    const collapsedArtifacts = await captureBestEffort('overlay_collapsed');
    if (!collapsedArtifacts) {
        await appendWarning(plan.artifactRoot, '- collapsed overlay surface was not available for capture');
    }

    const expandedArtifacts = await captureBestEffort('overlay_expanded');
    if (!expandedArtifacts) {
        await appendWarning(plan.artifactRoot, '- expanded overlay surface was not available for capture');
    }

    await writeTextArtifact(
        join(plan.artifactRoot, 'manual-steps.md'),
        [
            '# Manual steps',
            '',
            ...plan.manual.map((entry) => `- [manual] ${entry}`),
            '',
        ].join('\n'),
    );

    await appendTrackerEvidence({
        trackerPath: plan.trackerPath,
        artifactRoot: plan.artifactRoot,
        stepArtifacts,
        driverSession: `${driverSession.driverSessionCommand} -> ${driverSession.driverSessionResponseFile}`,
        driverSessionStatus: `${driverSession.driverSessionStatusCommand} -> ${driverSession.driverSessionStatusResponseFile}`,
        backendState: backendStateFile,
    });

    process.stdout.write(
        JSON.stringify(
            {
                ok: true,
                artifactRoot: plan.artifactRoot,
                trackerPath: plan.trackerPath,
                appIdentifier: driverSession.resolvedAppIdentifier,
                steps: Object.keys(stepArtifacts),
            },
            null,
            2,
        ) + '\n',
    );
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && process.argv[1] === currentFilePath) {
    main().catch((error) => {
        process.stderr.write(`[tauri-activity-surfaces-qa] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        process.exit(1);
    });
}
