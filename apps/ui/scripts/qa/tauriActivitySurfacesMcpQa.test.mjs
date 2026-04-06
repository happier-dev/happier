import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import * as preflightModule from './tauriActivitySurfacesPreflight.mjs';
import * as qaModule from './tauriActivitySurfacesMcpQa.mjs';

const execFileAsync = promisify(execFile);
const { resolveActivitySurfacesPreflightSelector } = preflightModule;

test('tauri activity-surfaces QA exposes a deterministic capture plan', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriActivitySurfacesMcpQa.mjs');

    const { stdout } = await execFileAsync(process.execPath, [scriptPath, '--json'], {
        cwd: dirname(dirname(scriptsDir)),
        env: { ...process.env },
        encoding: 'utf8',
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.ok, true);
    assert.match(String(payload.plan.artifactRoot), /activity-surfaces-qa[\\/]/);
    assert.match(String(payload.plan.trackerPath), /happier-activity-surfaces-qa-tracking-2026-04-05\.md$/);
    assert.deepEqual(
        payload.plan.steps.map((step) => step.id),
        ['settings_overlay', 'overlay_route', 'overlay_collapsed', 'overlay_expanded'],
    );
    assert.deepEqual(payload.plan.steps[0].selectors, ['[data-testid="settings-desktop-overlay-enabled"]']);
    assert.equal(payload.plan.steps[0].snapshotSelector, '[data-testid="settings-desktop-overlay-enabled"]');
    assert.deepEqual(payload.plan.steps[1].selectors, ['[data-testid="desktop-activity-overlay-collapsed"]']);
    assert.deepEqual(payload.plan.steps[2].selectors, ['[data-testid="desktop-activity-overlay-collapsed"]']);
    assert.deepEqual(payload.plan.steps[3].selectors, ['[data-testid="desktop-activity-overlay-expanded"]']);
    assert.deepEqual(payload.plan.preflight.settingsSelectors, [
        '[data-testid="settings-desktop-entry"]',
        '[data-testid="settings-desktop-overlay-enabled"]',
    ]);
    assert.deepEqual(payload.plan.preflight.onboardingSelectors, [
        '[data-testid="onboarding-wizard-card"]',
        '[data-testid="onboarding-wizard"]',
        '[data-testid="onboarding-wizard-primary"]',
        '[data-testid="onboarding-wizard-scan"]',
        '[data-testid="onboarding-wizard-skip"]',
        '[data-testid="onboarding-wizard-relay-diagram"]',
        '[data-testid="onboarding-wizard-relay:cloud"]',
        '[data-testid="onboarding-wizard-relay:thisComputer"]',
        '[data-testid="onboarding-wizard-relay:customUrl"]',
        '[data-testid="onboarding-wizard-relay-host-local-checklist-row-startRelayRuntime"]',
        '[data-testid="onboarding-wizard-back"]',
        '[data-testid="onboarding-wizard-welcome-body"]',
    ]);
    assert.equal(payload.plan.preflight.settingsPath, '/settings');
});

test('tauri activity-surfaces QA prefers the stack-owned driver-session port when stack runtime hints are present', () => {
    assert.equal(typeof qaModule.buildTauriActivitySurfacesQaPlan, 'function');

    const plan = qaModule.buildTauriActivitySurfacesQaPlan({
        env: {
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.activity-surfaces-qa',
        },
    });

    assert.equal(plan.driverSessionPort, 9223);
});

test('tauri activity-surfaces QA preflight resolves onboarding before settings', () => {
    const onboardingSnapshot = [
        'data-testid=onboarding-wizard-card',
        'data-testid=onboarding-wizard',
        'data-testid=onboarding-wizard-skip',
        'data-testid="onboarding-wizard-relay:thisComputer"',
        'data-testid="onboarding-wizard-relay-host-local-checklist-row-startRelayRuntime"',
    ].join('\n');

    assert.equal(
        resolveActivitySurfacesPreflightSelector(onboardingSnapshot),
        '[data-testid="onboarding-wizard-skip"]',
    );

    assert.equal(
        resolveActivitySurfacesPreflightSelector('data-testid=settings-shell.sidebarPane\n'),
        null,
    );
});

test('tauri activity-surfaces QA preflight advances to the next visible onboarding action after a tried selector', () => {
    const expandedOnboardingSnapshot = [
        'data-testid=onboarding-wizard-relay-host-local-checklist-row-installRelayRuntime',
        'data-testid=onboarding-wizard-relay-host-local-checklist-row-startRelayRuntime',
    ].join('\n');

    assert.equal(
        resolveActivitySurfacesPreflightSelector(expandedOnboardingSnapshot, {
            triedSelectors: new Set(['[data-testid="onboarding-wizard-relay-host-local-checklist-row-installRelayRuntime"]']),
        }),
        '[data-testid="onboarding-wizard-relay-host-local-checklist-row-startRelayRuntime"]',
    );
});

test('tauri activity-surfaces QA preflight can resolve the relay back action after relay choices are exhausted', () => {
    const relaySnapshot = [
        'data-testid=onboarding-wizard-relay-diagram',
        'data-testid=onboarding-wizard-relay:cloud',
        'data-testid=onboarding-wizard-relay:thisComputer',
        'data-testid=onboarding-wizard-relay:customUrl',
        'data-testid=onboarding-wizard-back',
    ].join('\n');

    assert.equal(
        resolveActivitySurfacesPreflightSelector(relaySnapshot, {
            triedSelectors: new Set([
                '[data-testid="onboarding-wizard-skip"]',
                '[data-testid="onboarding-wizard-relay:cloud"]',
                '[data-testid="onboarding-wizard-relay:thisComputer"]',
                '[data-testid="onboarding-wizard-relay:customUrl"]',
                '[data-testid="onboarding-wizard-relay-host-local-checklist-row-installRelayRuntime"]',
                '[data-testid="onboarding-wizard-relay-host-local-checklist-row-startRelayRuntime"]',
                '[data-testid="onboarding-wizard-primary"]',
            ]),
        }),
        '[data-testid="onboarding-wizard-back"]',
    );
});

test('tauri activity-surfaces QA preflight classifies auth surfaces as guided manual blockers', () => {
    assert.equal(typeof preflightModule.analyzeActivitySurfacesPreflightSurface, 'function');
    const authSnapshot = [
        'data-testid=welcome-create-account',
        'data-testid=welcome-restore',
        'data-testid=welcome-signup-provider',
    ].join('\n');

    assert.deepEqual(preflightModule.analyzeActivitySurfacesPreflightSurface(authSnapshot), {
        kind: 'blocked',
        blocker: 'auth',
        message: 'The app reached the auth welcome surface before settings. Sign in or seed a post-auth state, then rerun the activity-surfaces QA capture.',
    });
});

test('tauri activity-surfaces QA preflight treats the server-unavailable onboarding shell as retryable onboarding state', () => {
    assert.equal(typeof preflightModule.analyzeActivitySurfacesPreflightSurface, 'function');
    const onboardingSnapshot = [
        'data-testid=onboarding-wizard-card',
        'data-testid=onboarding-wizard',
        'data-testid=welcome-server-unavailable',
        'data-testid=onboarding-wizard-skip',
    ].join('\n');

    assert.deepEqual(preflightModule.analyzeActivitySurfacesPreflightSurface(onboardingSnapshot), {
        kind: 'action',
        selector: '[data-testid="onboarding-wizard-skip"]',
    });
});

test('tauri activity-surfaces QA preflight retries the server-unavailable onboarding shell via the retry button when available', () => {
    assert.equal(typeof preflightModule.analyzeActivitySurfacesPreflightSurface, 'function');
    const onboardingSnapshot = [
        'data-testid=onboarding-wizard-card',
        'data-testid=onboarding-wizard',
        'data-testid=welcome-server-unavailable',
        'data-testid=welcome-retry-server',
    ].join('\n');

    assert.deepEqual(preflightModule.analyzeActivitySurfacesPreflightSurface(onboardingSnapshot), {
        kind: 'action',
        selector: '[data-testid="welcome-retry-server"]',
    });
});

test('tauri activity-surfaces QA preflight can classify selector presence without a DOM snapshot', () => {
    assert.equal(typeof preflightModule.classifyActivitySurfacesPreflightSelectors, 'function');

    assert.deepEqual(
        preflightModule.classifyActivitySurfacesPreflightSelectors(
            new Set(['[data-testid="settings-shell.sidebarPane"]']),
        ),
        {
            kind: 'navigate',
            targetPath: '/settings',
            reason: 'settings-shell-not-visible-yet',
        },
    );

    assert.deepEqual(
        preflightModule.classifyActivitySurfacesPreflightSelectors(
            new Set([
                '[data-testid="onboarding-wizard"]',
                '[data-testid="onboarding-wizard-relay:cloud"]',
            ]),
        ),
        {
            kind: 'action',
            selector: '[data-testid="onboarding-wizard-relay:cloud"]',
        },
    );
});

test('tauri activity-surfaces QA preflight skips already-tried onboarding actions when another action remains', () => {
    assert.equal(typeof preflightModule.classifyActivitySurfacesPreflightSelectors, 'function');

    assert.deepEqual(
        preflightModule.classifyActivitySurfacesPreflightSelectors(
            new Set([
                '[data-testid="onboarding-wizard"]',
                '[data-testid="onboarding-wizard-relay:cloud"]',
                '[data-testid="onboarding-wizard-relay:thisComputer"]',
            ]),
            preflightModule.buildActivitySurfacesPreflightPlan(),
            {
                triedSelectors: new Set(['[data-testid="onboarding-wizard-relay:cloud"]']),
            },
        ),
        {
            kind: 'action',
            selector: '[data-testid="onboarding-wizard-relay:thisComputer"]',
        },
    );
});

test('tauri activity-surfaces QA preflight retries an already-tried visible onboarding action when it is the only actionable selector left', () => {
    assert.equal(typeof preflightModule.classifyActivitySurfacesPreflightSelectors, 'function');

    assert.deepEqual(
        preflightModule.classifyActivitySurfacesPreflightSelectors(
            new Set([
                '[data-testid="onboarding-wizard"]',
                '[data-testid="onboarding-wizard-skip"]',
            ]),
            preflightModule.buildActivitySurfacesPreflightPlan(),
            {
                triedSelectors: new Set(['[data-testid="onboarding-wizard-skip"]']),
            },
        ),
        {
            kind: 'action',
            selector: '[data-testid="onboarding-wizard-skip"]',
        },
    );
});

test('tauri activity-surfaces QA uses a scoped onboarding snapshot before probing every onboarding action selector', async () => {
    assert.equal(typeof qaModule.probeActivitySurfacesPreflightSurface, 'function');

    const selectorCalls = [];
    const snapshotCalls = [];
    const plan = preflightModule.buildActivitySurfacesPreflightPlan();

    const result = await qaModule.probeActivitySurfacesPreflightSurface({
        appIdentifier: 9224,
        env: { EXISTING: 'value' },
        plan,
        isSelectorVisible: async (selector) => {
            selectorCalls.push(selector);
            return selector === '[data-testid="onboarding-wizard-card"]';
        },
        captureStructureSnapshot: async ({ selector }) => {
            snapshotCalls.push(selector);
            return 'data-testid=onboarding-wizard-card';
        },
    });

    assert.deepEqual(result, {
        kind: 'blocked',
        blocker: 'onboarding',
        message: 'The app is still on an onboarding step that the activity-surfaces QA script cannot advance automatically. Complete the wizard until the main app shell is available, then rerun the activity-surfaces QA capture.',
    });
    assert.deepEqual(snapshotCalls, ['[data-testid="onboarding-wizard-card"]']);
    assert.equal(selectorCalls.includes('[data-testid="onboarding-wizard-skip"]'), false);
    assert.equal(selectorCalls.includes('[data-testid="onboarding-wizard-primary"]'), false);
});

test('tauri activity-surfaces QA preflight treats non-settings routes as retryable settings navigation', () => {
    assert.equal(typeof preflightModule.analyzeActivitySurfacesPreflightSurface, 'function');
    const nonSettingsSnapshot = [
        'data-testid=session-list',
        'data-testid=home-shell',
    ].join('\n');

    assert.deepEqual(preflightModule.analyzeActivitySurfacesPreflightSurface(nonSettingsSnapshot), {
        kind: 'navigate',
        targetPath: '/settings',
        reason: 'settings-shell-not-visible-yet',
    });
});

test('tauri activity-surfaces QA preflight classifies setup wizard as a manual prerequisite', () => {
    assert.equal(typeof preflightModule.analyzeActivitySurfacesPreflightSurface, 'function');
    const setupSnapshot = [
        'data-testid=setupWizard.surface',
        'data-testid=setupWizard.surface-primary',
    ].join('\n');

    assert.deepEqual(preflightModule.analyzeActivitySurfacesPreflightSurface(setupSnapshot), {
        kind: 'blocked',
        blocker: 'setup-wizard',
        message: 'The app reached the post-auth setup wizard before settings. Complete or dismiss the setup wizard, then rerun the activity-surfaces QA capture.',
    });
});

test('tauri activity-surfaces QA preflight can dismiss the setup wizard when its skip action is visible', () => {
    assert.equal(typeof preflightModule.analyzeActivitySurfacesPreflightSurface, 'function');
    const setupSnapshot = [
        'data-testid=setupWizard.surface',
        'data-testid=setupWizard.surface-skip',
    ].join('\n');

    assert.deepEqual(preflightModule.analyzeActivitySurfacesPreflightSurface(setupSnapshot), {
        kind: 'action',
        selector: '[data-testid="setupWizard.surface-skip"]',
    });
});

test('tauri activity-surfaces QA injects the active app identifier into mcp child env', () => {
    assert.equal(typeof qaModule.resolveActivitySurfacesMcpCliEnv, 'function');
    const env = qaModule.resolveActivitySurfacesMcpCliEnv({
        existing: 'preserved',
        HAPPIER_STACK_STACK: 'activity-surfaces-qa',
        HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
    }, 9223);

    assert.equal(env.existing, 'preserved');
    assert.equal(env.HAPPIER_TAURI_MCP_APP_IDENTIFIER, '9223');
    assert.equal(env.HAPPIER_STACK_ENV_FILE, '/tmp/happier-stack/env');
    assert.equal(env.HAPPIER_STACK_STACK, 'activity-surfaces-qa');
    assert.equal(env.HAPPIER_STACK_CLI_HOME_DIR, '/tmp/happier-stack/cli');
    assert.equal(env.HAPPIER_HOME_DIR, '/tmp/happier-stack/cli');
    assert.equal(env.HAPPIER_STACK_ENV_FILE, '/tmp/happier-stack/env');
});

test('tauri activity-surfaces QA derives the stack-owned Tauri identifier into mcp child env when needed', () => {
    assert.equal(typeof qaModule.resolveActivitySurfacesMcpCliEnv, 'function');
    const env = qaModule.resolveActivitySurfacesMcpCliEnv({
        HAPPIER_STACK_STACK: 'activity-surfaces-qa',
        HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
    });

    assert.equal(env.HAPPIER_STACK_TAURI_IDENTIFIER, 'com.happier.stack.activity-surfaces-qa');
    assert.equal(env.HAPPIER_TAURI_MCP_APP_IDENTIFIER, 'com.happier.stack.activity-surfaces-qa');
});

test('tauri activity-surfaces QA resolves the stack env file alongside the stack CLI home', () => {
    assert.equal(typeof qaModule.resolveActivitySurfacesStackCliEnv, 'function');
    const env = qaModule.resolveActivitySurfacesStackCliEnv({
        HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
    });

    assert.equal(env.HAPPIER_STACK_CLI_HOME_DIR, '/tmp/happier-stack/cli');
    assert.equal(env.HAPPIER_HOME_DIR, '/tmp/happier-stack/cli');
    assert.equal(env.HAPPIER_STACK_ENV_FILE, '/tmp/happier-stack/env');
});

test('tauri activity-surfaces QA enables the desktop overlay without choosing the capture visibility mode', async () => {
    assert.equal(typeof qaModule.enableDesktopOverlayIfNeeded, 'function');

    const calls = [];
    await qaModule.enableDesktopOverlayIfNeeded({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        runCli: async (args, options) => {
            calls.push({ args, options });
            return { stdout: '{"ok":true}' };
        },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[0], 'webview-execute-js');
    assert.equal(String(calls[0].args[2]).includes('desktopOverlayEnabled'), true);
    assert.equal(String(calls[0].args[2]).includes('window.localStorage'), true);
    assert.equal(String(calls[0].args[2]).includes('settings-desktop-overlay-enabled'), false);
});

test('tauri activity-surfaces QA seeds a qualifying session through the canonical stack happier commands', async () => {
    assert.equal(typeof qaModule.seedActivitySurfacesOverlaySession, 'function');

    const calls = [];
    const result = await qaModule.seedActivitySurfacesOverlaySession({
        env: {
            HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
            HAPPIER_HOME_DIR: '',
        },
        runCliJson: async (args, options) => {
            calls.push({ args, options });
            if (args[0] === 'session' && args[1] === 'create') {
                return {
                    ok: true,
                    kind: 'session_create',
                    data: {
                        created: true,
                        session: {
                            id: 'sess_seeded_overlay',
                        },
                    },
                };
            }
            if (args[0] === 'session' && args[1] === 'send') {
                return {
                    ok: true,
                    kind: 'session_send',
                    data: {
                        sessionId: 'sess_seeded_overlay',
                        localId: 'local_1',
                        waited: false,
                    },
                };
            }
            throw new Error(`Unexpected seed command: ${args.join(' ')}`);
        },
    });

    assert.equal(result.sessionId, 'sess_seeded_overlay');
    assert.deepEqual(
        calls.map(({ args }) => args),
        [
            ['session', 'create', '--path', '/Users/leeroy/Documents/Development/happier/dev'],
            ['session', 'send', 'sess_seeded_overlay', 'Please post a brief status update so the desktop overlay becomes visible.'],
        ],
    );
    assert.equal(calls[0].options.env.HAPPIER_HOME_DIR, '/tmp/happier-stack/cli');
    assert.equal(calls[0].options.env.HAPPIER_STACK_CLI_HOME_DIR, '/tmp/happier-stack/cli');
    assert.equal(calls[1].options.env.HAPPIER_HOME_DIR, '/tmp/happier-stack/cli');
    assert.equal(calls[1].options.env.HAPPIER_STACK_CLI_HOME_DIR, '/tmp/happier-stack/cli');
});

test('tauri activity-surfaces QA can seed a deterministic attention-only session through create-stop-send', async () => {
    assert.equal(typeof qaModule.seedActivitySurfacesOverlaySession, 'function');

    const calls = [];
    const result = await qaModule.seedActivitySurfacesOverlaySession({
        strategy: 'attention_only',
        env: {
            HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
            HAPPIER_HOME_DIR: '',
        },
        runCliJson: async (args, options) => {
            calls.push({ args, options });
            if (args[0] === 'session' && args[1] === 'create') {
                return {
                    ok: true,
                    kind: 'session_create',
                    data: {
                        created: true,
                        session: {
                            id: 'sess_attention_only',
                        },
                    },
                };
            }
            if (args[0] === 'session' && args[1] === 'stop') {
                return {
                    ok: true,
                    kind: 'session_stop',
                    data: {
                        sessionId: 'sess_attention_only',
                        stopped: true,
                    },
                };
            }
            if (args[0] === 'session' && args[1] === 'send') {
                return {
                    ok: true,
                    kind: 'session_send',
                    data: {
                        sessionId: 'sess_attention_only',
                        localId: 'local_2',
                        waited: false,
                    },
                };
            }
            throw new Error(`Unexpected seed command: ${args.join(' ')}`);
        },
    });

    assert.equal(result.sessionId, 'sess_attention_only');
    assert.equal(result.stopPayload.kind, 'session_stop');
    assert.deepEqual(
        calls.map(({ args }) => args),
        [
            ['session', 'create', '--path', '/Users/leeroy/Documents/Development/happier/dev'],
            ['session', 'stop', 'sess_attention_only'],
            ['session', 'send', 'sess_attention_only', 'Please post a brief status update so the desktop overlay becomes visible.'],
        ],
    );
    assert.equal(calls[0].options.env.HAPPIER_HOME_DIR, '/tmp/happier-stack/cli');
    assert.equal(calls[1].options.env.HAPPIER_HOME_DIR, '/tmp/happier-stack/cli');
    assert.equal(calls[2].options.env.HAPPIER_HOME_DIR, '/tmp/happier-stack/cli');
});

test('tauri activity-surfaces QA can persist desktop overlay visibility mode directly for deterministic capture', async () => {
    assert.equal(typeof qaModule.enableDesktopOverlayVisibilityMode, 'function');

    const calls = [];
    const result = await qaModule.enableDesktopOverlayVisibilityMode({
        appIdentifier: 9223,
        env: {
            HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
            HAPPIER_HOME_DIR: '',
        },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        visibilityMode: 'active_sessions',
        windowId: 'activity_overlay',
        runCli: async (args, options) => {
            calls.push({ args, options });
            return { stdout: '{"ok":true,"targetLabel":"Active sessions","targetValue":"active_sessions","appliedValue":"active_sessions"}' };
        },
    });

    assert.equal(result, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[0], 'webview-execute-js');
    assert.equal(calls[0].args.includes('--json'), true);
    assert.equal(String(calls[0].args[2]).includes('desktopOverlayVisibilityMode'), true);
    assert.equal(String(calls[0].args[2]).includes('settings-desktop-overlay-enabled'), false);
    assert.equal(String(calls[0].args[2]).includes('window.localStorage'), true);
    assert.equal(String(calls[0].args[2]).includes('window.dispatchEvent(new StorageEvent'), true);
    assert.equal(String(calls[0].args[2]).includes('StorageEvent'), true);
    assert.equal(calls[0].options.windowId, 'activity_overlay');
    assert.equal(calls[0].options.env.HAPPIER_STACK_CLI_HOME_DIR, '/tmp/happier-stack/cli');
    assert.equal(calls[0].options.env.HAPPIER_HOME_DIR, '');
});

test('tauri activity-surfaces QA accepts a tauri-mcp warning prefix before the structured visibility payload', async () => {
    assert.equal(typeof qaModule.enableDesktopOverlayVisibilityMode, 'function');

    const result = await qaModule.enableDesktopOverlayVisibilityMode({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        visibilityMode: 'active_sessions',
        runCli: async () => ({
            stdout: [
                "⚠️ Multiple windows detected (2 total). Defaulting to 'main' window. Use windowId parameter to target a specific window. Available windows: main, activity_overlay",
                '',
                '{"ok":true,"targetLabel":"Active sessions","targetValue":"active_sessions","appliedValue":"active_sessions"}',
            ].join('\n'),
        }),
    });

    assert.equal(result, true);
});

test('tauri activity-surfaces QA only reports success when the persisted overlay visibility mode matches the requested value', async () => {
    assert.equal(typeof qaModule.enableDesktopOverlayVisibilityMode, 'function');

    const result = await qaModule.enableDesktopOverlayVisibilityMode({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        visibilityMode: 'always_when_enabled',
        runCli: async () => ({
            stdout: '{"ok":true,"targetLabel":"Always when enabled","targetValue":"always_when_enabled","appliedValue":"attention_only"}',
        }),
    });

    assert.equal(result, false);
});

test('tauri activity-surfaces QA injects the requested window id into webview mcp commands', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesMcpCli, 'function');

    const calls = [];
    await qaModule.runActivitySurfacesMcpCli(
        [
            'webview-dom-snapshot',
            '--type',
            'structure',
            '--app-identifier',
            '9223',
        ],
        {
            appIdentifier: 9223,
            windowId: 'activity_overlay',
            runCli: async (args, options) => {
                calls.push({ args, options });
                return { stdout: 'snapshot-ready' };
            },
        },
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
        'webview-dom-snapshot',
        '--type',
        'structure',
        '--app-identifier',
        '9223',
        '--window-id',
        'activity_overlay',
    ]);
});

test('tauri activity-surfaces QA captures the settings surface before enabling the desktop overlay', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async (pathname) => {
            calls.push(['navigate', pathname]);
        },
        openDesktopAppSettingsPage: async (options = {}) => {
            calls.push(['open-settings-page', options.windowId ?? null]);
            return true;
        },
        captureRequired: async (stepId) => {
            calls.push(['capture', stepId]);
            return { stepId };
        },
        enableDesktopOverlay: async (options = {}) => {
            calls.push(['enable-overlay', options.windowId ?? null]);
        },
        enableDesktopOverlayVisibility: async ({ visibilityMode, windowId }) => {
            calls.push(['visibility', visibilityMode, windowId ?? null]);
            return true;
        },
        clickCollapsedOverlay: async (selector) => {
            calls.push(['click', selector]);
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
        appendWarning: async () => {
            throw new Error('unexpected warning');
        },
    });

    assert.deepEqual(result, {
        settingsArtifacts: { stepId: 'settings_overlay' },
        overlayRouteArtifacts: { stepId: 'overlay_route' },
        collapsedArtifacts: { stepId: 'overlay_collapsed' },
        expandedArtifacts: { stepId: 'overlay_expanded' },
        overlayVisibilityEnabled: true,
    });
    assert.deepEqual(calls.slice(0, 6), [
        ['navigate', '/settings'],
        ['delay', 500],
        ['open-settings-page', null],
        ['capture', 'settings_overlay'],
        ['enable-overlay', 'main'],
        ['delay', 500],
    ]);
    assert.equal(
        calls.findIndex((entry) => entry[0] === 'capture' && entry[1] === 'settings_overlay')
        < calls.findIndex((entry) => entry[0] === 'enable-overlay'),
        true,
    );
    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'visibility').map((entry) => entry.slice(1)),
        [['active_sessions', 'main']],
    );
});

test('tauri activity-surfaces QA opens the dedicated desktop app settings page before capturing overlay settings', async () => {
    assert.equal(typeof qaModule.openActivitySurfacesDesktopAppSettingsPage, 'function');

    const calls = [];
    let desktopPageVisible = false;
    const result = await qaModule.openActivitySurfacesDesktopAppSettingsPage({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        navigateWebview: async (pathname) => {
            calls.push(['navigate', pathname]);
            desktopPageVisible = pathname === '/settings/desktop';
        },
        click: async (selector) => {
            calls.push(['click', selector]);
            desktopPageVisible = selector === '[data-testid="settings-desktop-entry"]';
        },
        isSelectorVisible: async (selector) => {
            calls.push(['visible', selector]);
            if (selector === '[data-testid="settings-desktop-entry"]') {
                return true;
            }
            if (selector === '[data-testid="settings-desktop-overlay-enabled"]') {
                return desktopPageVisible;
            }
            return false;
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
    });

    assert.equal(result, true);
    assert.equal(calls.some((entry) => entry[0] === 'click' && entry[1] === '[data-testid="settings-desktop-entry"]'), true);
    assert.equal(calls.some((entry) => entry[0] === 'navigate' && entry[1] === '/settings/desktop'), false);
});

test('tauri activity-surfaces QA scopes DOM snapshot commands to an explicit window when provided', () => {
    assert.equal(typeof qaModule.buildActivitySurfacesDomSnapshotArgs, 'function');

    assert.deepEqual(
        qaModule.buildActivitySurfacesDomSnapshotArgs({
            type: 'structure',
            appIdentifier: 9223,
            windowId: 'activity_overlay',
            selector: '[data-testid="desktop-activity-overlay-collapsed"]',
        }),
        [
            'webview-dom-snapshot',
            '--type',
            'structure',
            '--app-identifier',
            '9223',
            '--window-id',
            'activity_overlay',
            '--selector',
            '[data-testid="desktop-activity-overlay-collapsed"]',
            '--strategy',
            'css',
        ],
    );
});

test('tauri activity-surfaces QA scopes DOM snapshot commands to the target surface selector', () => {
    assert.equal(typeof qaModule.buildActivitySurfacesDomSnapshotArgs, 'function');

    assert.deepEqual(
        qaModule.buildActivitySurfacesDomSnapshotArgs({
            type: 'structure',
            appIdentifier: 9223,
            selector: '[data-testid="settings-shell.sidebarPane"]',
        }),
        [
            'webview-dom-snapshot',
            '--type',
            'structure',
            '--app-identifier',
            '9223',
            '--selector',
            '[data-testid="settings-shell.sidebarPane"]',
            '--strategy',
            'css',
        ],
    );
});

test('tauri activity-surfaces QA retries accessibility DOM snapshots without a selector when the scoped selector is missing', async () => {
    assert.equal(typeof qaModule.captureActivitySurfacesDomSnapshot, 'function');

    const calls = [];
    const result = await qaModule.captureActivitySurfacesDomSnapshot({
        type: 'accessibility',
        appIdentifier: 9223,
        selector: '[data-testid="settings-desktop-overlay-enabled"]',
        runCli: async (args, options) => {
            calls.push({ args, options });
            if (calls.length === 1) {
                throw new Error('No elements found matching selector "[data-testid="settings-desktop-overlay-enabled"]" (strategy: css)');
            }
            return { stdout: 'fallback-ready' };
        },
    });

    assert.equal(result.stdout, 'fallback-ready');
    assert.deepEqual(calls[0].args, [
        'webview-dom-snapshot',
        '--type',
        'accessibility',
        '--app-identifier',
        '9223',
        '--selector',
        '[data-testid="settings-desktop-overlay-enabled"]',
        '--strategy',
        'css',
    ]);
    assert.deepEqual(calls[1].args, [
        'webview-dom-snapshot',
        '--type',
        'accessibility',
        '--app-identifier',
        '9223',
    ]);
});

test('tauri activity-surfaces QA appends the HMR opt-out param to navigated paths', () => {
    assert.equal(typeof qaModule.buildActivitySurfacesPath, 'function');

    assert.equal(
        qaModule.buildActivitySurfacesPath('/settings'),
        '/settings?happier_hmr=0',
    );
    assert.equal(
        qaModule.buildActivitySurfacesPath('/desktop/activity-overlay?desktopOverlayWindow=1'),
        '/desktop/activity-overlay?desktopOverlayWindow=1&happier_hmr=0',
    );
});

test('tauri activity-surfaces QA builds a navigation script that no-ops when the target href is already active', () => {
    assert.equal(typeof qaModule.buildActivitySurfacesNavigationScript, 'function');

    const script = qaModule.buildActivitySurfacesNavigationScript('/settings');

    assert.equal(
        script.includes("const current = window.location && window.location.href ? window.location.href : '';"),
        true,
    );
    assert.equal(script.includes('if (current === next) {'), true);
    assert.equal(script.includes("window.history.pushState({}, '', nextPath);"), true);
    assert.equal(script.includes("window.dispatchEvent(new PopStateEvent('popstate'));"), true);
    assert.equal(script.includes('unchanged: true'), true);
    assert.equal(script.includes('changed: true'), true);
});

test('tauri activity-surfaces QA bounds the navigation webview command timeout and swallows navigation errors', async () => {
    assert.equal(typeof qaModule.navigateWebviewToPath, 'function');

    const calls = [];
    await assert.doesNotReject(async () => {
        await qaModule.navigateWebviewToPath('/settings', {
            appIdentifier: 9223,
            env: { EXISTING: 'value' },
            runCli: async (args, options) => {
                calls.push({ args, options });
                throw new Error('timed out');
            },
            windowId: 'main',
        });
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 2), ['webview-execute-js', '--script']);
    assert.equal(calls[0].options.timeoutMs, 5_000);
    assert.equal(calls[0].options.windowId, 'main');
    assert.equal(calls[0].options.appIdentifier, 9223);
});

test('tauri activity-surfaces QA types selector text through supported webview JS execution', async () => {
    assert.equal(typeof qaModule.typeActivitySurfacesSelectorText, 'function');

    const cliCalls = [];

    await qaModule.typeActivitySurfacesSelectorText(
        '[data-testid="restore-manual-secret-input"]',
        'ABC-DEF',
        {
            appIdentifier: 9223,
            env: { EXISTING: 'value' },
            runCli: async (args, options) => {
                cliCalls.push({ args, options });
                return { stdout: '{"ok":true}' };
            },
        },
    );

    assert.deepEqual(cliCalls, [
        {
            args: [
                'webview-execute-js',
                '--script',
                `(() => {
            const selector = "[data-testid='restore-manual-secret-input']";
            const text = "ABC-DEF";
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
                '9223',
                '--json',
            ],
            options: {
                appIdentifier: 9223,
                driverSession: null,
                env: { EXISTING: 'value' },
                windowId: null,
                timeoutMs: 20000,
            },
        },
    ]);
});

test('tauri activity-surfaces QA clicks selectors through webview JS execution instead of interactive transport', async () => {
    assert.equal(typeof qaModule.clickActivitySurfacesSelector, 'function');

    const cliCalls = [];

    await qaModule.clickActivitySurfacesSelector('[data-testid="onboarding-wizard-skip"]', {
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        runCli: async (args, options) => {
            cliCalls.push({ args, options });
            return { stdout: '{"ok":true}' };
        },
    });

    assert.equal(cliCalls.length, 2);
    assert.deepEqual(cliCalls[0], {
        args: [
            'webview-wait-for',
            '--type',
            'selector',
            '--strategy',
            'css',
            '--value',
            "[data-testid='onboarding-wizard-skip']",
            '--timeout',
            '8000',
            '--app-identifier',
            '9223',
        ],
        options: {
            appIdentifier: 9223,
            driverSession: null,
            env: { EXISTING: 'value' },
            windowId: null,
            timeoutMs: 20000,
        },
    });
    assert.equal(cliCalls[1].args[0], 'webview-execute-js');
    assert.equal(cliCalls[1].args.includes('--json'), true);
    assert.equal(String(cliCalls[1].args[2]).includes("onboarding-wizard-skip"), true);
});

test('tauri activity-surfaces QA re-establishes the driver session before a webview command when no resolved app is available', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesMcpCli, 'function');

    const driverSession = {
        driverSessionPort: 9225,
        resolvedAppIdentifier: null,
    };
    const jsonCalls = [];
    const jsonOptions = [];
    const cliCalls = [];

    const result = await qaModule.runActivitySurfacesMcpCli(
        ['webview-dom-snapshot', '--type', 'structure', '--app-identifier', '9225', '--window-id', 'main'],
        {
            appIdentifier: 9225,
            driverSession,
            env: { EXISTING: 'value' },
            runCli: async (args, options) => {
                cliCalls.push({ args, options });
                return { stdout: 'snapshot-ready' };
            },
            runCliJson: async (args, options) => {
                jsonCalls.push(args);
                jsonOptions.push(options ?? {});
                if (args[0] === 'driver-session' && args[1] === 'status' && jsonCalls.length === 1) {
                    return { text: JSON.stringify({ apps: [] }) };
                }
                if (args[0] === 'driver-session' && args[1] === 'start') {
                    return { ok: true };
                }
                if (args[0] === 'driver-session' && args[1] === 'status') {
                    return { text: JSON.stringify({ port: 9225 }) };
                }
                throw new Error(`Unexpected JSON call: ${args.join(' ')}`);
            },
        },
    );

    assert.equal(result.stdout, 'snapshot-ready');
    assert.equal(driverSession.resolvedAppIdentifier, 9225);
    assert.deepEqual(jsonCalls, [
        ['driver-session', 'status', '--port', '9225'],
        ['driver-session', 'start', '--port', '9225'],
        ['driver-session', 'status', '--port', '9225'],
    ]);
    assert.deepEqual(jsonOptions.map((options) => options.timeoutMs), [8_000, 8_000, 8_000]);
    assert.deepEqual(cliCalls, [
        {
            args: ['webview-dom-snapshot', '--type', 'structure', '--app-identifier', '9225', '--window-id', 'main'],
            options: {
                appIdentifier: 9225,
                driverSession,
                env: { EXISTING: 'value' },
                timeoutMs: undefined,
            },
        },
    ]);
});

test('tauri activity-surfaces QA reuses an already-resolved driver session without probing status first', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesMcpCli, 'function');

    const driverSession = {
        driverSessionPort: 9225,
        resolvedAppIdentifier: 9225,
    };
    const cliCalls = [];

    const result = await qaModule.runActivitySurfacesMcpCli(
        ['webview-dom-snapshot', '--type', 'structure', '--app-identifier', '9225', '--window-id', 'main'],
        {
            appIdentifier: driverSession.resolvedAppIdentifier,
            driverSession,
            env: { EXISTING: 'value' },
            runCli: async (args, options) => {
                cliCalls.push({ args, options });
                return { stdout: 'snapshot-ready' };
            },
            runCliJson: async () => {
                throw new Error('driver-session status should not be queried when a resolved app identifier is already cached');
            },
        },
    );

    assert.equal(result.stdout, 'snapshot-ready');
    assert.deepEqual(cliCalls, [
        {
            args: ['webview-dom-snapshot', '--type', 'structure', '--app-identifier', '9225', '--window-id', 'main'],
            options: {
                appIdentifier: '9225',
                driverSession,
                env: { EXISTING: 'value' },
                timeoutMs: undefined,
            },
        },
    ]);
});

test('tauri activity-surfaces QA retries a webview command after a lost driver session error', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesMcpCli, 'function');

    const driverSession = {
        driverSessionPort: 9225,
        resolvedAppIdentifier: 9225,
    };
    const jsonCalls = [];
    const jsonOptions = [];
    const cliCalls = [];

    const result = await qaModule.runActivitySurfacesMcpCli(
        ['webview-wait-for', '--type', 'selector', '--strategy', 'css', '--value', '[data-testid="foo"]', '--timeout', '8000', '--app-identifier', '9225', '--window-id', 'main'],
        {
            appIdentifier: driverSession.resolvedAppIdentifier,
            driverSession,
            env: { EXISTING: 'value' },
            runCli: async (args, options) => {
                cliCalls.push({ args, options });
                if (cliCalls.length === 1) {
                    throw new Error('Wait failed: WebView execution failed: No active session. Call driver_session with action "start" first to connect to a Tauri app.');
                }
                return { stdout: 'selector-ready' };
            },
            runCliJson: async (args, options) => {
                jsonCalls.push(args);
                jsonOptions.push(options ?? {});
                if (args[0] === 'driver-session' && args[1] === 'status' && jsonCalls.length === 1) {
                    return { text: JSON.stringify({ port: 9225 }) };
                }
                if (args[0] === 'driver-session' && args[1] === 'start') {
                    return { ok: true };
                }
                if (args[0] === 'driver-session' && args[1] === 'status') {
                    return { text: JSON.stringify({ port: 9225 }) };
                }
                throw new Error(`Unexpected JSON call: ${args.join(' ')}`);
            },
        },
    );

    assert.equal(result.stdout, 'selector-ready');
    assert.equal(driverSession.resolvedAppIdentifier, 9225);
    assert.deepEqual(jsonCalls, [
        ['driver-session', 'start', '--port', '9225'],
        ['driver-session', 'status', '--port', '9225'],
    ]);
    assert.deepEqual(jsonOptions.map((options) => options.timeoutMs), [8_000, 8_000]);
    assert.deepEqual(cliCalls, [
        {
            args: ['webview-wait-for', '--type', 'selector', '--strategy', 'css', '--value', '[data-testid="foo"]', '--timeout', '8000', '--app-identifier', '9225', '--window-id', 'main'],
            options: {
                appIdentifier: '9225',
                driverSession,
                env: { EXISTING: 'value' },
                timeoutMs: undefined,
            },
        },
        {
            args: ['webview-wait-for', '--type', 'selector', '--strategy', 'css', '--value', '[data-testid="foo"]', '--timeout', '8000', '--app-identifier', '9225', '--window-id', 'main'],
            options: {
                appIdentifier: 9225,
                driverSession,
                env: { EXISTING: 'value' },
                timeoutMs: undefined,
            },
        },
    ]);
});

test('tauri activity-surfaces QA only accepts a driver-session match for the requested target app', () => {
    assert.equal(typeof qaModule.resolveExactDriverSessionTarget, 'function');

    assert.deepEqual(
        qaModule.resolveExactDriverSessionTarget(
            { port: 9224, identifier: 'com.happier.stack.activity-surfaces-qa' },
            9224,
        ),
        {
            port: 9224,
            identifier: 'com.happier.stack.activity-surfaces-qa',
            host: null,
            name: null,
            isDefault: false,
        },
    );

    assert.equal(
        qaModule.resolveExactDriverSessionTarget(
            { port: 9223, identifier: 'dev.happier.app.publicdev' },
            9224,
        ),
        null,
    );

    assert.deepEqual(
        qaModule.resolveExactDriverSessionTarget(
            {
                apps: [
                    { port: 9223, identifier: 'dev.happier.app.publicdev', isDefault: true },
                    { port: 9224, identifier: 'com.happier.stack.activity-surfaces-qa', isDefault: false },
                ],
            },
            9224,
        ),
        {
            port: 9224,
            identifier: 'com.happier.stack.activity-surfaces-qa',
            host: null,
            name: null,
            isDefault: false,
        },
    );
});

test('tauri activity-surfaces QA parses selector-probe payloads from webview execute responses', () => {
    assert.equal(typeof qaModule.parseSelectorPresenceProbeText, 'function');

    assert.deepEqual(
        qaModule.parseSelectorPresenceProbeText(
            '["[data-testid=\\"onboarding-wizard\\"]","[data-testid=\\"onboarding-wizard-skip\\"]"]\n\n[Executed in window: main]',
        ),
        [
            '[data-testid="onboarding-wizard"]',
            '[data-testid="onboarding-wizard-skip"]',
        ],
    );

    assert.deepEqual(
        qaModule.parseSelectorPresenceProbeText(
            JSON.stringify({
                text: '["[data-testid=\\"onboarding-wizard\\"]","[data-testid=\\"welcome-server-unavailable\\"]"]\n\n[Executed in window: main]',
                markdown: null,
                structuredContent: null,
                content: [],
                files: [],
            }),
        ),
        [
            '[data-testid="onboarding-wizard"]',
            '[data-testid="welcome-server-unavailable"]',
        ],
    );

    assert.deepEqual(qaModule.parseSelectorPresenceProbeText('not-json'), []);
});

test('tauri activity-surfaces QA reaches settings via selector-based preflight without requiring a DOM snapshot', async () => {
    assert.equal(typeof qaModule.ensureActivitySurfacesSettingsShellReady, 'function');

    const warnings = [];
    const navigations = [];
    const clicks = [];
    const probeCalls = [];

    const result = await qaModule.ensureActivitySurfacesSettingsShellReady({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        preflightPlan: preflightModule.buildActivitySurfacesPreflightPlan(),
        navigateWebview: async (pathname) => {
            navigations.push(pathname);
        },
        click: async (selector) => {
            clicks.push(selector);
        },
        appendWarning: async (_artifactRoot, text) => {
            warnings.push(text);
        },
        wait: async () => {},
        probeSurface: async () => {
            probeCalls.push(true);
            if (probeCalls.length === 1) {
                return {
                    kind: 'action',
                    selector: '[data-testid="onboarding-wizard-skip"]',
                };
            }
            return {
                kind: 'ready',
            };
        },
    });

    assert.deepEqual(result, { ok: true, attempts: 2 });
    assert.deepEqual(navigations, ['/settings', '/settings']);
    assert.deepEqual(clicks, ['[data-testid="onboarding-wizard-skip"]']);
    assert.equal(probeCalls.length, 2);
    assert.deepEqual(warnings, []);
});

test('tauri activity-surfaces QA can retry the same actionable onboarding selector across multiple attempts', async () => {
    assert.equal(typeof qaModule.ensureActivitySurfacesSettingsShellReady, 'function');

    const warnings = [];
    const navigations = [];
    const clicks = [];
    const probeCalls = [];

    const result = await qaModule.ensureActivitySurfacesSettingsShellReady({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        preflightPlan: preflightModule.buildActivitySurfacesPreflightPlan(),
        navigateWebview: async (pathname) => {
            navigations.push(pathname);
        },
        click: async (selector) => {
            clicks.push(selector);
        },
        appendWarning: async (_artifactRoot, text) => {
            warnings.push(text);
        },
        wait: async () => {},
        probeSurface: async () => {
            probeCalls.push(true);
            if (probeCalls.length <= 2) {
                return {
                    kind: 'action',
                    selector: '[data-testid="onboarding-wizard-skip"]',
                };
            }
            return {
                kind: 'ready',
            };
        },
    });

    assert.deepEqual(result, { ok: true, attempts: 3 });
    assert.deepEqual(navigations, ['/settings', '/settings', '/settings']);
    assert.deepEqual(clicks, [
        '[data-testid="onboarding-wizard-skip"]',
        '[data-testid="onboarding-wizard-skip"]',
    ]);
    assert.equal(probeCalls.length, 3);
    assert.deepEqual(warnings, []);
});

test('tauri activity-surfaces QA keeps retrying the same actionable selector after a transient click failure', async () => {
    assert.equal(typeof qaModule.ensureActivitySurfacesSettingsShellReady, 'function');

    const warnings = [];
    const navigations = [];
    const clicks = [];
    const probeCalls = [];
    const selector = '[data-testid="onboarding-wizard-skip"]';

    const result = await qaModule.ensureActivitySurfacesSettingsShellReady({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        preflightPlan: preflightModule.buildActivitySurfacesPreflightPlan(),
        navigateWebview: async (pathname) => {
            navigations.push(pathname);
        },
        click: async (currentSelector) => {
            clicks.push(currentSelector);
            if (clicks.length === 1) {
                throw new Error('WebView execution failed: Not connected to plugin and reconnection failed');
            }
        },
        appendWarning: async (_artifactRoot, text) => {
            warnings.push(text);
        },
        wait: async () => {},
        probeSurface: async ({ triedSelectors }) => {
            probeCalls.push(new Set(triedSelectors));
            if (probeCalls.length <= 2 && !triedSelectors.has(selector)) {
                return {
                    kind: 'action',
                    selector,
                };
            }
            return {
                kind: 'ready',
            };
        },
    });

    assert.deepEqual(result, { ok: true, attempts: 3 });
    assert.deepEqual(navigations, ['/settings', '/settings', '/settings']);
    assert.deepEqual(clicks, [selector, selector]);
    assert.equal(probeCalls.length, 3);
    assert.deepEqual(warnings, []);
});

test('tauri activity-surfaces QA restore-secret resolution prefers explicit env over stack dev-key lookup', async () => {
    assert.equal(typeof qaModule.resolveActivitySurfacesRestoreSecretKey, 'function');

    const secret = await qaModule.resolveActivitySurfacesRestoreSecretKey({
        env: {
            HAPPIER_TAURI_QA_RESTORE_SECRET_KEY: 'MANUAL-RESTORE-SECRET',
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
        },
        readStackDevAuthKey: async () => {
            throw new Error('stack lookup should not be called when an explicit restore secret is configured');
        },
    });

    assert.equal(secret, 'MANUAL-RESTORE-SECRET');
});

test('tauri activity-surfaces QA auth completion does not settle on a transient missing-manual-input poll', async () => {
    assert.equal(typeof qaModule.waitForActivitySurfacesAuthCompletion, 'function');

    const cliResponses = [
        {
            stdout: JSON.stringify({
                pathname: '/',
                hasWelcomeRestore: false,
                hasRestoreOpenManual: false,
                hasRestoreManualInput: false,
                hasSettingsShell: false,
                hasSetupWizard: false,
            }),
        },
        ...Array.from({ length: 11 }, () => ({
            stdout: JSON.stringify({
                pathname: '/',
                hasWelcomeRestore: false,
                hasRestoreOpenManual: false,
                hasRestoreManualInput: true,
                hasSettingsShell: false,
                hasSetupWizard: false,
            }),
        })),
    ];

    const completed = await qaModule.waitForActivitySurfacesAuthCompletion({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        wait: async () => {},
        runCli: async () => {
            const next = cliResponses.shift();
            if (!next) {
                throw new Error('Unexpected extra completion poll');
            }
            return next;
        },
        isSelectorVisible: async () => false,
    });

    assert.equal(completed, false);
    assert.equal(cliResponses.length, 0);
});

test('tauri activity-surfaces QA auth completion accepts two consecutive auth-free polls when no positive surface is visible yet', async () => {
    assert.equal(typeof qaModule.waitForActivitySurfacesAuthCompletion, 'function');

    const cliResponses = [
        {
            stdout: JSON.stringify({
                pathname: '/',
                hasWelcomeRestore: false,
                hasRestoreOpenManual: false,
                hasRestoreManualInput: false,
                hasSettingsShell: false,
                hasSetupWizard: false,
            }),
        },
        {
            stdout: JSON.stringify({
                pathname: '/',
                hasWelcomeRestore: false,
                hasRestoreOpenManual: false,
                hasRestoreManualInput: false,
                hasSettingsShell: false,
                hasSetupWizard: false,
            }),
        },
    ];

    const completed = await qaModule.waitForActivitySurfacesAuthCompletion({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        wait: async () => {},
        runCli: async () => {
            const next = cliResponses.shift();
            if (!next) {
                throw new Error('Unexpected extra completion poll');
            }
            return next;
        },
        isSelectorVisible: async () => false,
    });

    assert.equal(completed, true);
    assert.equal(cliResponses.length, 0);
});

test('tauri activity-surfaces QA auth completion keeps polling long enough for a delayed setup wizard surface', async () => {
    assert.equal(typeof qaModule.waitForActivitySurfacesAuthCompletion, 'function');

    const cliResponses = [
        1, 2, 3, 4, 5, 6,
    ].map(() => ({
        stdout: JSON.stringify({
            pathname: '/',
            hasWelcomeRestore: false,
            hasRestoreOpenManual: false,
            hasRestoreManualInput: true,
            hasSettingsShell: false,
            hasSetupWizard: false,
        }),
    }));
    cliResponses.push({
        stdout: JSON.stringify({
            pathname: '/',
            hasWelcomeRestore: false,
            hasRestoreOpenManual: false,
            hasRestoreManualInput: false,
            hasSettingsShell: false,
            hasSetupWizard: true,
        }),
    });

    const completed = await qaModule.waitForActivitySurfacesAuthCompletion({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        wait: async () => {},
        runCli: async () => {
            const next = cliResponses.shift();
            if (!next) {
                throw new Error('Unexpected extra completion poll');
            }
            return next;
        },
        isSelectorVisible: async () => false,
    });

    assert.equal(completed, true);
    assert.equal(cliResponses.length, 0);
});

test('tauri activity-surfaces QA retries settings preflight after restoring auth through the canonical restore flow', async () => {
    assert.equal(typeof qaModule.ensureActivitySurfacesSettingsShellReady, 'function');

    const warnings = [];
    const navigations = [];
    const restoreCalls = [];
    const probeCalls = [];

    const result = await qaModule.ensureActivitySurfacesSettingsShellReady({
        appIdentifier: 9223,
        env: { HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        preflightPlan: preflightModule.buildActivitySurfacesPreflightPlan(),
        navigateWebview: async (pathname) => {
            navigations.push(pathname);
        },
        appendWarning: async (_artifactRoot, text) => {
            warnings.push(text);
        },
        wait: async () => {},
        probeSurface: async () => {
            probeCalls.push(true);
            if (probeCalls.length === 1) {
                return {
                    kind: 'blocked',
                    blocker: 'auth',
                    message: 'The app reached the auth welcome surface before settings. Sign in or seed a post-auth state, then rerun the activity-surfaces QA capture.',
                };
            }
            return {
                kind: 'ready',
            };
        },
        restoreAuth: async (options) => {
            restoreCalls.push(options);
            return true;
        },
    });

    assert.deepEqual(result, { ok: true, attempts: 2 });
    assert.deepEqual(navigations, ['/settings', '/settings']);
    assert.equal(restoreCalls.length, 1);
    assert.deepEqual(warnings, []);
});

test('tauri activity-surfaces QA restore helper drives the real restore/manual auth selectors with the stack dev key', async () => {
    assert.equal(typeof qaModule.restoreActivitySurfacesAuthWithDevKey, 'function');

    const clicks = [];
    const visibilityChecks = [];
    const completions = [];
    const submissions = [];
    const visibilityPlan = new Map([
        ['[data-testid="restore-manual-secret-input"]', [true]],
    ]);

    const restored = await qaModule.restoreActivitySurfacesAuthWithDevKey({
        appIdentifier: 9223,
        env: { HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        resolveRestoreSecret: async () => 'AAAAB-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH-IIIII-JJJJJ-KKKKK',
        click: async (selector) => {
            clicks.push(selector);
        },
        submitRestoreSecret: async (secret, options) => {
            submissions.push({ secret, options });
        },
        isSelectorVisible: async (selector) => {
            visibilityChecks.push(selector);
            const planned = visibilityPlan.get(selector);
            if (planned && planned.length > 0) {
                return planned.shift();
            }
            return false;
        },
        waitForAuthCompletion: async (options) => {
            completions.push(options);
            return true;
        },
        wait: async () => {},
    });

    assert.equal(restored, true);
    assert.deepEqual(clicks, []);
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0]?.secret, 'AAAAB-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH-IIIII-JJJJJ-KKKKK');
    assert.equal(submissions[0]?.options?.appIdentifier, 9223);
    assert.deepEqual(submissions[0]?.options?.env, { HAPPIER_STACK_STACK: 'activity-surfaces-qa' });
    assert.equal(submissions[0]?.options?.driverSession, null);
    assert.deepEqual(visibilityChecks, [
        '[data-testid="restore-manual-secret-input"]',
    ]);
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.appIdentifier, 9223);
});

test('tauri activity-surfaces QA restore helper resumes from an already-open manual restore screen', async () => {
    assert.equal(typeof qaModule.restoreActivitySurfacesAuthWithDevKey, 'function');

    const clicks = [];
    const typed = [];
    const visibilityChecks = [];
    const visibilityPlan = new Map([
        ['[data-testid="welcome-restore"]', [false, false, false, false, false, false]],
        ['[data-testid="restore-open-manual"]', [true]],
        ['[data-testid="restore-manual-secret-input"]', [false, true]],
    ]);

    const restored = await qaModule.restoreActivitySurfacesAuthWithDevKey({
        appIdentifier: 9223,
        env: { HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        resolveRestoreSecret: async () => 'AAAAB-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH-IIIII-JJJJJ-KKKKK',
        click: async (selector) => {
            clicks.push(selector);
        },
        submitRestoreSecret: async (secret) => {
            typed.push({
                selector: '[data-testid="restore-manual-secret-input"]',
                text: secret,
            });
            clicks.push('[data-testid="restore-manual-submit"]');
        },
        isSelectorVisible: async (selector) => {
            visibilityChecks.push(selector);
            const planned = visibilityPlan.get(selector);
            if (planned && planned.length > 0) {
                return planned.shift();
            }
            return false;
        },
        waitForAuthCompletion: async () => true,
        wait: async () => {},
    });

    assert.equal(restored, true);
    assert.deepEqual(clicks, [
        '[data-testid="restore-open-manual"]',
        '[data-testid="restore-manual-submit"]',
    ]);
    assert.deepEqual(typed, [
        {
            selector: '[data-testid="restore-manual-secret-input"]',
            text: 'AAAAB-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH-IIIII-JJJJJ-KKKKK',
        },
    ]);
    assert.deepEqual(visibilityChecks, [
        '[data-testid="restore-manual-secret-input"]',
        '[data-testid="welcome-restore"]',
        '[data-testid="welcome-restore"]',
        '[data-testid="welcome-restore"]',
        '[data-testid="welcome-restore"]',
        '[data-testid="welcome-restore"]',
        '[data-testid="welcome-restore"]',
        '[data-testid="restore-open-manual"]',
        '[data-testid="restore-manual-secret-input"]',
    ]);
});

test('tauri activity-surfaces QA restore helper waits for the welcome restore button to appear before advancing', async () => {
    assert.equal(typeof qaModule.restoreActivitySurfacesAuthWithDevKey, 'function');

    const clicks = [];
    const typed = [];
    const visibilityChecks = [];
    const visibilityPlan = new Map([
        ['[data-testid="welcome-restore"]', [false, false, true]],
        ['[data-testid="restore-manual-secret-input"]', [false, true]],
    ]);

    const restored = await qaModule.restoreActivitySurfacesAuthWithDevKey({
        appIdentifier: 9223,
        env: { HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        resolveRestoreSecret: async () => 'AAAAB-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH-IIIII-JJJJJ-KKKKK',
        click: async (selector) => {
            clicks.push(selector);
        },
        submitRestoreSecret: async (secret) => {
            typed.push({
                selector: '[data-testid="restore-manual-secret-input"]',
                text: secret,
            });
            clicks.push('[data-testid="restore-manual-submit"]');
        },
        isSelectorVisible: async (selector) => {
            visibilityChecks.push(selector);
            const planned = visibilityPlan.get(selector);
            if (planned && planned.length > 0) {
                return planned.shift();
            }
            return false;
        },
        waitForAuthCompletion: async () => true,
        wait: async () => {},
    });

    assert.equal(restored, true);
    assert.deepEqual(clicks, [
        '[data-testid="welcome-restore"]',
        '[data-testid="restore-manual-submit"]',
    ]);
    assert.deepEqual(typed, [
        {
            selector: '[data-testid="restore-manual-secret-input"]',
            text: 'AAAAB-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH-IIIII-JJJJJ-KKKKK',
        },
    ]);
    assert.deepEqual(visibilityChecks, [
        '[data-testid="restore-manual-secret-input"]',
        '[data-testid="welcome-restore"]',
        '[data-testid="welcome-restore"]',
        '[data-testid="welcome-restore"]',
        '[data-testid="restore-manual-secret-input"]',
    ]);
});

test('tauri activity-surfaces QA restore helper retries settings navigation when auth completion is still pending after submit', async () => {
    assert.equal(typeof qaModule.restoreActivitySurfacesAuthWithDevKey, 'function');

    const navigations = [];
    const clicks = [];
    const typed = [];
    const visibilityChecks = [];
    const visibilityPlan = new Map([
        ['[data-testid="welcome-restore"]', [true]],
        ['[data-testid="restore-manual-secret-input"]', [false, true]],
    ]);
    const completionPlan = [false, true];

    const restored = await qaModule.restoreActivitySurfacesAuthWithDevKey({
        appIdentifier: 9223,
        env: { HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        resolveRestoreSecret: async () => 'AAAAB-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH-IIIII-JJJJJ-KKKKK',
        navigateWebview: async (pathname) => {
            navigations.push(pathname);
        },
        click: async (selector) => {
            clicks.push(selector);
        },
        submitRestoreSecret: async (secret) => {
            typed.push({
                selector: '[data-testid="restore-manual-secret-input"]',
                text: secret,
            });
            clicks.push('[data-testid="restore-manual-submit"]');
        },
        isSelectorVisible: async (selector) => {
            visibilityChecks.push(selector);
            const planned = visibilityPlan.get(selector);
            if (planned && planned.length > 0) {
                return planned.shift();
            }
            return false;
        },
        waitForAuthCompletion: async () => completionPlan.shift() ?? false,
        wait: async () => {},
    });

    assert.equal(restored, true);
    assert.deepEqual(navigations, ['/settings']);
    assert.deepEqual(clicks, [
        '[data-testid="welcome-restore"]',
        '[data-testid="restore-manual-submit"]',
    ]);
    assert.deepEqual(typed, [
        {
            selector: '[data-testid="restore-manual-secret-input"]',
            text: 'AAAAB-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH-IIIII-JJJJJ-KKKKK',
        },
    ]);
    assert.deepEqual(visibilityChecks, [
        '[data-testid="restore-manual-secret-input"]',
        '[data-testid="welcome-restore"]',
        '[data-testid="restore-manual-secret-input"]',
    ]);
});
