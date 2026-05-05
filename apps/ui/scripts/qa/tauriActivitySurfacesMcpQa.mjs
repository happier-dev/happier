#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { ensureUiWorkspacePackagesBuilt } from '../ensureWorkspacePackagesBuilt.mjs';
import {
    appendTextArtifact,
    ensureDir,
    throwIfTauriMcpCliError,
    nowStamp,
    runTauriMcpCli,
    runTauriMcpCliJson,
    todayStamp,
    writeTextArtifact,
} from './tauriMcpCli.mjs';
import { summarizeQaStepArtifactsProof } from './tauriQaProofSummary.mjs';
import {
    analyzeActivitySurfacesPreflightRootText,
    analyzeActivitySurfacesPreflightSurface,
    buildActivitySurfacesPreflightPlan,
    classifyActivitySurfacesPreflightSelectors,
    selectorToTestId,
} from './tauriActivitySurfacesPreflight.mjs';
import {
    hasStackOwnedTauriRuntime,
    resolveDefaultDriverSessionPort,
    resolveCandidateDriverSessionPorts,
    resolvePreferredStackTauriIdentifier,
    resolveStackNameFromStackOwnedTauriIdentifier,
    startTargetedDriverSession,
    tryParseDriverSessionStatus,
    resolvePreferredAppIdentifierFromDriverStatus,
} from './tauriDriverSessionSelection.mjs';
import { appendTauriQaHmrOptOut } from './tauriQaPathing.mjs';
import { resolveStackCredentialPaths } from '../../../stack/scripts/utils/auth/credentials_paths.mjs';
import {
    desktopActivityOverlayQaCardSeedIds,
    normalizeDesktopActivityOverlayCardKindForTestID,
    resolveDesktopActivityOverlayCardSelectorByKind,
    resolveDesktopActivityOverlaySurfaceSelector,
} from '../../sources/activity/adapters/desktop/ui/shared/desktopActivityOverlaySelectors.mjs';
export { resolveExactDriverSessionTarget } from './tauriDriverSessionSelection.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(dirname(scriptDir));
const repoRoot = dirname(dirname(packageRoot));

const selectorWaitMs = 8_000;
const cliSelectorWaitTimeoutMs = 20_000;
const cliInteractTimeoutMs = 20_000;
const selectorClickRetryAttempts = 3;
const selectorClickRetryDelayMs = 250;
const selectorPresenceCliMinimumTimeoutMs = 3_000;
const selectorPresenceCliGraceMs = 1_500;
const seededSessionPathProbeTimeoutMs = 2_000;
const navigationInteractTimeoutMs = 5_000;
const driverSessionRecoveryTimeoutMs = 20_000;
const initialDriverSessionTimeoutMs = 20_000;
const stackCliCommandTimeoutMs = 120_000;
// The overlay webview reconciles native state every 250ms; proof-state captures need to
// wait beyond that interval so screenshots and DOM snapshots observe the same seeded card.
const overlayExpandedCaptureStabilizationDelayMs = 350;
const overlayWindowDiagnosticTimeoutMs = 1_500;
const authRestorePostSubmitPollAttempts = 12;
const authRestorePostSubmitPollDelayMs = 400;
const domQueryFallbackProbeTimeoutMs = 1_200;
const overlayProofDomReadinessAttempts = 4;
const overlayProofDomReadinessDelayMs = 250;
const authRestoreWelcomeSelector = '[data-testid="welcome-restore"]';
const authWelcomeShellSelector = '[data-testid="onboarding-wizard-welcome-auth"]';
const authWelcomeSkipSelector = '[data-testid="onboarding-wizard-skip"]';
const authRestoreOpenManualSelector = '[data-testid="restore-open-manual"]';
const authRestoreSecretInputSelector = '[data-testid="restore-manual-secret-input"]';
const authRestoreSubmitSelector = '[data-testid="restore-manual-submit"]';
const authCompletionSettingsSelector = '[data-testid="settings-desktop-entry"]';
const appCrashRestartSelector = '[data-testid="app-crash-restart"]';
const relaySpecificOnboardingSelectors = [
    '[data-testid="onboarding-wizard-relay-diagram"]',
    '[data-testid="onboarding-wizard-relay:cloud"]',
    '[data-testid="onboarding-wizard-relay:thisComputer"]',
    '[data-testid="onboarding-wizard-relay:remoteComputer"]',
    '[data-testid="onboarding-wizard-relay:customUrl"]',
    '[data-testid="onboarding-wizard-relay-host-local-checklist-row-installRelayRuntime"]',
    '[data-testid="onboarding-wizard-relay-host-local-checklist-row-startRelayRuntime"]',
];
const activitySurfacesSeedFollowUpMessage = 'Please post a brief status update so the desktop overlay becomes visible.';
const canonicalActivitySurfacesRequiredProofStepIds = [
    'settings_overlay',
    'overlay_route',
    'overlay_collapsed',
    'overlay_expanded',
    'overlay_floating_fallback',
    'overlay_floating_expanded',
    'overlay_idle',
    'overlay_permission_request',
    'overlay_user_question',
    'overlay_quota_summary',
    'overlay_multi_session_list',
    'overlay_completion_state',
];
const canonicalActivitySurfacesOptionalOverlayCardStepIds = [];
const desktopOverlayLocalSettingsStorageKey = 'mmkv.default\\local-settings';
const defaultDesktopOverlayVisibilityMode = 'active_sessions';
const desktopOverlayVisibilityModeLabelByValue = {
    attention_only: 'Attention only',
    active_sessions: 'Active sessions',
    always_when_enabled: 'Always when enabled',
};
const desktopOverlayPresentationModeLabelByValue = {
    automatic: 'Automatic',
    notch_integrated: 'Notch-integrated',
    floating_overlay: 'Floating overlay',
};
const premiumFinalizationPlanPath = join(
    repoRoot,
    '.project',
    'plans',
    '2026-04-07-activity-surfaces-premium-finalization-plan.md',
);
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

function resolveActivitySurfacesQaCaptureFixture(env = process.env) {
    const fixture = readString(env?.HAPPIER_TAURI_ACTIVITY_SURFACES_QA_CAPTURE_FIXTURE);
    if (fixture !== 'incomplete-proof') {
        return null;
    }

    return {
        ok: false,
        blocker: 'missing_required_step_artifacts',
        steps: [],
    };
}

function normalizeStorageScope(raw) {
    const text = readString(raw);
    if (!text) {
        return '';
    }
    return text.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').slice(0, 64);
}

function buildScopedWebStorageKey(baseKey, storageScope) {
    const normalizedScope = normalizeStorageScope(storageScope);
    return normalizedScope ? `${baseKey}__${normalizedScope}` : baseKey;
}

function buildServerScopedAuthStorageKey(scopeToken, storageScope) {
    const normalizedScopeToken = readString(scopeToken);
    if (!normalizedScopeToken) {
        return '';
    }
    return buildScopedWebStorageKey(`auth_credentials__srv_${normalizedScopeToken}`, storageScope);
}

function deriveScopeTokenFromAccessKeyPath(accessKeyPath) {
    const path = readString(accessKeyPath);
    if (!path) {
        return '';
    }
    const match = path.match(/[\\/]servers[\\/]+([^\\/]+)[\\/]access\.key$/u);
    return readString(match?.[1]);
}

function deriveHostPortScopeToken(serverUrl) {
    const rawUrl = readString(serverUrl);
    if (!rawUrl) {
        return '';
    }
    try {
        const parsed = new URL(rawUrl);
        const hostname = ['127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) ? 'localhost' : parsed.hostname.toLowerCase();
        const port = parsed.port ? `-${parsed.port}` : '';
        return `${hostname}${port}`.replace(/[^a-z0-9._-]/g, '_').replace(/_+/g, '_');
    } catch {
        return '';
    }
}

function isStackBootAuthCredentials(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const record = value;
    if (typeof record.token !== 'string' || record.token.trim().length === 0) {
        return false;
    }
    if (typeof record.secret === 'string' && record.secret.trim().length > 0) {
        return true;
    }
    if (!record.encryption || typeof record.encryption !== 'object') {
        return false;
    }
    return (
        typeof record.encryption.publicKey === 'string'
        && record.encryption.publicKey.trim().length > 0
        && typeof record.encryption.machineKey === 'string'
        && record.encryption.machineKey.trim().length > 0
    );
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

    return `(async () => {
                    try {
                        const targetLabel = ${serializedTargetLabel};
                        const targetValue = ${serializedTargetValue};
                        const mcp = window.__MCP__;
                        if (mcp && typeof mcp.applyHappierLocalSettings === 'function') {
                            const bridgeResult = await mcp.applyHappierLocalSettings({
                                [${serializedSettingKey}]: targetValue,
                            });
                            if (bridgeResult && typeof bridgeResult === 'object' && bridgeResult.ok === true) {
                                return {
                                    ok: true,
                                    targetLabel,
                                    targetValue,
                                    appliedValue: targetValue,
                                    previousValue: null,
                                    via: 'mcp-bridge',
                                    bridgeResult,
                                };
                            }
                        }
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
                            via: 'local-storage',
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

function parseStructuredJsonCandidate(candidate) {
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
        return null;
    }
}

export function parseStructuredJsonPayload(text) {
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
        const parsed = parseStructuredJsonCandidate(candidate);
        if (parsed != null) {
            return parsed;
        }

        const lineCandidates = candidate
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter(Boolean)
            .reverse();
        for (const lineCandidate of lineCandidates) {
            const parsedLine = parseStructuredJsonCandidate(lineCandidate);
            if (parsedLine != null) {
                return parsedLine;
            }
        }
    }

    return null;
}

function parseBooleanFromCommandOutput(text) {
    const parsed = parseStructuredJsonPayload(text);
    if (typeof parsed === 'boolean') {
        return parsed;
    }

    if (typeof parsed === 'string') {
        const normalized = parsed.trim().toLowerCase();
        if (normalized === 'true') {
            return true;
        }
        if (normalized === 'false') {
            return false;
        }
        const nested = parseStructuredJsonPayload(parsed);
        if (typeof nested === 'boolean') {
            return nested;
        }
    }

    if (parsed && typeof parsed === 'object') {
        for (const key of ['ok', 'result', 'value', 'visible', 'present']) {
            if (typeof parsed[key] === 'boolean') {
                return parsed[key];
            }
        }
    }

    const normalizedRaw = extractStructuredTextPayload(text).trim().toLowerCase();
    return normalizedRaw === 'true';
}

export async function readActivitySurfacesBackendStateWithRetries({
    appIdentifier,
    env,
    driverSession = null,
    attempts = 3,
    delayMs = 750,
    runCli = runActivitySurfacesMcpCli,
    runProbeCli = runRawActivitySurfacesMcpCli,
    recoverDriverSession = async (session, options = {}) => ensureActivitySurfacesDriverSession(session, {
        env,
        runCliJson: runRawActivitySurfacesMcpCliJson,
        ...options,
    }),
    probeProofChannel = async () => {
        const probeEnv = { ...(env && typeof env === 'object' ? env : {}) };
        const driverSessionPort = Number(driverSession?.driverSessionPort ?? 0);
        if (Number.isFinite(driverSessionPort) && driverSessionPort > 0) {
            probeEnv.HAPPIER_TAURI_MCP_PORT = String(driverSessionPort);
        }
        const response = await runProbeCli(
            [
                'webview-execute-js',
                '--script',
                '(() => true)()',
                '--app-identifier',
                String(appIdentifier),
                '--json',
            ],
            {
                appIdentifier,
                env: probeEnv,
                timeoutMs: 2_000,
            },
        );
        throwIfTauriMcpCliError(response);
    },
    wait = delay,
} = {}) {
    const normalizedAttempts = Math.max(1, Number(attempts) || 1);
    const normalizedDelayMs = Math.max(0, Number(delayMs) || 0);
    let lastError = null;
    let lastResponse = null;
    let sawTransientProofChannelDisconnect = false;
    let recoveredDriverSession = false;

    for (let attempt = 1; attempt <= normalizedAttempts; attempt += 1) {
        try {
            const response = await runCli(
                ['ipc-get-backend-state', '--json', '--app-identifier', String(appIdentifier)],
                { appIdentifier, driverSession, env },
            );
            lastResponse = response;
            throwIfTauriMcpCliError(response);
            return {
                ok: true,
                response,
                error: null,
            };
        } catch (error) {
            lastError = error;
            sawTransientProofChannelDisconnect = sawTransientProofChannelDisconnect || isTransientWebviewConnectionError(error);
        }

        if (attempt < normalizedAttempts) {
            // eslint-disable-next-line no-await-in-loop
            await wait(normalizedDelayMs);
        }
    }

    const result = {
        ok: false,
        response: lastResponse,
        error: lastError instanceof Error ? lastError.message : String(lastError ?? 'backend state unavailable'),
    };
    if (!sawTransientProofChannelDisconnect && result.error.includes('Failed to get backend state')) {
        try {
            await probeProofChannel();
        } catch (error) {
            sawTransientProofChannelDisconnect = isTransientWebviewConnectionError(error);
        }
    }
    if (sawTransientProofChannelDisconnect && driverSession && !recoveredDriverSession) {
        try {
            await recoverDriverSession(driverSession, { forceRestart: true });
            const response = await runCli(
                ['ipc-get-backend-state', '--json', '--app-identifier', String(appIdentifier)],
                { appIdentifier, driverSession, env },
            );
            throwIfTauriMcpCliError(response);
            return {
                ok: true,
                response,
                error: null,
                recoveredDriverSession: true,
            };
        } catch (error) {
            recoveredDriverSession = true;
            lastError = error;
            if (error && typeof error === 'object' && 'stdout' in error) {
                lastResponse = {
                    stdout: String(error.stdout ?? ''),
                    stderr: String(error.stderr ?? ''),
                };
            }
            result.response = lastResponse;
            result.error = lastError instanceof Error ? lastError.message : String(lastError ?? result.error);
        }
    }
    if (sawTransientProofChannelDisconnect) {
        result.blocker = 'proof_channel_disconnect';
    }
    return result;
}

function isActivitySurfacesBlankRootStructureSnapshot(structureText) {
    const lines = String(structureText ?? '')
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0);

    if (lines.length !== 2) {
        return false;
    }

    return lines[0].startsWith('- body ')
        && /(^|\s)div#root(\s|$)/u.test(lines[1]);
}

export async function probeActivitySurfacesRootState({
    appIdentifier,
    env,
    driverSession = null,
    windowId = 'main',
    timeoutMs = cliInteractTimeoutMs,
    runCli = runActivitySurfacesMcpCli,
} = {}) {
    try {
        const response = await runCli(
            [
                'webview-execute-js',
                '--script',
                `(() => ({
                    pathname: window.location?.pathname ?? '',
                    rootText: document.body?.innerText ?? '',
                    visibleTestIds: Array.from(document.querySelectorAll('[data-testid]'))
                        .map((node) => node.getAttribute('data-testid'))
                        .filter((value) => typeof value === 'string' && value.trim().length > 0)
                }))()`,
                '--app-identifier',
                String(appIdentifier),
                '--json',
            ],
            {
                appIdentifier,
                driverSession,
                env,
                windowId,
                timeoutMs,
            },
        );
        const payload = parseStructuredJsonPayload(String(response.stdout ?? ''));
        return payload && typeof payload === 'object' ? payload : null;
    } catch {
        return null;
    }
}

export function resolveActivitySurfacesStackCliEnv(env = process.env) {
    const resolvedEnv = { ...env };
    const stackCliHomeDir = readString(resolvedEnv.HAPPIER_STACK_CLI_HOME_DIR);
    if (stackCliHomeDir && !readString(resolvedEnv.HAPPIER_HOME_DIR)) {
        resolvedEnv.HAPPIER_HOME_DIR = stackCliHomeDir;
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

export async function runActivitySurfacesStackCli(
    args,
    {
        env = process.env,
        timeoutMs = stackCliCommandTimeoutMs,
        execFileImpl = execFileAsync,
    } = {},
) {
    const resolvedEnv = resolveActivitySurfacesStackCliEnv(env);
    const stackName = readString(resolvedEnv.HAPPIER_STACK_STACK);
    const invocationArgs = stackName
        ? [join(repoRoot, 'apps', 'stack', 'scripts', 'stack.mjs'), 'happier', stackName, '--', ...args]
        : [join(repoRoot, 'apps', 'stack', 'scripts', 'happier.mjs'), ...args];
    return execFileImpl(
        process.execPath,
        invocationArgs,
        {
            cwd: repoRoot,
            env: resolvedEnv,
            encoding: 'utf8',
            timeout: timeoutMs,
            maxBuffer: 20 * 1024 * 1024,
        },
    );
}

async function runActivitySurfacesStackControlCli(args, { env = process.env, timeoutMs = stackCliCommandTimeoutMs } = {}) {
    return execFileAsync(
        process.execPath,
        [join(repoRoot, 'bin', 'hstack.mjs'), ...args],
        {
            cwd: repoRoot,
            env: resolveActivitySurfacesStackCliEnv(env),
            encoding: 'utf8',
            timeout: timeoutMs,
            maxBuffer: 20 * 1024 * 1024,
        },
    );
}

async function runActivitySurfacesStackAuthStatus({
    env = process.env,
    stackName = '',
    runStackControlCli = runActivitySurfacesStackControlCli,
} = {}) {
    const normalizedStackName = readString(stackName);
    if (!normalizedStackName) {
        throw new Error('Expected a stack name before reading stack auth status for activity-surfaces QA.');
    }
    const result = await runStackControlCli(
        ['stack', 'auth', normalizedStackName, 'status', '--json'],
        { env },
    );
    const payload = parseStructuredJsonPayload(String(result.stdout ?? ''));
    if (!payload || typeof payload !== 'object') {
        throw new Error('The stack auth status command returned an invalid JSON payload.');
    }
    return payload;
}

async function runActivitySurfacesStackCliJson(args, options = {}) {
    const result = await runActivitySurfacesStackCli([...args, '--json'], options);
    const payload = parseStructuredJsonPayload(String(result.stdout ?? ''));
    if (!payload || typeof payload !== 'object') {
        throw new Error('The stack happier command returned an invalid JSON payload.');
    }
    return payload;
}

function isMissingActivitySurfacesStackDaemonError(error) {
    const pieces = [
        error instanceof Error ? error.message : String(error ?? ''),
        error && typeof error === 'object' && 'stdout' in error ? String(error.stdout ?? '') : '',
        error && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '') : '',
    ];
    return pieces.some((piece) => piece.includes('No daemon running, no state file found'));
}

function isMissingActivitySurfacesStackError(error) {
    const pieces = [
        error instanceof Error ? error.message : String(error ?? ''),
        error && typeof error === 'object' && 'stdout' in error ? String(error.stdout ?? '') : '',
        error && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '') : '',
    ];
    return pieces.some((piece) => /stack\s+"[^"]+"\s+does not exist yet/i.test(piece));
}

function isRejectedActivitySurfacesDirectCliAuthError(error) {
    const pieces = [
        error instanceof Error ? error.message : String(error ?? ''),
        error && typeof error === 'object' && 'stdout' in error ? String(error.stdout ?? '') : '',
        error && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '') : '',
    ];
    return pieces.some((piece) => piece.includes('daemon credentials were rejected by the server (401)'));
}

function hasActivitySurfacesSeedServerUrl(env = process.env) {
    return Boolean(
        readString(env?.HAPPIER_TAURI_WEB_RUNTIME_SERVER_URL)
        || readString(env?.HAPPIER_SERVER_URL),
    );
}

function hasActivitySurfacesStackCliRuntimeContext(env = process.env) {
    return Boolean(
        readString(env?.HAPPIER_STACK_CLI_HOME_DIR)
        || readString(env?.HAPPIER_STACK_ENV_FILE),
    );
}

function resolveActivitySurfacesSessionSeedMode(env = process.env) {
    if (!hasActivitySurfacesSeedServerUrl(env)) {
        return 'stack';
    }

    const runtimeServerContext = readString(env?.HAPPIER_TAURI_WEB_RUNTIME_SERVER_CONTEXT)
        || readString(env?.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT);
    if (!hasActivitySurfacesStackCliRuntimeContext(env)) {
        return runtimeServerContext === 'stack' ? 'stack' : 'direct';
    }
    return runtimeServerContext === 'stack' ? 'stack' : 'direct';
}

function resolveActivitySurfacesDirectCliEnv(env = process.env) {
    const resolvedEnv = resolveActivitySurfacesStackCliEnv(env);
    delete resolvedEnv.HAPPIER_STACK_STACK;
    delete resolvedEnv.HAPPIER_SOCKET_TRANSPORTS;
    resolvedEnv.HAPPIER_SOCKET_FORCE_WEBSOCKET = '1';
    return resolvedEnv;
}

function isActivitySurfacesCliAuthCredentials(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const token = readString(value.token);
    if (!token) {
        return false;
    }
    if (readString(value.secret)) {
        return true;
    }
    const encryption = value.encryption;
    return Boolean(
        encryption
        && typeof encryption === 'object'
        && !Array.isArray(encryption)
        && readString(encryption.publicKey)
        && readString(encryption.machineKey),
    );
}

function normalizeActivitySurfacesCliBase64(value) {
    const text = readString(value);
    if (!text || !/^[A-Za-z0-9+/=_-]+$/u.test(text)) {
        return text;
    }

    try {
        const decoded = Buffer.from(text, text.includes('-') || text.includes('_') ? 'base64url' : 'base64');
        if (decoded.length === 0 && text.length > 0) {
            return text;
        }

        const normalized = decoded.toString('base64');
        const comparableInput = text.replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');
        const comparableNormalized = normalized.replace(/=+$/u, '').replace(/\+/gu, '-').replace(/\//gu, '_');
        return comparableInput === comparableNormalized ? normalized : text;
    } catch {
        return text;
    }
}

function normalizeActivitySurfacesCliAuthCredentialsForCli(value) {
    if (!isActivitySurfacesCliAuthCredentials(value)) {
        return null;
    }

    const token = readString(value.token);
    const secret = readString(value.secret);
    if (secret) {
        return {
            token,
            secret: normalizeActivitySurfacesCliBase64(secret),
        };
    }

    return {
        token,
        encryption: {
            publicKey: normalizeActivitySurfacesCliBase64(value.encryption.publicKey),
            machineKey: normalizeActivitySurfacesCliBase64(value.encryption.machineKey),
        },
    };
}

function buildReadActivitySurfacesAuthCredentialsScript() {
    return `(() => {
        try {
            const storage = window.localStorage;
            const session = window.sessionStorage;
            if (!storage || typeof storage.getItem !== 'function') {
                return { ok: false, reason: 'missing-storage' };
            }

            const activeServerId = String(session?.getItem?.('activeServerId') ?? '').trim();
            const preferredKeys = [];
            if (activeServerId) {
                preferredKeys.push(\`auth_credentials__srv_\${activeServerId}\`);
            }
            preferredKeys.push('auth_credentials');

            const seen = new Set();
            const orderedKeys = [];
            for (const key of preferredKeys) {
                if (typeof key === 'string' && key && !seen.has(key)) {
                    seen.add(key);
                    orderedKeys.push(key);
                }
            }
            for (let index = 0; index < storage.length; index += 1) {
                const key = storage.key(index);
                if (typeof key === 'string' && key.startsWith('auth_credentials') && !seen.has(key)) {
                    seen.add(key);
                    orderedKeys.push(key);
                }
            }

            for (const key of orderedKeys) {
                const raw = storage.getItem(key);
                if (!raw) {
                    continue;
                }
                try {
                    const parsed = JSON.parse(raw);
                    if (
                        parsed
                        && typeof parsed === 'object'
                        && typeof parsed.token === 'string'
                        && parsed.token.trim()
                        && (
                            (typeof parsed.secret === 'string' && parsed.secret.trim())
                            || (
                                parsed.encryption
                                && typeof parsed.encryption === 'object'
                                && typeof parsed.encryption.publicKey === 'string'
                                && parsed.encryption.publicKey.trim()
                                && typeof parsed.encryption.machineKey === 'string'
                                && parsed.encryption.machineKey.trim()
                            )
                        )
                    ) {
                        return {
                            ok: true,
                            activeServerId,
                            sourceKey: key,
                            credentials: parsed,
                        };
                    }
                } catch {
                    // ignore malformed entries and keep scanning
                }
            }

            return {
                ok: false,
                reason: 'missing-auth-credentials',
                activeServerId,
                scannedKeys: orderedKeys,
            };
        } catch (error) {
            return {
                ok: false,
                reason: 'read-failed',
                error: String(error && error.message ? error.message : error),
            };
        }
    })()`;
}

async function readActivitySurfacesAuthCredentialsFromWebview({
    appIdentifier,
    env = process.env,
    driverSession = null,
    windowId = 'main',
    runCli = runActivitySurfacesMcpCli,
} = {}) {
    const response = await runCli(
        [
            'webview-execute-js',
            '--script',
            buildReadActivitySurfacesAuthCredentialsScript(),
            '--app-identifier',
            String(appIdentifier),
            '--json',
        ],
        { appIdentifier, env, driverSession, windowId, timeoutMs: cliInteractTimeoutMs },
    );
    const payload = parseStructuredJsonPayload(String(response.stdout ?? ''));
    if (!payload || typeof payload !== 'object' || payload.ok !== true || !isActivitySurfacesCliAuthCredentials(payload.credentials)) {
        return null;
    }
    return {
        activeServerId: readString(payload.activeServerId),
        sourceKey: readString(payload.sourceKey),
        credentials: payload.credentials,
    };
}

export async function materializeActivitySurfacesCliAuthFromWebStorage({
    appIdentifier,
    env = process.env,
    cliHomeDir = null,
    driverSession = null,
    windowId = 'main',
    runCli = runActivitySurfacesMcpCli,
} = {}) {
    const serverUrl = readString(env?.HAPPIER_SERVER_URL) || readString(env?.HAPPIER_TAURI_WEB_RUNTIME_SERVER_URL);
    if (!serverUrl || !appIdentifier) {
        return null;
    }

    const resolvedCredentials = await readActivitySurfacesAuthCredentialsFromWebview({
        appIdentifier,
        env,
        driverSession,
        windowId,
        runCli,
    });
    if (!resolvedCredentials) {
        return null;
    }

    const resolvedCliHomeDir = readString(cliHomeDir)
        || join(repoRoot, '.project', 'tmp', 'activity-surfaces-cli-auth', nowStamp());
    const credentialPaths = resolveStackCredentialPaths({
        cliHomeDir: resolvedCliHomeDir,
        serverUrl,
        env: {
            ...env,
            ...(resolvedCredentials.activeServerId ? { HAPPIER_ACTIVE_SERVER_ID: resolvedCredentials.activeServerId } : {}),
        },
    });

    const cliCredentials = normalizeActivitySurfacesCliAuthCredentialsForCli(resolvedCredentials.credentials);
    if (!cliCredentials) {
        return null;
    }

    const credentialsText = `${JSON.stringify(cliCredentials, null, 2)}\n`;
    for (const credentialPath of [credentialPaths.serverScopedPath, credentialPaths.legacyPath]) {
        await ensureDir(dirname(credentialPath));
        await writeFile(credentialPath, credentialsText, { encoding: 'utf8', mode: 0o600 });
    }

    const settingsPath = join(resolvedCliHomeDir, 'settings.json');
    await ensureDir(dirname(settingsPath));
    await writeFile(
        settingsPath,
        `${JSON.stringify({
            schemaVersion: 5,
            onboardingCompleted: true,
            activeServerId: credentialPaths.activeServerId,
            servers: {
                [credentialPaths.activeServerId]: {
                    id: credentialPaths.activeServerId,
                    name: credentialPaths.activeServerId,
                    serverUrl,
                    webappUrl: serverUrl,
                    createdAt: 0,
                    updatedAt: 0,
                    lastUsedAt: 0,
                },
            },
            machineIdByServerId: {
                [credentialPaths.activeServerId]: randomUUID(),
            },
            machineIdConfirmedByServerByServerId: {},
            lastChangesCursorByServerIdByAccountId: {},
        }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
    );

    return resolvedCliHomeDir;
}

export async function ensureActivitySurfacesStackRuntimeReadyForSessionSeed({
    appIdentifier = null,
    env = process.env,
    timeoutMs = stackCliCommandTimeoutMs,
    runStackControlCli = runActivitySurfacesStackControlCli,
} = {}) {
    const stackEnv = resolveActivitySurfacesStackCliEnv(env);
    const stackName = readString(stackEnv.HAPPIER_STACK_STACK)
        || resolveStackNameFromStackOwnedTauriIdentifier(appIdentifier);
    if (!stackName) {
        throw new Error('Expected HAPPIER_STACK_STACK before auto-starting the stack runtime for activity-surfaces session seeding.');
    }
    if (!readString(stackEnv.HAPPIER_STACK_STACK)) {
        stackEnv.HAPPIER_STACK_STACK = stackName;
    }

    await runStackControlCli(
        ['stack', 'start', stackName, '--background', '--runtime', '--no-browser'],
        { env: stackEnv, timeoutMs },
    );
    return true;
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
    appIdentifier = null,
    strategy = 'active_session',
    env = process.env,
    runCliJson = runActivitySurfacesStackCliJson,
    ensureSessionCreateReady = ensureActivitySurfacesStackRuntimeReadyForSessionSeed,
    materializeDirectCliAuth = materializeActivitySurfacesCliAuthFromWebStorage,
    cliHomeDir = null,
    sessionPath = repoRoot,
    timeoutMs = stackCliCommandTimeoutMs,
} = {}) {
    const stackEnv = resolveActivitySurfacesStackCliEnv(env);
    const backendTarget = readString(stackEnv.HAPPIER_ACTIVITY_SURFACES_QA_SEED_BACKEND_TARGET) || 'codex';
    if (!readString(stackEnv.HAPPIER_STACK_STACK)) {
        const derivedStackName = resolveStackNameFromStackOwnedTauriIdentifier(appIdentifier);
        if (derivedStackName) {
            stackEnv.HAPPIER_STACK_STACK = derivedStackName;
        }
    }
    const seedMode = resolveActivitySurfacesSessionSeedMode(stackEnv);
    let sessionCliEnv = seedMode === 'direct' ? resolveActivitySurfacesDirectCliEnv(stackEnv) : stackEnv;
    const createSeedSession = async (currentEnv) => await runCliJson(
        ['session', 'create', '--path', String(sessionPath), '--backend', backendTarget],
        { env: currentEnv, timeoutMs },
    );
    let createPayload;
    try {
        createPayload = await createSeedSession(sessionCliEnv);
    } catch (error) {
        if (seedMode === 'stack' && isMissingActivitySurfacesStackDaemonError(error)) {
            await ensureSessionCreateReady({ env: stackEnv, timeoutMs, appIdentifier });
            createPayload = await createSeedSession(sessionCliEnv);
        } else if (isMissingActivitySurfacesStackError(error) && hasActivitySurfacesSeedServerUrl(stackEnv)) {
            sessionCliEnv = resolveActivitySurfacesDirectCliEnv(stackEnv);
            try {
                createPayload = await createSeedSession(sessionCliEnv);
            } catch (retryError) {
                if (!(isRejectedActivitySurfacesDirectCliAuthError(retryError) && hasActivitySurfacesSeedServerUrl(sessionCliEnv))) {
                    throw retryError;
                }
                const reseededCliHomeDir = await materializeDirectCliAuth({
                    appIdentifier,
                    env: sessionCliEnv,
                    cliHomeDir,
                });
                if (!reseededCliHomeDir) {
                    throw retryError;
                }
                sessionCliEnv = {
                    ...sessionCliEnv,
                    HAPPIER_HOME_DIR: reseededCliHomeDir,
                    HAPPIER_STACK_CLI_HOME_DIR: reseededCliHomeDir,
                };
                createPayload = await createSeedSession(sessionCliEnv);
            }
        } else if (isRejectedActivitySurfacesDirectCliAuthError(error) && hasActivitySurfacesSeedServerUrl(sessionCliEnv)) {
            const reseededCliHomeDir = await materializeDirectCliAuth({
                appIdentifier,
                env: sessionCliEnv,
                cliHomeDir,
            });
            if (!reseededCliHomeDir) {
                throw error;
            }
            sessionCliEnv = {
                ...sessionCliEnv,
                HAPPIER_HOME_DIR: reseededCliHomeDir,
                HAPPIER_STACK_CLI_HOME_DIR: reseededCliHomeDir,
            };
            createPayload = await runCliJson(
                ['session', 'create', '--path', String(sessionPath), '--backend', backendTarget],
                { env: sessionCliEnv, timeoutMs },
            );
        } else {
            throw error;
        }
    }

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
            { env: sessionCliEnv, timeoutMs },
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
        { env: sessionCliEnv, timeoutMs },
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

export async function ensureActivitySurfacesSessionVisibleForRoute({
    sessionId,
    appIdentifier,
    env = process.env,
    driverSession = null,
    windowId = 'main',
    runCli = runActivitySurfacesMcpCli,
} = {}) {
    const normalizedSessionId = readString(sessionId);
    if (!normalizedSessionId) {
        throw new Error('Expected a seeded session id before hydrating the session route for overlay capture.');
    }

    const response = await runCli(
        [
            'webview-execute-js',
            '--script',
            `(async () => {
                const sessionId = ${JSON.stringify(normalizedSessionId)};
                const mcp = window.__MCP__;
                if (!mcp || typeof mcp.ensureHappierSessionVisible !== 'function') {
                    return { ok: false, reason: 'missing-session-visibility-hook', sessionId };
                }
                return await mcp.ensureHappierSessionVisible(sessionId, { forceRefresh: true });
            })()`,
            '--app-identifier',
            String(appIdentifier),
            '--json',
        ],
        { appIdentifier, env, driverSession, windowId, timeoutMs: cliInteractTimeoutMs },
    );
    const payload = parseStructuredJsonPayload(String(response.stdout ?? ''));
    if (!payload || typeof payload !== 'object' || payload.ok !== true) {
        const reason = typeof payload?.reason === 'string' && payload.reason.trim()
            ? payload.reason.trim()
            : 'session-visibility-unavailable';
        throw new Error(`Unable to hydrate the seeded session into the app runtime: ${reason}`);
    }
    return true;
}

export async function waitForActivitySurfacesPathname(
    pathname,
    {
        appIdentifier,
        env = process.env,
        driverSession = null,
        windowId = 'main',
        probeRootState = probeActivitySurfacesRootState,
        wait = delay,
        attempts = 6,
        delayMs = 350,
        probeTimeoutMs = seededSessionPathProbeTimeoutMs,
    } = {},
) {
    const targetPathname = readString(pathname);
    if (!targetPathname) {
        throw new Error('Expected a pathname before waiting for an activity-surfaces route.');
    }

    for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
        // eslint-disable-next-line no-await-in-loop
        const rootState = await probeRootState({
            appIdentifier,
            env,
            driverSession,
            windowId,
            timeoutMs: probeTimeoutMs,
        });
        if (readString(rootState?.pathname) === targetPathname) {
            return true;
        }
        if (attempt < attempts) {
            // eslint-disable-next-line no-await-in-loop
            await wait(delayMs);
        }
    }

    throw new Error(`Timed out waiting for the seeded session route to settle on ${targetPathname}.`);
}

export async function hydrateActivitySurfacesSeededSessionForOverlayCapture({
    sessionId,
    appIdentifier,
    env = process.env,
    driverSession = null,
    windowId = 'main',
    ensureSessionVisible = ensureActivitySurfacesSessionVisibleForRoute,
    recoverDriverSession = async (session, options = {}) => ensureActivitySurfacesDriverSession(session, {
        env,
        runCliJson: runRawActivitySurfacesMcpCliJson,
        ...options,
    }),
    navigateWebview = navigateWebviewToPath,
    waitForPathname = waitForActivitySurfacesPathname,
    wait = delay,
    settleDelayMs = 500,
} = {}) {
    const normalizedSessionId = readString(sessionId);
    if (!normalizedSessionId) {
        throw new Error('Expected a seeded session id before hydrating the session route for overlay capture.');
    }

    let bestEffortSessionHydration = false;
    try {
        await ensureSessionVisible({
            sessionId: normalizedSessionId,
            appIdentifier,
            env,
            driverSession,
            windowId,
        });
    } catch (error) {
        if (isTransientWebviewConnectionError(error) && driverSession) {
            try {
                await recoverDriverSession(driverSession, { forceRestart: true });
                await ensureSessionVisible({
                    sessionId: normalizedSessionId,
                    appIdentifier,
                    env,
                    driverSession,
                    windowId,
                });
                // Recovered successfully, continue with the normal hydrated flow.
                bestEffortSessionHydration = false;
            } catch (retryError) {
                if (
                    !isMissingSessionVisibilityHookError(retryError)
                    && !isUnavailableSessionVisibilityError(retryError)
                    && !isSessionVisibilityTimeoutError(retryError)
                    && !isTransientWebviewConnectionError(retryError)
                ) {
                    throw retryError;
                }
                bestEffortSessionHydration = true;
            }
        } else if (
            !isMissingSessionVisibilityHookError(error)
            && !isUnavailableSessionVisibilityError(error)
            && !isSessionVisibilityTimeoutError(error)
        ) {
            throw error;
        } else {
            bestEffortSessionHydration = true;
        }
    }

    const sessionPath = `/session/${normalizedSessionId}`;
    if (bestEffortSessionHydration) {
        await navigateWebview(sessionPath, {
            appIdentifier,
            env,
            driverSession,
            windowId,
        });
        await wait(settleDelayMs);
    } else {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop
            await navigateWebview(sessionPath, {
                appIdentifier,
                env,
                driverSession,
                windowId,
            });
            try {
                // eslint-disable-next-line no-await-in-loop
                await waitForPathname(sessionPath, {
                    appIdentifier,
                    env,
                    driverSession,
                    windowId,
                });
                break;
            } catch (error) {
                if (!isSeededSessionRouteWaitTimeoutError(error)) {
                    throw error;
                }
                if (attempt >= 2) {
                    break;
                }
            }
        }
    }

    await navigateWebview('/settings/desktop', {
        appIdentifier,
        env,
        driverSession,
        windowId,
    });
    await wait(settleDelayMs);

    return true;
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

function normalizeActivitySurfacesWindowId(windowId) {
    const normalized = String(windowId ?? '').trim();
    if (!normalized) {
        return null;
    }
    return normalized;
}

function replaceCommandWindowId(args, windowId) {
    const normalizedWindowId = normalizeActivitySurfacesWindowId(windowId);
    if (!Array.isArray(args)) {
        return Array.isArray(args) ? [...args] : [];
    }

    const command = String(args[0] ?? '').trim();
    if (!command.startsWith('webview-')) {
        return [...args];
    }

    const nextArgs = [...args];
    const flagIndex = nextArgs.findIndex((entry) => entry === '--window-id');
    if (flagIndex >= 0 && flagIndex + 1 < nextArgs.length) {
        if (!normalizedWindowId) {
            nextArgs.splice(flagIndex, 2);
            return nextArgs;
        }
        nextArgs[flagIndex + 1] = normalizedWindowId;
        return nextArgs;
    }

    if (!normalizedWindowId) {
        return nextArgs;
    }

    nextArgs.push('--window-id', normalizedWindowId);
    return nextArgs;
}

function isMissingDriverSessionError(error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message.includes('No active session. Call driver_session with action "start" first to connect to a Tauri app.');
}

function isTransientWebviewConnectionError(error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (message.includes('WebView execution failed') && !message.includes('Script execution timeout')) {
        return true;
    }
    return message.includes('Not connected to plugin') || message.includes('reconnection failed');
}

function isDriverSessionStatusTimeoutError(error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /timed out|timeout/i.test(message) && message.includes('driver-session status');
}

function isMissingSessionVisibilityHookError(error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message.includes('missing-session-visibility-hook');
}

function isUnavailableSessionVisibilityError(error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message.includes('session-visibility-unavailable');
}

function isSessionVisibilityTimeoutError(error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message.includes('Script execution timeout');
}

function isSeededSessionRouteWaitTimeoutError(error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return message.includes('Timed out waiting for the seeded session route to settle on /session/');
}

async function ensureActivitySurfacesDriverSession(driverSession, { env = process.env, runCliJson = runRawActivitySurfacesMcpCliJson, forceRestart = false } = {}) {
    let driverSessionPort = Number(driverSession?.driverSessionPort ?? 0);
    const resolvedAppIdentifier = String(driverSession?.resolvedAppIdentifier ?? '').trim();
    const cachedDriverSessionStatusResponse = driverSession?.driverSessionStatusResponse ?? null;
    if (!Number.isFinite(driverSessionPort) || driverSessionPort <= 0) {
        throw new Error('Expected a positive driverSessionPort for activity-surfaces QA session recovery.');
    }

    const requireStackOwnedIdentifier = hasStackOwnedTauriRuntime(env) === true;
    const preferredStackOwnedIdentifier = requireStackOwnedIdentifier
        ? resolvePreferredStackTauriIdentifier(env)
        : '';

    function shouldAcceptResolvedAppIdentifier(value) {
        const normalized = String(value ?? '').trim();
        if (!normalized) return false;
        if (!requireStackOwnedIdentifier) return true;
        if (preferredStackOwnedIdentifier) {
            return normalized === preferredStackOwnedIdentifier;
        }
        return normalized.startsWith('com.happier.stack.');
    }

    if (!forceRestart && shouldAcceptResolvedAppIdentifier(resolvedAppIdentifier) && cachedDriverSessionStatusResponse) {
        return {
            restarted: false,
            resolvedAppIdentifier,
            driverSessionStatusResponse: cachedDriverSessionStatusResponse,
        };
    }

    async function readStatus(port) {
        const statusResponse = await runCliJson(
            ['driver-session', 'status', '--port', String(port)],
            { env, timeoutMs: driverSessionRecoveryTimeoutMs },
        );
        const parsedStatus = tryParseDriverSessionStatus(statusResponse);
        return {
            statusResponse,
            resolvedAppIdentifier: resolvePreferredAppIdentifierFromDriverStatus(parsedStatus, port),
        };
    }

    if (!forceRestart) {
        try {
            const status = await readStatus(driverSessionPort);
            if (shouldAcceptResolvedAppIdentifier(status.resolvedAppIdentifier)) {
                driverSession.resolvedAppIdentifier = status.resolvedAppIdentifier;
                driverSession.driverSessionStatusResponse = status.statusResponse;
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

    async function tryResolveAlternatePort({ startedPort = null } = {}) {
        const candidatePorts = resolveCandidateDriverSessionPorts({ preferredPort: driverSessionPort, env });
        let lastStartResponse = null;
        let lastStatusResponse = null;
        for (const candidatePort of candidatePorts) {
            if (candidatePort === driverSessionPort) continue;
            if (startedPort != null && Number(startedPort) === Number(candidatePort)) continue;

            try {
                // eslint-disable-next-line no-await-in-loop
                const status = await readStatus(candidatePort);
                lastStatusResponse = status.statusResponse;
                if (shouldAcceptResolvedAppIdentifier(status.resolvedAppIdentifier)) {
                    driverSessionPort = candidatePort;
                    driverSession.driverSessionPort = candidatePort;
                    driverSession.resolvedAppIdentifier = status.resolvedAppIdentifier;
                    driverSession.driverSessionStatusResponse = status.statusResponse;
                    return {
                        ok: true,
                        driverSessionPort: candidatePort,
                        resolvedAppIdentifier: status.resolvedAppIdentifier,
                        driverSessionResponse: lastStartResponse,
                        driverSessionStatusResponse: status.statusResponse,
                    };
                }
            } catch {
                // Fall through to starting the driver session on the candidate port.
            }

            try {
                // eslint-disable-next-line no-await-in-loop
                lastStartResponse = await runCliJson(
                    ['driver-session', 'start', '--port', String(candidatePort)],
                    { env, timeoutMs: driverSessionRecoveryTimeoutMs },
                );
            } catch {
                lastStartResponse = null;
            }

            let status = null;
            for (let attempt = 1; attempt <= 3; attempt += 1) {
                try {
                    // eslint-disable-next-line no-await-in-loop
                    status = await readStatus(candidatePort);
                } catch (error) {
                    if (isDriverSessionStatusTimeoutError(error) && attempt < 3) {
                        status = null;
                        continue;
                    }
                    throw error;
                }
                lastStatusResponse = status.statusResponse;
                if (shouldAcceptResolvedAppIdentifier(status.resolvedAppIdentifier)) {
                    break;
                }
            }

            if (shouldAcceptResolvedAppIdentifier(status?.resolvedAppIdentifier)) {
                driverSessionPort = candidatePort;
                driverSession.driverSessionPort = candidatePort;
                driverSession.resolvedAppIdentifier = status.resolvedAppIdentifier;
                driverSession.driverSessionStatusResponse = status.statusResponse;
                return {
                    ok: true,
                    driverSessionPort: candidatePort,
                    resolvedAppIdentifier: status.resolvedAppIdentifier,
                    driverSessionResponse: lastStartResponse,
                    driverSessionStatusResponse: status.statusResponse,
                };
            }
        }

        return {
            ok: false,
            driverSessionResponse: lastStartResponse,
            driverSessionStatusResponse: lastStatusResponse,
        };
    }

    if (forceRestart) {
        await runCliJson(
            ['driver-session', 'stop', '--port', String(driverSessionPort)],
            { env, timeoutMs: driverSessionRecoveryTimeoutMs },
        ).catch(() => {});
    }

    const driverSessionResponse = await runCliJson(
        ['driver-session', 'start', '--port', String(driverSessionPort)],
        { env, timeoutMs: driverSessionRecoveryTimeoutMs },
    );

    let status = null;
    let restartStatusTimeoutError = null;
    // `driver-session start` can race the app attach; retry `status` briefly before failing closed.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            // eslint-disable-next-line no-await-in-loop
            status = await readStatus(driverSessionPort);
        } catch (error) {
            if (isDriverSessionStatusTimeoutError(error)) {
                restartStatusTimeoutError = error instanceof Error ? error : new Error(String(error));
                if (attempt < 3) {
                    status = null;
                    continue;
                }
                status = null;
                break;
            }
            throw error;
        }
        if (shouldAcceptResolvedAppIdentifier(status.resolvedAppIdentifier)) {
            break;
        }
    }

    if (!shouldAcceptResolvedAppIdentifier(status?.resolvedAppIdentifier)) {
        const resolvedAlternate = await tryResolveAlternatePort({ startedPort: driverSessionPort });
        if (!resolvedAlternate.ok) {
            if (restartStatusTimeoutError) {
                throw new Error(
                    `Unable to resolve a connected Tauri app identifier after driver-session status timed out on port ${driverSessionPort} and alternate-port recovery failed.`,
                    { cause: restartStatusTimeoutError },
                );
            }
            throw new Error(`Unable to resolve a connected Tauri app identifier from driver-session status on port ${driverSessionPort}.`);
        }
        return {
            restarted: true,
            resolvedAppIdentifier: resolvedAlternate.resolvedAppIdentifier,
            driverSessionResponse: resolvedAlternate.driverSessionResponse,
            driverSessionStatusResponse: resolvedAlternate.driverSessionStatusResponse,
        };
    }

    driverSession.driverSessionPort = driverSessionPort;
    driverSession.resolvedAppIdentifier = status.resolvedAppIdentifier;
    driverSession.driverSessionStatusResponse = status.statusResponse;
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

    const maxRecoveryAttempts = 2;
    let lastError = null;

    for (let recoveryAttempt = 0; recoveryAttempt <= maxRecoveryAttempts; recoveryAttempt += 1) {
        try {
            // eslint-disable-next-line no-await-in-loop
            return await runCli(effectiveArgs, {
                appIdentifier: effectiveAppIdentifier,
                driverSession,
                env,
                timeoutMs,
            });
        } catch (error) {
            lastError = error;
            if (
                !requiresDriverSession
                || (!isMissingDriverSessionError(error) && !isTransientWebviewConnectionError(error))
            ) {
                throw error;
            }

            if (recoveryAttempt >= maxRecoveryAttempts) {
                throw error;
            }

            // eslint-disable-next-line no-await-in-loop
            const recoveredSession = await ensureActivitySurfacesDriverSession(driverSession, {
                env,
                runCliJson,
                forceRestart: true,
            });
            effectiveAppIdentifier = recoveredSession.resolvedAppIdentifier;
            effectiveArgs = replaceCommandAppIdentifier(args, effectiveAppIdentifier);
            effectiveArgs = replaceCommandWindowId(effectiveArgs, windowId);
        }
    }

    throw lastError;
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
    const normalizedWindowId = normalizeActivitySurfacesWindowId(windowId);
    if (normalizedWindowId) {
        args.push('--window-id', normalizedWindowId);
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
            required: true,
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
            required: true,
            title: 'Desktop overlay route',
            windowId: 'activity_overlay',
            selectors: [
                '[data-testid="desktop-activity-overlay-collapsed"]',
                '[data-testid="desktop-activity-overlay-expanded"]',
            ],
            screenshot: '02-overlay-route.png',
            domStructure: '02-overlay-route.structure.yml',
            domAccessibility: '02-overlay-route.a11y.yml',
            notes: ['capture the visible collapsed overlay state after navigation'],
        },
        {
            id: 'overlay_collapsed',
            required: true,
            title: 'Desktop overlay collapsed / notch mode',
            windowId: 'activity_overlay',
            selectors: [resolveDesktopActivityOverlaySurfaceSelector('desktop-activity-overlay-collapsed', 'notch_integrated')],
            screenshot: '03-overlay-collapsed-notch.png',
            domStructure: '03-overlay-collapsed-notch.structure.yml',
            domAccessibility: '03-overlay-collapsed-notch.a11y.yml',
            notes: ['capture the interactive collapsed overlay surface while notch-integrated presentation is forced'],
            expectedOverlayState: {
                expanded: false,
            },
            expectedPlacement: {
                requestedHostMode: 'notch_integrated',
            },
        },
        {
            id: 'overlay_expanded',
            required: true,
            title: 'Desktop overlay expanded / notch mode',
            windowId: 'activity_overlay',
            selectors: [resolveDesktopActivityOverlaySurfaceSelector('desktop-activity-overlay-expanded', 'notch_integrated')],
            screenshot: '04-overlay-expanded-notch.png',
            domStructure: '04-overlay-expanded-notch.structure.yml',
            domAccessibility: '04-overlay-expanded-notch.a11y.yml',
            notes: ['capture the expanded overlay surface after the collapsed surface expands in notch-integrated presentation'],
            expectedOverlayState: {
                expanded: true,
            },
            expectedPlacement: {
                requestedHostMode: 'notch_integrated',
            },
        },
        {
            id: 'overlay_floating_fallback',
            required: true,
            title: 'Desktop overlay collapsed / floating mode',
            windowId: 'activity_overlay',
            selectors: [resolveDesktopActivityOverlaySurfaceSelector('desktop-activity-overlay-collapsed', 'floating_overlay')],
            screenshot: '05-overlay-floating-fallback.png',
            domStructure: '05-overlay-floating-fallback.structure.yml',
            domAccessibility: '05-overlay-floating-fallback.a11y.yml',
            notes: ['capture the collapsed floating fallback surface after forcing floating overlay presentation'],
            expectedOverlayState: {
                expanded: false,
            },
            expectedPlacement: {
                requestedHostMode: 'floating',
                hostMode: 'floating',
            },
        },
        {
            id: 'overlay_floating_expanded',
            required: true,
            title: 'Desktop overlay expanded / floating mode',
            windowId: 'activity_overlay',
            selectors: [resolveDesktopActivityOverlaySurfaceSelector('desktop-activity-overlay-expanded', 'floating_overlay')],
            screenshot: '06-overlay-expanded-floating.png',
            domStructure: '06-overlay-expanded-floating.structure.yml',
            domAccessibility: '06-overlay-expanded-floating.a11y.yml',
            notes: ['capture the expanded floating overlay surface after forcing floating overlay presentation'],
            expectedOverlayState: {
                expanded: true,
            },
            expectedPlacement: {
                requestedHostMode: 'floating',
                hostMode: 'floating',
            },
        },
        {
            id: 'overlay_idle',
            required: true,
            title: 'Desktop overlay idle card',
            windowId: 'activity_overlay',
            proofSeedMode: 'idle',
            selectors: [resolveDesktopActivityOverlayCardSelectorByKind('idle')],
            screenshot: '07-overlay-idle.png',
            domStructure: '07-overlay-idle.structure.yml',
            domAccessibility: '07-overlay-idle.a11y.yml',
            notes: ['capture the explicit idle-state overlay card with no inactive fallback rows'],
            expectedOverlayState: {
                expanded: true,
                primaryCardKind: 'idle',
                cardKinds: ['idle'],
                rowCount: 0,
            },
        },
        {
            id: 'overlay_permission_request',
            required: true,
            title: 'Desktop overlay permission request card',
            windowId: 'activity_overlay',
            proofSeedMode: 'permission_request',
            selectors: [
                resolveDesktopActivityOverlayCardSelectorByKind(
                    'permission_request',
                    desktopActivityOverlayQaCardSeedIds.permission_request,
                ),
            ],
            screenshot: '08-overlay-permission-request.png',
            domStructure: '08-overlay-permission-request.structure.yml',
            domAccessibility: '08-overlay-permission-request.a11y.yml',
            notes: ['capture the deterministic permission-request overlay card'],
            expectedOverlayState: {
                expanded: true,
                primaryCardKind: 'permission_request',
                cardKinds: ['permission_request'],
            },
        },
        {
            id: 'overlay_user_question',
            required: true,
            title: 'Desktop overlay user question card',
            windowId: 'activity_overlay',
            proofSeedMode: 'user_question',
            selectors: [
                resolveDesktopActivityOverlayCardSelectorByKind(
                    'user_question',
                    desktopActivityOverlayQaCardSeedIds.user_question,
                ),
            ],
            screenshot: '09-overlay-user-question.png',
            domStructure: '09-overlay-user-question.structure.yml',
            domAccessibility: '09-overlay-user-question.a11y.yml',
            notes: ['capture the deterministic user-question overlay card'],
            expectedOverlayState: {
                expanded: true,
                primaryCardKind: 'user_question',
                cardKinds: ['user_question'],
            },
        },
        {
            id: 'overlay_quota_summary',
            required: true,
            title: 'Desktop overlay quota summary card',
            windowId: 'activity_overlay',
            proofSeedMode: 'quota_summary',
            selectors: [
                resolveDesktopActivityOverlayCardSelectorByKind(
                    'quota_summary',
                    desktopActivityOverlayQaCardSeedIds.quota_summary,
                ),
            ],
            screenshot: '10-overlay-quota-summary.png',
            domStructure: '10-overlay-quota-summary.structure.yml',
            domAccessibility: '10-overlay-quota-summary.a11y.yml',
            notes: ['capture the deterministic quota-summary overlay card'],
            expectedOverlayState: {
                expanded: true,
                primaryCardKind: 'quota_summary',
                cardKinds: ['quota_summary'],
            },
        },
        {
            id: 'overlay_multi_session_list',
            required: true,
            title: 'Desktop overlay multi-session overview card',
            windowId: 'activity_overlay',
            proofSeedMode: 'multi_session_list',
            selectors: [
                resolveDesktopActivityOverlayCardSelectorByKind('multi_session_list', 'list'),
            ],
            screenshot: '11-overlay-multi-session-list.png',
            domStructure: '11-overlay-multi-session-list.structure.yml',
            domAccessibility: '11-overlay-multi-session-list.a11y.yml',
            notes: ['capture the multi-session overview proof state with multiple visible session rows'],
            expectedOverlayState: {
                expanded: true,
                primaryCardKind: 'multi_session_list',
                cardKinds: ['multi_session_list'],
                minRowCount: 2,
            },
        },
        {
            id: 'overlay_completion_state',
            required: true,
            title: 'Desktop overlay completion card',
            windowId: 'activity_overlay',
            proofSeedMode: 'completion_state',
            selectors: [
                resolveDesktopActivityOverlayCardSelectorByKind(
                    'completion_state',
                    desktopActivityOverlayQaCardSeedIds.completion_state,
                ),
            ],
            screenshot: '12-overlay-completion-state.png',
            domStructure: '12-overlay-completion-state.structure.yml',
            domAccessibility: '12-overlay-completion-state.a11y.yml',
            notes: ['capture the deterministic completion-state overlay card'],
            expectedOverlayState: {
                expanded: true,
                primaryCardKind: 'completion_state',
                cardKinds: ['completion_state'],
            },
        },
    ];
}

function parseActivitySurfacesQaStepIdList(rawValue) {
    return String(rawValue ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
}

function resolveActivitySurfacesRequiredProofStepIds(steps, env = process.env) {
    const knownStepIds = new Set(
        Array.isArray(steps)
            ? steps.map((step) => readString(step?.id)).filter(Boolean)
            : [],
    );
    const explicitRequired = Array.isArray(steps)
        ? steps
            .filter((step) => step?.required === true)
            .map((step) => readString(step?.id))
            .filter(Boolean)
        : [];
    const required = explicitRequired.length > 0
        ? explicitRequired
        : knownStepIds.size > 0
            ? canonicalActivitySurfacesRequiredProofStepIds.filter((stepId) => knownStepIds.has(stepId))
            : canonicalActivitySurfacesRequiredProofStepIds;
    const promoted = parseActivitySurfacesQaStepIdList(
        env?.HAPPIER_TAURI_ACTIVITY_SURFACES_QA_REQUIRE_STEPS,
    ).filter((stepId) => knownStepIds.has(stepId));

    return [...new Set([...required, ...promoted])];
}

function resolveActivitySurfacesQaSeedStrategy(env = process.env) {
    const strategy = readString(env?.HAPPIER_TAURI_ACTIVITY_SURFACES_QA_SEED_STRATEGY, 'active_session');
    if (strategy === 'skip') {
        return 'idle';
    }
    if (
        strategy === 'active_session'
        || strategy === 'attention_only'
        || strategy === 'idle'
        || strategy === 'permission_request'
        || strategy === 'user_question'
        || strategy === 'quota_summary'
        || strategy === 'multi_session_list'
        || strategy === 'completion_state'
    ) {
        return strategy;
    }
    throw new Error(`Unsupported activity-surfaces QA seed strategy: ${strategy}`);
}

async function capturePreflightStructureSnapshot({
    appIdentifier,
    env,
    driverSession = null,
    selector,
    windowId = 'main',
    timeoutMs = cliInteractTimeoutMs,
}) {
    const structure = await runActivitySurfacesMcpCli(
        buildActivitySurfacesDomSnapshotArgs({
            type: 'structure',
            appIdentifier,
            selector,
            windowId,
        }),
        { appIdentifier, env, driverSession, windowId, timeoutMs },
    );
    return String(structure.stdout ?? '');
}

export async function probeActivitySurfacesVisibleSelectors({
    appIdentifier,
    selectors,
    env = process.env,
    driverSession = null,
    windowId = 'main',
    timeoutMs = cliInteractTimeoutMs,
    runCli = runActivitySurfacesMcpCli,
} = {}) {
    const response = await runCli(
        [
            'webview-execute-js',
            '--script',
            `(() => {
                const selectors = ${JSON.stringify(Array.isArray(selectors) ? selectors : [])};
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
            timeoutMs,
        },
    );

    return parseSelectorPresenceProbeText(String(response.stdout ?? ''));
}

export async function probeActivitySurfacesPreflightSurface({
    appIdentifier,
    env,
    driverSession = null,
    windowId = 'main',
    plan,
    triedSelectors = new Set(),
    isSelectorVisible = isSelectorPresent,
    probeVisibleSelectors = probeActivitySurfacesVisibleSelectors,
    probeRootState = probeActivitySurfacesRootState,
    captureStructureSnapshot = capturePreflightStructureSnapshot,
}) {
    const selectors = [
        ...plan.settingsSelectors,
        ...(plan.settingsIndexSelectors ?? []),
        ...plan.onboardingSelectors,
        ...plan.actionSelectors,
        ...plan.authSelectors,
        ...(plan.appCrashSelectors ?? []),
        ...plan.setupSelectors,
        ...(plan.setupActionSelectors ?? []),
    ].filter(Boolean);
    const presentSelectors = new Set();
    let rootStateLoaded = false;
    let rootStateCache = null;
    const readRootState = async ({ retryOnNull = false } = {}) => {
        if (!rootStateLoaded) {
            rootStateLoaded = true;
            rootStateCache = await probeRootState({
                appIdentifier,
                driverSession,
                env,
                windowId,
                timeoutMs: plan.rootStateProbeTimeoutMs ?? cliInteractTimeoutMs,
            }).catch(() => null);
        }
        if (rootStateCache == null && retryOnNull) {
            rootStateCache = await probeRootState({
                appIdentifier,
                driverSession,
                env,
                windowId,
                timeoutMs: plan.rootStateProbeTimeoutMs ?? cliInteractTimeoutMs,
            }).catch(() => null);
        }
        return rootStateCache;
    };
    const resolveOnboardingSnapshotAnalysis = async (structureText) => {
        const analysis = analyzeActivitySurfacesPreflightSurface(structureText, plan, {
            triedSelectors,
        });
        const sawOnboardingSelectors = plan.onboardingSelectors.some((selector) =>
            String(structureText ?? '').includes(selectorToTestId(selector)),
        );
        const sawRelaySpecificSelectors = relaySpecificOnboardingSelectors.some((selector) =>
            String(structureText ?? '').includes(selectorToTestId(selector)),
        );
        if (!sawOnboardingSelectors || sawRelaySpecificSelectors) {
            return analysis;
        }

        try {
            const settleDelayMs = Math.max(
                0,
                Math.min(Number(plan.settleDelayMs ?? 0) || 0, 600),
            );
            if (settleDelayMs > 0) {
                await delay(settleDelayMs);
            }
            const fullWindowStructureText = await captureStructureSnapshot({
                appIdentifier,
                driverSession,
                env,
                windowId,
                selector: null,
                timeoutMs: plan.structureSnapshotProbeTimeoutMs ?? cliInteractTimeoutMs,
            });
            const fullWindowAnalysis = analyzeActivitySurfacesPreflightSurface(fullWindowStructureText, plan, {
                triedSelectors,
            });
            if (fullWindowAnalysis.kind !== 'navigate') {
                return fullWindowAnalysis;
            }
        } catch {
            // Fall through to the caller's current analysis when the full-window probe is unavailable.
        }

        return analysis;
    };

    if (presentSelectors.size === 0) {
        try {
            const visibleSelectors = await probeVisibleSelectors({
                appIdentifier,
                selectors,
                driverSession,
                env,
                windowId,
                timeoutMs: plan.selectorPresenceProbeTimeoutMs ?? cliInteractTimeoutMs,
            });

            for (const selector of visibleSelectors) {
                presentSelectors.add(selector);
            }
        } catch {
            // Fall through to the bounded selector probes if JS execution fails.
        }
    }

    const onboardingSelectorsVisible = plan.onboardingSelectors.some((selector) => presentSelectors.has(selector));
    const relaySelectorsVisible = relaySpecificOnboardingSelectors.some((selector) => presentSelectors.has(selector));
    if (onboardingSelectorsVisible && !relaySelectorsVisible) {
        try {
            const rootState = await readRootState({ retryOnNull: true });
            const rootStateVisibleTestIds = Array.isArray(rootState?.visibleTestIds)
                ? rootState.visibleTestIds
                    .filter((value) => typeof value === 'string' && value.trim().length > 0)
                    .map((value) => `[data-testid="${value.trim()}"]`)
                : [];
            if (rootStateVisibleTestIds.length > 0) {
                for (const selector of rootStateVisibleTestIds) {
                    presentSelectors.add(selector);
                }
                if (relaySpecificOnboardingSelectors.some((selector) => presentSelectors.has(selector))) {
                    return classifyActivitySurfacesPreflightSelectors(presentSelectors, plan, { triedSelectors });
                }
            }
        } catch {
            // Fall through to the existing onboarding snapshot and bounded selector probes.
        }
    }

    if (presentSelectors.size === 0) {
        const rootState = await readRootState({ retryOnNull: true });
        if (
            rootState
            && typeof rootState === 'object'
            && String(rootState.pathname ?? '') === '/'
            && String(rootState.rootText ?? '').trim().length === 0
        ) {
            return {
                kind: 'navigate',
                targetPath: plan.desktopSettingsPath ?? plan.settingsPath ?? '/settings/desktop',
                reason: 'settings-shell-not-visible-yet',
            };
        }

        const rootTextAnalysis = analyzeActivitySurfacesPreflightRootText(rootState?.rootText ?? '');
        if (rootTextAnalysis) {
            return rootTextAnalysis;
        }

        const rootStateVisibleTestIds = Array.isArray(rootState?.visibleTestIds)
            ? rootState.visibleTestIds
                .filter((value) => typeof value === 'string' && value.trim().length > 0)
                .map((value) => `[data-testid="${value.trim()}"]`)
            : [];
        if (rootStateVisibleTestIds.length > 0) {
            return classifyActivitySurfacesPreflightSelectors(new Set(rootStateVisibleTestIds), plan, { triedSelectors });
        }

        try {
            const structureText = await captureStructureSnapshot({
                appIdentifier,
                driverSession,
                env,
                windowId,
                selector: null,
                timeoutMs: plan.structureSnapshotProbeTimeoutMs ?? cliInteractTimeoutMs,
            });
            const analysis = await resolveOnboardingSnapshotAnalysis(structureText);
            if (analysis.kind !== 'navigate' || isActivitySurfacesBlankRootStructureSnapshot(structureText)) {
                return analysis;
            }
        } catch {
            // Fall through to the bounded selector probes if the full-window snapshot fails.
        }

        const fallbackSelectors = [
            ...plan.authSelectors.slice(0, 3),
            ...((plan.appCrashSelectors ?? []).slice(0, 2)),
            ...plan.onboardingSelectors.slice(0, 2),
            plan.setupSelectors[0],
            plan.setupActionSelectors?.[0],
            ...(plan.settingsIndexSelectors ?? []),
            ...plan.settingsSelectors,
        ].filter(Boolean);

        const fallbackVisibility = await Promise.all(
            fallbackSelectors.map(async (selector) => ({
                selector,
                visible: await isSelectorVisible(selector, {
                    appIdentifier,
                    driverSession,
                    env,
                    windowId,
                    timeoutMs: plan.probeSelectorTimeoutMs,
                    throwOnTransientDisconnect: true,
                }),
            })),
        );

        for (const { selector, visible } of fallbackVisibility) {
            if (visible) {
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
                        timeoutMs: plan.structureSnapshotProbeTimeoutMs ?? cliInteractTimeoutMs,
                    });
                    const analysis = analyzeActivitySurfacesPreflightSurface(structureText, plan, {
                        triedSelectors,
                    });
                    if (analysis.kind !== 'navigate') {
                        const sawRelaySpecificSelectors = relaySpecificOnboardingSelectors.some((selector) =>
                            structureText.includes(selectorToTestId(selector)),
                        );
                        if (analysis.kind === 'action' && !sawRelaySpecificSelectors) {
                            try {
                                const fullWindowStructureText = await captureStructureSnapshot({
                                    appIdentifier,
                                    driverSession,
                                    env,
                                    windowId,
                                    selector: null,
                                    timeoutMs: plan.structureSnapshotProbeTimeoutMs ?? cliInteractTimeoutMs,
                                });
                                const fullWindowAnalysis = analyzeActivitySurfacesPreflightSurface(fullWindowStructureText, plan, {
                                    triedSelectors,
                                });
                                if (fullWindowAnalysis.kind !== 'navigate') {
                                    return fullWindowAnalysis;
                                }
                            } catch {
                                // Fall through to the root-selector classification below.
                            }
                        } else {
                            return analysis;
                        }
                    }
                } catch {
                    // Fall through to the root-selector classification below.
                }
            }
        }
    }
    const shouldEnrichOnboardingContext = onboardingSelectorsVisible && !relaySelectorsVisible;

    if (shouldEnrichOnboardingContext) {
        try {
            const rootState = await readRootState({ retryOnNull: true });
            const rootStateVisibleTestIds = Array.isArray(rootState?.visibleTestIds)
                ? rootState.visibleTestIds
                    .filter((value) => typeof value === 'string' && value.trim().length > 0)
                    .map((value) => `[data-testid="${value.trim()}"]`)
                : [];
            for (const selector of rootStateVisibleTestIds) {
                presentSelectors.add(selector);
            }
            if (relaySpecificOnboardingSelectors.some((selector) => presentSelectors.has(selector))) {
                return classifyActivitySurfacesPreflightSelectors(presentSelectors, plan, { triedSelectors });
            }
        } catch {
            // Fall through to the focused onboarding snapshot path below.
        }
    }

    if (shouldEnrichOnboardingContext) {
        const onboardingRootSelector = plan.onboardingSelectors.find((selector) => presentSelectors.has(selector));
        if (onboardingRootSelector) {
            try {
                const structureText = await captureStructureSnapshot({
                    appIdentifier,
                    driverSession,
                    env,
                    windowId,
                    selector: onboardingRootSelector,
                    timeoutMs: plan.structureSnapshotProbeTimeoutMs ?? cliInteractTimeoutMs,
                });
                const analysis = await resolveOnboardingSnapshotAnalysis(structureText);
                if (analysis.kind !== 'navigate') {
                    return analysis;
                }
            } catch {
                // Fall through to the fast-probe classification below.
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
    restoreAuth = restoreActivitySurfacesAuth,
    recoverAppCrash = recoverActivitySurfacesAppCrash,
    captureBlockedSnapshot = captureSnapshotArtifacts,
    appendWarning: appendWarningArtifact = appendWarning,
    traceAttempt = null,
    wait = delay,
}) {
    const plan = preflightPlan ?? buildActivitySurfacesPreflightPlan();
    const triedSelectors = new Set();
    let attemptedAuthRestore = false;
    let attemptedAppCrashRecovery = false;
    let capturedBlockedSnapshot = false;
    const primarySettingsSelector = plan.settingsSelectors[0] ?? '[data-testid="settings-desktop-overlay-enabled"]';
    const desktopSettingsPath = plan.desktopSettingsPath ?? '/settings/desktop';
    const genericSettingsPath = plan.settingsPath ?? '/settings';
    const desktopSettingsShellMaxAttempts = Math.max(
        1,
        Math.floor(Number(plan.desktopSettingsShellMaxAttempts ?? 2) || 2),
    );
    const maxAttempts = Math.max(1, Math.floor(Number(plan.maxAttempts) || 1));

    const desktopSettingsShellRetryPlan = {
        ...plan,
        selectorPresenceProbeTimeoutMs: Math.max(
            1,
            Math.floor(Number(plan.desktopSettingsShellSelectorPresenceProbeTimeoutMs ?? plan.selectorPresenceProbeTimeoutMs ?? 0) || 1),
        ),
        rootStateProbeTimeoutMs: Math.max(
            1,
            Math.floor(Number(plan.desktopSettingsShellRootStateProbeTimeoutMs ?? plan.rootStateProbeTimeoutMs ?? 0) || 1),
        ),
        structureSnapshotProbeTimeoutMs: Math.max(
            1,
            Math.floor(Number(plan.desktopSettingsShellStructureSnapshotProbeTimeoutMs ?? plan.structureSnapshotProbeTimeoutMs ?? 0) || 1),
        ),
    };

    for (let pass = 1; pass <= 3; pass += 1) {
        let targetPath = genericSettingsPath;
        // Prefer probing/clicking in-app navigation (settings tab, etc.) before mutating history
        // directly. Raw `pushState` navigation can surface transient router crashes in runtime
        // snapshots if the shell is still settling.
        let shouldNavigateBeforeProbe = false;
        let attemptedSettingsShellRetries = 0;
        let attempts = 0;
        let activeProbePlan = plan;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            attempts = attempt;
            if (typeof traceAttempt === 'function') {
                await traceAttempt({
                    attempt,
                    kind: 'attempt_start',
                    targetPath,
                });
            }
            if (shouldNavigateBeforeProbe) {
                await navigateWebview(targetPath, {
                    appIdentifier,
                    env,
                    driverSession,
                    windowId: 'main',
                });
                // After a direct navigation mutation, default to navigating again on the next attempt
                // unless an in-app action handler overrides it.
                shouldNavigateBeforeProbe = true;
            }
            await wait(plan.settleDelayMs);

            let surface;
            try {
                if (typeof traceAttempt === 'function') {
                    await traceAttempt({
                        attempt,
                        kind: 'probe_start',
                    });
                }
                surface = await probeSurface({
                    appIdentifier,
                    driverSession,
                    env,
                    windowId: 'main',
                    plan: activeProbePlan,
                    triedSelectors,
                });
            } catch (error) {
                if (isTransientWebviewConnectionError(error)) {
                    await wait(plan.settleDelayMs);
                    continue;
                }
                throw error;
            }
            if (typeof traceAttempt === 'function') {
                await traceAttempt({
                    attempt,
                    kind: surface.kind,
                    ...(surface.selector ? { selector: surface.selector } : {}),
                    ...(surface.blocker ? { blocker: surface.blocker } : {}),
                    ...(surface.targetPath ? { targetPath: surface.targetPath } : {}),
                    ...(surface.reason ? { reason: surface.reason } : {}),
                    ...(surface.message ? { message: surface.message } : {}),
                });
            }
            if (surface.kind === 'ready') {
                return { ok: true, attempts: attempt };
            }
            if (surface.kind === 'blocked') {
                if (surface.blocker === 'app-crash' && !attemptedAppCrashRecovery) {
                    attemptedAppCrashRecovery = true;
                    const recovered = await recoverAppCrash({
                        appIdentifier,
                        env,
                        artifactRoot,
                        driverSession,
                        windowId: 'main',
                    });
                    if (recovered) {
                        shouldNavigateBeforeProbe = false;
                        await wait(plan.settleDelayMs);
                        continue;
                    }
                }
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

                if (
                    !capturedBlockedSnapshot
                    && artifactRoot
                    && typeof captureBlockedSnapshot === 'function'
                ) {
                    capturedBlockedSnapshot = true;
                    const suffix = normalizeStorageScope(surface.blocker) || 'blocked';
                    try {
                        await captureBlockedSnapshot({
                            screenshotPath: join(artifactRoot, `99-settings-preflight-blocked.${suffix}.png`),
                            structurePath: join(artifactRoot, `99-settings-preflight-blocked.${suffix}.structure.yml`),
                            a11yPath: join(artifactRoot, `99-settings-preflight-blocked.${suffix}.a11y.yml`),
                            label: `settings-preflight-blocked.${suffix}`,
                            appIdentifier,
                            env,
                            driverSession,
                            windowId: 'main',
                            snapshotSelector: null,
                        });
                    } catch (error) {
                        await appendWarningArtifact(
                            artifactRoot,
                            `- unable to capture settings preflight blocked snapshot (${suffix}): ${error instanceof Error ? error.message : String(error)}`,
                        );
                    }
                }
                await appendWarningArtifact(artifactRoot, `- settings preflight blocked (${surface.blocker}): ${surface.message}`);
                throw new Error(surface.message);
            }
            if (surface.kind === 'navigate') {
                const requestedTargetPath = typeof surface.targetPath === 'string' && surface.targetPath.trim()
                    ? surface.targetPath.trim()
                    : targetPath;
                const isSettingsShellRetry = surface.reason === 'settings-shell-not-visible-yet'
                    && (requestedTargetPath === desktopSettingsPath || requestedTargetPath === genericSettingsPath);
                const normalizedRequestedTargetPath = requestedTargetPath === desktopSettingsPath
                    ? genericSettingsPath
                    : requestedTargetPath;
                const retryCurrentSettingsPathWithoutRenavigation = isSettingsShellRetry
                    && targetPath === genericSettingsPath
                    && normalizedRequestedTargetPath === genericSettingsPath;
                targetPath = normalizedRequestedTargetPath;
                shouldNavigateBeforeProbe = !retryCurrentSettingsPathWithoutRenavigation;
                if (isSettingsShellRetry) {
                    attemptedSettingsShellRetries += 1;
                    activeProbePlan = desktopSettingsShellRetryPlan;
                    if (attemptedSettingsShellRetries >= desktopSettingsShellMaxAttempts) {
                        break;
                    }
                }
                continue;
            }

            try {
                await click(surface.selector, { appIdentifier, env, driverSession, windowId: 'main' });
                triedSelectors.add(surface.selector);
                // After advancing via an in-app action, let the UI settle on its next state before
                // we force navigation again. This avoids repeatedly blasting /settings while the
                // shell is still transitioning (a common source of flake/crash screens).
                shouldNavigateBeforeProbe = false;
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
            triedSelectors,
        });
        if (finalSurface.kind === 'ready') {
            return { ok: true, attempts };
        }
        if (finalSurface.kind === 'blocked') {
            if (finalSurface.blocker === 'app-crash' && !attemptedAppCrashRecovery) {
                attemptedAppCrashRecovery = true;
                const recovered = await recoverAppCrash({
                    appIdentifier,
                    env,
                    artifactRoot,
                    driverSession,
                    windowId: 'main',
                });
                if (recovered) {
                    await wait(plan.settleDelayMs);
                    continue;
                }
            }
            if (finalSurface.blocker === 'auth' && !attemptedAuthRestore) {
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

            throw new Error(finalSurface.message);
        }
        if (finalSurface.kind === 'action') {
            const selector = finalSurface.selector;
            if (typeof selector === 'string' && selector.trim()) {
                try {
                    await click(selector, { appIdentifier, env, driverSession, windowId: 'main' });
                    triedSelectors.add(selector);
                    await wait(plan.settleDelayMs);
                    continue;
                } catch {
                    // fall through to the generic error below
                }
            }
        }
        if (finalSurface.kind === 'navigate') {
            const requestedTargetPath = typeof finalSurface.targetPath === 'string' && finalSurface.targetPath.trim()
                ? finalSurface.targetPath.trim()
                : targetPath;
            if (
                finalSurface.reason === 'settings-shell-not-visible-yet'
                && (requestedTargetPath === desktopSettingsPath || requestedTargetPath === genericSettingsPath)
            ) {
                await appendWarningArtifact(
                    artifactRoot,
                    '- settings preflight could not confirm the desktop settings shell after repeated navigation; continuing so the dedicated desktop settings page opener can retry the page directly',
                );
                return { ok: true, attempts };
            }
        }

        throw new Error(
            [
                'Unable to reach the settings shell before activity-surfaces capture.',
                `The primary settings selector (${selectorToTestId(primarySettingsSelector)}) was not visible after ${attempts || maxAttempts} attempts.`,
                'If the app is redirecting to auth or setup, complete that prerequisite once and rerun the activity-surfaces QA capture.',
            ].join(' '),
        );
    }

    throw new Error('Unable to reach the settings shell before activity-surfaces capture.');
}

export async function recoverActivitySurfacesAppCrash({
    appIdentifier,
    env,
    driverSession = null,
    windowId = 'main',
    navigateWebview = navigateWebviewToPath,
    click = clickSelector,
    isSelectorVisible = isSelectorPresent,
    wait = delay,
} = {}) {
    try {
        await navigateWebview('/', {
            appIdentifier,
            env,
            driverSession,
            windowId,
            forceReload: true,
        });
        await wait(1_500);
        const crashStillVisible = await isSelectorVisible(appCrashRestartSelector, {
            appIdentifier,
            env,
            driverSession,
            windowId,
            timeoutMs: 1_200,
        });
        if (!crashStillVisible) {
            return true;
        }
    } catch {
        // Fall through to the explicit crash button recovery path below.
    }

    await click(appCrashRestartSelector, {
        appIdentifier,
        env,
        driverSession,
        windowId,
    });
    await wait(1_500);

    const crashStillVisible = await isSelectorVisible(appCrashRestartSelector, {
        appIdentifier,
        env,
        driverSession,
        windowId,
        timeoutMs: 1_200,
    });
    return !crashStillVisible;
}

function isDesktopSettingsRouteFromRootState(rootState) {
    const pathname = readString(rootState?.pathname);
    return pathname.endsWith('/settings/desktop');
}

function isDesktopSettingsPageVisibleFromRootState(rootState) {
    if (!isDesktopSettingsRouteFromRootState(rootState)) {
        return false;
    }

    const visibleTestIds = Array.isArray(rootState?.visibleTestIds)
        ? rootState.visibleTestIds.filter((value) => typeof value === 'string' && value.trim().length > 0)
        : [];

    return visibleTestIds.some((value) => value.startsWith('settings-desktop-') && value !== 'settings-desktop-entry');
}

function isDesktopSettingsEntryVisibleFromRootState(rootState) {
    const pathname = readString(rootState?.pathname);
    if (!pathname.endsWith('/settings')) {
        return false;
    }

    const visibleTestIds = Array.isArray(rootState?.visibleTestIds)
        ? rootState.visibleTestIds.filter((value) => typeof value === 'string' && value.trim().length > 0)
        : [];

    return visibleTestIds.includes('settings-desktop-entry');
}

function summarizeDesktopSettingsOpenRootState(rootState) {
    if (!rootState || typeof rootState !== 'object') {
        return null;
    }

    const visibleTestIds = Array.isArray(rootState.visibleTestIds)
        ? rootState.visibleTestIds.filter((value) => typeof value === 'string' && value.trim().length > 0)
        : [];
    const rootText = readString(rootState.rootText);

    return {
        pathname: readString(rootState.pathname),
        rootTextExcerpt: rootText.slice(0, 2_000),
        visibleTestIds,
    };
}

async function writeDesktopSettingsOpenDiagnostics({
    artifactRoot,
    appIdentifier,
    env,
    driverSession,
    windowId = 'main',
    rootState,
    selectorProbes,
    writeArtifact,
    reason,
    attemptedSettingsShellNavigation,
}) {
    if (!artifactRoot) {
        return;
    }

    await writeArtifact(
        join(artifactRoot, '99-desktop-settings-open.root-state.json'),
        `${JSON.stringify(rootState, null, 2)}\n`,
    );
    await writeArtifact(
        join(artifactRoot, '99-desktop-settings-open.selector-probes.json'),
        `${JSON.stringify({
            ok: false,
            reason,
            attemptedSettingsShellNavigation: attemptedSettingsShellNavigation === true,
            rootState: summarizeDesktopSettingsOpenRootState(rootState),
            selectorProbes,
        }, null, 2)}\n`,
    );
    const structure = await runActivitySurfacesMcpCli(
        buildActivitySurfacesDomSnapshotArgs({
            type: 'structure',
            appIdentifier,
            selector: null,
            windowId,
        }),
        { appIdentifier, env, driverSession, windowId, timeoutMs: cliInteractTimeoutMs },
    ).catch((error) => ({
        stdout: `error: ${error instanceof Error ? error.message : String(error)}\n`,
    }));
    await writeArtifact(
        join(artifactRoot, '99-desktop-settings-open.structure.txt'),
        String(structure?.stdout ?? ''),
    );
}

async function writeOverlayRouteOpenDiagnostics({
    artifactRoot,
    appIdentifier,
    env,
    driverSession,
    rootState,
    writeArtifact,
    probeError = null,
}) {
    if (!artifactRoot) {
        return;
    }

    const diagnosticsRoot = join(artifactRoot, '99-overlay-route-open');
    await writeArtifact(
        `${diagnosticsRoot}.root-state.json`,
        `${JSON.stringify(rootState, null, 2)}\n`,
    );
    await writeArtifact(
        `${diagnosticsRoot}.selector-fallback.json`,
        `${JSON.stringify({
            ok: false,
            reason: 'overlay-route-selector-miss',
            error: probeError instanceof Error ? probeError.message : String(probeError ?? ''),
            rootState,
        }, null, 2)}\n`,
    );

    try {
        await captureSnapshotArtifacts({
            screenshotPath: `${diagnosticsRoot}.png`,
            structurePath: `${diagnosticsRoot}.structure.txt`,
            a11yPath: `${diagnosticsRoot}.a11y.yml`,
            label: 'overlay_route_open',
            appIdentifier,
            env,
            driverSession,
            windowId: 'activity_overlay',
            snapshotSelector: null,
            writeArtifact,
        });
    } catch {
        // Best-effort diagnostics only.
    }
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
    isSelectorVisibleByDomQuery = isSelectorPresentByDomQuery,
    probeRootState = probeActivitySurfacesRootState,
    captureSnapshot = captureSnapshotArtifacts,
    appendWarning: appendWarningArtifact = appendWarning,
    writeArtifact = writeTextArtifact,
    wait = delay,
    traceSelectorProbe = null,
} = {}) {
    const desktopPageSelector = '[data-testid="settings-desktop-overlay-enabled"]';
    const desktopEntrySelector = '[data-testid="settings-desktop-entry"]';
    const settingsTabSelector = '[data-testid="tabbar-tab-settings"]';
    const setupWizardSkipSelector = '[data-testid="setupWizard.surface-skip"]';
    const appCrashRestartSelector = '[data-testid="app-crash-restart"]';
    let attemptedSettingsShellNavigation = false;
    const capturedCrashContexts = new Set();
    const selectorProbes = [];
    const recordSelectorProbe = async (entry) => {
        const normalizedEntry = {
            ts: new Date().toISOString(),
            ...entry,
        };
        selectorProbes.push(normalizedEntry);
        if (typeof traceSelectorProbe === 'function') {
            await traceSelectorProbe(normalizedEntry);
        }
    };
    const checkSelectorVisible = async (selector) => {
        try {
            const visible = await isSelectorVisible(selector, {
                appIdentifier,
                env,
                driverSession,
                windowId,
                timeoutMs: 1_000,
                throwOnTransientDisconnect: true,
            });
            await recordSelectorProbe({
                kind: 'selector',
                source: 'mcp',
                selector,
                windowId,
                timeoutMs: 1_000,
                result: visible === true,
            });
            if (visible) {
                return true;
            }
        } catch (error) {
            if (!isTransientWebviewConnectionError(error)) {
                throw error;
            }
            await recordSelectorProbe({
                kind: 'selector',
                source: 'mcp',
                selector,
                windowId,
                timeoutMs: 1_000,
                result: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }

        const domQueryVisible = await isSelectorVisibleByDomQuery(selector, {
            appIdentifier,
            env,
            driverSession,
            windowId,
            timeoutMs: domQueryFallbackProbeTimeoutMs,
        }).catch((error) => {
            selectorProbes.push({
                ts: new Date().toISOString(),
                kind: 'selector',
                source: 'dom-query',
                selector,
                windowId,
                timeoutMs: domQueryFallbackProbeTimeoutMs,
                result: false,
                error: error instanceof Error ? error.message : String(error),
            });
            return false;
        });
        if (domQueryVisible === true) {
            await recordSelectorProbe({
                kind: 'selector',
                source: 'dom-query',
                selector,
                windowId,
                timeoutMs: domQueryFallbackProbeTimeoutMs,
                result: true,
            });
        } else if (!selectorProbes.some((entry) => entry.selector === selector && entry.source === 'dom-query' && entry.result === false)) {
            await recordSelectorProbe({
                kind: 'selector',
                source: 'dom-query',
                selector,
                windowId,
                timeoutMs: domQueryFallbackProbeTimeoutMs,
                result: false,
            });
        }
        return domQueryVisible;
    };

    const dismissSetupWizardIfNeeded = async (context) => {
        const skipVisible = await checkSelectorVisible(setupWizardSkipSelector);
        if (!skipVisible) {
            return false;
        }

        try {
            await click(setupWizardSkipSelector, {
                appIdentifier,
                env,
                driverSession,
                windowId,
            });
            await recordSelectorProbe({
                kind: 'action',
                context,
                selector: setupWizardSkipSelector,
                windowId,
                result: true,
            });
        } catch (error) {
            await recordSelectorProbe({
                kind: 'action',
                context,
                selector: setupWizardSkipSelector,
                windowId,
                result: false,
                error: error instanceof Error ? error.message : String(error),
            });
            if (artifactRoot) {
                await appendWarningArtifact(
                    artifactRoot,
                    `- unable to dismiss the setup wizard while probing desktop settings (${context}): ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        await wait(600);
        return true;
    };

    const recoverFromCrashIfNeeded = async (context) => {
        let crashVisible = false;
        try {
            crashVisible = await isSelectorVisible(appCrashRestartSelector, {
                appIdentifier,
                env,
                driverSession,
                windowId,
                timeoutMs: 1_000,
            });
        } catch (error) {
            if (!isTransientWebviewConnectionError(error)) {
                throw error;
            }
            crashVisible = false;
        }

        if (!crashVisible) {
            return false;
        }

        attemptedSettingsShellNavigation = true;
        if (artifactRoot) {
            await appendWarningArtifact(
                artifactRoot,
                `- crash recovery screen visible while probing desktop settings (${context}); attempting restart`,
            );
        }

        if (
            artifactRoot
            && typeof captureSnapshot === 'function'
            && !capturedCrashContexts.has(context)
        ) {
            capturedCrashContexts.add(context);
            try {
                await captureSnapshot({
                    screenshotPath: join(artifactRoot, `99-desktop-settings-crash.${context}.png`),
                    structurePath: join(artifactRoot, `99-desktop-settings-crash.${context}.structure.yml`),
                    a11yPath: join(artifactRoot, `99-desktop-settings-crash.${context}.a11y.yml`),
                    label: `desktop-settings-crash.${context}`,
                    appIdentifier,
                    env,
                    driverSession,
                    windowId,
                    snapshotSelector: null,
                    writeArtifact,
                });
            } catch (error) {
                await appendWarningArtifact(
                    artifactRoot,
                    `- unable to capture crash recovery snapshot during desktop settings probe (${context}): ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        try {
            await click(appCrashRestartSelector, {
                appIdentifier,
                env,
                driverSession,
                windowId,
            });
        } catch (error) {
            if (artifactRoot) {
                await appendWarningArtifact(
                    artifactRoot,
                    `- unable to click crash restart during desktop settings probe (${context}): ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        await wait(1_500);
        return true;
    };
    const waitForDesktopPage = async (attempts = 1) => {
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop
            await recoverFromCrashIfNeeded('desktop-page');
            // eslint-disable-next-line no-await-in-loop
            await dismissSetupWizardIfNeeded('desktop-page');
            // eslint-disable-next-line no-await-in-loop
            if (await checkSelectorVisible(desktopPageSelector)) {
                return true;
            }
            // eslint-disable-next-line no-await-in-loop
            const rootState = await probeRootState({
                appIdentifier,
                env,
                driverSession,
                windowId,
                timeoutMs: 1_500,
            });
            await recordSelectorProbe({
                kind: 'root-state',
                context: 'desktop-page',
                windowId,
                timeoutMs: 1_500,
                matched: isDesktopSettingsPageVisibleFromRootState(rootState),
                rootState: summarizeDesktopSettingsOpenRootState(rootState),
            });
            if (isDesktopSettingsPageVisibleFromRootState(rootState)) {
                return true;
            }
            if (attempt < attempts) {
                // eslint-disable-next-line no-await-in-loop
                await wait(500);
            }
        }
        return false;
    };
    const waitForDesktopEntry = async (attempts = 1) => {
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            // eslint-disable-next-line no-await-in-loop
            await recoverFromCrashIfNeeded('desktop-entry');
            // eslint-disable-next-line no-await-in-loop
            await dismissSetupWizardIfNeeded('desktop-entry');
            // eslint-disable-next-line no-await-in-loop
            let desktopEntryVisible = await checkSelectorVisible(desktopEntrySelector);
            if (!desktopEntryVisible) {
                // eslint-disable-next-line no-await-in-loop
                const rootState = await probeRootState({
                    appIdentifier,
                    env,
                    driverSession,
                    windowId,
                    timeoutMs: 1_500,
                }).catch(() => null);
                await recordSelectorProbe({
                    kind: 'root-state',
                    context: 'desktop-entry',
                    windowId,
                    timeoutMs: 1_500,
                    matched: isDesktopSettingsEntryVisibleFromRootState(rootState),
                    rootState: summarizeDesktopSettingsOpenRootState(rootState),
                });
                desktopEntryVisible = isDesktopSettingsEntryVisibleFromRootState(rootState);
            }

            if (desktopEntryVisible) {
                return true;
            }

            if (attempt < attempts) {
                // eslint-disable-next-line no-await-in-loop
                await wait(500);
            }
        }

        return false;
    };
    const openDesktopPageFromSettingsEntry = async (warningContext, entryAttempts = 1) => {
        if (!(await waitForDesktopEntry(entryAttempts))) {
            return false;
        }

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
                    `- unable to open the dedicated desktop app settings page from ${warningContext}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        await wait(500);
        if (await waitForDesktopPage(2)) {
            return true;
        }

        return isDesktopSettingsRouteFromRootState(await probeRootState({
            appIdentifier,
            env,
            driverSession,
            windowId,
            timeoutMs: 1_500,
        }).catch(() => null));
    };

    if (await waitForDesktopPage()) {
        return true;
    }

    if (await openDesktopPageFromSettingsEntry('the settings entry')) {
        return true;
    }

    await recoverFromCrashIfNeeded('settings-shell');

    if (await checkSelectorVisible(settingsTabSelector)) {
        attemptedSettingsShellNavigation = true;
        try {
            await click(settingsTabSelector, {
                appIdentifier,
                env,
                driverSession,
                windowId,
            });
        } catch (error) {
            if (artifactRoot) {
                await appendWarningArtifact(
                    artifactRoot,
                    `- unable to open the settings shell from the settings tab: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        await wait(500);
        if (await waitForDesktopPage(2)) {
            return true;
        }

        if (await openDesktopPageFromSettingsEntry('the settings shell', 2)) {
            return true;
        }
    }

    if (attemptedSettingsShellNavigation) {
        if (artifactRoot) {
            await appendWarningArtifact(
                artifactRoot,
                '- unable to confirm the dedicated desktop app settings page from the real settings shell; attempting a force-reload of /settings/desktop as a last resort (this may destabilize the live app)',
            );
            try {
                const rootState = await probeRootState({
                    appIdentifier,
                    env,
                    driverSession,
                    windowId,
                    timeoutMs: 2_000,
                }).catch(() => null);
                await writeDesktopSettingsOpenDiagnostics({
                    artifactRoot,
                    appIdentifier,
                    env,
                    driverSession,
                    windowId,
                    rootState,
                    selectorProbes,
                    writeArtifact,
                    reason: 'confirmed-settings-shell-page-not-visible',
                    attemptedSettingsShellNavigation,
                });
            } catch {
                // Best-effort diagnostics only.
            }
        }

        await recordSelectorProbe({
            kind: 'action',
            context: 'settings-shell-last-resort',
            selector: '/settings/desktop',
            windowId,
            result: true,
        });
        await navigateWebview('/settings/desktop', {
            appIdentifier,
            env,
            driverSession,
            windowId,
            forceReload: true,
        });
        await wait(750);
        if (await waitForDesktopPage(3)) {
            return true;
        }

        return false;
    }

    await navigateWebview('/settings/desktop', {
        appIdentifier,
        env,
        driverSession,
        windowId,
        forceReload: false,
    });
    await wait(500);

    if (await waitForDesktopPage(3)) {
        return true;
    }

    if (isDesktopSettingsRouteFromRootState(await probeRootState({
        appIdentifier,
        env,
        driverSession,
        windowId,
        timeoutMs: 1_500,
    }).catch(() => null))) {
        return true;
    }

    await navigateWebview('/settings', {
        appIdentifier,
        env,
        driverSession,
        windowId,
        forceReload: false,
    });
    await wait(500);

    if (await openDesktopPageFromSettingsEntry('the settings index', 3)) {
        return true;
    }

    if (artifactRoot) {
        await appendWarningArtifact(
            artifactRoot,
            '- unable to confirm the dedicated desktop app settings page after navigating from settings',
        );
        try {
            const rootState = await probeRootState({
                appIdentifier,
                env,
                driverSession,
                windowId,
                timeoutMs: 2_000,
            }).catch(() => null);
            await writeDesktopSettingsOpenDiagnostics({
                artifactRoot,
                appIdentifier,
                env,
                driverSession,
                windowId,
                rootState,
                selectorProbes,
                writeArtifact,
                reason: 'direct-settings-navigation-did-not-confirm-dedicated-page',
                attemptedSettingsShellNavigation,
            });
        } catch {
            // Best-effort diagnostics only.
        }
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
            'If you need to validate the explicit idle surface, rerun with `HAPPIER_TAURI_ACTIVITY_SURFACES_QA_SEED_STRATEGY=skip`; `always_when_enabled` should still render the idle surface without an active session.',
            'To validate deterministic seeded proof states directly, rerun with modes such as `permission_request`, `user_question`, `quota_summary`, or `multi_session_list`.',
            'If the overlay still stays hidden after enabling it in `always_when_enabled`, inspect placement diagnostics and warnings, then rerun the capture.',
        ],
    };
}

export function buildActivitySurfacesPath(pathname) {
    return appendTauriQaHmrOptOut(pathname);
}

export function buildActivitySurfacesNavigationScript(pathname, options = {}) {
    const path = buildActivitySurfacesPath(pathname);
    const forceReload = options?.forceReload === true;
    return `(() => {
        try {
            const origin = window.location && window.location.origin ? window.location.origin : '';
            const next = origin ? origin + ${JSON.stringify(path)} : ${JSON.stringify(path)};
            const current = window.location && window.location.href ? window.location.href : '';
            if (current === next) {
                ${forceReload ? 'window.location.reload();' : ''}
                return { ok: true, unchanged: true, currentHref: current, nextHref: next };
            }
            const nextUrl = new URL(next, origin || window.location.href);
            const nextPath = nextUrl.pathname + nextUrl.search + nextUrl.hash;
            window.history.pushState({}, '', nextPath);
            window.dispatchEvent(new PopStateEvent('popstate'));
            ${forceReload ? 'window.location.reload();' : ''}
            return { ok: true, changed: true, currentHref: current, nextHref: next${forceReload ? ", reloaded: true" : ''} };
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
        forceReload = false,
        runCli = runActivitySurfacesMcpCli,
    } = {},
) {
    const script = buildActivitySurfacesNavigationScript(pathname, { forceReload });

    await runCli(
        ['webview-execute-js', '--script', script, '--app-identifier', String(appIdentifier), '--json'],
        { appIdentifier, env, driverSession, windowId, timeoutMs: navigationInteractTimeoutMs },
    ).catch(() => {});
}

function resolveActivitySurfacesStepSelectorFromRootState(step, rootState) {
    const visibleTestIds = rootState?.visibleTestIds;
    if (!Array.isArray(visibleTestIds)) {
        return null;
    }

    const selectors = Array.isArray(step?.selectors) ? step.selectors : [];
    for (const selector of selectors) {
        const testId = selectorToTestId(selector);
        if (testId && visibleTestIds.includes(testId)) {
            return selector;
        }
    }

    return null;
}

export async function resolveActivitySurfacesStepSnapshotSelector(step, {
    appIdentifier,
    env,
    driverSession = null,
    windowId = null,
    runCli = runActivitySurfacesMcpCli,
    isSelectorVisibleByDomQuery = isSelectorPresentByDomQuery,
    probeRootState = probeActivitySurfacesRootState,
} = {}) {
    const resolvedWindowId = windowId ?? step?.windowId ?? null;
    const selectors = Array.isArray(step?.selectors) ? step.selectors : [];
    let rootStateProbeStarted = false;
    let rootState = null;
    const getRootState = async () => {
        if (rootStateProbeStarted) {
            return rootState;
        }
        rootStateProbeStarted = true;
        if (typeof probeRootState !== 'function') {
            return null;
        }
        rootState = await probeRootState({
            appIdentifier,
            env,
            driverSession,
            windowId: resolvedWindowId,
            timeoutMs: domQueryFallbackProbeTimeoutMs,
        }).catch(() => null);
        return rootState;
    };

    for (const selector of selectors) {
        if (!readString(selector)) {
            continue;
        }
        let selectorWaitMatched = false;
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
                    selector,
                    '--timeout',
                    String(selectorWaitMs),
                    '--app-identifier',
                    String(appIdentifier),
                ],
                { appIdentifier, env, driverSession, windowId: resolvedWindowId, timeoutMs: cliSelectorWaitTimeoutMs },
            );
            selectorWaitMatched = true;
        } catch {
            // Fall through to the DOM-query fallback below.
        }

        try {
            // eslint-disable-next-line no-await-in-loop
            const domConfirmed = await isSelectorVisibleByDomQuery(selector, {
                appIdentifier,
                env,
                driverSession,
                windowId: resolvedWindowId,
                timeoutMs: domQueryFallbackProbeTimeoutMs,
            });
            if (domConfirmed === true) {
                return selector;
            }
        } catch {
            // try the next selector
        }

        const rootStateConfirmedSelector = resolveActivitySurfacesStepSelectorFromRootState(
            { ...step, selectors: [selector] },
            await getRootState(),
        );
        if (rootStateConfirmedSelector) {
            return rootStateConfirmedSelector;
        }

        if (selectorWaitMatched) {
            continue;
        }
    }

    throw new Error(`Unable to find a matching selector for step ${step.id}: ${step.selectors.join(', ')}`);
}

function resolveSelectorPresenceCommandTimeoutMs(timeoutMs) {
    const requestedTimeoutMs = Number(timeoutMs);
    if (!Number.isFinite(requestedTimeoutMs) || requestedTimeoutMs <= 0) {
        return selectorPresenceCliMinimumTimeoutMs;
    }

    return Math.max(selectorPresenceCliMinimumTimeoutMs, requestedTimeoutMs + selectorPresenceCliGraceMs);
}

export async function isSelectorPresent(selector, {
    appIdentifier,
    env,
    driverSession = null,
    windowId = null,
    timeoutMs = 1_200,
    throwOnTransientDisconnect = false,
    runCli = runActivitySurfacesMcpCli,
} = {}) {
    try {
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
            {
                appIdentifier,
                env,
                driverSession,
                windowId,
                timeoutMs: resolveSelectorPresenceCommandTimeoutMs(timeoutMs),
            },
        );
        return true;
    } catch (error) {
        if (throwOnTransientDisconnect && isTransientWebviewConnectionError(error)) {
            throw error;
        }
        return false;
    }
}

export async function isSelectorPresentByDomQuery(selector, {
    appIdentifier,
    env,
    driverSession = null,
    windowId = null,
    timeoutMs = domQueryFallbackProbeTimeoutMs,
    runCli = runActivitySurfacesMcpCli,
} = {}) {
    try {
        const response = await runCli(
            [
                'webview-execute-js',
                '--script',
                `(() => {
                    const selector = ${JSON.stringify(String(selector))};
                    try {
                        return document.querySelector(selector) !== null;
                    } catch {
                        return false;
                    }
                })()`,
                '--app-identifier',
                String(appIdentifier),
                '--json',
            ],
            {
                appIdentifier,
                env,
                driverSession,
                windowId,
                timeoutMs,
            },
        );
        return parseBooleanFromCommandOutput(String(response.stdout ?? ''));
    } catch {
        return false;
    }
}

async function clickSelector(selector, { appIdentifier, env, driverSession = null, windowId = null } = {}) {
    return clickActivitySurfacesSelector(selector, { appIdentifier, env, driverSession, windowId });
}

export async function setActivitySurfacesOverlayExpanded(
    expanded,
    {
        appIdentifier,
        env,
        driverSession = null,
        windowId = 'main',
        mainWindowId = 'main',
        runCli = runActivitySurfacesMcpCli,
    } = {},
) {
    const expandedLiteral = expanded === true ? 'true' : 'false';

    // Best-effort: keep the main window's analytics/runtime state in sync with the overlay's
    // expanded/collapsed change, but do not block the overlay capture run on it.
    try {
        await runCli(
            [
                'webview-execute-js',
                '--script',
                `(async () => {
                    const expanded = ${expandedLiteral};
                    try {
                        await window.__TAURI__.core.invoke('desktop_activity_overlay_emit_interaction', {
                            payload: {
                                actionIdentifier: 'overlay-set-expanded',
                                data: { expanded },
                            },
                        });
                        return { ok: true, expanded };
                    } catch (error) {
                        return {
                            ok: false,
                            error: String(error && error.message ? error.message : error),
                        };
                    }
                })()`,
                '--app-identifier',
                String(appIdentifier),
                '--json',
            ],
            { appIdentifier, env, driverSession, windowId, timeoutMs: cliInteractTimeoutMs },
        );
    } catch {
        // Some states may still accept direct expansion without broadcasting to the main window.
    }

    // Important: perform the actual `set_expanded` from the main window to avoid deadlocks/timeouts
    // when the overlay webview is simultaneously resizing itself while the invoke call is in-flight.
    const response = await runCli(
        [
            'webview-execute-js',
            '--script',
            `(async () => {
                const expanded = ${expandedLiteral};
                try {
                    await window.__TAURI__.core.invoke('desktop_activity_overlay_set_expanded', {
                        expanded,
                    });
                    return { ok: true, expanded };
                } catch (error) {
                    return {
                        ok: false,
                        error: String(error && error.message ? error.message : error),
                    };
                }
            })()`,
            '--app-identifier',
            String(appIdentifier),
            '--json',
        ],
        { appIdentifier, env, driverSession, windowId: mainWindowId, timeoutMs: cliInteractTimeoutMs },
    );
    const payload = parseStructuredJsonPayload(String(response.stdout ?? ''));
    if (!payload || typeof payload !== 'object' || payload.ok !== true) {
        const reason = typeof payload?.error === 'string' && payload.error.trim()
            ? payload.error.trim()
            : 'overlay-expand-command-failed';
        throw new Error(`Unable to set desktop overlay expanded=${expanded === true}: ${reason}`);
    }
}

export async function getActivitySurfacesOverlayWindowState({
    appIdentifier,
    env,
    driverSession = null,
    windowId = 'activity_overlay',
    runCli = runActivitySurfacesMcpCli,
    timeoutMs = cliInteractTimeoutMs,
} = {}) {
    const response = await runCli(
        [
            'webview-execute-js',
            '--script',
            `(async () => {
                try {
                    const state = await window.__TAURI__.core.invoke('desktop_activity_overlay_get_window_state');
                    return { ok: true, state };
                } catch (error) {
                    return {
                        ok: false,
                        error: String(error && error.message ? error.message : error),
                    };
                }
            })()`,
            '--app-identifier',
            String(appIdentifier),
            '--json',
        ],
        { appIdentifier, env, driverSession, windowId, timeoutMs },
    );

    const payload = parseStructuredJsonPayload(String(response.stdout ?? ''));
    if (!payload || typeof payload !== 'object' || payload.ok !== true) {
        const reason = typeof payload?.error === 'string' && payload.error.trim()
            ? payload.error.trim()
            : 'overlay-get-window-state-failed';
        throw new Error(`Unable to read desktop overlay window state: ${reason}`);
    }
    return payload.state ?? null;
}

export async function seedActivitySurfacesOverlayProofState({
    mode,
    appIdentifier,
    env,
    artifactRoot,
    driverSession = null,
    windowId = 'main',
    runCli = runActivitySurfacesMcpCli,
} = {}) {
    const normalizedMode = readString(mode);
    if (!normalizedMode) {
        throw new Error('Desktop overlay proof-state seed mode is required.');
    }

    const response = await runCli(
        [
            'webview-execute-js',
            '--script',
            `(async () => {
                const mcp = window.__MCP__;
                if (!mcp || typeof mcp.seedDesktopActivityOverlayQaState !== 'function') {
                    return { ok: false, reason: 'missing-seed-helper' };
                }
                try {
                    return await mcp.seedDesktopActivityOverlayQaState(${JSON.stringify(normalizedMode)});
                } catch (error) {
                    return {
                        ok: false,
                        reason: String(error && error.message ? error.message : error),
                    };
                }
            })()`,
            '--app-identifier',
            String(appIdentifier),
            '--json',
        ],
        { appIdentifier, env, driverSession, windowId, timeoutMs: cliInteractTimeoutMs },
    );
    const payload = parseStructuredJsonPayload(String(response.stdout ?? ''));
    if (payload?.ok !== true && artifactRoot) {
        await appendWarning(
            artifactRoot,
            `- overlay proof-state seed ${normalizedMode} failed: ${readString(payload?.reason, 'unknown')}`,
        );
    }
    return payload ?? { ok: false, reason: 'invalid-seed-response', mode: normalizedMode };
}

export async function clickActivitySurfacesSelector(
    selector,
    {
        appIdentifier,
        env,
        driverSession = null,
        windowId = null,
        runCli = runActivitySurfacesMcpCli,
        wait = delay,
    } = {},
) {
    const normalizedSelector = normalizeActivitySurfacesSelector(selector);
    for (let attempt = 1; attempt <= selectorClickRetryAttempts; attempt += 1) {
        const response = await runCli(
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
                        setTimeout(() => {
                            try {
                                element.click();
                            } catch {
                                // The follow-up preflight/capture step owns verifying the resulting UI state.
                            }
                        }, 0);
                        return { ok: true, selector, deferred: true };
                    }
                    return { ok: false, reason: 'missing-click', selector };
                })()`,
                '--app-identifier',
                String(appIdentifier),
                '--json',
            ],
            { appIdentifier, env, driverSession, windowId, timeoutMs: cliInteractTimeoutMs },
        );

        const payload = parseStructuredJsonPayload(String(response.stdout ?? ''));
        if (payload?.ok === true) {
            return;
        }

        const shouldRetry = payload == null || payload?.reason === 'missing-element';
        if (!shouldRetry) {
            const reason = typeof payload?.reason === 'string' && payload.reason.trim()
                ? payload.reason.trim()
                : 'unknown-click-failure';
            throw new Error(`Unable to click selector ${normalizedSelector}: ${reason}`);
        }

        if (attempt < selectorClickRetryAttempts) {
            // eslint-disable-next-line no-await-in-loop
            await wait(selectorClickRetryDelayMs);
        }
    }

    throw new Error(`Unable to click selector ${normalizedSelector}: missing-element`);
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

export async function resolveActivitySurfacesStackBootCredentials({
    env = process.env,
    runStackAuthStatus = runActivitySurfacesStackAuthStatus,
    readCredentialFile = async (path) => await readFile(path, 'utf8'),
} = {}) {
    const stackEnv = resolveActivitySurfacesStackCliEnv(env);
    const stackName = readString(stackEnv.HAPPIER_STACK_STACK);
    if (!stackName) {
        return null;
    }

    const status = await runStackAuthStatus({ env: stackEnv, stackName });
    const accessKeyPath = readString(status?.auth?.accessKeyPath);
    if (status?.auth?.ok !== true || !accessKeyPath) {
        return null;
    }

    const rawCredentials = await readCredentialFile(accessKeyPath);
    const parsedCredentials = parseStructuredJsonPayload(String(rawCredentials ?? ''));
    if (!isStackBootAuthCredentials(parsedCredentials)) {
        throw new Error('The stack access.key file did not contain valid stack boot credentials.');
    }

    const rawCandidatePaths = Array.isArray(status?.auth?.accessKeyPaths) && status.auth.accessKeyPaths.length > 0
        ? status.auth.accessKeyPaths
        : [accessKeyPath];
    const authStorageKeys = [];
    const seenKeys = new Set();
    for (const candidatePath of rawCandidatePaths) {
        const scopeToken = deriveScopeTokenFromAccessKeyPath(candidatePath);
        const candidateKeys = scopeToken
            ? [
                buildServerScopedAuthStorageKey(scopeToken, ''),
                buildServerScopedAuthStorageKey(normalizeStorageScope(scopeToken), ''),
            ]
            : ['auth_credentials'];
        for (const key of candidateKeys) {
            if (!key || seenKeys.has(key)) {
                continue;
            }
            seenKeys.add(key);
            authStorageKeys.push(key);
        }
    }

    const primaryAuthStorageKey = buildServerScopedAuthStorageKey(
        deriveScopeTokenFromAccessKeyPath(accessKeyPath) || readString(stackEnv.HAPPIER_ACTIVE_SERVER_ID),
        '',
    ) || authStorageKeys[0] || 'auth_credentials';
    if (!seenKeys.has(primaryAuthStorageKey)) {
        authStorageKeys.unshift(primaryAuthStorageKey);
    }

    return {
        authStorageKey: primaryAuthStorageKey,
        authStorageKeys,
        credentials: parsedCredentials,
        internalServerUrl: readString(status?.internalServerUrl),
    };
}

function buildPersistActivitySurfacesAuthScript({ authStorageKeys, credentials }) {
    return `(() => {
        try {
            const storage = window.localStorage;
            if (!storage || typeof storage.setItem !== 'function') {
                return { ok: false, reason: 'missing-storage' };
            }
            const keys = ${JSON.stringify(authStorageKeys)};
            const raw = JSON.stringify(${JSON.stringify(credentials)});
            for (const key of keys) {
                if (typeof key === 'string' && key.trim()) {
                    storage.setItem(key, raw);
                }
            }
            return { ok: true, appliedKeys: keys };
        } catch (error) {
            return {
                ok: false,
                reason: 'persist-failed',
                error: String(error && error.message ? error.message : error),
            };
        }
    })()`;
}

export async function seedActivitySurfacesAuthFromStackCredentials({
    appIdentifier,
    env,
    artifactRoot,
    driverSession = null,
    windowId = 'main',
    resolveStackCredentials = resolveActivitySurfacesStackBootCredentials,
    runCli = runActivitySurfacesMcpCli,
    navigateWebview = navigateWebviewToPath,
    waitForAuthCompletion = waitForActivitySurfacesAuthCompletion,
    appendWarning: appendWarningArtifact = appendWarning,
    wait = delay,
} = {}) {
    let resolved = null;
    try {
        resolved = await resolveStackCredentials({ env });
    } catch (error) {
        await appendWarningArtifact(
            artifactRoot,
            `- activity-surfaces QA could not resolve stack boot credentials automatically: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
    }

    if (!resolved) {
        return false;
    }

    const response = await runCli(
        [
            'webview-execute-js',
            '--script',
            buildPersistActivitySurfacesAuthScript({
                authStorageKeys: resolved.authStorageKeys,
                credentials: resolved.credentials,
            }),
            '--app-identifier',
            String(appIdentifier),
            '--json',
        ],
        { appIdentifier, env, driverSession, windowId, timeoutMs: cliInteractTimeoutMs },
    );
    const payload = parseStructuredJsonPayload(String(response.stdout ?? ''));
    if (!payload || typeof payload !== 'object' || payload.ok !== true) {
        await appendWarningArtifact(
            artifactRoot,
            '- activity-surfaces QA could not persist stack boot credentials into the Tauri webview storage',
        );
        return false;
    }

    await wait(authRestorePostSubmitPollDelayMs);
    await navigateWebview('/settings/desktop', {
        appIdentifier,
        env,
        driverSession,
        windowId,
        forceReload: true,
    });

    return await waitForAuthCompletion({
        appIdentifier,
        env,
        driverSession,
        windowId,
        wait,
    });
}

export async function seedActivitySurfacesAuthWithStackBootCredentials(options = {}) {
    return seedActivitySurfacesAuthFromStackCredentials(options);
}

export async function restoreActivitySurfacesAuth({
    seedStackAuth = seedActivitySurfacesAuthFromStackCredentials,
    seedStackBootCredentials = null,
    restoreWithDevKey = restoreActivitySurfacesAuthWithDevKey,
    ...options
} = {}) {
    const seed = typeof seedStackBootCredentials === 'function' ? seedStackBootCredentials : seedStackAuth;
    if (typeof seed === 'function' && await seed(options)) {
        return true;
    }
    return restoreWithDevKey(options);
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
    for (let attempt = 1; attempt <= authRestorePostSubmitPollAttempts; attempt += 1) {
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
                if (payload.hasSettingsShell === true || payload.hasSetupWizard === true) {
                    return true;
                }
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
    isSelectorPresentByDomQuery: isSelectorPresentByDom = isSelectorPresentByDomQuery,
    wait = delay,
    waitForAuthCompletion = waitForActivitySurfacesAuthCompletion,
    appendWarning: appendWarningArtifact = appendWarning,
    resolveRestoreSecret = resolveActivitySurfacesRestoreSecretKey,
} = {}) {
    async function waitForVisibleSelector(
        selector,
        { attempts = 6, delayMs = 350, timeoutMs = 2_500, allowDomQueryFallback = false } = {},
    ) {
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

        if (allowDomQueryFallback) {
            return isSelectorPresentByDom(selector, {
                appIdentifier,
                env,
                driverSession,
                windowId,
                timeoutMs: domQueryFallbackProbeTimeoutMs,
            });
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
        let welcomeVisible = await waitForVisibleSelector(authRestoreWelcomeSelector, {
            allowDomQueryFallback: true,
        });
        if (!welcomeVisible) {
            const authWelcomeVisible = await waitForVisibleSelector(authWelcomeShellSelector, {
                attempts: 1,
                timeoutMs: 1_200,
            });
            if (authWelcomeVisible) {
                const authSkipVisible = await waitForVisibleSelector(authWelcomeSkipSelector, {
                    attempts: 1,
                    timeoutMs: 1_200,
                });
                if (authSkipVisible) {
                    await click(authWelcomeSkipSelector, { appIdentifier, env, driverSession, windowId });
                    welcomeVisible = await waitForVisibleSelector(authRestoreWelcomeSelector, {
                        allowDomQueryFallback: true,
                    });
                    if (!welcomeVisible) {
                        await navigateWebview('/restore/manual', {
                            appIdentifier,
                            env,
                            driverSession,
                            windowId,
                        });
                        manualInputVisible = await waitForVisibleSelector(authRestoreSecretInputSelector, {
                            attempts: 10,
                            delayMs: 500,
                            timeoutMs: 5_000,
                        });
                    }
                }
            }
        }
        if (welcomeVisible) {
            await click(authRestoreWelcomeSelector, { appIdentifier, env, driverSession, windowId });
            manualInputVisible = await waitForVisibleSelector(authRestoreSecretInputSelector, {
                attempts: 3,
                delayMs: 350,
                timeoutMs: 2_500,
            });
        }
        if (!manualInputVisible) {
            const manualEntryVisible = await waitForVisibleSelector(authRestoreOpenManualSelector, {
                allowDomQueryFallback: true,
            });
            if (manualEntryVisible) {
                await click(authRestoreOpenManualSelector, { appIdentifier, env, driverSession, windowId });
                manualInputVisible = await waitForVisibleSelector(authRestoreSecretInputSelector, {
                    attempts: 10,
                    delayMs: 500,
                    timeoutMs: 5_000,
                });
            } else {
                await navigateWebview('/restore/manual', {
                    appIdentifier,
                    env,
                    driverSession,
                    windowId,
                });
                manualInputVisible = await waitForVisibleSelector(authRestoreSecretInputSelector, {
                    attempts: 10,
                    delayMs: 500,
                    timeoutMs: 5_000,
                });
            }
        }
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

    await navigateWebview('/settings/desktop', {
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

function isAccessibilitySnapshotOptionalFailure(error) {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return /aria-api library not loaded/i.test(message)
        || /Unable to resolve a connected Tauri app identifier/i.test(message)
        || /No active session\./i.test(message)
        || /Not connected to plugin and reconnection failed/i.test(message)
        || (/Command timed out/i.test(message) && /webview-dom-snapshot --type accessibility/i.test(message));
}

export async function captureSnapshotArtifacts({
    screenshotPath,
    structurePath,
    a11yPath,
    label,
    appIdentifier,
    env,
    driverSession = null,
    windowId = null,
    snapshotSelector = null,
    beforeScreenshotCapture = null,
    beforeStructureCapture = null,
    beforeAccessibilityCapture = null,
    runCli = runActivitySurfacesMcpCli,
    writeArtifact = writeTextArtifact,
}) {
    await withRetries(
        `screenshot:${label}`,
        async () => {
            if (typeof beforeScreenshotCapture === 'function') {
                await beforeScreenshotCapture();
            }
            return runCli(
                [
                    'webview-screenshot',
                    '--format',
                    'png',
                    '--file-path',
                    screenshotPath,
                    '--app-identifier',
                    String(appIdentifier),
                ],
                { appIdentifier, env, driverSession, windowId, timeoutMs: cliInteractTimeoutMs },
            );
        },
        { attempts: 3, delayMs: 350 },
    );

    const structure = await withRetries(
        `dom-structure:${label}`,
        async () => {
            if (typeof beforeStructureCapture === 'function') {
                await beforeStructureCapture();
            }
            return captureActivitySurfacesDomSnapshot({
                type: 'structure',
                appIdentifier,
                selector: snapshotSelector,
                windowId,
                env,
                driverSession,
                runCli,
            });
        },
        { attempts: 2, delayMs: 250 },
    );
    await writeArtifact(structurePath, String(structure.stdout ?? ''));

    try {
        const accessibility = await withRetries(
            `dom-accessibility:${label}`,
            async () => {
                if (typeof beforeAccessibilityCapture === 'function') {
                    await beforeAccessibilityCapture();
                }
                return captureActivitySurfacesDomSnapshot({
                    type: 'accessibility',
                    appIdentifier,
                    selector: snapshotSelector,
                    windowId,
                    env,
                    driverSession,
                    runCli,
                });
            },
            { attempts: 2, delayMs: 250 },
        );
        await writeArtifact(a11yPath, String(accessibility.stdout ?? ''));
    } catch (error) {
        if (!isAccessibilitySnapshotOptionalFailure(error)) {
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error ?? '');
        await writeArtifact(
            a11yPath,
            `# accessibility snapshot unavailable\n${message}\n`,
        );
    }

    return {
        screenshotPath,
        structurePath,
        a11yPath,
    };
}

async function captureStep(step, {
    artifactRoot,
    appIdentifier,
    env,
    driverSession = null,
    matchedSelector = null,
    windowId = null,
    snapshotSelector = undefined,
    beforeScreenshotCapture = null,
    beforeStructureCapture = null,
    beforeAccessibilityCapture = null,
}) {
    return captureSnapshotArtifacts({
        screenshotPath: join(artifactRoot, step.screenshot),
        structurePath: join(artifactRoot, step.domStructure),
        a11yPath: join(artifactRoot, step.domAccessibility),
        label: step.id,
        appIdentifier,
        env,
        driverSession,
        windowId: windowId ?? step.windowId ?? null,
        snapshotSelector: snapshotSelector !== undefined ? snapshotSelector : (step.snapshotSelector ?? matchedSelector),
        beforeScreenshotCapture,
        beforeStructureCapture,
        beforeAccessibilityCapture,
    });
}

async function appendWarning(artifactRoot, text) {
    const warningPath = join(artifactRoot, '98-warnings.md');
    await appendTextArtifact(warningPath, `${text.trim()}\n`);
}

async function appendActivitySurfacesQaStageTrace(
    artifactRoot,
    entry,
    {
        appendArtifact = appendTextArtifact,
        now = () => new Date().toISOString(),
    } = {},
) {
    const tracePath = join(artifactRoot, '00-stage-trace.jsonl');
    const payload = {
        ts: now(),
        ...entry,
    };
    await appendArtifact(tracePath, `${JSON.stringify(payload)}\n`);
    return tracePath;
}

async function appendTrackerEvidence({
    trackerPath,
    artifactRoot,
    stepArtifacts,
    driverSession,
    driverSessionStatus,
    backendState,
    seededSessionPath = null,
    planPath = premiumFinalizationPlanPath,
}) {
    const lines = [
        '',
        `- ${new Date().toISOString().slice(0, 10)}: Tauri activity-surfaces QA captured for \`${planPath.replaceAll('\\', '/')}\` under \`${artifactRoot.replaceAll('\\', '/')}\`:`,
        `  - driver session: \`${driverSession.replaceAll('\\', '/')}\``,
        ...(driverSessionStatus ? [`  - status: \`${driverSessionStatus.replaceAll('\\', '/')}\``] : []),
        `  - backend state: \`${backendState.replaceAll('\\', '/')}\``,
        ...(seededSessionPath ? [`  - seeded session: \`${seededSessionPath.replaceAll('\\', '/')}\``] : []),
    ];

    for (const [stepId, artifacts] of Object.entries(stepArtifacts)) {
        lines.push(`  - ${stepId}:`);
        if (!artifacts || typeof artifacts !== 'object') {
            lines.push('    - missing: true');
            continue;
        }
        const screenshotPath = typeof artifacts.screenshotPath === 'string' ? artifacts.screenshotPath : null;
        const structurePath = typeof artifacts.structurePath === 'string' ? artifacts.structurePath : null;
        const a11yPath = typeof artifacts.a11yPath === 'string' ? artifacts.a11yPath : null;

        lines.push(`    - screenshot: ${screenshotPath ? `\`${screenshotPath.replaceAll('\\', '/')}\`` : 'missing'}`);
        lines.push(`    - structure: ${structurePath ? `\`${structurePath.replaceAll('\\', '/')}\`` : 'missing'}`);
        lines.push(`    - accessibility: ${a11yPath ? `\`${a11yPath.replaceAll('\\', '/')}\`` : 'missing'}`);
    }

    lines.push('');
    await appendTextArtifact(trackerPath, `${lines.join('\n')}\n`);
}

export function summarizeTauriActivitySurfacesQaProof({ stepArtifacts = {}, requiredStepIds = [] } = {}) {
    return summarizeQaStepArtifactsProof({
        stepArtifacts,
        requiredStepIds,
    });
}

async function persistDesktopOverlayLocalSetting({
    appIdentifier,
    env,
    driverSession = null,
    windowId = null,
    settingKey,
    targetLabel,
    targetValue,
    runCli = runActivitySurfacesMcpCli,
}) {
    const response = await runCli(
        [
            'webview-execute-js',
            '--script',
            buildPersistDesktopOverlayLocalSettingScript({
                settingKey,
                targetLabel,
                targetValue,
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
        throw new Error(`Unable to persist desktop overlay setting ${settingKey}.${reason}`);
    }
    return payload;
}

export async function enableDesktopOverlayIfNeeded({
    appIdentifier,
    env,
    artifactRoot,
    driverSession = null,
    windowId = null,
    runCli = runActivitySurfacesMcpCli,
    writeArtifact = writeTextArtifact,
    appendWarning: appendWarningArtifact = appendWarning,
}) {
    let payload;
    try {
        payload = await persistDesktopOverlayLocalSetting({
            appIdentifier,
            env,
            driverSession,
            windowId,
            settingKey: 'desktopOverlayEnabled',
            targetLabel: 'Enabled',
            targetValue: true,
            runCli,
        });
    } catch (error) {
        if (artifactRoot) {
            await appendWarningArtifact(
                artifactRoot,
                `- unable to auto-enable desktop overlay from settings: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        throw error instanceof Error ? error : new Error(String(error));
    }
    if (artifactRoot) {
        try {
            await writeArtifact(
                join(artifactRoot, '99-overlay-enable.desktopOverlayEnabled.json'),
                `${JSON.stringify(payload, null, 2)}\n`,
            );
        } catch {
            // Best-effort diagnostics only.
        }
        const via = typeof payload.via === 'string' ? payload.via : null;
        if (via && via !== 'mcp-bridge') {
            await appendWarningArtifact(artifactRoot, `- desktop overlay enablement used fallback channel (${via}); overlay sync may not run`);
        }
        const bridgeResult = payload.bridgeResult && typeof payload.bridgeResult === 'object' ? payload.bridgeResult : null;
        if (bridgeResult && bridgeResult.overlaySyncOk === false) {
            const err = typeof bridgeResult.overlaySyncError === 'string' && bridgeResult.overlaySyncError.trim().length > 0
                ? bridgeResult.overlaySyncError.trim()
                : 'unknown';
            await appendWarningArtifact(artifactRoot, `- desktop overlay enablement flush reported failure: ${err}`);
        }
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
        const payload = await persistDesktopOverlayLocalSetting({
            appIdentifier,
            env,
            driverSession,
            windowId,
            settingKey: 'desktopOverlayVisibilityMode',
            targetLabel: label,
            targetValue: visibilityMode,
            runCli,
        });
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

export async function enableDesktopOverlayPresentationMode({
    appIdentifier,
    env,
    artifactRoot,
    driverSession = null,
    presentationMode = 'automatic',
    windowId = null,
    runCli = runActivitySurfacesMcpCli,
} = {}) {
    const label = desktopOverlayPresentationModeLabelByValue[presentationMode];
    if (!label) {
        throw new Error(`Unsupported desktop overlay presentation mode: ${String(presentationMode)}`);
    }

    try {
        const payload = await persistDesktopOverlayLocalSetting({
            appIdentifier,
            env,
            driverSession,
            windowId,
            settingKey: 'desktopOverlayPresentationMode',
            targetLabel: label,
            targetValue: presentationMode,
            runCli,
        });
        return payload.targetValue === presentationMode && payload.appliedValue === presentationMode;
    } catch (error) {
        if (artifactRoot) {
            await appendWarning(
                artifactRoot,
                `- unable to set desktop overlay presentation mode to ${presentationMode}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        throw error;
    }
}

export async function setActivitySurfacesDesktopOverlayAutoHideEnabled({
    appIdentifier,
    env,
    artifactRoot,
    driverSession = null,
    enabled,
    windowId = null,
    runCli = runActivitySurfacesMcpCli,
} = {}) {
    try {
        return await persistDesktopOverlayLocalSetting({
            appIdentifier,
            env,
            driverSession,
            windowId,
            settingKey: 'desktopOverlayAutoHideEnabled',
            targetLabel: enabled === true ? 'Enabled' : 'Disabled',
            targetValue: enabled === true,
            runCli,
        });
    } catch (error) {
        if (artifactRoot) {
            await appendWarning(
                artifactRoot,
                `- unable to ${enabled === true ? 'enable' : 'disable'} desktop overlay auto-hide: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        throw error;
    }
}

const notchNativeFrameTopEdgeTolerancePx = 4;

export function assertActivitySurfacesOverlayPlacementContract(
    overlayState,
    {
        expectedHostMode,
        expectedRequestedHostMode = null,
        expectedNativeHostPath = null,
        requireFallbackReason = false,
        requireNoFallbackReason = false,
        requireComputedTopEdge = false,
        requireAppliedNativeFrame = false,
        requireAppliedNativeFrameTopEdge = requireAppliedNativeFrame && expectedHostMode === 'notch_integrated',
        label = 'overlay',
    } = {},
) {
    const placementDiagnostics = overlayState?.placementDiagnostics;
    if (!placementDiagnostics || typeof placementDiagnostics !== 'object') {
        throw new Error(`Unable to validate ${label}: overlay placement diagnostics are unavailable.`);
    }
    if (
        expectedRequestedHostMode
        && placementDiagnostics.requestedHostMode !== expectedRequestedHostMode
    ) {
        throw new Error(
            `Unable to validate ${label}: expected requested host mode ${expectedRequestedHostMode}, received ${String(placementDiagnostics.requestedHostMode ?? 'unknown')}.`,
        );
    }
    if (placementDiagnostics.hostMode !== expectedHostMode) {
        throw new Error(
            `Unable to validate ${label}: expected ${expectedHostMode} host mode, received ${String(placementDiagnostics.hostMode ?? 'unknown')}.`,
        );
    }
    if (
        expectedNativeHostPath
        && placementDiagnostics.nativeHostPath !== expectedNativeHostPath
    ) {
        throw new Error(
            `Unable to validate ${label}: expected native host path ${expectedNativeHostPath}, received ${String(placementDiagnostics.nativeHostPath ?? 'unknown')}.`,
        );
    }
    if (requireFallbackReason && !readString(placementDiagnostics.hostFallbackReason)) {
        throw new Error(`Unable to validate ${label}: host fallback reason is missing for a degraded host state.`);
    }
    if (requireNoFallbackReason && readString(placementDiagnostics.hostFallbackReason)) {
        throw new Error(
            `Unable to validate ${label}: expected no host fallback reason, received ${String(placementDiagnostics.hostFallbackReason)}.`,
        );
    }

    if (requireComputedTopEdge) {
        const y = Number(placementDiagnostics.computedPosition?.y);
        if (!Number.isFinite(y) || Math.abs(y) > 0.5) {
            throw new Error(`Unable to validate ${label}: expected computed top-edge y=0, received ${String(placementDiagnostics.computedPosition?.y ?? 'unknown')}.`);
        }
    }

    if (requireAppliedNativeFrame) {
        const frame = placementDiagnostics.appliedNativeFrame;
        if (!frame || typeof frame !== 'object') {
            throw new Error(`Unable to validate ${label}: native frame diagnostics are unavailable.`);
        }
        const frameMetrics = [frame.x, frame.y, frame.width, frame.height];
        if (frameMetrics.some((value) => !Number.isFinite(Number(value)))) {
            throw new Error(`Unable to validate ${label}: native frame diagnostics are incomplete.`);
        }

        const screenFrame =
            placementDiagnostics.displayContext?.screenFrame ??
            placementDiagnostics.effectiveMonitor;
        const computedY = Number(placementDiagnostics.computedPosition?.y);
        const screenTopEdge = Number(screenFrame?.y) + Number(screenFrame?.height);
        const nativeTopEdge = Number(frame.y) + Number(frame.height);
        if (
            Number.isFinite(computedY) &&
            Number.isFinite(screenTopEdge) &&
            Number.isFinite(nativeTopEdge)
        ) {
            const expectedNativeTopEdge = screenTopEdge - computedY;
            if (
                Math.abs(nativeTopEdge - expectedNativeTopEdge) >
                notchNativeFrameTopEdgeTolerancePx
            ) {
                throw new Error(
                    `Unable to validate ${label}: expected native frame top edge near ${String(expectedNativeTopEdge)} (received ${String(nativeTopEdge)}, tolerance ${String(notchNativeFrameTopEdgeTolerancePx)}).`,
                );
            }
        } else if (expectedHostMode === 'notch_integrated') {
            throw new Error(`Unable to validate ${label}: target display frame diagnostics are unavailable.`);
        }
    }

    return placementDiagnostics;
}

function summarizeActivitySurfacesOverlayWindowState(overlayState) {
    const model = overlayState?.model && typeof overlayState.model === 'object'
        ? overlayState.model
        : null;
    const expandedModel = model?.expanded && typeof model.expanded === 'object'
        ? model.expanded
        : null;
    const cards = Array.isArray(expandedModel?.cards) ? expandedModel.cards : [];
    const rows = Array.isArray(expandedModel?.rows) ? expandedModel.rows : [];

    return {
        expanded: overlayState?.expanded === true || model?.isExpanded === true,
        primaryCardKind: model?.collapsed?.primaryCardKind
            ? normalizeDesktopActivityOverlayCardKindForTestID(model.collapsed.primaryCardKind)
            : null,
        cardKinds: cards.map((card) => normalizeDesktopActivityOverlayCardKindForTestID(card?.kind)),
        rowCount: rows.length,
        requestedHostMode: overlayState?.placementDiagnostics?.requestedHostMode ?? null,
        hostMode: overlayState?.placementDiagnostics?.hostMode ?? null,
        hostFallbackReason: overlayState?.placementDiagnostics?.hostFallbackReason ?? null,
        nativeHostPath: overlayState?.placementDiagnostics?.nativeHostPath ?? null,
        computedPosition: overlayState?.placementDiagnostics?.computedPosition ?? null,
        appliedNativeFrame: overlayState?.placementDiagnostics?.appliedNativeFrame ?? null,
    };
}

function assertActivitySurfacesOverlayStateContract(
    overlayState,
    expectedOverlayState,
    { label = 'overlay' } = {},
) {
    if (!expectedOverlayState || typeof expectedOverlayState !== 'object') {
        return summarizeActivitySurfacesOverlayWindowState(overlayState);
    }

    const summary = summarizeActivitySurfacesOverlayWindowState(overlayState);

    if (typeof expectedOverlayState.expanded === 'boolean' && summary.expanded !== expectedOverlayState.expanded) {
        throw new Error(
            `Unable to validate ${label}: expected expanded=${String(expectedOverlayState.expanded)}, received ${String(summary.expanded)}.`,
        );
    }
    if (
        expectedOverlayState.primaryCardKind
        && summary.primaryCardKind !== normalizeDesktopActivityOverlayCardKindForTestID(expectedOverlayState.primaryCardKind)
    ) {
        throw new Error(
            `Unable to validate ${label}: expected primary card kind ${String(expectedOverlayState.primaryCardKind)}, received ${String(summary.primaryCardKind ?? 'unknown')}.`,
        );
    }
    if (Array.isArray(expectedOverlayState.cardKinds)) {
        const expectedCardKinds = expectedOverlayState.cardKinds.map((kind) =>
            normalizeDesktopActivityOverlayCardKindForTestID(kind),
        );
        if (JSON.stringify(summary.cardKinds) !== JSON.stringify(expectedCardKinds)) {
            throw new Error(
                `Unable to validate ${label}: expected card kinds ${JSON.stringify(expectedCardKinds)}, received ${JSON.stringify(summary.cardKinds)}.`,
            );
        }
    }
    if (
        typeof expectedOverlayState.rowCount === 'number'
        && summary.rowCount !== expectedOverlayState.rowCount
    ) {
        throw new Error(
            `Unable to validate ${label}: expected rowCount=${String(expectedOverlayState.rowCount)}, received ${String(summary.rowCount)}.`,
        );
    }
    if (
        typeof expectedOverlayState.minRowCount === 'number'
        && summary.rowCount < expectedOverlayState.minRowCount
    ) {
        throw new Error(
            `Unable to validate ${label}: expected at least ${String(expectedOverlayState.minRowCount)} rows, received ${String(summary.rowCount)}.`,
        );
    }

    return summary;
}

function resolveActivitySurfacesOverlayNativeTopEdge(frame) {
    if (!frame || typeof frame !== 'object') {
        return null;
    }
    const y = Number(frame.y);
    const height = Number(frame.height);
    if (!Number.isFinite(y) || !Number.isFinite(height)) {
        return null;
    }
    return y + height;
}

function assertActivitySurfacesOverlayInteractionPlacementStable(
    beforeState,
    afterState,
    { label = 'overlay_interaction' } = {},
) {
    const beforeDiagnostics = beforeState?.placementDiagnostics;
    const afterDiagnostics = afterState?.placementDiagnostics;
    if (!beforeDiagnostics || !afterDiagnostics) {
        throw new Error(`Unable to validate ${label}: interaction placement diagnostics are unavailable.`);
    }
    const beforeY = Number(beforeDiagnostics.computedPosition?.y);
    const afterY = Number(afterDiagnostics.computedPosition?.y);
    if (Number.isFinite(beforeY) && Number.isFinite(afterY) && afterY > beforeY + 0.5) {
        throw new Error(
            `Unable to validate ${label}: overlay dropped below the menu-bar plane after interaction (${String(beforeY)} -> ${String(afterY)}).`,
        );
    }
    const beforeTopEdge = resolveActivitySurfacesOverlayNativeTopEdge(beforeDiagnostics.appliedNativeFrame);
    const afterTopEdge = resolveActivitySurfacesOverlayNativeTopEdge(afterDiagnostics.appliedNativeFrame);
    if (
        beforeTopEdge != null
        && afterTopEdge != null
        && Math.abs(afterTopEdge - beforeTopEdge) > notchNativeFrameTopEdgeTolerancePx
    ) {
        throw new Error(
            `Unable to validate ${label}: native frame top edge drifted after interaction (${String(beforeTopEdge)} -> ${String(afterTopEdge)}).`,
        );
    }
}

async function writeActivitySurfacesOverlayStepStateArtifact({
    artifactRoot,
    step,
    overlayState,
    screenshotPath = null,
    writeArtifact = writeTextArtifact,
}) {
    if (!artifactRoot || !step?.screenshot || !overlayState) {
        return null;
    }
    const diagnosticsPath = join(
        artifactRoot,
        String(step.screenshot).replace(/\.png$/i, '.window-state.json'),
    );
    const summary = summarizeActivitySurfacesOverlayWindowState(overlayState);
    await writeArtifact(
        diagnosticsPath,
        `${JSON.stringify({
            stepId: step.id,
            screenshotPath,
            expectedOverlayState: step.expectedOverlayState ?? null,
            expectedPlacement: step.expectedPlacement ?? null,
            overlayState: summary,
            placementDiagnostics: overlayState?.placementDiagnostics ?? null,
        }, null, 2)}\n`,
    );
    return diagnosticsPath;
}

function buildForcedNotchCaptureOverrides(hostMode) {
    if (hostMode !== 'floating') {
        return {
            collapsed: null,
            expanded: null,
        };
    }

    return {
        collapsed: {
            selectorOverride: '[data-testid="desktop-activity-overlay-collapsed-floating"]',
            snapshotSelector: '[data-testid="desktop-activity-overlay-collapsed-floating"]',
        },
        expanded: {
            selectorOverride: '[data-testid="desktop-activity-overlay-expanded-floating"]',
            snapshotSelector: '[data-testid="desktop-activity-overlay-expanded-floating"]',
        },
    };
}

async function findFirstVisibleActivitySurfacesStepSelector({
    step,
    appIdentifier,
    env,
    driverSession,
    isSelectorVisible,
    isSelectorVisibleByDomQuery,
}) {
    const selectors = Array.isArray(step?.selectors) ? step.selectors : [];

    for (const selector of selectors) {
        if (!readString(selector)) {
            continue;
        }
        let selectorWaitMatched = false;
        try {
            if (await isSelectorVisible(selector, {
                appIdentifier,
                env,
                driverSession,
                windowId: step?.windowId ?? null,
                timeoutMs: 1_200,
            })) {
                selectorWaitMatched = true;
            }
        } catch {}
        if (selectorWaitMatched) {
            try {
                if (await isSelectorVisibleByDomQuery(selector, {
                    appIdentifier,
                    env,
                    driverSession,
                    windowId: step?.windowId ?? null,
                    timeoutMs: domQueryFallbackProbeTimeoutMs,
                })) {
                    return selector;
                }
            } catch {}
            continue;
        }
        try {
            if (await isSelectorVisibleByDomQuery(selector, {
                appIdentifier,
                env,
                driverSession,
                windowId: step?.windowId ?? null,
                timeoutMs: domQueryFallbackProbeTimeoutMs,
            })) {
                return selector;
            }
        } catch {}
    }

    return null;
}

export async function runActivitySurfacesDesktopOverlayCaptureLane({
    appIdentifier,
    driverSession,
    env,
    artifactRoot,
    captureRequired,
    navigateToPath = navigateWebviewToPath,
    runCli = runActivitySurfacesMcpCli,
    openDesktopAppSettingsPage = openActivitySurfacesDesktopAppSettingsPage,
    probeRootState = probeActivitySurfacesRootState,
    isSelectorVisible = isSelectorPresent,
    isSelectorVisibleByDomQuery = isSelectorPresentByDomQuery,
    recoverAppCrash = recoverActivitySurfacesAppCrash,
    enableDesktopOverlay = enableDesktopOverlayIfNeeded,
    enableDesktopOverlayVisibility = enableDesktopOverlayVisibilityMode,
    setOverlayAutoHideEnabled = null,
    setOverlayPresentationMode = async () => true,
    setOverlayExpanded = setActivitySurfacesOverlayExpanded,
    seedOverlayProofState = seedActivitySurfacesOverlayProofState,
    getOverlayWindowState = null,
    clickCollapsedOverlay = clickSelector,
    captureUnscoped = null,
    writeArtifact = writeTextArtifact,
    appendWarning: appendWarningArtifact = appendWarning,
    wait = delay,
    visibilityMode = defaultDesktopOverlayVisibilityMode,
    postSettingsDelayMs = 500,
    postOverlayToggleDelayMs = 500,
    postEnableDelayMs = 750,
    postCollapseDelayMs = 600,
    presentationMode = 'automatic',
    seedStrategy = 'active_session',
}) {
    const requestedVisibilityMode = visibilityMode;
    const requestedPresentationMode = presentationMode;
    // Deterministic automation needs the overlay to be visible even when session heuristics would
    // hide it. We temporarily force the overlay visible for capture and restore the requested mode
    // afterwards (the capture runs against a dedicated QA stack).
    const overlayCaptureVisibilityMode = 'always_when_enabled';
    const shouldRestoreVisibilityMode = requestedVisibilityMode !== overlayCaptureVisibilityMode;
    let shouldRestoreAutoHide = false;
    let autoHideRestoreValue = true;

    const isOverlayRouteUnavailableError = (error) => {
        const message = error instanceof Error ? error.message : String(error ?? '');
        return message.includes('step overlay_route')
            || message.includes("Window 'activity_overlay' not found");
    };
    const proofStepsById = Object.fromEntries(buildStepPlan().map((step) => [step.id, step]));
    const desktopSettingsOpenSelectorProbeTraceFile = join(artifactRoot, '99-desktop-settings-open.selector-probes.jsonl');
    const traceDesktopSettingsSelectorProbe = async (entry) => {
        await appendTextArtifact(
            desktopSettingsOpenSelectorProbeTraceFile,
            `${JSON.stringify(entry)}\n`,
        );
    };

    const captureUnconfirmedSettingsArtifacts = async (reason) => {
        if (typeof captureUnscoped !== 'function') {
            return null;
        }
        if (artifactRoot) {
            await appendWarningArtifact(
                artifactRoot,
                `- capturing an unscoped settings overlay snapshot (${reason}) because the dedicated desktop settings page could not be confirmed`,
            );
        }
        try {
            return await captureUnscoped('settings_overlay');
        } catch (error) {
            if (artifactRoot) {
                await appendWarningArtifact(
                    artifactRoot,
                    `- unable to capture fallback settings overlay snapshot (${reason}): ${error instanceof Error ? error.message : String(error)}`,
                );
            }
            return null;
        }
    };
    const captureConfirmedSettingsArtifacts = async (reason) => {
        try {
            return await captureRequired('settings_overlay');
        } catch (error) {
            if (artifactRoot) {
                await appendWarningArtifact(
                    artifactRoot,
                    `- unable to capture scoped settings overlay snapshot (${reason}): ${error instanceof Error ? error.message : String(error)}`,
                );
            }
            const fallbackArtifacts = await captureUnconfirmedSettingsArtifacts(reason);
            if (fallbackArtifacts) {
                return fallbackArtifacts;
            }
            throw error;
        }
    };
    // Prefer real UI navigation over a raw pushState jump: it is less likely to strand the app on
    // the global crash recovery screen when the settings shell is mid-transition.
    const initialDesktopSettingsReady = await openDesktopAppSettingsPage({
        appIdentifier,
        driverSession,
        env,
        artifactRoot,
        traceSelectorProbe: traceDesktopSettingsSelectorProbe,
    }).catch(() => false);
    if (!initialDesktopSettingsReady) {
        await navigateToPath('/settings/desktop', {
            appIdentifier,
            driverSession,
            env,
            windowId: 'main',
            forceReload: true,
        });
    }
    await wait(postSettingsDelayMs);

    let settingsArtifacts = null;

    try {
        try {
            settingsArtifacts = await captureRequired('settings_overlay');
        } catch (error) {
            const routeStateAfterDesktopNavigate = await probeRootState({
                appIdentifier,
                driverSession,
                env,
                windowId: 'main',
                timeoutMs: cliInteractTimeoutMs,
            }).catch(() => null);
            let confirmedDesktopSettingsPage = isDesktopSettingsPageVisibleFromRootState(routeStateAfterDesktopNavigate);
            const desktopAppSettingsReady = await openDesktopAppSettingsPage({
                appIdentifier,
                driverSession,
                env,
                artifactRoot,
                traceSelectorProbe: traceDesktopSettingsSelectorProbe,
            });
            confirmedDesktopSettingsPage = confirmedDesktopSettingsPage || desktopAppSettingsReady;
            if (!confirmedDesktopSettingsPage) {
                const routeState = routeStateAfterDesktopNavigate ?? await probeRootState({
                    appIdentifier,
                    driverSession,
                    env,
                    windowId: 'main',
                    timeoutMs: cliInteractTimeoutMs,
                }).catch(() => null);
                confirmedDesktopSettingsPage = isDesktopSettingsPageVisibleFromRootState(routeState);
            }
            if (!confirmedDesktopSettingsPage) {
                let crashVisible = await isSelectorVisible(appCrashRestartSelector, {
                    appIdentifier,
                    env,
                    driverSession,
                    windowId: 'main',
                    timeoutMs: 1_200,
                }).catch(() => false);
                if (!crashVisible) {
                    crashVisible = await isSelectorVisibleByDomQuery(appCrashRestartSelector, {
                        appIdentifier,
                        env,
                        driverSession,
                        windowId: 'main',
                        timeoutMs: domQueryFallbackProbeTimeoutMs,
                    }).catch(() => false);
                }

                if (!crashVisible) {
                    if (artifactRoot) {
                        await appendWarningArtifact(
                            artifactRoot,
                            '- unable to confirm the dedicated desktop app settings page from the live settings shell; continuing with overlay capture so the rest of the native flow can still be validated',
                        );
                        try {
                            const rootState = await probeRootState({
                                appIdentifier,
                                driverSession,
                                env,
                                windowId: 'main',
                                timeoutMs: 2_000,
                            }).catch(() => null);
                            await writeDesktopSettingsOpenDiagnostics({
                                artifactRoot,
                                appIdentifier,
                                env,
                                driverSession,
                                windowId: 'main',
                                rootState,
                                selectorProbes: [],
                                writeArtifact,
                                reason: 'dedicated-settings-page-unconfirmed-before-recovery',
                                attemptedSettingsShellNavigation,
                            });
                    } catch {
                        // Best-effort diagnostics only.
                    }
                }
                    settingsArtifacts = await captureUnconfirmedSettingsArtifacts('unconfirmed-before-recovery');
                } else {
                    const recovered = await recoverAppCrash({
                        appIdentifier,
                        env,
                        artifactRoot,
                        driverSession,
                        windowId: 'main',
                    });
                    if (!recovered) {
                        throw error;
                    }

                    confirmedDesktopSettingsPage = await openDesktopAppSettingsPage({
                        appIdentifier,
                        driverSession,
                        env,
                        artifactRoot,
                        traceSelectorProbe: traceDesktopSettingsSelectorProbe,
                    });
                    if (!confirmedDesktopSettingsPage) {
                        if (artifactRoot) {
                            await appendWarningArtifact(
                                artifactRoot,
                                '- unable to confirm the dedicated desktop app settings page after recovery; continuing with overlay capture so the rest of the native flow can still be validated',
                            );
                            try {
                                const rootState = await probeRootState({
                                    appIdentifier,
                                    driverSession,
                                    env,
                                    windowId: 'main',
                                    timeoutMs: 2_000,
                                }).catch(() => null);
                                await writeDesktopSettingsOpenDiagnostics({
                                    artifactRoot,
                                    appIdentifier,
                                    env,
                                    driverSession,
                                    windowId: 'main',
                                    rootState,
                                    selectorProbes: [],
                                    writeArtifact,
                                    reason: 'dedicated-settings-page-unconfirmed-after-recovery',
                                    attemptedSettingsShellNavigation,
                                });
                            } catch {
                                // Best-effort diagnostics only.
                            }
                        }
                        settingsArtifacts = await captureUnconfirmedSettingsArtifacts('after-recovery');
                    } else {
                        settingsArtifacts = await captureConfirmedSettingsArtifacts('after-recovery');
                    }
                }
            } else {
                settingsArtifacts = await captureConfirmedSettingsArtifacts('confirmed-page');
            }
        }
    } catch (error) {
        throw new Error('Unable to open the dedicated desktop app settings page before overlay capture.', {
            cause: error,
        });
    }

    if (!settingsArtifacts) {
        settingsArtifacts = await captureUnconfirmedSettingsArtifacts('post-open');
    }

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
        visibilityMode: overlayCaptureVisibilityMode,
        windowId: 'main',
    });

    if (overlayVisibilityEnabled !== true) {
        const message = `desktop overlay visibility mode could not be switched to ${overlayCaptureVisibilityMode}; overlay capture may remain hidden`;
        await appendWarningArtifact(artifactRoot, `- ${message}`);
        throw new Error(message);
    }

    if (typeof setOverlayAutoHideEnabled === 'function') {
        try {
            const autoHidePayload = await setOverlayAutoHideEnabled({
                appIdentifier,
                driverSession,
                env,
                artifactRoot,
                enabled: false,
                windowId: 'main',
            });
            shouldRestoreAutoHide = true;
            autoHideRestoreValue = typeof autoHidePayload?.previousValue === 'boolean'
                ? autoHidePayload.previousValue
                : true;
        } catch (error) {
            await appendWarningArtifact(
                artifactRoot,
                `- unable to disable desktop overlay auto-hide for deterministic capture; expanded proof capture may collapse before artifacts are written: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    await wait(postEnableDelayMs);

    const waitForOverlayStateFromMainWindow = async ({
        attempts,
        delayMs,
        accept = (state) => state?.policy?.enabled === true,
        beforeAttempt = null,
    }) => {
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            if (typeof beforeAttempt === 'function') {
                // eslint-disable-next-line no-await-in-loop
                await beforeAttempt(attempt);
            }
            // eslint-disable-next-line no-await-in-loop
            const overlayState = await (typeof getOverlayWindowState === 'function'
                ? getOverlayWindowState({
                    appIdentifier,
                    driverSession,
                    env,
                    windowId: 'main',
                })
                : getActivitySurfacesOverlayWindowState({
                    appIdentifier,
                    driverSession,
                    env,
                    windowId: 'main',
                    runCli,
                })
            ).catch(() => null);
            if (accept(overlayState)) {
                return overlayState;
            }
            // eslint-disable-next-line no-await-in-loop
            await wait(delayMs);
        }
        return null;
    };

    const validateOverlayProofState = (stepId, overlayState, { placementOverride = null } = {}) => {
        const step = proofStepsById[stepId];
        if (!step) {
            throw new Error(`Unknown overlay proof step: ${String(stepId)}`);
        }

        const expectedPlacement = {
            ...(step.expectedPlacement ?? {}),
            ...(placementOverride ?? {}),
        };
        if (expectedPlacement.hostMode) {
            assertActivitySurfacesOverlayPlacementContract(overlayState, {
                expectedHostMode: expectedPlacement.hostMode,
                expectedRequestedHostMode: expectedPlacement.requestedHostMode ?? null,
                expectedNativeHostPath: expectedPlacement.nativeHostPath ?? null,
                requireFallbackReason: expectedPlacement.requireFallbackReason === true,
                requireNoFallbackReason: expectedPlacement.requireNoFallbackReason === true,
                requireComputedTopEdge: expectedPlacement.requireComputedTopEdge === true,
                requireAppliedNativeFrame: expectedPlacement.requireAppliedNativeFrame === true,
                label: stepId,
            });
        }
        if (step.expectedOverlayState) {
            assertActivitySurfacesOverlayStateContract(overlayState, step.expectedOverlayState, { label: stepId });
        }
        return summarizeActivitySurfacesOverlayWindowState(overlayState);
    };

    const lastObservedOverlayProofStateByStepId = new Map();

    const waitForValidatedOverlayProofState = async (stepId, {
        attempts = 8,
        delayMs = 350,
        placementOverride = null,
        beforeAttempt = null,
    } = {}) =>
        waitForOverlayStateFromMainWindow({
            attempts,
            delayMs,
            beforeAttempt,
            accept: (state) => {
                if (!state?.policy?.enabled) {
                    lastObservedOverlayProofStateByStepId.set(stepId, {
                        validationError: 'overlay-policy-disabled-or-missing',
                        summary: summarizeActivitySurfacesOverlayWindowState(state),
                    });
                    return false;
                }
                try {
                    validateOverlayProofState(stepId, state, { placementOverride });
                    lastObservedOverlayProofStateByStepId.delete(stepId);
                    return true;
                } catch (error) {
                    lastObservedOverlayProofStateByStepId.set(stepId, {
                        validationError: error instanceof Error ? error.message : String(error),
                        summary: summarizeActivitySurfacesOverlayWindowState(state),
                    });
                    return false;
                }
            },
        });

    const buildExpandedOverlayCaptureOptions = (step, captureOptions = {}) => {
        if (step?.expectedOverlayState?.expanded !== true) {
            return captureOptions;
        }
        if (step?.proofSeedMode) {
            return captureOptions;
        }

        const reassertExpandedState = async () => {
            try {
                await setOverlayExpanded(true, {
                    appIdentifier,
                    driverSession,
                    env,
                    windowId: 'main',
                });
                await wait(overlayExpandedCaptureStabilizationDelayMs);
            } catch (error) {
                await appendWarningArtifact(
                    artifactRoot,
                    `- unable to reassert expanded desktop overlay state before ${step.id} DOM proof capture: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        };

        return {
            ...captureOptions,
            beforeSelectorCapture: async () => {
                if (typeof captureOptions.beforeSelectorCapture === 'function') {
                    await captureOptions.beforeSelectorCapture();
                }
                await reassertExpandedState();
            },
            beforeScreenshotCapture: async () => {
                if (typeof captureOptions.beforeScreenshotCapture === 'function') {
                    await captureOptions.beforeScreenshotCapture();
                }
                await reassertExpandedState();
            },
            beforeStructureCapture: async () => {
                if (typeof captureOptions.beforeStructureCapture === 'function') {
                    await captureOptions.beforeStructureCapture();
                }
                await reassertExpandedState();
            },
            beforeAccessibilityCapture: async () => {
                if (typeof captureOptions.beforeAccessibilityCapture === 'function') {
                    await captureOptions.beforeAccessibilityCapture();
                }
                await reassertExpandedState();
            },
        };
    };

    const waitForSeededOverlayStepDomReadiness = async (step) => {
        const selectors = Array.isArray(step?.selectors)
            ? step.selectors.filter((selector) => readString(selector))
            : [];
        if (selectors.length === 0) {
            return null;
        }

        for (let attempt = 1; attempt <= overlayProofDomReadinessAttempts; attempt += 1) {
            const matchedSelector = await findFirstVisibleActivitySurfacesStepSelector({
                step,
                appIdentifier,
                env,
                driverSession,
                isSelectorVisible,
                isSelectorVisibleByDomQuery,
            });
            if (matchedSelector) {
                return matchedSelector;
            }
            if (attempt < overlayProofDomReadinessAttempts) {
                await wait(overlayProofDomReadinessDelayMs);
            }
        }

        throw new Error(
            `Seeded overlay proof selector never became visible for ${step.id}: ${selectors.join(', ')}`,
        );
    };

    const reseedOverlayProofStepState = async (step, { waitForDomReadiness = false } = {}) => {
        if (!step?.proofSeedMode) {
            return;
        }
        const seedResult = await seedOverlayProofState({
            mode: step.proofSeedMode,
            appIdentifier,
            driverSession,
            env,
            artifactRoot,
            windowId: 'main',
        });
        if (seedResult?.ok !== true) {
            throw new Error(`Unable to reseed overlay proof state ${String(step.proofSeedMode)} before ${step.id} capture: ${readString(seedResult?.reason, 'seed-proof-state-failed')}`);
        }
        await wait(overlayExpandedCaptureStabilizationDelayMs);
        if (waitForDomReadiness) {
            await waitForSeededOverlayStepDomReadiness(step);
        }
    };

    const buildSeededOverlayCaptureOptions = (step, captureOptions = {}) => {
        if (!step?.proofSeedMode) {
            return captureOptions;
        }

        return {
            ...captureOptions,
            beforeSelectorCapture: async () => {
                if (typeof captureOptions.beforeSelectorCapture === 'function') {
                    await captureOptions.beforeSelectorCapture();
                }
                await reseedOverlayProofStepState(step, { waitForDomReadiness: true });
            },
            beforeScreenshotCapture: async () => {
                if (typeof captureOptions.beforeScreenshotCapture === 'function') {
                    await captureOptions.beforeScreenshotCapture();
                }
                await reseedOverlayProofStepState(step, { waitForDomReadiness: true });
            },
            beforeStructureCapture: async () => {
                if (typeof captureOptions.beforeStructureCapture === 'function') {
                    await captureOptions.beforeStructureCapture();
                }
                await reseedOverlayProofStepState(step, { waitForDomReadiness: true });
            },
            beforeAccessibilityCapture: async () => {
                if (typeof captureOptions.beforeAccessibilityCapture === 'function') {
                    await captureOptions.beforeAccessibilityCapture();
                }
                await reseedOverlayProofStepState(step, { waitForDomReadiness: true });
            },
        };
    };

    const captureValidatedOverlayProofStep = async (stepId, captureOptions = {}, { overlayState, placementOverride = null } = {}) => {
        const step = proofStepsById[stepId];
        const resolvedState = overlayState ?? await waitForValidatedOverlayProofState(stepId, {
            placementOverride,
            beforeAttempt: step?.proofSeedMode
                ? () => reseedOverlayProofStepState(step)
                : null,
        });
        if (!resolvedState) {
            const lastObservedState = lastObservedOverlayProofStateByStepId.get(stepId);
            const lastObservedSuffix = lastObservedState
                ? ` Last observed state: ${JSON.stringify(lastObservedState)}.`
                : '';
            throw new Error(`Desktop overlay proof state never matched ${stepId}.${lastObservedSuffix}`);
        }
        validateOverlayProofState(stepId, resolvedState, { placementOverride });
        const resolvedCaptureOptions = buildSeededOverlayCaptureOptions(
            step,
            buildExpandedOverlayCaptureOptions(step, captureOptions),
        );
        const deterministicSelector = Array.isArray(step?.selectors) && step.selectors.length === 1
            ? readString(step.selectors[0])
            : '';
        const artifacts = await captureRequired(
            stepId,
            deterministicSelector && !resolvedCaptureOptions.selectorOverride
                ? {
                    ...resolvedCaptureOptions,
                    selectorOverride: deterministicSelector,
                    snapshotSelector: resolvedCaptureOptions.snapshotSelector ?? deterministicSelector,
                }
                : resolvedCaptureOptions,
        );
        await writeActivitySurfacesOverlayStepStateArtifact({
            artifactRoot,
            step,
            overlayState: resolvedState,
            screenshotPath: artifacts?.screenshotPath ?? null,
            writeArtifact,
        });
        return {
            artifacts,
            overlayState: resolvedState,
        };
    };

    let overlayState = await waitForOverlayStateFromMainWindow({ attempts: 10, delayMs: 500 });
    if (!overlayState) {
        // The QA harness can apply desktop settings via localStorage as a fallback when the in-app MCP bridge
        // is unavailable. That does not reliably notify the runtime store, so do a deterministic reload of
        // the main window after applying the overlay settings, then re-probe the overlay state.
        await navigateToPath('/settings/desktop', {
            appIdentifier,
            driverSession,
            env,
            windowId: 'main',
            forceReload: true,
        });
        await wait(postEnableDelayMs);
        overlayState = await waitForOverlayStateFromMainWindow({ attempts: 10, delayMs: 500 });
    }
    if (!overlayState) {
        throw new Error('Desktop overlay window state never became available after enabling the overlay.');
    }

    const recoverOverlayWindowIfMissing = async (error, context) => {
        if (!isOverlayRouteUnavailableError(error)) {
            return false;
        }
        await appendWarningArtifact(
            artifactRoot,
            `- overlay window unavailable (${context}); reapplying ${overlayCaptureVisibilityMode} and retrying`,
        );
        const ok = await enableDesktopOverlayVisibility({
            appIdentifier,
            driverSession,
            env,
            artifactRoot,
            visibilityMode: overlayCaptureVisibilityMode,
            windowId: 'main',
        }).catch(() => false);
        if (ok !== true) {
            return false;
        }
        // Best-effort: poke the overlay state machine from the main window. This forces the Rust
        // layer to re-apply the last sync payload and re-create/park the overlay window if it was
        // destroyed, without requiring the overlay window's CDP target to be present.
        try {
            await setOverlayExpanded(false, {
                appIdentifier,
                driverSession,
                env,
                windowId: 'main',
            });
        } catch {
            // Diagnostics only: the visibility mode restore is the actual recovery mechanism.
        }
        await wait(postEnableDelayMs);
        return true;
    };

    const navigateToOverlayRoute = async () => {
        await navigateToPath('/desktop/activity-overlay?desktopOverlayWindow=1', {
            appIdentifier,
            driverSession,
            env,
            windowId: 'activity_overlay',
            forceReload: true,
        });
    };
    const captureOverlayRouteArtifacts = async () => {
        await navigateToOverlayRoute();
        try {
            return await captureRequired('overlay_route');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error ?? '');
            const collapsedSelectorMiss = message.includes('step overlay_route')
                || message.includes('desktop-activity-overlay-collapsed')
                || message.includes('desktop-activity-overlay-expanded');
            if (!collapsedSelectorMiss) {
                throw error;
            }

            await appendWarningArtifact(
                artifactRoot,
                '- overlay route selector miss; dumping a full DOM snapshot and retrying the overlay route without a selector',
            );

            const rootState = await probeRootState({
                appIdentifier,
                driverSession,
                env,
                windowId: 'activity_overlay',
                timeoutMs: cliInteractTimeoutMs,
            }).catch(() => null);
            await writeOverlayRouteOpenDiagnostics({
                artifactRoot,
                appIdentifier,
                env,
                driverSession,
                rootState,
                writeArtifact,
                probeError: error,
            });

            const rootStateConfirmedSelector = resolveActivitySurfacesStepSelectorFromRootState(
                proofStepsById.overlay_route,
                rootState,
            );
            if (rootStateConfirmedSelector) {
                await appendWarningArtifact(
                    artifactRoot,
                    `- overlay route root-state confirmed selector ${rootStateConfirmedSelector}; retrying scoped capture`,
                );
                return await captureRequired('overlay_route', {
                    selectorOverride: rootStateConfirmedSelector,
                    snapshotSelector: rootStateConfirmedSelector,
                });
            }

            // Do not treat an unscoped overlay-route snapshot as a successful capture: later steps need the
            // collapsed/expanded overlay surfaces. Re-throw so the caller can switch visibility mode and retry.
            throw error;
        }
    };

    let overlayRouteArtifacts;
    try {
        overlayRouteArtifacts = await captureOverlayRouteArtifacts();
    } catch (error) {
        try {
            const rootState = await probeRootState({
                appIdentifier,
                driverSession,
                env,
                windowId: 'activity_overlay',
                timeoutMs: 2_000,
            }).catch(() => null);
            await writeArtifact(
                join(artifactRoot, '99-overlay-route-open.root-state.json'),
                `${JSON.stringify(rootState, null, 2)}\n`,
            );
            const structure = await runCli(
                buildActivitySurfacesDomSnapshotArgs({
                    type: 'structure',
                    appIdentifier,
                    selector: null,
                    windowId: 'activity_overlay',
                }),
                { appIdentifier, env, driverSession, windowId: 'activity_overlay', timeoutMs: cliInteractTimeoutMs },
            ).catch((structureError) => ({
                stdout: `error: ${structureError instanceof Error ? structureError.message : String(structureError)}\n`,
            }));
            await writeArtifact(
                join(artifactRoot, '99-overlay-route-open.structure.txt'),
                String(structure?.stdout ?? ''),
            );
        } catch {
            // Best-effort diagnostics only.
        }

        if (!isOverlayRouteUnavailableError(error)) {
            throw error;
        }

        const recovered = await recoverOverlayWindowIfMissing(error, 'overlay_route');
        if (!recovered) {
            throw error;
        }

        const fallbackOverlayState = await waitForOverlayStateFromMainWindow({ attempts: 10, delayMs: 500 });
        if (!fallbackOverlayState) {
            throw new Error('Desktop overlay window state never became available after reapplying the overlay visibility mode.', {
                cause: error,
            });
        }

        overlayRouteArtifacts = await captureOverlayRouteArtifacts();
    }

    const restoreRequestedOverlayPresentationMode = async () => {
        if (requestedPresentationMode === 'floating_overlay') {
            return;
        }
        try {
            const restored = await setOverlayPresentationMode({
                appIdentifier,
                driverSession,
                env,
                artifactRoot,
                presentationMode: requestedPresentationMode,
                windowId: 'main',
            });
            if (restored !== true) {
                await appendWarningArtifact(
                    artifactRoot,
                    `- unable to restore desktop overlay presentation mode to ${requestedPresentationMode} after capture`,
                );
            }
        } catch (error) {
            await appendWarningArtifact(
                artifactRoot,
                `- unable to restore desktop overlay presentation mode to ${requestedPresentationMode} after capture: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    };

    const restoreRequestedOverlayVisibilityMode = async () => {
        if (!shouldRestoreVisibilityMode) {
            return;
        }
        try {
            const restored = await enableDesktopOverlayVisibility({
                appIdentifier,
                driverSession,
                env,
                artifactRoot,
                visibilityMode: requestedVisibilityMode,
                windowId: 'main',
            });
            if (restored !== true) {
                await appendWarningArtifact(
                    artifactRoot,
                    `- unable to restore desktop overlay visibility mode to ${requestedVisibilityMode} after capture`,
                );
            }
        } catch (error) {
            await appendWarningArtifact(
                artifactRoot,
                `- unable to restore desktop overlay visibility mode to ${requestedVisibilityMode} after capture: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    };

    const restoreRequestedOverlayAutoHideSetting = async () => {
        if (!shouldRestoreAutoHide || typeof setOverlayAutoHideEnabled !== 'function') {
            return;
        }
        try {
            await setOverlayAutoHideEnabled({
                appIdentifier,
                driverSession,
                env,
                artifactRoot,
                enabled: autoHideRestoreValue,
                windowId: 'main',
            });
        } catch (error) {
            await appendWarningArtifact(
                artifactRoot,
                `- unable to restore desktop overlay auto-hide to ${autoHideRestoreValue === true ? 'enabled' : 'disabled'} after capture: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    };

    const optionalStepArtifacts = {};

    try {
        const notchPresentationApplied = await setOverlayPresentationMode({
            appIdentifier,
            driverSession,
            env,
            artifactRoot,
            presentationMode: 'notch_integrated',
            windowId: 'main',
        });
        if (notchPresentationApplied !== true) {
            throw new Error('Desktop overlay presentation mode could not be switched to notch_integrated for notch capture.');
        }
        await wait(postCollapseDelayMs);
        const notchOverlayState = await waitForOverlayStateFromMainWindow({
            attempts: 10,
            delayMs: 500,
            accept: (state) =>
                state?.policy?.enabled === true &&
                (
                    state?.placementDiagnostics?.hostMode === 'notch_integrated'
                    || state?.placementDiagnostics?.hostMode === 'floating'
                ),
        });
        if (!notchOverlayState) {
            throw new Error('Desktop overlay never reported placement diagnostics after forcing notch presentation mode.');
        }
        const forcedNotchHostMode = notchOverlayState.placementDiagnostics?.hostMode;
        const forcedNotchCaptureOverrides = buildForcedNotchCaptureOverrides(forcedNotchHostMode);
        if (forcedNotchHostMode === 'floating') {
            await appendWarningArtifact(
                artifactRoot,
                '- notch-integrated presentation resolved to floating host mode; capturing floating fallback geometry for the forced-notch steps',
            );
        }
        const notchPlacementOverride = {
            hostMode: forcedNotchHostMode,
            requestedHostMode: 'notch_integrated',
            nativeHostPath: forcedNotchHostMode === 'notch_integrated' ? 'panel' : 'window',
            requireFallbackReason: forcedNotchHostMode === 'floating',
            requireNoFallbackReason: forcedNotchHostMode === 'notch_integrated',
            requireComputedTopEdge: forcedNotchHostMode === 'notch_integrated',
            requireAppliedNativeFrame: forcedNotchHostMode === 'notch_integrated',
        };
        validateOverlayProofState('overlay_collapsed', notchOverlayState, {
            placementOverride: notchPlacementOverride,
        });

        // The overlay can persist an expanded state between launches. Force a collapsed baseline
        // so the `overlay_collapsed` capture step is deterministic.
        try {
            await setOverlayExpanded(false, {
                appIdentifier,
                driverSession,
                env,
                windowId: 'main',
            });
        } catch (error) {
            await appendWarningArtifact(
                artifactRoot,
                `- unable to force-collapse the desktop overlay before capture; continuing: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        await wait(postCollapseDelayMs);

        const collapsedNotchState = await waitForValidatedOverlayProofState('overlay_collapsed', {
            placementOverride: notchPlacementOverride,
        });
        if (!collapsedNotchState) {
            throw new Error('Desktop overlay never reached the collapsed notch proof state.');
        }

        let collapsedArtifacts;
        try {
            ({ artifacts: collapsedArtifacts } = await captureValidatedOverlayProofStep(
                'overlay_collapsed',
                forcedNotchCaptureOverrides.collapsed ?? undefined,
                {
                    overlayState: collapsedNotchState,
                    placementOverride: notchPlacementOverride,
                },
            ));
        } catch (error) {
            const recovered = await recoverOverlayWindowIfMissing(error, 'overlay_collapsed');
            if (!recovered) {
                throw error;
            }
            ({ artifacts: collapsedArtifacts } = await captureValidatedOverlayProofStep(
                'overlay_collapsed',
                forcedNotchCaptureOverrides.collapsed ?? undefined,
                {
                    placementOverride: notchPlacementOverride,
                },
            ));
        }

        let clickTriggeredExpansion = false;
        let notchExpandedViaClick = true;
        try {
            await clickCollapsedOverlay('[data-testid="desktop-activity-overlay-collapsed"]', {
                appIdentifier,
                driverSession,
                env,
                windowId: 'activity_overlay',
            });
            clickTriggeredExpansion = true;
        } catch (error) {
            notchExpandedViaClick = false;
            await appendWarningArtifact(
                artifactRoot,
                `- unable to click the collapsed desktop overlay before expanded proof capture; falling back to programmatic expansion: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        await setOverlayExpanded(true, {
            appIdentifier,
            driverSession,
            env,
            windowId: 'main',
        }).catch(async (setExpandedError) => {
            await appendWarningArtifact(
                artifactRoot,
                `- unable to force-expand the desktop overlay before capture${notchExpandedViaClick ? ' after the collapsed notch surface click' : ''}; continuing: ${setExpandedError instanceof Error ? setExpandedError.message : String(setExpandedError)}`,
            );
        });

        await wait(postCollapseDelayMs);
        let expandedNotchState = await waitForValidatedOverlayProofState('overlay_expanded', {
            placementOverride: notchPlacementOverride,
        });
        if (!expandedNotchState) {
            await setOverlayExpanded(true, {
                appIdentifier,
                driverSession,
                env,
                windowId: 'main',
            }).catch(async (error) => {
                await appendWarningArtifact(
                    artifactRoot,
                    `- unable to recover expanded desktop overlay state after click interaction: ${error instanceof Error ? error.message : String(error)}`,
                );
            });
            await wait(postCollapseDelayMs);
            expandedNotchState = await waitForValidatedOverlayProofState('overlay_expanded', {
                placementOverride: notchPlacementOverride,
            });
        }
        if (!expandedNotchState) {
            throw new Error('Desktop overlay never reached the expanded notch proof state.');
        }
        if (clickTriggeredExpansion) {
            assertActivitySurfacesOverlayInteractionPlacementStable(
                collapsedNotchState,
                expandedNotchState,
                { label: 'overlay_expanded' },
            );
        }
        let expandedArtifacts;
        try {
            ({ artifacts: expandedArtifacts } = await captureValidatedOverlayProofStep(
                'overlay_expanded',
                forcedNotchCaptureOverrides.expanded ?? undefined,
                {
                    overlayState: expandedNotchState,
                    placementOverride: notchPlacementOverride,
                },
            ));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error ?? '');
            const canCaptureUnscoped = typeof captureUnscoped === 'function'
                && message.includes('dom-structure:overlay_expanded')
                && message.includes('desktop-activity-overlay-expanded');
            if (canCaptureUnscoped) {
                expandedArtifacts = await captureUnscoped('overlay_expanded');
            } else {
                const recovered = await recoverOverlayWindowIfMissing(error, 'overlay_expanded');
                if (recovered) {
                    try {
                        ({ artifacts: expandedArtifacts } = await captureValidatedOverlayProofStep(
                            'overlay_expanded',
                            forcedNotchCaptureOverrides.expanded ?? undefined,
                            {
                                placementOverride: notchPlacementOverride,
                            },
                        ));
                    } catch {
                        // Fall through to the interactive click fallback.
                    }
                }

                if (!expandedArtifacts) {
                    let expandedViaCommand = true;
                    try {
                        await setOverlayExpanded(true, {
                            appIdentifier,
                            driverSession,
                            env,
                            windowId: 'main',
                        });
                    } catch (error) {
                        expandedViaCommand = false;
                        await appendWarningArtifact(
                            artifactRoot,
                            `- unable to recover overlay expansion through the programmatic expanded command; retrying with a collapsed-surface click: ${error instanceof Error ? error.message : String(error)}`,
                        );
                    }
                    if (!expandedViaCommand) {
                        await clickCollapsedOverlay('[data-testid="desktop-activity-overlay-collapsed"]', {
                            appIdentifier,
                            driverSession,
                            env,
                            windowId: 'activity_overlay',
                        });
                    }
                    await wait(postCollapseDelayMs);
                    ({ artifacts: expandedArtifacts } = await captureValidatedOverlayProofStep(
                        'overlay_expanded',
                        forcedNotchCaptureOverrides.expanded ?? undefined,
                        {
                            placementOverride: notchPlacementOverride,
                        },
                    ));
                }
            }
        }

        if (typeof getOverlayWindowState === 'function') {
            try {
                await getOverlayWindowState({
                    appIdentifier,
                    driverSession,
                    env,
                    windowId: 'activity_overlay',
                    timeoutMs: overlayWindowDiagnosticTimeoutMs,
                });
            } catch {
                // Best-effort diagnostics only; the expanded proof artifact is already captured.
            }
        }

        const floatingPresentationApplied = await setOverlayPresentationMode({
            appIdentifier,
            driverSession,
            env,
            artifactRoot,
            presentationMode: 'floating_overlay',
            windowId: 'main',
        });
        if (floatingPresentationApplied !== true) {
            throw new Error('Desktop overlay presentation mode could not be switched to floating_overlay for fallback capture.');
        }
        await wait(postCollapseDelayMs);
        const floatingOverlayState = await waitForOverlayStateFromMainWindow({
            attempts: 10,
            delayMs: 500,
            accept: (state) =>
                state?.policy?.enabled === true &&
                state?.placementDiagnostics?.hostMode === 'floating',
        });
        if (!floatingOverlayState) {
            throw new Error('Desktop overlay never reported floating placement diagnostics after forcing floating overlay presentation mode.');
        }
        const floatingPlacementOverride = {
            hostMode: 'floating',
            requestedHostMode: 'floating',
            nativeHostPath: 'window',
            requireNoFallbackReason: true,
        };
        assertActivitySurfacesOverlayPlacementContract(floatingOverlayState, {
            expectedHostMode: 'floating',
            expectedRequestedHostMode: 'floating',
            expectedNativeHostPath: 'window',
            requireNoFallbackReason: true,
            label: 'overlay_floating_fallback',
        });

        try {
            await setOverlayExpanded(false, {
                appIdentifier,
                driverSession,
                env,
                windowId: 'main',
            });
        } catch (error) {
            await appendWarningArtifact(
                artifactRoot,
                `- unable to force-collapse the desktop overlay before floating fallback capture; continuing: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        await wait(postCollapseDelayMs);

        const collapsedFloatingState = await waitForValidatedOverlayProofState('overlay_floating_fallback', {
            placementOverride: floatingPlacementOverride,
        });
        if (!collapsedFloatingState) {
            throw new Error('Desktop overlay never reached the collapsed floating proof state.');
        }

        let floatingFallbackArtifacts;
        try {
            ({ artifacts: floatingFallbackArtifacts } = await captureValidatedOverlayProofStep(
                'overlay_floating_fallback',
                {},
                {
                    overlayState: collapsedFloatingState,
                    placementOverride: floatingPlacementOverride,
                },
            ));
        } catch (error) {
            const recovered = await recoverOverlayWindowIfMissing(error, 'overlay_floating_fallback');
            if (!recovered) {
                throw error;
            }
            ({ artifacts: floatingFallbackArtifacts } = await captureValidatedOverlayProofStep(
                'overlay_floating_fallback',
                {},
                {
                    placementOverride: floatingPlacementOverride,
                },
            ));
        }

        let floatingExpandedViaClick = true;
        try {
            await clickCollapsedOverlay('[data-testid="desktop-activity-overlay-collapsed-floating"]', {
                appIdentifier,
                driverSession,
                env,
                windowId: 'activity_overlay',
            });
        } catch (clickError) {
            floatingExpandedViaClick = false;
            await appendWarningArtifact(
                artifactRoot,
                `- unable to expand the floating desktop overlay via the collapsed floating surface; retrying the programmatic expanded command: ${clickError instanceof Error ? clickError.message : String(clickError)}`,
            );
        }
        await setOverlayExpanded(true, {
            appIdentifier,
            driverSession,
            env,
            windowId: 'main',
        }).catch(async (error) => {
            await appendWarningArtifact(
                artifactRoot,
                `- unable to expand the floating desktop overlay before proof capture${floatingExpandedViaClick ? ' after the collapsed floating surface click' : ''}: ${error instanceof Error ? error.message : String(error)}`,
            );
        });
        await wait(postCollapseDelayMs);
        let floatingExpandedArtifacts;
        try {
            ({ artifacts: floatingExpandedArtifacts } = await captureValidatedOverlayProofStep('overlay_floating_expanded', {}, {
                placementOverride: floatingPlacementOverride,
            }));
        } catch (error) {
            const recovered = await recoverOverlayWindowIfMissing(error, 'overlay_floating_expanded');
            if (recovered) {
                try {
                    ({ artifacts: floatingExpandedArtifacts } = await captureValidatedOverlayProofStep('overlay_floating_expanded', {}, {
                        placementOverride: floatingPlacementOverride,
                    }));
                } catch {
                    // Fall through to the interactive click fallback.
                }
            }

            if (!floatingExpandedArtifacts) {
                try {
                    await clickCollapsedOverlay('[data-testid="desktop-activity-overlay-collapsed-floating"]', {
                        appIdentifier,
                        driverSession,
                        env,
                        windowId: 'activity_overlay',
                    });
                } catch (clickError) {
                    await appendWarningArtifact(
                        artifactRoot,
                        `- unable to recover floating overlay expansion via the collapsed floating surface; retrying the programmatic expanded command: ${clickError instanceof Error ? clickError.message : String(clickError)}`,
                    );
                }
                await setOverlayExpanded(true, {
                    appIdentifier,
                    driverSession,
                    env,
                    windowId: 'main',
                }).catch(async (setExpandedError) => {
                    await appendWarningArtifact(
                        artifactRoot,
                        `- unable to recover floating overlay expansion through the programmatic expanded command: ${setExpandedError instanceof Error ? setExpandedError.message : String(setExpandedError)}`,
                    );
                });
                await wait(postCollapseDelayMs);
                ({ artifacts: floatingExpandedArtifacts } = await captureValidatedOverlayProofStep('overlay_floating_expanded', {}, {
                    placementOverride: floatingPlacementOverride,
                }));
            }
        }
        optionalStepArtifacts.overlay_floating_expanded = floatingExpandedArtifacts;

        const seededProofStepIds = canonicalActivitySurfacesRequiredProofStepIds
            .concat(canonicalActivitySurfacesOptionalOverlayCardStepIds)
            .filter((stepId) => proofStepsById[stepId]?.proofSeedMode);
        for (const stepId of seededProofStepIds) {
            const step = proofStepsById[stepId];
            const seedResult = await seedOverlayProofState({
                mode: step.proofSeedMode,
                appIdentifier,
                driverSession,
                env,
                artifactRoot,
                windowId: 'main',
            }).catch((error) => ({
                ok: false,
                reason: error instanceof Error ? error.message : String(error),
            }));
            if (seedResult?.ok !== true) {
                const reason = readString(seedResult?.reason, 'seed-proof-state-failed');
                if (step.required === true) {
                    throw new Error(`Unable to seed overlay proof state ${String(step.proofSeedMode)}: ${reason}`);
                }
                await appendWarningArtifact(
                    artifactRoot,
                    `- optional overlay proof step ${stepId} could not be seeded: ${reason}`,
                );
                continue;
            }

            await wait(postCollapseDelayMs);
            try {
                if (step.required !== true) {
                    const matchedSelector = await findFirstVisibleActivitySurfacesStepSelector({
                        step,
                        appIdentifier,
                        env,
                        driverSession,
                        isSelectorVisible,
                        isSelectorVisibleByDomQuery,
                    });
                    if (!matchedSelector) {
                        continue;
                    }
                }
                const { artifacts } = await captureValidatedOverlayProofStep(stepId);
                optionalStepArtifacts[stepId] = artifacts;
            } catch (error) {
                if (step.required === true) {
                    throw error;
                }
                await appendWarningArtifact(
                    artifactRoot,
                    `- optional overlay proof step ${stepId} could not be captured: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }

        return {
            settingsArtifacts,
            overlayRouteArtifacts,
            collapsedArtifacts,
            expandedArtifacts,
            floatingFallbackArtifacts,
            overlayVisibilityEnabled,
            optionalStepArtifacts,
        };
    } finally {
        await restoreRequestedOverlayAutoHideSetting();
        await restoreRequestedOverlayPresentationMode();
        await restoreRequestedOverlayVisibilityMode();
    }
}

export async function startDriverSession(
    plan,
    {
        env = process.env,
        runCliJson = null,
    } = {},
) {
    const driverSessionEnv = resolveActivitySurfacesMcpCliEnv(env);
    const runCliJsonFn = runCliJson ?? ((args, options = {}) => runTauriMcpCliJson(args, {
        cwd: plan.packageRoot,
        env: options.env ?? driverSessionEnv,
        timeoutMs: options.timeoutMs,
    }));
    const candidatePorts = resolveCandidateDriverSessionPorts({ preferredPort: plan.driverSessionPort, env: driverSessionEnv });
    const attemptsFile = join(plan.artifactRoot, '00-driver-session-attempts.jsonl');
    const driverSessionResult = await startTargetedDriverSession({
        candidatePorts,
        attemptTimeoutMs: initialDriverSessionTimeoutMs,
        requireStackOwnedIdentifier: true,
        env: driverSessionEnv,
        runCliJson: (args, options = {}) => runCliJsonFn(args, {
            ...options,
            timeoutMs: options.timeoutMs ?? initialDriverSessionTimeoutMs,
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
        driverSessionStatusResponse: driverSessionResult.driverSessionStatusResponse,
        driverSessionCommand,
        driverSessionResponseFile,
        driverSessionStatusCommand,
        driverSessionStatusResponseFile,
    };
}

export async function runTauriActivitySurfacesQaCapture({
    plan = buildTauriActivitySurfacesQaPlan(),
    env = process.env,
    ensureWorkspaceBuilt = ensureUiWorkspacePackagesBuilt,
    ensureArtifactDir = ensureDir,
    ensureDriverSessionReady = ensureActivitySurfacesStackRuntimeReadyForSessionSeed,
    wait = delay,
    startDriverSession: startDriverSessionOverride = startDriverSession,
    startDriverSessionImpl = null,
    driverSessionRetryAttempts = 3,
    driverSessionRetryDelayMs = 1500,
    runCli = runActivitySurfacesMcpCli,
    writeArtifact = writeTextArtifact,
    appendWarning: appendWarningArtifact = appendWarning,
    ensureSettingsReady = ensureActivitySurfacesSettingsShellReady,
    seedSession = seedActivitySurfacesOverlaySession,
    hydrateSeededSession = hydrateActivitySurfacesSeededSessionForOverlayCapture,
    runOverlayCapture = runActivitySurfacesDesktopOverlayCaptureLane,
    appendTracker = appendTrackerEvidence,
    appendStageTrace = appendActivitySurfacesQaStageTrace,
} = {}) {
    await ensureWorkspaceBuilt({ env });
    await ensureArtifactDir(plan.artifactRoot);
    const startDriverSessionFn = startDriverSessionImpl ?? startDriverSessionOverride;
    const requiredStepIds = resolveActivitySurfacesRequiredProofStepIds(plan.steps, env);
    const seedStrategy = resolveActivitySurfacesQaSeedStrategy(env);

    const stageTraceFile = join(plan.artifactRoot, '00-stage-trace.jsonl');
    function isRetryableDriverSessionBootstrapError(error) {
        const message = error instanceof Error ? error.message : String(error ?? '');
        return message.includes('Unable to resolve a connected Tauri app identifier from driver-session status')
            || message.includes('Session start failed - no Tauri app found');
    }

    async function startDriverSessionWithRetries() {
        const attempts = Math.max(1, Math.floor(Number(driverSessionRetryAttempts) || 1));
        const delayMs = Math.max(0, Math.floor(Number(driverSessionRetryDelayMs) || 0));
        let lastError = null;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                return await startDriverSessionFn(plan, { env });
            } catch (error) {
                lastError = error;
                if (attempt >= attempts || !isRetryableDriverSessionBootstrapError(error)) {
                    throw error;
                }
                await ensureDriverSessionReady({
                    env,
                    appIdentifier: null,
                }).catch(() => null);
                // eslint-disable-next-line no-await-in-loop
                await wait(delayMs);
            }
        }

        throw lastError;
    }

    async function traceStage(stage, runStage, buildDoneDetails = null) {
        await appendStageTrace(plan.artifactRoot, { stage, status: 'start' });
        try {
            const result = await runStage();
            const details = typeof buildDoneDetails === 'function' ? buildDoneDetails(result) : {};
            await appendStageTrace(plan.artifactRoot, { stage, status: 'done', ...details });
            return result;
        } catch (error) {
            await appendStageTrace(plan.artifactRoot, {
                stage,
                status: 'error',
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    const driverSession = await traceStage(
        'driver_session',
        () => startDriverSessionWithRetries(),
        (result) => ({
            driverSessionPort: result?.driverSessionPort ?? null,
            appIdentifier: result?.resolvedAppIdentifier ?? null,
        }),
    );

    const backendStateFile = join(plan.artifactRoot, '00-backend-state.json');
    const backendStateDiagnosticsFile = join(plan.artifactRoot, '00-backend-state.diagnostics.json');
    const backendState = await traceStage(
        'backend_state',
        async () => {
            const result = await readActivitySurfacesBackendStateWithRetries({
                appIdentifier: driverSession.resolvedAppIdentifier,
                driverSession,
                env,
                runCli,
            });
            const backendStateText = result.response
                ? String(result.response.stdout ?? '')
                : `${JSON.stringify({ ok: false, error: result.error }, null, 2)}\n`;
            await writeArtifact(backendStateFile, backendStateText);
            if (result.ok !== true) {
                const failureReason = result.blocker === 'proof_channel_disconnect'
                    ? `proof-channel disconnect: ${result.error}`
                    : result.error;
                await appendWarningArtifact(
                    plan.artifactRoot,
                    `- backend state probe failed: ${failureReason}`,
                );
                await writeArtifact(
                    backendStateDiagnosticsFile,
                    `${JSON.stringify({
                        ok: false,
                        error: result.error || 'backend state unavailable',
                        blocker: result.blocker ?? null,
                        appIdentifier: driverSession.resolvedAppIdentifier ?? null,
                        driverSessionPort: driverSession?.driverSessionPort ?? null,
                        response: result.response
                            ? {
                                stdout: String(result.response.stdout ?? ''),
                                stderr: String(result.response.stderr ?? ''),
                            }
                            : null,
                    }, null, 2)}\n`,
                );
            }
            return result;
        },
        (result) => ({
            backendStateFile,
            backendStateDiagnosticsFile: result?.ok === true ? null : backendStateDiagnosticsFile,
            appIdentifier: driverSession.resolvedAppIdentifier,
            backendStateOk: result?.ok === true,
        }),
    );

    const stepsById = Object.fromEntries(plan.steps.map((step) => [step.id, step]));
    const stepArtifacts = {};
    const settingsPreflightTraceFile = join(plan.artifactRoot, '00-settings-preflight-trace.jsonl');

    await traceStage(
        'settings_preflight',
        () => ensureSettingsReady({
            appIdentifier: driverSession.resolvedAppIdentifier,
            driverSession,
            env,
            artifactRoot: plan.artifactRoot,
            preflightPlan: plan.preflight,
            traceAttempt: async (entry) => {
                await appendTextArtifact(
                    settingsPreflightTraceFile,
                    `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
                );
            },
        }),
        (result) => ({
            attempts: result?.attempts ?? null,
            settingsPreflightTraceFile,
        }),
    );

    const shouldSeedStackSession = seedStrategy === 'active_session' || seedStrategy === 'attention_only';
    const seededSessionFile = shouldSeedStackSession
        ? join(plan.artifactRoot, '00-seeded-session.json')
        : null;
    let seededSession = null;
    if (shouldSeedStackSession) {
        seededSession = await traceStage(
            'seed_overlay_session',
            async () => {
                const result = await seedSession({
                    appIdentifier: driverSession.resolvedAppIdentifier,
                    env: { ...env, HAPPIER_TAURI_ACTIVITY_SURFACES_QA_SEED_STRATEGY: seedStrategy },
                    strategy: seedStrategy,
                });
                await writeArtifact(
                    seededSessionFile,
                    `${JSON.stringify(result, null, 2)}\n`,
                );
                return result;
            },
            (result) => ({
                seededSessionFile,
                sessionId: result?.sessionId ?? null,
            }),
        );

        await traceStage(
            'hydrate_seeded_session',
            () => hydrateSeededSession({
                sessionId: seededSession.sessionId,
                appIdentifier: driverSession.resolvedAppIdentifier,
                env,
                driverSession,
            }),
            () => ({
                sessionId: seededSession.sessionId,
            }),
        );
    }

    async function captureRequired(stepId, captureOptions = {}) {
        const step = stepsById[stepId];
        if (!step) throw new Error(`Unknown step id: ${stepId}`);
        const selectorOverride = String(captureOptions.selectorOverride ?? '').trim() || null;
        if (typeof captureOptions.beforeSelectorCapture === 'function') {
            await captureOptions.beforeSelectorCapture();
        }
        const matchedSelector = selectorOverride || await resolveActivitySurfacesStepSnapshotSelector(step, {
            appIdentifier: driverSession.resolvedAppIdentifier,
            driverSession,
            env,
            windowId: step.windowId,
        });
        const artifacts = await captureStep(step, {
            artifactRoot: plan.artifactRoot,
            appIdentifier: driverSession.resolvedAppIdentifier,
            driverSession,
            env,
            matchedSelector,
            windowId: step.windowId,
            snapshotSelector: captureOptions.snapshotSelector,
            beforeScreenshotCapture: captureOptions.beforeScreenshotCapture,
            beforeStructureCapture: captureOptions.beforeStructureCapture,
            beforeAccessibilityCapture: captureOptions.beforeAccessibilityCapture,
        });
        stepArtifacts[stepId] = artifacts;
        return artifacts;
    }

    const overlayCapture = await traceStage(
        'overlay_capture',
        () => runOverlayCapture({
            appIdentifier: driverSession.resolvedAppIdentifier,
            driverSession,
            env,
            artifactRoot: plan.artifactRoot,
            seedStrategy,
            visibilityMode: defaultDesktopOverlayVisibilityMode,
            setOverlayAutoHideEnabled: (options) => setActivitySurfacesDesktopOverlayAutoHideEnabled(options),
            setOverlayPresentationMode: (options) => enableDesktopOverlayPresentationMode(options),
            captureRequired,
            captureUnscoped: async (stepId) => {
                const step = stepsById[stepId];
                if (!step) {
                    throw new Error(`Unknown step id: ${stepId}`);
                }
                const artifacts = await captureStep(step, {
                    artifactRoot: plan.artifactRoot,
                    appIdentifier: driverSession.resolvedAppIdentifier,
                    env,
                    driverSession,
                    windowId: step.windowId,
                    matchedSelector: null,
                    snapshotSelector: null,
                });
                stepArtifacts[stepId] = artifacts;
                return artifacts;
            },
            getOverlayWindowState: ({ windowId, timeoutMs }) => getActivitySurfacesOverlayWindowState({
                appIdentifier: driverSession.resolvedAppIdentifier,
                env,
                driverSession,
                windowId,
                timeoutMs,
            }),
        }),
        (result) => ({
            overlayVisibilityEnabled: result?.overlayVisibilityEnabled ?? null,
        }),
    );

    const {
        settingsArtifacts,
        overlayRouteArtifacts,
        collapsedArtifacts,
        expandedArtifacts,
        floatingFallbackArtifacts,
        overlayVisibilityEnabled,
        optionalStepArtifacts = {},
    } = overlayCapture;
    stepArtifacts.settings_overlay = settingsArtifacts;
    stepArtifacts.overlay_route = overlayRouteArtifacts;
    stepArtifacts.overlay_collapsed = collapsedArtifacts;
    stepArtifacts.overlay_expanded = expandedArtifacts;
    stepArtifacts.overlay_floating_fallback = floatingFallbackArtifacts;
    for (const [stepId, artifacts] of Object.entries(optionalStepArtifacts)) {
        stepArtifacts[stepId] = artifacts;
    }

    const proofSummary = summarizeTauriActivitySurfacesQaProof({
        stepArtifacts,
        requiredStepIds,
    });
    const hasDeclaredProofSteps = Array.isArray(plan.steps) && plan.steps.length > 0;
    const effectiveProofSummary = hasDeclaredProofSteps
        ? proofSummary
        : {
            ok: false,
            blocker: 'missing_required_step_artifacts',
            steps: requiredStepIds,
        };
    if (!effectiveProofSummary.ok) {
        await appendWarningArtifact(
            plan.artifactRoot,
            '- required step artifacts were incomplete or not declared during the native proof run; the live stack is not authoritative yet',
        );
    }

    await traceStage(
        'manual_steps_artifact',
        () => writeArtifact(
            join(plan.artifactRoot, 'manual-steps.md'),
            [
                '# Manual steps',
                '',
                ...plan.manual.map((entry) => `- [manual] ${entry}`),
                '',
            ].join('\n'),
        ),
        () => ({
            manualCount: Array.isArray(plan.manual) ? plan.manual.length : 0,
        }),
    );

    await traceStage(
        'tracker_evidence',
        () => appendTracker({
            trackerPath: plan.trackerPath,
            artifactRoot: plan.artifactRoot,
            stepArtifacts,
            driverSession: `${driverSession.driverSessionCommand} -> ${driverSession.driverSessionResponseFile}`,
            driverSessionStatus: `${driverSession.driverSessionStatusCommand} -> ${driverSession.driverSessionStatusResponseFile}`,
            backendState: backendStateFile,
            seededSessionPath: seededSessionFile,
        }),
        () => ({
            stepCount: Object.keys(stepArtifacts).length,
        }),
    );

    return {
        ...effectiveProofSummary,
        artifactRoot: plan.artifactRoot,
        trackerPath: plan.trackerPath,
        appIdentifier: driverSession.resolvedAppIdentifier,
        seededSession,
        seededSessionId: seededSession?.sessionId ?? null,
        steps: Object.keys(stepArtifacts),
        stageTraceFile,
        backendState,
    };
}

export async function main(
    argv = process.argv.slice(2),
    {
        runCapture = null,
        stdout = process.stdout,
        stderr = process.stderr,
        processApi = process,
    } = {},
) {
    const plan = buildTauriActivitySurfacesQaPlan();
    const json = argv.includes('--json');
    const help = argv.includes('--help') || argv.includes('-h');

    if (help) {
        stdout.write([
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
        stdout.write(JSON.stringify({ ok: true, plan }, null, 2) + '\n');
        return;
    }

    if (typeof runCapture === 'function') {
        const result = await runCapture({ plan, env: process.env });
        stdout.write(JSON.stringify(result, null, 2) + '\n');
        if (!result.ok) {
            processApi.exitCode = 1;
        }
        return;
    }

    const fixtureResult = resolveActivitySurfacesQaCaptureFixture(process.env);
    if (fixtureResult) {
        stdout.write(JSON.stringify(fixtureResult, null, 2) + '\n');
        processApi.exitCode = 1;
        return;
    }

    const result = await runTauriActivitySurfacesQaCapture({ plan, env: process.env });
    stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.ok) {
        processApi.exitCode = 1;
    }
}

const currentFilePath = fileURLToPath(import.meta.url);
if (process.argv[1] && process.argv[1] === currentFilePath) {
    main().catch((error) => {
        process.stderr.write(`[tauri-activity-surfaces-qa] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        process.exit(1);
    });
}
