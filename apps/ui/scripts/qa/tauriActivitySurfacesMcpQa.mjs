#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

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
import {
    analyzeActivitySurfacesPreflightSurface,
    buildActivitySurfacesPreflightPlan,
    classifyActivitySurfacesPreflightSelectors,
    selectorToTestId,
} from './tauriActivitySurfacesPreflight.mjs';
import {
    hasStackOwnedTauriRuntime,
    resolveDefaultDriverSessionPort,
    resolveCandidateDriverSessionPorts,
    startTargetedDriverSession,
    tryParseDriverSessionStatus,
    resolvePreferredAppIdentifierFromDriverStatus,
} from './tauriDriverSessionSelection.mjs';
import { appendTauriQaHmrOptOut } from './tauriQaPathing.mjs';
export { resolveExactDriverSessionTarget } from './tauriDriverSessionSelection.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(dirname(scriptDir));
const repoRoot = dirname(dirname(packageRoot));

const selectorWaitMs = 8_000;
const cliSelectorWaitTimeoutMs = 20_000;
const cliInteractTimeoutMs = 20_000;
const navigationInteractTimeoutMs = 5_000;
const driverSessionRecoveryTimeoutMs = 8_000;
const stackCliCommandTimeoutMs = 120_000;
const authRestorePostSubmitPollAttempts = 12;
const authRestorePostSubmitPollDelayMs = 400;
const authRestoreWelcomeSelector = '[data-testid="welcome-restore"]';
const authRestoreOpenManualSelector = '[data-testid="restore-open-manual"]';
const authRestoreSecretInputSelector = '[data-testid="restore-manual-secret-input"]';
const authRestoreSubmitSelector = '[data-testid="restore-manual-submit"]';
const authCompletionSettingsSelector = '[data-testid="settings-desktop-entry"]';
const activitySurfacesSeedFollowUpMessage = 'Please post a brief status update so the desktop overlay becomes visible.';
const desktopOverlayLocalSettingsStorageKey = 'mmkv.default\\local-settings';
const defaultDesktopOverlayVisibilityMode = 'active_sessions';
const desktopOverlayVisibilityModeLabelByValue = {
    attention_only: 'Attention only',
    active_sessions: 'Active sessions',
    always_when_enabled: 'Always when enabled',
};
const defaultTrackerPath = join(
    repoRoot,
    '.project',
    'plans',
    'todo',
    'activity-surfaces',
    'happier-activity-surfaces-qa-tracking-2026-04-05.md',
);
const execFileAsync = promisify(execFile);

function readString(value, fallback = '') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function normalizeActivitySurfacesSelector(selector) {
    return String(selector).replace(
        /^\[data-testid="([^"]+)"\]$/u,
        (_match, testId) => `[data-testid='${testId}']`,
    );
}

function extractStructuredTextPayload(text) {
    const raw = String(text ?? '').trim();
    if (!raw) {
        return '';
    }

    const [firstChunk = ''] = raw.split(/\n\s*\n/u);
    return firstChunk.trim();
}

function buildPersistDesktopOverlayLocalSettingScript({ settingKey, targetLabel, targetValue }) {
    const serializedSettingKey = JSON.stringify(settingKey);
    const serializedTargetLabel = JSON.stringify(targetLabel);
    const serializedTargetValue = JSON.stringify(targetValue);

    return `(() => {
                    try {
                        const targetLabel = ${serializedTargetLabel};
                        const targetValue = ${serializedTargetValue};
                        const storageKey = ${JSON.stringify(desktopOverlayLocalSettingsStorageKey)};
                        const storage = window.localStorage;
                        if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
                            return { ok: false, reason: 'missing-storage', targetLabel, targetValue };
                        }
                        const raw = storage.getItem(storageKey);
                        const parsed = raw ? JSON.parse(raw) : {};
                        const previousValue = typeof parsed?.[${serializedSettingKey}] !== 'undefined'
                            ? parsed?.[${serializedSettingKey}]
                            : null;
                        const next = { ...(parsed && typeof parsed === 'object' ? parsed : {}) };
                        next[${serializedSettingKey}] = targetValue;
                        const nextRaw = JSON.stringify(next);
                        storage.setItem(storageKey, nextRaw);
                        if (typeof window.dispatchEvent === 'function' && typeof StorageEvent === 'function') {
                            try {
                                window.dispatchEvent(new StorageEvent('storage', {
                                    key: storageKey,
                                    oldValue: raw,
                                    newValue: nextRaw,
                                    storageArea: storage,
                                    url: window.location.href,
                                }));
                            } catch {}
                        }
                        return {
                            ok: true,
                            targetLabel,
                            targetValue,
                            appliedValue: targetValue,
                            previousValue,
                        };
                    } catch (error) {
                        return {
                            ok: false,
                            reason: 'persist-failed',
                            error: String(error && error.message ? error.message : error),
                        };
                    }
                })()`;
}

export function parseSelectorPresenceProbeText(text) {
    const payload = extractStructuredTextPayload(text);
    if (!payload) {
        return [];
    }

    try {
        const parsed = JSON.parse(payload);
        if (Array.isArray(parsed)) {
            return parsed.filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
        }
        if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
            return parseSelectorPresenceProbeText(parsed.text);
        }
        return [];
    } catch {
        return [];
    }
}

function parseStructuredJsonPayload(text) {
    const raw = String(text ?? '').trim();
    if (!raw) {
        return null;
    }

    const candidates = raw
        .split(/\n\s*\n/u)
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .reverse();

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object' && typeof parsed.text === 'string') {
                const nested = parseStructuredJsonPayload(parsed.text);
                if (nested != null) {
                    return nested;
                }
            }
            return parsed;
        } catch {
            // Keep scanning earlier chunks until we find the real JSON envelope.
        }
    }

    return null;
}

export function resolveActivitySurfacesStackCliEnv(env = process.env) {
    const resolvedEnv = { ...env };
    const stackCliHomeDir = readString(resolvedEnv.HAPPIER_STACK_CLI_HOME_DIR);
    if (stackCliHomeDir && !readString(resolvedEnv.HAPPIER_HOME_DIR)) {
        resolvedEnv.HAPPIER_HOME_DIR = stackCliHomeDir;
    }
    const stackName = readString(resolvedEnv.HAPPIER_STACK_STACK);
    if (stackName && !readString(resolvedEnv.HAPPIER_STACK_TAURI_IDENTIFIER)) {
        resolvedEnv.HAPPIER_STACK_TAURI_IDENTIFIER = `com.happier.stack.${stackName}`;
    }
    if (stackCliHomeDir && !readString(resolvedEnv.HAPPIER_STACK_ENV_FILE)) {
        resolvedEnv.HAPPIER_STACK_ENV_FILE = join(dirname(stackCliHomeDir), 'env');
    }
    return resolvedEnv;
}

export function resolveActivitySurfacesMcpCliEnv(env = process.env, appIdentifier = null) {
    const resolvedEnv = resolveActivitySurfacesStackCliEnv(env);
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

async function runRawActivitySurfacesMcpCli(args, { appIdentifier = null, env = process.env, timeoutMs } = {}) {
    return runTauriMcpCli(args, {
        cwd: packageRoot,
        env: resolveActivitySurfacesMcpCliEnv(env, appIdentifier),
        timeoutMs,
    });
}

async function runRawActivitySurfacesMcpCliJson(args, options = {}) {
    return runTauriMcpCliJson(args, {
        cwd: packageRoot,
        env: resolveActivitySurfacesMcpCliEnv(options.env ?? process.env, options.appIdentifier ?? null),
        timeoutMs: options.timeoutMs,
    });
}

async function runActivitySurfacesStackCli(args, { env = process.env, timeoutMs = stackCliCommandTimeoutMs } = {}) {
    return execFileAsync(
        process.execPath,
        [join(repoRoot, 'apps', 'stack', 'scripts', 'happier.mjs'), ...args],
        {
            cwd: repoRoot,
            env: resolveActivitySurfacesStackCliEnv(env),
            encoding: 'utf8',
            timeout: timeoutMs,
            maxBuffer: 20 * 1024 * 1024,
        },
    );
}

async function runActivitySurfacesStackCliJson(args, options = {}) {
    const result = await runActivitySurfacesStackCli([...args, '--json'], options);
    const payload = parseStructuredJsonPayload(String(result.stdout ?? ''));
    if (!payload || typeof payload !== 'object') {
        throw new Error('The stack happier command returned an invalid JSON payload.');
    }
    return payload;
}

export async function captureActivitySurfacesDomSnapshot({
    type,
    appIdentifier,
    selector = null,
    windowId = null,
    env = process.env,
    driverSession = null,
    runCli = runRawActivitySurfacesMcpCli,
    timeoutMs = cliInteractTimeoutMs,
}) {
    const buildArgs = (nextSelector = selector) => buildActivitySurfacesDomSnapshotArgs({
        type,
        appIdentifier,
        selector: nextSelector,
        windowId,
    });

    try {
        const result = await runCli(
            buildArgs(selector),
            {
                appIdentifier,
                env,
                driverSession,
                timeoutMs,
                windowId,
            },
        );
        return result;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? '');
        if (
            type === 'accessibility'
            && selector
            && /No elements found matching selector/i.test(message)
        ) {
            return runCli(
                buildArgs(null),
                {
                    appIdentifier,
                    env,
                    driverSession,
                    timeoutMs,
                    windowId,
                },
            );
        }
        throw error;
    }
}

export async function seedActivitySurfacesOverlaySession({
    strategy = 'active_session',
    env = process.env,
    runCliJson = runActivitySurfacesStackCliJson,
    sessionPath = repoRoot,
    timeoutMs = stackCliCommandTimeoutMs,
} = {}) {
    const stackEnv = resolveActivitySurfacesStackCliEnv(env);
    const createPayload = await runCliJson(
        ['session', 'create', '--path', String(sessionPath)],
        { env: stackEnv, timeoutMs },
    );

    if (!createPayload || typeof createPayload !== 'object' || createPayload.ok !== true || createPayload.kind !== 'session_create') {
        throw new Error('The stack happier session create command did not return a valid session_create envelope.');
    }

    const sessionId = readString(createPayload?.data?.session?.id);
    if (!sessionId) {
        throw new Error('The stack happier session create command returned no session id.');
    }

    let stopPayload = null;
    if (strategy === 'attention_only') {
        stopPayload = await runCliJson(
            ['session', 'stop', sessionId],
            { env: stackEnv, timeoutMs },
        );

        if (!stopPayload || typeof stopPayload !== 'object' || stopPayload.ok !== true || stopPayload.kind !== 'session_stop') {
            throw new Error('The stack happier session stop command did not return a valid session_stop envelope.');
        }
    }

    const sendPayload = await runCliJson(
        [
            'session',
            'send',
            sessionId,
            activitySurfacesSeedFollowUpMessage,
        ],
        { env: stackEnv, timeoutMs },
    );

    if (!sendPayload || typeof sendPayload !== 'object' || sendPayload.ok !== true || sendPayload.kind !== 'session_send') {
        throw new Error('The stack happier session send command did not return a valid session_send envelope.');
    }

    return {
        sessionId,
        createPayload,
        stopPayload,
        sendPayload,
    };
}

function activitySurfacesCommandRequiresDriverSession(args) {
    const command = String(Array.isArray(args) ? args[0] ?? '' : '').trim();
    return command === 'ipc-get-backend-state' || command.startsWith('webview-');
}

function replaceCommandAppIdentifier(args, appIdentifier) {
    if (!Array.isArray(args) || !String(appIdentifier ?? '').trim()) {
        return Array.isArray(args) ? [...args] : [];
    }

    const nextArgs = [...args];
    const flagIndex = nextArgs.findIndex((entry) => entry === '--app-identifier');
    if (flagIndex >= 0 && flagIndex + 1 < nextArgs.length) {
        nextArgs[flagIndex + 1] = String(appIdentifier);
        return nextArgs;
    }

    nextArgs.push('--app-identifier', String(appIdentifier));
    return nextArgs;
}

function replaceCommandWindowId(args, windowId) {
    if (!Array.isArray(args) || !String(windowId ?? '').trim()) {
        return Array.isArray(args) ? [...args] : [];
    }

    const command = String(args[0] ?? '').trim();
    if (!command.startsWith('webview-')) {
        return [...args];
    }

    const nextArgs = [...args];
    const flagIndex = nextArgs.findIndex((entry) => entry === '--window-id');
    if (flagIndex >= 0 && flagIndex + 1 < nextArgs.length) {
        nextArgs[flagIndex + 1] = String(windowId);
        return nextArgs;
    }

    nextArgs.push('--window-id', String(windowId));
    return nextArgs;
}

function isMissingDriverSessionError(error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message.includes('No active session. Call driver_session with action "start" first to connect to a Tauri app.');
}

function isTransientWebviewConnectionError(error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message.includes('Not connected to plugin') || message.includes('reconnection failed');
}

async function ensureActivitySurfacesDriverSession(driverSession, { env = process.env, runCliJson = runRawActivitySurfacesMcpCliJson, forceRestart = false } = {}) {
    const driverSessionPort = Number(driverSession?.driverSessionPort ?? 0);
    const resolvedAppIdentifier = String(driverSession?.resolvedAppIdentifier ?? '').trim();
    if (!Number.isFinite(driverSessionPort) || driverSessionPort <= 0) {
        throw new Error('Expected a positive driverSessionPort for activity-surfaces QA session recovery.');
    }

    if (!forceRestart && resolvedAppIdentifier) {
        return {
            restarted: false,
            resolvedAppIdentifier,
            driverSessionStatusResponse: null,
        };
    }

    async function readStatus() {
        const statusResponse = await runCliJson(
            ['driver-session', 'status', '--port', String(driverSessionPort)],
            { env, timeoutMs: driverSessionRecoveryTimeoutMs },
        );
        const parsedStatus = tryParseDriverSessionStatus(statusResponse);
        return {
            statusResponse,
            resolvedAppIdentifier: resolvePreferredAppIdentifierFromDriverStatus(parsedStatus, driverSessionPort),
        };
    }

    if (!forceRestart) {
        try {
            const status = await readStatus();
            if (status.resolvedAppIdentifier) {
                driverSession.resolvedAppIdentifier = status.resolvedAppIdentifier;
                return {
                    restarted: false,
                    resolvedAppIdentifier: status.resolvedAppIdentifier,
                    driverSessionStatusResponse: status.statusResponse,
                };
            }
        } catch {
            // Fall through to a restart attempt.
        }
    }

    const driverSessionResponse = await runCliJson(
        ['driver-session', 'start', '--port', String(driverSessionPort)],
        { env, timeoutMs: driverSessionRecoveryTimeoutMs },
    );
    const status = await readStatus();
    if (!status.resolvedAppIdentifier) {
        throw new Error(`Unable to resolve a connected Tauri app identifier from driver-session status on port ${driverSessionPort}.`);
    }

    driverSession.resolvedAppIdentifier = status.resolvedAppIdentifier;
    return {
        restarted: true,
        resolvedAppIdentifier: status.resolvedAppIdentifier,
        driverSessionResponse,
        driverSessionStatusResponse: status.statusResponse,
    };
}

export async function runActivitySurfacesMcpCli(args, { appIdentifier = null, env = process.env, timeoutMs, driverSession = null, windowId = null, runCli = runRawActivitySurfacesMcpCli, runCliJson = runRawActivitySurfacesMcpCliJson } = {}) {
    const requiresDriverSession = driverSession && activitySurfacesCommandRequiresDriverSession(args);
    let effectiveAppIdentifier = appIdentifier;
    let effectiveArgs = Array.isArray(args) ? [...args] : [];

    if (requiresDriverSession) {
        const ensuredSession = await ensureActivitySurfacesDriverSession(driverSession, {
            env,
            runCliJson,
        });
        effectiveAppIdentifier = ensuredSession.resolvedAppIdentifier;
        effectiveArgs = replaceCommandAppIdentifier(effectiveArgs, effectiveAppIdentifier);
    }

    effectiveArgs = replaceCommandWindowId(effectiveArgs, windowId);

    try {
        return await runCli(effectiveArgs, {
            appIdentifier: effectiveAppIdentifier,
            driverSession,
            env,
            timeoutMs,
        });
    } catch (error) {
        if (!requiresDriverSession || !isMissingDriverSessionError(error)) {
            throw error;
        }

        const recoveredSession = await ensureActivitySurfacesDriverSession(driverSession, {
            env,
            runCliJson,
            forceRestart: true,
        });
        effectiveAppIdentifier = recoveredSession.resolvedAppIdentifier;
        effectiveArgs = replaceCommandAppIdentifier(args, effectiveAppIdentifier);
        effectiveArgs = replaceCommandWindowId(effectiveArgs, windowId);
        return runCli(effectiveArgs, {
            appIdentifier: effectiveAppIdentifier,
            driverSession,
            env,
            timeoutMs,
        });
    }
}

async function runActivitySurfacesMcpCliJson(args, options = {}) {
    return runActivitySurfacesMcpCli([...args, '--json'], options).then((result) =>
        JSON.parse(String(result.stdout ?? '').trim() || '{}'),
    );
}

export function buildActivitySurfacesDomSnapshotArgs({ type, appIdentifier, selector = null, windowId = null }) {
    const args = [
        'webview-dom-snapshot',
        '--type',
        String(type),
        '--app-identifier',
        String(appIdentifier),
    ];
    if (String(windowId ?? '').trim()) {
        args.push('--window-id', String(windowId));
    }
    if (String(selector ?? '').trim()) {
        args.push('--selector', String(selector), '--strategy', 'css');
    }
    return args;
}

function resolveActivitySurfacesQaArtifactRoot(rootDir, { date = new Date(), runId = nowStamp(date) } = {}) {
    return join(rootDir, '.project', 'logs', 'activity-surfaces-qa', `tauri-activity-surfaces-${todayStamp(date)}-${runId}`);
}

function buildStepPlan() {
    return [
        {
            id: 'settings_overlay',
            title: 'Settings / desktop overlay',
            windowId: 'main',
            selectors: [
                '[data-testid="settings-desktop-overlay-enabled"]',
            ],
            snapshotSelector: '[data-testid="settings-desktop-overlay-enabled"]',
            screenshot: '01-settings-overlay.png',
            domStructure: '01-settings-overlay.structure.yml',
            domAccessibility: '01-settings-overlay.a11y.yml',
            notes: ['capture the desktop overlay settings section inside the real settings screen'],
        },
        {
            id: 'overlay_route',
            title: 'Desktop overlay route',
            windowId: 'activity_overlay',
            selectors: [
                '[data-testid="desktop-activity-overlay-collapsed"]',
            ],
            screenshot: '02-overlay-route.png',
            domStructure: '02-overlay-route.structure.yml',
            domAccessibility: '02-overlay-route.a11y.yml',
            notes: ['capture the visible collapsed overlay state after navigation'],
        },
        {
            id: 'overlay_collapsed',
            title: 'Desktop overlay collapsed',
            windowId: 'activity_overlay',
            selectors: ['[data-testid="desktop-activity-overlay-collapsed"]'],
            screenshot: '03-overlay-collapsed.png',
            domStructure: '03-overlay-collapsed.structure.yml',
            domAccessibility: '03-overlay-collapsed.a11y.yml',
            notes: ['capture the interactive collapsed overlay surface when visible'],
        },
        {
            id: 'overlay_expanded',
            title: 'Desktop overlay expanded',
            windowId: 'activity_overlay',
            selectors: ['[data-testid="desktop-activity-overlay-expanded"]'],
            screenshot: '04-overlay-expanded.png',
            domStructure: '04-overlay-expanded.structure.yml',
            domAccessibility: '04-overlay-expanded.a11y.yml',
            notes: ['capture the expanded overlay surface after the collapsed surface expands'],
        },
    ];
}

async function capturePreflightStructureSnapshot({ appIdentifier, env, driverSession = null, selector, windowId = 'main' }) {
    const structure = await runActivitySurfacesMcpCli(
        buildActivitySurfacesDomSnapshotArgs({
            type: 'structure',
            appIdentifier,
            selector,
            windowId,
        }),
        { appIdentifier, env, driverSession, windowId },
    );
    return String(structure.stdout ?? '');
}

export async function probeActivitySurfacesPreflightSurface({
    appIdentifier,
    env,
    driverSession = null,
    windowId = 'main',
    plan,
    triedSelectors = new Set(),
    isSelectorVisible = isSelectorPresent,
    captureStructureSnapshot = capturePreflightStructureSnapshot,
}) {
    const selectors = [
        ...plan.settingsSelectors,
        ...plan.onboardingSelectors,
        ...plan.actionSelectors,
        ...plan.authSelectors,
        ...plan.setupSelectors,
        ...(plan.setupActionSelectors ?? []),
    ].filter(Boolean);
    const presentSelectors = new Set();

    try {
        const probeResponse = await runActivitySurfacesMcpCli(
            [
                'webview-execute-js',
                '--script',
                `(() => {
                    const selectors = ${JSON.stringify(selectors)};
                    return selectors.filter((selector) => {
                        try {
                            return document.querySelector(selector) !== null;
                        } catch {
                            return false;
                        }
                    });
                })()`,
                '--app-identifier',
                String(appIdentifier),
                '--json',
            ],
            {
                appIdentifier,
                driverSession,
                env,
                windowId,
                timeoutMs: cliInteractTimeoutMs,
            },
        );

        for (const selector of parseSelectorPresenceProbeText(String(probeResponse.stdout ?? ''))) {
            presentSelectors.add(selector);
        }
    } catch {
        // Fall through to the slower visibility probes if JS execution fails.
    }

    if (presentSelectors.size === 0) {
        const fallbackSelectors = [
            ...plan.settingsSelectors,
            plan.authSelectors[0],
            plan.setupSelectors[0],
            plan.setupActionSelectors?.[0],
            ...plan.onboardingSelectors.slice(0, 2),
        ].filter(Boolean);

        for (const selector of fallbackSelectors) {
            // eslint-disable-next-line no-await-in-loop
            if (await isSelectorVisible(selector, {
                appIdentifier,
                driverSession,
                env,
                windowId,
                timeoutMs: plan.probeSelectorTimeoutMs,
            })) {
                presentSelectors.add(selector);
            }
        }

        if (plan.onboardingSelectors.some((selector) => presentSelectors.has(selector))) {
            const onboardingRootSelector = plan.onboardingSelectors.find((selector) => presentSelectors.has(selector));
            if (onboardingRootSelector) {
                try {
                    const structureText = await captureStructureSnapshot({
                        appIdentifier,
                        driverSession,
                        env,
                        windowId,
                        selector: onboardingRootSelector,
                    });
                    const analysis = analyzeActivitySurfacesPreflightSurface(structureText, plan, {
                        triedSelectors,
                    });
                    if (analysis.kind !== 'navigate') {
                        return analysis;
                    }
                } catch {
                    // Fall through to the root-selector classification below.
                }
            }
        }
    }

    return classifyActivitySurfacesPreflightSelectors(presentSelectors, plan, { triedSelectors });
}

export async function ensureActivitySurfacesSettingsShellReady({
    appIdentifier,
    env,
    artifactRoot,
    preflightPlan,
    driverSession = null,
    probeSurface = probeActivitySurfacesPreflightSurface,
    navigateWebview = navigateWebviewToPath,
    click = clickSelector,
    restoreAuth = restoreActivitySurfacesAuthWithDevKey,
    appendWarning: appendWarningArtifact = appendWarning,
    wait = delay,
}) {
    const plan = preflightPlan ?? buildActivitySurfacesPreflightPlan();
    const triedSelectors = new Set();
    let attemptedAuthRestore = false;
    const primarySettingsSelector = plan.settingsSelectors[0] ?? '[data-testid="settings-desktop-overlay-enabled"]';

    for (let attempt = 1; attempt <= plan.maxAttempts; attempt += 1) {
        await navigateWebview(plan.settingsPath ?? '/settings', {
            appIdentifier,
            env,
            driverSession,
            windowId: 'main',
        });
        await wait(plan.settleDelayMs);

        let surface;
        try {
            surface = await probeSurface({
                appIdentifier,
                driverSession,
                env,
                windowId: 'main',
                plan,
                triedSelectors,
            });
        } catch (error) {
            throw error;
        }
        if (surface.kind === 'ready') {
            return { ok: true, attempts: attempt };
        }
        if (surface.kind === 'blocked') {
            if (surface.blocker === 'auth' && !attemptedAuthRestore) {
                attemptedAuthRestore = true;
                const restored = await restoreAuth({
                    appIdentifier,
                    env,
                    artifactRoot,
                    driverSession,
                    windowId: 'main',
                });
                if (restored) {
                    await wait(plan.settleDelayMs);
                    continue;
                }
            }
            await appendWarningArtifact(artifactRoot, `- settings preflight blocked (${surface.blocker}): ${surface.message}`);
            throw new Error(surface.message);
        }
        if (surface.kind === 'navigate') {
            continue;
        }

        try {
            await click(surface.selector, { appIdentifier, env, driverSession, windowId: 'main' });
            triedSelectors.add(surface.selector);
        } catch (error) {
            if (!isTransientWebviewConnectionError(error)) {
                await appendWarningArtifact(
                    artifactRoot,
                    `- onboarding preflight click failed for ${surface.selector}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        await wait(plan.settleDelayMs);
    }

    const finalSurface = await probeSurface({
        appIdentifier,
        driverSession,
        env,
        windowId: 'main',
        plan,
    });
    if (finalSurface.kind === 'ready') {
        return { ok: true, attempts: plan.maxAttempts };
    }
    if (finalSurface.kind === 'blocked') {
        throw new Error(finalSurface.message);
    }

    throw new Error(
        [
            'Unable to reach the settings shell before activity-surfaces capture.',
            `The primary settings selector (${selectorToTestId(primarySettingsSelector)}) was not visible after ${plan.maxAttempts} attempts.`,
            'If the app is redirecting to auth or setup, complete that prerequisite once and rerun the activity-surfaces QA capture.',
        ].join(' '),
    );
}

export async function openActivitySurfacesDesktopAppSettingsPage({
    appIdentifier,
    env,
    artifactRoot,
    driverSession = null,
    windowId = 'main',
    navigateWebview = navigateWebviewToPath,
    click = clickSelector,
    isSelectorVisible = isSelectorPresent,
    appendWarning: appendWarningArtifact = appendWarning,
    wait = delay,
} = {}) {
    const desktopPageSelector = '[data-testid="settings-desktop-overlay-enabled"]';
    const desktopEntrySelector = '[data-testid="settings-desktop-entry"]';

    if (await isSelectorVisible(desktopPageSelector, {
        appIdentifier,
        env,
        driverSession,
        windowId,
        timeoutMs: 1_000,
    })) {
        return true;
    }

    if (await isSelectorVisible(desktopEntrySelector, {
        appIdentifier,
        env,
        driverSession,
        windowId,
        timeoutMs: 1_000,
    })) {
        try {
            await click(desktopEntrySelector, {
                appIdentifier,
                env,
                driverSession,
                windowId,
            });
        } catch (error) {
            if (artifactRoot) {
                await appendWarningArtifact(
                    artifactRoot,
                    `- unable to open the dedicated desktop app settings page from the settings entry: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        await wait(500);
        if (await isSelectorVisible(desktopPageSelector, {
            appIdentifier,
            env,
            driverSession,
            windowId,
            timeoutMs: 1_000,
        })) {
            return true;
        }
    }

    await navigateWebview('/settings/desktop', {
        appIdentifier,
        env,
        driverSession,
        windowId,
    });
    await wait(500);

    if (await isSelectorVisible(desktopPageSelector, {
        appIdentifier,
        env,
        driverSession,
        windowId,
        timeoutMs: 1_000,
    })) {
        return true;
    }

    if (artifactRoot) {
        await appendWarningArtifact(
            artifactRoot,
            '- unable to confirm the dedicated desktop app settings page after navigating from settings',
        );
    }
    return false;
}

export function buildTauriActivitySurfacesQaPlan({ env = process.env } = {}) {
    const trackerPathRaw = readString(env.HAPPIER_TAURI_QA_TRACKER_PATH, defaultTrackerPath);
    const artifactRootRaw = readString(
        env.HAPPIER_TAURI_QA_OUTDIR,
        resolveActivitySurfacesQaArtifactRoot(repoRoot, { date: new Date(), runId: nowStamp() }),
    );

    const trackerPath = isAbsolute(trackerPathRaw) ? trackerPathRaw : join(repoRoot, trackerPathRaw);
    const artifactRoot = isAbsolute(artifactRootRaw) ? artifactRootRaw : join(repoRoot, artifactRootRaw);
    const stepPlan = buildStepPlan();
    const preflight = buildActivitySurfacesPreflightPlan();

    return {
        repoRoot,
        packageRoot,
        artifactRoot,
        trackerPath,
        driverSessionPort: resolveDefaultDriverSessionPort({ env }),
        timeouts: {
            selectorWaitMs,
            cliSelectorWaitTimeoutMs,
            cliInteractTimeoutMs,
        },
        preflight,
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
            'If protected-route navigation keeps redirecting back to `/`, sign in first or seed a post-auth state before rerunning this QA capture.',
            'If the app lands on the post-auth setup wizard, complete or dismiss it once before rerunning this QA capture.',
            'If the settings switch cannot be toggled through MCP, flip the desktop overlay switch once in the real settings screen and rerun.',
            'If the overlay stays hidden after enabling it, confirm the runtime has at least one active session and rerun the capture.',
        ],
    };
}

export function buildActivitySurfacesPath(pathname) {
    return appendTauriQaHmrOptOut(pathname);
}

export function buildActivitySurfacesNavigationScript(pathname) {
    const path = buildActivitySurfacesPath(pathname);
    return `(() => {
        try {
            const origin = window.location && window.location.origin ? window.location.origin : '';
            const next = origin ? origin + ${JSON.stringify(path)} : ${JSON.stringify(path)};
            const current = window.location && window.location.href ? window.location.href : '';
            if (current === next) {
                return { ok: true, unchanged: true, currentHref: current, nextHref: next };
            }
            const nextUrl = new URL(next, origin || window.location.href);
            const nextPath = nextUrl.pathname + nextUrl.search + nextUrl.hash;
            window.history.pushState({}, '', nextPath);
            window.dispatchEvent(new PopStateEvent('popstate'));
            return { ok: true, changed: true, currentHref: current, nextHref: next };
        } catch (error) {
            return { ok: false, error: String(error && error.message ? error.message : error) };
        }
    })()`;
}

export async function navigateWebviewToPath(
    pathname,
    {
        appIdentifier,
        env,
        driverSession = null,
        windowId = null,
        runCli = runActivitySurfacesMcpCli,
    } = {},
) {
    const script = buildActivitySurfacesNavigationScript(pathname);

    await runCli(
        ['webview-execute-js', '--script', script, '--app-identifier', String(appIdentifier), '--json'],
        { appIdentifier, env, driverSession, windowId, timeoutMs: navigationInteractTimeoutMs },
    ).catch(() => {});
}

async function waitForAnySelector(step, { appIdentifier, env, driverSession = null, windowId = null }) {
    for (const selector of step.selectors) {
        try {
            // eslint-disable-next-line no-await-in-loop
            await runActivitySurfacesMcpCli(
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
                { appIdentifier, env, driverSession, windowId, timeoutMs: cliSelectorWaitTimeoutMs },
            );
            return selector;
        } catch {
            // try the next selector
        }
    }

    throw new Error(`Unable to find a matching selector for step ${step.id}: ${step.selectors.join(', ')}`);
}

async function isSelectorPresent(selector, { appIdentifier, env, driverSession = null, windowId = null, timeoutMs = 1_200 } = {}) {
    try {
        await runActivitySurfacesMcpCli(
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
            { appIdentifier, env, driverSession, windowId, timeoutMs: Math.max(10_000, timeoutMs + 5_000) },
        );
        return true;
    } catch {
        return false;
    }
}

async function clickSelector(selector, { appIdentifier, env, driverSession = null, windowId = null } = {}) {
    return clickActivitySurfacesSelector(selector, { appIdentifier, env, driverSession, windowId });
}

export async function clickActivitySurfacesSelector(
    selector,
    {
        appIdentifier,
        env,
        driverSession = null,
        windowId = null,
        runCli = runActivitySurfacesMcpCli,
    } = {},
) {
    const normalizedSelector = normalizeActivitySurfacesSelector(selector);
    await runCli(
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
        { appIdentifier, env, driverSession, windowId, timeoutMs: cliSelectorWaitTimeoutMs },
    );
    await runCli(
        [
            'webview-execute-js',
            '--script',
            `(() => {
                const selector = ${JSON.stringify(normalizedSelector)};
                const element = document.querySelector(selector);
                if (!element) {
                    return { ok: false, reason: 'missing-element', selector };
                }
                if (typeof element.click === 'function') {
                    element.click();
                    return { ok: true, selector };
                }
                return { ok: false, reason: 'missing-click', selector };
            })()`,
            '--app-identifier',
            String(appIdentifier),
            '--json',
        ],
        { appIdentifier, env, driverSession, windowId, timeoutMs: cliInteractTimeoutMs },
    );
}

async function typeSelectorText(selector, text, { appIdentifier, env, driverSession = null, windowId = null, runCli = runActivitySurfacesMcpCli } = {}) {
    const normalizedSelector = normalizeActivitySurfacesSelector(selector);
    await runCli(
        [
            'webview-execute-js',
            '--script',
            `(() => {
            const selector = ${JSON.stringify(normalizedSelector)};
            const text = ${JSON.stringify(String(text))};
            const element = document.querySelector(selector);
            if (!element) {
                return { ok: false, reason: 'missing-element', selector };
            }
            const prototypes = [window.HTMLInputElement?.prototype, window.HTMLTextAreaElement?.prototype].filter(Boolean);
            let setter = null;
            for (const proto of prototypes) {
                const candidate = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (typeof candidate === 'function') {
                    setter = candidate;
                    break;
                }
            }
            if (setter) {
                setter.call(element, text);
            } else {
                element.value = text;
            }
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, selector, length: text.length };
        })()`,
            '--app-identifier',
            String(appIdentifier),
            '--json',
        ],
        { appIdentifier, env, driverSession, windowId, timeoutMs: cliInteractTimeoutMs },
    );
}

export async function typeActivitySurfacesSelectorText(selector, text, options = {}) {
    return typeSelectorText(selector, text, options);
}

async function readStackDevAuthKeyFromHstack({ env = process.env } = {}) {
    const { stdout } = await execFileAsync(
        process.execPath,
        [join(repoRoot, 'bin', 'hstack.mjs'), 'auth', 'dev-key', '--json'],
        {
            cwd: repoRoot,
            env: { ...env },
            encoding: 'utf8',
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
        },
    );

    const payload = parseStructuredJsonPayload(String(stdout ?? ''));
    if (!payload || typeof payload !== 'object') {
        throw new Error('The stack dev-key command returned an invalid JSON payload.');
    }
    if (payload.ok === false && payload.error === 'missing_dev_key') {
        return null;
    }

    const secret = readString(payload.key);
    if (!secret) {
        throw new Error('The stack dev-key command returned no restore key.');
    }
    return secret;
}

export async function resolveActivitySurfacesRestoreSecretKey({
    env = process.env,
    readStackDevAuthKey = readStackDevAuthKeyFromHstack,
} = {}) {
    const explicitSecret = readString(
        env.HAPPIER_TAURI_QA_RESTORE_SECRET_KEY
            ?? env.HAPPIER_STACK_DEV_AUTH_SECRET_KEY,
    );
    if (explicitSecret) {
        return explicitSecret;
    }
    if (!hasStackOwnedTauriRuntime(env)) {
        return null;
    }
    return readStackDevAuthKey({ env });
}

export async function waitForActivitySurfacesAuthCompletion({
    appIdentifier,
    env,
    driverSession = null,
    windowId = 'main',
    isSelectorVisible = isSelectorPresent,
    wait = delay,
    runCli = runActivitySurfacesMcpCli,
} = {}) {
    let consecutiveAuthFreePolls = 0;

    for (let attempt = 1; attempt <= authRestorePostSubmitPollAttempts; attempt += 1) {
        let settled = false;
        let resolvedFromPayload = false;
        try {
            // eslint-disable-next-line no-await-in-loop
            const response = await runCli(
                [
                    'webview-execute-js',
                    '--script',
                    `(() => ({
                        pathname: window.location?.pathname ?? '',
                        hasWelcomeRestore: document.querySelector(${JSON.stringify(authRestoreWelcomeSelector)}) !== null,
                        hasRestoreOpenManual: document.querySelector(${JSON.stringify(authRestoreOpenManualSelector)}) !== null,
                        hasRestoreManualInput: document.querySelector(${JSON.stringify(authRestoreSecretInputSelector)}) !== null,
                        hasSettingsShell: document.querySelector(${JSON.stringify(authCompletionSettingsSelector)}) !== null,
                        hasSetupWizard: document.querySelector('[data-testid="setupWizard.surface"]') !== null
                    }))()`,
                    '--app-identifier',
                    String(appIdentifier),
                    '--json',
                ],
                { appIdentifier, env, driverSession, windowId, timeoutMs: cliInteractTimeoutMs },
            );
            const payload = parseStructuredJsonPayload(String(response.stdout ?? ''));
            if (payload && typeof payload === 'object') {
                resolvedFromPayload = true;
                const pathname = String(payload.pathname ?? '');
                const authSurfacesCleared = (
                    payload.hasWelcomeRestore !== true
                    && payload.hasRestoreOpenManual !== true
                    && payload.hasRestoreManualInput !== true
                    && !pathname.endsWith('/restore/manual')
                );

                if (payload.hasSettingsShell === true || payload.hasSetupWizard === true) {
                    return true;
                }

                if (authSurfacesCleared) {
                    consecutiveAuthFreePolls += 1;
                } else {
                    consecutiveAuthFreePolls = 0;
                }

                settled = consecutiveAuthFreePolls >= 2;
            }
        } catch {
            // Fall through to slower selector probes below.
        }

        if (!resolvedFromPayload) {
            const welcomeVisible = await isSelectorVisible(authRestoreWelcomeSelector, {
                appIdentifier,
                env,
                driverSession,
                windowId,
                timeoutMs: 800,
            });
            const openManualVisible = await isSelectorVisible(authRestoreOpenManualSelector, {
                appIdentifier,
                env,
                driverSession,
                windowId,
                timeoutMs: 800,
            });
            const manualVisible = await isSelectorVisible(authRestoreSecretInputSelector, {
                appIdentifier,
                env,
                driverSession,
                windowId,
                timeoutMs: 800,
            });
            const settingsVisible = await isSelectorVisible(authCompletionSettingsSelector, {
                appIdentifier,
                env,
                driverSession,
                windowId,
                timeoutMs: 800,
            });
            const setupVisible = await isSelectorVisible('[data-testid="setupWizard.surface"]', {
                appIdentifier,
                env,
                driverSession,
                timeoutMs: 800,
            });

            if (settingsVisible || setupVisible) {
                return true;
            }

            if (!welcomeVisible && !openManualVisible && !manualVisible) {
                consecutiveAuthFreePolls += 1;
            } else {
                consecutiveAuthFreePolls = 0;
            }
            settled = consecutiveAuthFreePolls >= 2;
        }

        if (settled) {
            return true;
        }
        if (attempt < authRestorePostSubmitPollAttempts) {
            // eslint-disable-next-line no-await-in-loop
            await wait(authRestorePostSubmitPollDelayMs);
        }
    }
    return false;
}

async function submitActivitySurfacesRestoreSecret(secret, {
    appIdentifier,
    env,
    driverSession = null,
    windowId = null,
    typeText = typeSelectorText,
    runCli = runActivitySurfacesMcpCli,
} = {}) {
    await typeText(authRestoreSecretInputSelector, secret, { appIdentifier, env, driverSession, windowId, runCli });
    await runCli(
        [
            'webview-execute-js',
            '--script',
            `(() => {
                const selector = ${JSON.stringify(authRestoreSubmitSelector)};
                const submit = document.querySelector(selector);
                if (!submit) {
                    return { ok: false, reason: 'missing-submit', selector };
                }
                if (typeof submit.click === 'function') {
                    submit.click();
                    return { ok: true, selector };
                }
                return { ok: false, reason: 'missing-click', selector };
            })()`,
            '--app-identifier',
            String(appIdentifier),
            '--json',
        ],
        { appIdentifier, env, driverSession, windowId, timeoutMs: cliInteractTimeoutMs },
    );
}

export async function restoreActivitySurfacesAuthWithDevKey({
    appIdentifier,
    env,
    artifactRoot,
    driverSession = null,
    windowId = 'main',
    navigateWebview = navigateWebviewToPath,
    click = clickSelector,
    typeText = typeSelectorText,
    submitRestoreSecret = submitActivitySurfacesRestoreSecret,
    isSelectorVisible = isSelectorPresent,
    wait = delay,
    waitForAuthCompletion = waitForActivitySurfacesAuthCompletion,
    appendWarning: appendWarningArtifact = appendWarning,
    resolveRestoreSecret = resolveActivitySurfacesRestoreSecretKey,
} = {}) {
    async function waitForVisibleSelector(selector, { attempts = 6, delayMs = 350, timeoutMs = 2_500 } = {}) {
        const totalAttempts = Math.max(1, Math.floor(attempts));
        const pollDelayMs = Math.max(0, Math.floor(delayMs));

        for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop
            if (await isSelectorVisible(selector, {
                appIdentifier,
                env,
                driverSession,
                windowId,
                timeoutMs,
            })) {
                return true;
            }

            if (attempt < totalAttempts && pollDelayMs > 0) {
                // eslint-disable-next-line no-await-in-loop
                await wait(pollDelayMs);
            }
        }

        return false;
    }

    let restoreSecret = '';
    try {
        restoreSecret = String(await resolveRestoreSecret({ env })).trim();
    } catch (error) {
        await appendWarningArtifact(
            artifactRoot,
            `- activity-surfaces QA could not restore auth automatically because restore-secret resolution failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
    }
    if (!restoreSecret) {
        await appendWarningArtifact(
            artifactRoot,
            '- activity-surfaces QA could not restore auth automatically because no restore secret was available for the current stack runtime',
        );
        return false;
    }

    let manualInputVisible = false;

    manualInputVisible = await waitForVisibleSelector(authRestoreSecretInputSelector, {
        attempts: 1,
        timeoutMs: 1_200,
    });
    if (!manualInputVisible) {
        const welcomeVisible = await waitForVisibleSelector(authRestoreWelcomeSelector);
        if (welcomeVisible) {
            await click(authRestoreWelcomeSelector, { appIdentifier, env, driverSession, windowId });
        } else {
            const manualEntryVisible = await waitForVisibleSelector(authRestoreOpenManualSelector);
            if (!manualEntryVisible) {
                return false;
            }
            await click(authRestoreOpenManualSelector, { appIdentifier, env, driverSession, windowId });
        }
        manualInputVisible = await waitForVisibleSelector(authRestoreSecretInputSelector, {
            attempts: 10,
            delayMs: 500,
            timeoutMs: 5_000,
        });
    }

    if (!manualInputVisible) {
        await appendWarningArtifact(artifactRoot, '- activity-surfaces QA opened restore/manual but could not find the secret-key input');
        return false;
    }

    await submitRestoreSecret(restoreSecret, {
        appIdentifier,
        env,
        driverSession,
        windowId,
    });

    if (await waitForAuthCompletion({
        appIdentifier,
        env,
        driverSession,
        windowId,
        isSelectorVisible,
        wait,
    })) {
        return true;
    }

    await navigateWebview('/settings', {
        appIdentifier,
        env,
        driverSession,
        windowId,
    });

    if (await waitForAuthCompletion({
        appIdentifier,
        env,
        driverSession,
        windowId,
        isSelectorVisible,
        wait,
    })) {
        return true;
    }

    await appendWarningArtifact(artifactRoot, '- activity-surfaces QA submitted the restore/manual form but the auth welcome surface remained visible');
    return false;
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

async function captureSnapshotArtifacts({ screenshotPath, structurePath, a11yPath, label, appIdentifier, env, driverSession = null, windowId = null, snapshotSelector = null }) {
    await withRetries(
        `screenshot:${label}`,
        () => runActivitySurfacesMcpCli(
            [
                'webview-screenshot',
                '--format',
                'png',
                '--file-path',
                screenshotPath,
                '--app-identifier',
                String(appIdentifier),
            ],
            { appIdentifier, env, driverSession, windowId },
        ),
        { attempts: 3, delayMs: 350 },
    );

    const structure = await withRetries(
        `dom-structure:${label}`,
        () => captureActivitySurfacesDomSnapshot({
            type: 'structure',
            appIdentifier,
            selector: snapshotSelector,
            windowId,
            env,
            driverSession,
            runCli: runActivitySurfacesMcpCli,
        }),
        { attempts: 2, delayMs: 250 },
    );
    await writeTextArtifact(structurePath, String(structure.stdout ?? ''));

    const accessibility = await withRetries(
        `dom-accessibility:${label}`,
        () => captureActivitySurfacesDomSnapshot({
            type: 'accessibility',
            appIdentifier,
            selector: snapshotSelector,
            windowId,
            env,
            driverSession,
            runCli: runActivitySurfacesMcpCli,
        }),
        { attempts: 2, delayMs: 250 },
    );
    await writeTextArtifact(a11yPath, String(accessibility.stdout ?? ''));

    return {
        screenshotPath,
        structurePath,
        a11yPath,
    };
}

async function captureStep(step, { artifactRoot, appIdentifier, env, driverSession = null, matchedSelector = null, windowId = null }) {
    return captureSnapshotArtifacts({
        screenshotPath: join(artifactRoot, step.screenshot),
        structurePath: join(artifactRoot, step.domStructure),
        a11yPath: join(artifactRoot, step.domAccessibility),
        label: step.id,
        appIdentifier,
        env,
        driverSession,
        windowId: windowId ?? step.windowId ?? null,
        snapshotSelector: step.snapshotSelector ?? matchedSelector,
    });
}

async function appendWarning(artifactRoot, text) {
    const warningPath = join(artifactRoot, '98-warnings.md');
    await appendTextArtifact(warningPath, `${text.trim()}\n`);
}

async function appendTrackerEvidence({ trackerPath, artifactRoot, stepArtifacts, driverSession, driverSessionStatus, backendState, seededSessionPath = null }) {
    const lines = [
        '',
        `- ${new Date().toISOString().slice(0, 10)}: Tauri activity-surfaces QA captured for \`/Users/leeroy/Documents/Development/happier/dev/.project/plans/2026-04-05-activity-surfaces-cross-platform-v2-plan.md\` under \`${artifactRoot.replaceAll('\\', '/')}\`:`,
        `  - driver session: \`${driverSession.replaceAll('\\', '/')}\``,
        ...(driverSessionStatus ? [`  - status: \`${driverSessionStatus.replaceAll('\\', '/')}\``] : []),
        `  - backend state: \`${backendState.replaceAll('\\', '/')}\``,
        ...(seededSessionPath ? [`  - seeded session: \`${seededSessionPath.replaceAll('\\', '/')}\``] : []),
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

export async function enableDesktopOverlayIfNeeded({
    appIdentifier,
    env,
    artifactRoot,
    driverSession = null,
    windowId = null,
    runCli = runActivitySurfacesMcpCli,
}) {
    const response = await runCli(
        [
            'webview-execute-js',
            '--script',
            buildPersistDesktopOverlayLocalSettingScript({
                settingKey: 'desktopOverlayEnabled',
                targetLabel: 'Enabled',
                targetValue: true,
            }),
            '--app-identifier',
            String(appIdentifier),
            '--json',
        ],
        { appIdentifier, env, driverSession, windowId },
    );
    const payload = parseStructuredJsonPayload(String(response.stdout ?? ''));
    if (!payload || typeof payload !== 'object' || payload.ok !== true) {
        const reason = typeof payload?.reason === 'string' && payload.reason.trim()
            ? ` Reason: ${payload.reason.trim()}.`
            : '';
        const error = new Error(`Unable to enable desktop overlay.${reason}`);
        if (artifactRoot) {
            await appendWarning(artifactRoot, `- unable to auto-enable desktop overlay from settings: ${error.message}`);
        }
        throw error;
    }
    await delay(250);
}

export async function enableDesktopOverlayVisibilityMode({
    appIdentifier,
    env,
    artifactRoot,
    driverSession = null,
    visibilityMode = defaultDesktopOverlayVisibilityMode,
    windowId = null,
    runCli = runActivitySurfacesMcpCli,
} = {}) {
    const label = desktopOverlayVisibilityModeLabelByValue[visibilityMode];
    if (!label) {
        throw new Error(`Unsupported desktop overlay visibility mode: ${String(visibilityMode)}`);
    }

    try {
        const response = await runCli(
            [
                'webview-execute-js',
                '--script',
                buildPersistDesktopOverlayLocalSettingScript({
                    settingKey: 'desktopOverlayVisibilityMode',
                    targetLabel: label,
                    targetValue: visibilityMode,
                }),
                '--app-identifier',
                String(appIdentifier),
                '--json',
            ],
            { appIdentifier, env, driverSession, windowId },
        );
        const payload = parseStructuredJsonPayload(String(response.stdout ?? ''));
        if (!payload || typeof payload !== 'object' || payload.ok !== true) {
            const reason = typeof payload?.reason === 'string' && payload.reason.trim()
                ? ` Reason: ${payload.reason.trim()}.`
                : '';
            throw new Error(`Unable to set desktop overlay visibility mode to ${visibilityMode}.${reason}`);
        }
        return payload.targetValue === visibilityMode && payload.appliedValue === visibilityMode;
    } catch (error) {
        if (artifactRoot) {
            await appendWarning(
                artifactRoot,
                `- unable to set desktop overlay visibility mode to ${visibilityMode}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        throw error;
    }
}

export async function runActivitySurfacesDesktopOverlayCaptureLane({
    appIdentifier,
    driverSession,
    env,
    artifactRoot,
    captureRequired,
    navigateToPath = navigateWebviewToPath,
    openDesktopAppSettingsPage = openActivitySurfacesDesktopAppSettingsPage,
    enableDesktopOverlay = enableDesktopOverlayIfNeeded,
    enableDesktopOverlayVisibility = enableDesktopOverlayVisibilityMode,
    clickCollapsedOverlay = clickSelector,
    appendWarning: appendWarningArtifact = appendWarning,
    wait = delay,
    visibilityMode = defaultDesktopOverlayVisibilityMode,
    postSettingsDelayMs = 500,
    postOverlayToggleDelayMs = 500,
    postEnableDelayMs = 750,
    postCollapseDelayMs = 600,
}) {
    await navigateToPath('/settings', {
        appIdentifier,
        driverSession,
        env,
        windowId: 'main',
    });
    await wait(postSettingsDelayMs);

    const desktopAppSettingsReady = await openDesktopAppSettingsPage({
        appIdentifier,
        driverSession,
        env,
        artifactRoot,
    });
    if (!desktopAppSettingsReady) {
        throw new Error('Unable to open the dedicated desktop app settings page before overlay capture.');
    }

    const settingsArtifacts = await captureRequired('settings_overlay');

    await enableDesktopOverlay({
        appIdentifier,
        driverSession,
        env,
        artifactRoot,
        windowId: 'main',
    });

    await wait(postOverlayToggleDelayMs);

    const overlayVisibilityEnabled = await enableDesktopOverlayVisibility({
        appIdentifier,
        driverSession,
        env,
        artifactRoot,
        visibilityMode,
        windowId: 'main',
    });

    if (overlayVisibilityEnabled !== true) {
        const message = `desktop overlay visibility mode could not be switched to ${visibilityMode}; overlay capture may remain hidden`;
        await appendWarningArtifact(artifactRoot, `- ${message}`);
        throw new Error(message);
    }

    await wait(postEnableDelayMs);

    await navigateToPath('/desktop/activity-overlay?desktopOverlayWindow=1', {
        appIdentifier,
        driverSession,
        env,
        windowId: 'activity_overlay',
    });
    const overlayRouteArtifacts = await captureRequired('overlay_route');
    const collapsedArtifacts = await captureRequired('overlay_collapsed');

    await clickCollapsedOverlay('[data-testid="desktop-activity-overlay-collapsed"]', {
        appIdentifier,
        driverSession,
        env,
        windowId: 'activity_overlay',
    });

    await wait(postCollapseDelayMs);
    const expandedArtifacts = await captureRequired('overlay_expanded');

    return {
        settingsArtifacts,
        overlayRouteArtifacts,
        collapsedArtifacts,
        expandedArtifacts,
        overlayVisibilityEnabled,
    };
}

async function startDriverSession(plan) {
    const candidatePorts = resolveCandidateDriverSessionPorts({ preferredPort: plan.driverSessionPort, env: process.env });
    const attemptsFile = join(plan.artifactRoot, '00-driver-session-attempts.jsonl');
    const driverSessionResult = await startTargetedDriverSession({
        candidatePorts,
        runCliJson: (args) => runTauriMcpCliJson(args, {
            cwd: plan.packageRoot,
            env: process.env,
        }),
        appendAttempt: async (payload) => {
            await appendTextArtifact(attemptsFile, `${JSON.stringify(payload)}\n`);
        },
    });

    const driverSessionCommand = ['yarn', '-s', 'tauri:mcp:cli', 'driver-session', 'start', '--port', String(driverSessionResult.driverSessionPort)].join(' ');
    const driverSessionResponseFile = join(plan.artifactRoot, '00-driver-session.json');
    await writeTextArtifact(driverSessionResponseFile, `${JSON.stringify(driverSessionResult.driverSessionResponse, null, 2)}\n`);

    const driverSessionStatusCommand = ['yarn', '-s', 'tauri:mcp:cli', 'driver-session', 'status', '--port', String(driverSessionResult.driverSessionPort)].join(' ');
    const driverSessionStatusResponseFile = join(plan.artifactRoot, '00-driver-session-status.json');
    await writeTextArtifact(driverSessionStatusResponseFile, `${JSON.stringify(driverSessionResult.driverSessionStatusResponse, null, 2)}\n`);

    return {
        driverSessionPort: driverSessionResult.driverSessionPort,
        resolvedAppIdentifier: driverSessionResult.resolvedAppIdentifier,
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
    const backendState = await runActivitySurfacesMcpCli(
        ['ipc-get-backend-state', '--json', '--app-identifier', String(driverSession.resolvedAppIdentifier)],
        { appIdentifier: driverSession.resolvedAppIdentifier, driverSession, env: process.env },
    );
    await writeTextArtifact(backendStateFile, String(backendState.stdout ?? ''));

    const stepsById = Object.fromEntries(plan.steps.map((step) => [step.id, step]));
    const stepArtifacts = {};

    await ensureActivitySurfacesSettingsShellReady({
        appIdentifier: driverSession.resolvedAppIdentifier,
        driverSession,
        env: process.env,
        artifactRoot: plan.artifactRoot,
        preflightPlan: plan.preflight,
    });

    const seededSession = await seedActivitySurfacesOverlaySession({
        env: process.env,
    });
    const seededSessionFile = join(plan.artifactRoot, '00-seeded-session.json');
    await writeTextArtifact(
        seededSessionFile,
        `${JSON.stringify(seededSession, null, 2)}\n`,
    );

    async function captureRequired(stepId) {
        const step = stepsById[stepId];
        if (!step) throw new Error(`Unknown step id: ${stepId}`);
        const matchedSelector = await waitForAnySelector(step, {
            appIdentifier: driverSession.resolvedAppIdentifier,
            driverSession,
            env: process.env,
            windowId: step.windowId,
        });
        const artifacts = await captureStep(step, {
            artifactRoot: plan.artifactRoot,
            appIdentifier: driverSession.resolvedAppIdentifier,
            driverSession,
            env: process.env,
            matchedSelector,
            windowId: step.windowId,
        });
        stepArtifacts[stepId] = artifacts;
        return artifacts;
    }

    const overlayCapture = await runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: driverSession.resolvedAppIdentifier,
        driverSession,
        env: process.env,
        artifactRoot: plan.artifactRoot,
        visibilityMode: defaultDesktopOverlayVisibilityMode,
        captureRequired,
    });

    const { settingsArtifacts, overlayRouteArtifacts, collapsedArtifacts, expandedArtifacts, overlayVisibilityEnabled } = overlayCapture;
    stepArtifacts.settings_overlay = settingsArtifacts;
    stepArtifacts.overlay_route = overlayRouteArtifacts;
    stepArtifacts.overlay_collapsed = collapsedArtifacts;
    stepArtifacts.overlay_expanded = expandedArtifacts;

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
        seededSessionPath: seededSessionFile,
    });

    process.stdout.write(
        JSON.stringify(
            {
                ok: true,
                artifactRoot: plan.artifactRoot,
                trackerPath: plan.trackerPath,
                appIdentifier: driverSession.resolvedAppIdentifier,
                seededSessionId: seededSession.sessionId,
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
