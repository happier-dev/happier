import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import * as preflightModule from './tauriActivitySurfacesPreflight.mjs';
import * as qaModule from './tauriActivitySurfacesMcpQa.mjs';
import {
    resolvePreferredAppIdentifierFromDriverStatus,
    tryParseDriverSessionStatus,
} from './tauriDriverSessionSelection.mjs';

const execFileAsync = promisify(execFile);
const { resolveActivitySurfacesPreflightSelector } = preflightModule;
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
const canonicalActivitySurfacesProofStepIds = [...canonicalActivitySurfacesRequiredProofStepIds];
const minimalActivitySurfacesCaptureStepIds = [
    'settings_overlay',
    'overlay_route',
    'overlay_collapsed',
    'overlay_expanded',
    'overlay_floating_fallback',
];
const deterministicOverlayCaptureOptionalStepIds = canonicalActivitySurfacesRequiredProofStepIds.filter(
    (stepId) => !minimalActivitySurfacesCaptureStepIds.includes(stepId),
);

function createSyntheticOverlayCaptureLaneArtifacts(stepId) {
    return { stepId };
}

function createExpectedOverlayCaptureLaneResult({
    includeCompletionState = false,
} = {}) {
    const optionalStepIds = Array.from(new Set([
        ...deterministicOverlayCaptureOptionalStepIds,
        ...(includeCompletionState ? ['overlay_completion_state'] : []),
    ]));

    return {
        settingsArtifacts: createSyntheticOverlayCaptureLaneArtifacts('settings_overlay'),
        overlayRouteArtifacts: createSyntheticOverlayCaptureLaneArtifacts('overlay_route'),
        collapsedArtifacts: createSyntheticOverlayCaptureLaneArtifacts('overlay_collapsed'),
        expandedArtifacts: createSyntheticOverlayCaptureLaneArtifacts('overlay_expanded'),
        floatingFallbackArtifacts: createSyntheticOverlayCaptureLaneArtifacts('overlay_floating_fallback'),
        overlayVisibilityEnabled: true,
        optionalStepArtifacts: Object.fromEntries(
            optionalStepIds.map((stepId) => [stepId, createSyntheticOverlayCaptureLaneArtifacts(stepId)]),
        ),
    };
}

function createSyntheticQaProofArtifacts(stepId) {
    return {
        screenshotPath: `/tmp/${stepId}.png`,
        structurePath: `/tmp/${stepId}.structure.yml`,
        a11yPath: `/tmp/${stepId}.a11y.yml`,
    };
}

function createCompleteSyntheticQaOverlayCaptureResult({
    includeCompletionState = false,
} = {}) {
    const optionalStepIds = Array.from(new Set([
        ...deterministicOverlayCaptureOptionalStepIds,
        ...(includeCompletionState ? ['overlay_completion_state'] : []),
    ]));

    return {
        settingsArtifacts: createSyntheticQaProofArtifacts('settings_overlay'),
        overlayRouteArtifacts: createSyntheticQaProofArtifacts('overlay_route'),
        collapsedArtifacts: createSyntheticQaProofArtifacts('overlay_collapsed'),
        expandedArtifacts: createSyntheticQaProofArtifacts('overlay_expanded'),
        floatingFallbackArtifacts: createSyntheticQaProofArtifacts('overlay_floating_fallback'),
        overlayVisibilityEnabled: true,
        optionalStepArtifacts: Object.fromEntries(
            optionalStepIds.map((stepId) => [stepId, createSyntheticQaProofArtifacts(stepId)]),
        ),
    };
}

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
        canonicalActivitySurfacesProofStepIds,
    );
    assert.deepEqual(payload.plan.steps[0].selectors, ['[data-testid="settings-desktop-overlay-enabled"]']);
    assert.equal(payload.plan.steps[0].snapshotSelector, '[data-testid="settings-desktop-overlay-enabled"]');
    assert.deepEqual(payload.plan.steps[1].selectors, [
        '[data-testid="desktop-activity-overlay-collapsed"]',
        '[data-testid="desktop-activity-overlay-expanded"]',
    ]);
    assert.deepEqual(payload.plan.steps[2].selectors, ['[data-testid="desktop-activity-overlay-collapsed-notch"]']);
    assert.deepEqual(payload.plan.steps[3].selectors, ['[data-testid="desktop-activity-overlay-expanded-notch"]']);
    assert.deepEqual(payload.plan.steps[4].selectors, ['[data-testid="desktop-activity-overlay-collapsed-floating"]']);
    assert.deepEqual(payload.plan.steps[5].selectors, ['[data-testid="desktop-activity-overlay-expanded-floating"]']);
    assert.deepEqual(payload.plan.steps[6].selectors, ['[data-testid="desktop-activity-overlay-card-idle-idle"]']);
    assert.deepEqual(payload.plan.steps[7].selectors, ['[data-testid="desktop-activity-overlay-card-permission_request-qa-permission-request"]']);
    assert.deepEqual(payload.plan.steps[8].selectors, ['[data-testid="desktop-activity-overlay-card-user_question-qa-user-question"]']);
    assert.deepEqual(payload.plan.steps[9].selectors, ['[data-testid="desktop-activity-overlay-card-quota_summary-qa-quota-summary"]']);
    assert.deepEqual(payload.plan.steps[10].selectors, ['[data-testid="desktop-activity-overlay-card-multi_session_list-list"]']);
    assert.deepEqual(payload.plan.steps[11].selectors, ['[data-testid="desktop-activity-overlay-card-completion_state-qa-completion-state"]']);
    assert.deepEqual(
        payload.plan.steps.map((step) => [step.id, step.required === true]),
        [
            ['settings_overlay', true],
            ['overlay_route', true],
            ['overlay_collapsed', true],
            ['overlay_expanded', true],
            ['overlay_floating_fallback', true],
            ['overlay_floating_expanded', true],
            ['overlay_idle', true],
            ['overlay_permission_request', true],
            ['overlay_user_question', true],
            ['overlay_quota_summary', true],
            ['overlay_multi_session_list', true],
            ['overlay_completion_state', true],
        ],
    );
    assert.deepEqual(payload.plan.preflight.settingsSelectors, [
        '[data-testid="settings-desktop-overlay-enabled"]',
    ]);
    assert.deepEqual(payload.plan.preflight.settingsIndexSelectors, [
        '[data-testid="settings-shell.sidebarPane"]',
        '[data-testid="settings-desktop-entry"]',
        '[data-testid="settings-add-your-phone-shortcut"]',
        '[data-testid="settings-mcp-servers-item"]',
        '[data-testid="settings-system-status-item"]',
    ]);
    assert.deepEqual(payload.plan.preflight.settingsShellActionSelectors, [
        '[data-testid="tabbar-tab-settings"]',
    ]);
    assert.equal(payload.plan.preflight.desktopSettingsPath, '/settings/desktop');
    assert.equal(payload.plan.preflight.desktopSettingsShellMaxAttempts, 2);
    assert.equal(payload.plan.preflight.desktopSettingsShellSelectorPresenceProbeTimeoutMs, 1_500);
    assert.equal(payload.plan.preflight.desktopSettingsShellRootStateProbeTimeoutMs, 1_500);
    assert.equal(payload.plan.preflight.desktopSettingsShellStructureSnapshotProbeTimeoutMs, 2_000);
    assert.deepEqual(payload.plan.preflight.onboardingSelectors, [
        '[data-testid="onboarding-wizard-card"]',
        '[data-testid="onboarding-wizard"]',
        '[data-testid="onboarding-wizard-primary"]',
        '[data-testid="onboarding-wizard-scan"]',
        '[data-testid="onboarding-wizard-skip"]',
        '[data-testid="onboarding-wizard-relay-diagram"]',
        '[data-testid="onboarding-wizard-relay:cloud"]',
        '[data-testid="onboarding-wizard-relay:thisComputer"]',
        '[data-testid="onboarding-wizard-relay:remoteComputer"]',
        '[data-testid="onboarding-wizard-relay:customUrl"]',
        '[data-testid="onboarding-wizard-relay-host-local-checklist-row-startRelayRuntime"]',
        '[data-testid="onboarding-wizard-back"]',
        '[data-testid="onboarding-wizard-welcome-body"]',
    ]);
    assert.equal(payload.plan.preflight.settingsPath, '/settings');
    assert.equal(
        payload.plan.manual.some((entry) => entry.includes('confirm the runtime has at least one active session')),
        false,
    );
    assert.equal(payload.plan.manual.some((entry) => entry.includes('idle surface')), true);
    assert.equal(
        payload.plan.manual.some((entry) => entry.includes('HAPPIER_TAURI_ACTIVITY_SURFACES_QA_SEED_STRATEGY=skip')),
        true,
    );
    assert.equal(
        payload.plan.manual.some((entry) => entry.includes('permission_request') && entry.includes('user_question')),
        true,
    );
});

test('tauri activity-surfaces QA parses driver-session status from MCP content envelopes', () => {
    const status = tryParseDriverSessionStatus({
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    connected: true,
                    app: 'Tauri App (localhost:9223)',
                    identifier: 'com.happier.stack.activity-surfaces-qa',
                    host: 'localhost',
                    port: 9223,
                }),
            },
        ],
    });

    assert.equal(
        resolvePreferredAppIdentifierFromDriverStatus(status, 9223),
        'com.happier.stack.activity-surfaces-qa',
    );
});

test('tauri activity-surfaces expands the overlay by emitting an overlay interaction', async () => {
    const calls = [];

    await qaModule.setActivitySurfacesOverlayExpanded(true, {
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        windowId: 'activity_overlay',
        runCli: async (args, options) => {
            calls.push({ args, options });
            return { stdout: JSON.stringify({ ok: true }) };
        },
    });

    assert.equal(calls.length, 2);

    const scriptFlagIndex = calls[0].args.indexOf('--script');
    assert.equal(scriptFlagIndex >= 0, true);
    const script = String(calls[0].args[scriptFlagIndex + 1] ?? '');
    assert.match(script, /desktop_activity_overlay_emit_interaction/);
    assert.match(script, /overlay-set-expanded/);
    assert.equal(calls[0].options.windowId, 'activity_overlay');

    const scriptFlagIndex2 = calls[1].args.indexOf('--script');
    assert.equal(scriptFlagIndex2 >= 0, true);
    const script2 = String(calls[1].args[scriptFlagIndex2 + 1] ?? '');
    assert.match(script2, /desktop_activity_overlay_set_expanded/);
    assert.equal(calls[1].options.windowId, 'main');
});

test('tauri activity-surfaces programmatic expansion emits the canonical state interaction from main by default', async () => {
    const calls = [];

    await qaModule.setActivitySurfacesOverlayExpanded(true, {
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        runCli: async (args, options) => {
            calls.push({ args, options });
            return { stdout: JSON.stringify({ ok: true }) };
        },
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.windowId, 'main');
    assert.equal(calls[1].options.windowId, 'main');
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
        '[data-testid="onboarding-wizard-relay-host-local-checklist-row-startRelayRuntime"]',
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
        'data-testid=onboarding-wizard-welcome-auth',
        'data-testid=onboarding-wizard-welcome-showcase',
        'data-testid=onboarding-wizard-welcome-provider:claude',
    ].join('\n');

    assert.deepEqual(preflightModule.analyzeActivitySurfacesPreflightSurface(authSnapshot), {
        kind: 'blocked',
        blocker: 'auth',
        message: 'The app reached the auth welcome surface before settings. Sign in or seed a post-auth state, then rerun the activity-surfaces QA capture.',
    });
});

test('tauri activity-surfaces QA preflight classifies app crash surfaces as explicit blockers', () => {
    assert.equal(typeof preflightModule.analyzeActivitySurfacesPreflightSurface, 'function');
    const crashSnapshot = [
        'data-testid=app-blocking-logo',
        'data-testid=app-crash-restart',
        'data-testid=app-crash-copy-details',
    ].join('\n');

    assert.deepEqual(preflightModule.analyzeActivitySurfacesPreflightSurface(crashSnapshot), {
        kind: 'blocked',
        blocker: 'app-crash',
        message: 'The main app window is on the crash recovery screen instead of the settings shell. Fix or clear the app crash, then rerun the activity-surfaces QA capture.',
    });
});

test('tauri activity-surfaces QA preflight classifies Metro bundle failures from root text as explicit blockers', () => {
    assert.equal(typeof preflightModule.analyzeActivitySurfacesPreflightRootText, 'function');

    assert.deepEqual(
        preflightModule.analyzeActivitySurfacesPreflightRootText([
            'Web Bundling failed',
            'Unable to resolve "../../sync/domains/server/url/shouldHoldUnauthenticatedShellForWebServerOverride"',
            'Import stack:',
        ].join('\n')),
        {
            kind: 'blocked',
            blocker: 'bundle-failure',
            message: 'The app failed to bundle before the desktop settings shell loaded. Fix the Expo/Metro bundle error, then rerun the activity-surfaces QA capture.',
        },
    );
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
            new Set(['[data-testid="settings-desktop-overlay-enabled"]']),
        ),
        { kind: 'ready' },
    );

    assert.deepEqual(
        preflightModule.classifyActivitySurfacesPreflightSelectors(
            new Set(['[data-testid="settings-shell.sidebarPane"]']),
        ),
        { kind: 'ready' },
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

test('tauri activity-surfaces QA preflight uses the real settings tab before raw route navigation', () => {
    assert.equal(typeof preflightModule.classifyActivitySurfacesPreflightSelectors, 'function');

    assert.deepEqual(
        preflightModule.classifyActivitySurfacesPreflightSelectors(
            new Set(['[data-testid="tabbar-tab-settings"]']),
        ),
        {
            kind: 'action',
            selector: '[data-testid="tabbar-tab-settings"]',
        },
    );
});

test('tauri activity-surfaces QA preflight prefers a relay branch action over skip on the onboarding relay step', () => {
    assert.equal(typeof preflightModule.classifyActivitySurfacesPreflightSelectors, 'function');

    assert.deepEqual(
        preflightModule.classifyActivitySurfacesPreflightSelectors(
            new Set([
                '[data-testid="onboarding-wizard"]',
                '[data-testid="onboarding-wizard-skip"]',
                '[data-testid="onboarding-wizard-primary"]',
                '[data-testid="onboarding-wizard-relay-diagram"]',
                '[data-testid="onboarding-wizard-relay:cloud"]',
                '[data-testid="onboarding-wizard-relay:thisComputer"]',
                '[data-testid="onboarding-wizard-relay:customUrl"]',
            ]),
        ),
        {
            kind: 'action',
            selector: '[data-testid="onboarding-wizard-relay:cloud"]',
        },
    );
});

test('tauri activity-surfaces QA preflight prefers the relay primary action after a relay branch was already chosen', () => {
    assert.equal(typeof preflightModule.classifyActivitySurfacesPreflightSelectors, 'function');

    assert.deepEqual(
        preflightModule.classifyActivitySurfacesPreflightSelectors(
            new Set([
                '[data-testid="onboarding-wizard"]',
                '[data-testid="onboarding-wizard-skip"]',
                '[data-testid="onboarding-wizard-primary"]',
                '[data-testid="onboarding-wizard-relay-diagram"]',
                '[data-testid="onboarding-wizard-relay:cloud"]',
                '[data-testid="onboarding-wizard-relay:thisComputer"]',
                '[data-testid="onboarding-wizard-relay:customUrl"]',
            ]),
            preflightModule.buildActivitySurfacesPreflightPlan(),
            {
                triedSelectors: new Set(['[data-testid="onboarding-wizard-relay:cloud"]']),
            },
        ),
        {
            kind: 'action',
            selector: '[data-testid="onboarding-wizard-primary"]',
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

test('tauri activity-surfaces QA uses a full-window onboarding snapshot before probing every onboarding action selector', async () => {
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
    assert.deepEqual(snapshotCalls, [null, null]);
    assert.equal(selectorCalls.includes('[data-testid="onboarding-wizard-skip"]'), false);
    assert.equal(selectorCalls.includes('[data-testid="onboarding-wizard-primary"]'), false);
});

test('tauri activity-surfaces QA falls back to bounded selector probes when the fast probe returns empty', async () => {
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
            return selector === '[data-testid="setupWizard.surface"]'
                || selector === '[data-testid="setupWizard.surface-skip"]';
        },
        captureStructureSnapshot: async ({ selector }) => {
            snapshotCalls.push(selector ?? null);
            return '';
        },
    });

    assert.deepEqual(result, {
        kind: 'action',
        selector: '[data-testid="setupWizard.surface-skip"]',
    });
    assert.deepEqual(snapshotCalls, [null]);
    assert.deepEqual(selectorCalls, [
        '[data-testid="onboarding-wizard-welcome-auth"]',
        '[data-testid="welcome-create-account"]',
        '[data-testid="welcome-restore"]',
        '[data-testid="app-blocking-logo"]',
        '[data-testid="app-crash-restart"]',
        '[data-testid="onboarding-wizard-card"]',
        '[data-testid="onboarding-wizard"]',
        '[data-testid="setupWizard.surface"]',
        '[data-testid="setupWizard.surface-skip"]',
        '[data-testid="settings-shell.sidebarPane"]',
        '[data-testid="settings-desktop-entry"]',
        '[data-testid="settings-add-your-phone-shortcut"]',
        '[data-testid="settings-mcp-servers-item"]',
        '[data-testid="settings-system-status-item"]',
        '[data-testid="settings-desktop-overlay-enabled"]',
    ]);
});

test('tauri activity-surfaces QA enriches partial onboarding selector probes with root-state visible test ids before falling back to a snapshot', async () => {
    assert.equal(typeof qaModule.probeActivitySurfacesPreflightSurface, 'function');

    const captureCalls = [];
    const rootStateCalls = [];
    const result = await qaModule.probeActivitySurfacesPreflightSurface({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        plan: preflightModule.buildActivitySurfacesPreflightPlan(),
        probeVisibleSelectors: async () => [
            '[data-testid="onboarding-wizard"]',
            '[data-testid="onboarding-wizard-skip"]',
            '[data-testid="onboarding-wizard-primary"]',
        ],
        probeRootState: async () => {
            rootStateCalls.push(true);
            return {
                pathname: '/',
                visibleTestIds: [
                    'onboarding-wizard',
                    'onboarding-wizard-skip',
                    'onboarding-wizard-primary',
                    'onboarding-wizard-relay-diagram',
                    'onboarding-wizard-relay:cloud',
                    'onboarding-wizard-relay:thisComputer',
                ],
            };
        },
        captureStructureSnapshot: async (options) => {
            captureCalls.push(options);
            return [
                'data-testid=onboarding-wizard',
                'data-testid=onboarding-wizard-skip',
                'data-testid=onboarding-wizard-primary',
                'data-testid=onboarding-wizard-relay-diagram',
                'data-testid=onboarding-wizard-relay:cloud',
                'data-testid=onboarding-wizard-relay:thisComputer',
            ].join('\n');
        },
    });

    assert.deepEqual(result, {
        kind: 'action',
        selector: '[data-testid="onboarding-wizard-relay:cloud"]',
    });
    assert.equal(rootStateCalls.length, 1);
    assert.deepEqual(captureCalls, []);
});

test('tauri activity-surfaces QA retries root-state probing after an initial transient failure before degrading to generic settings navigation', async () => {
    assert.equal(typeof qaModule.probeActivitySurfacesPreflightSurface, 'function');

    const rootStateCalls = [];
    const snapshotCalls = [];

    const result = await qaModule.probeActivitySurfacesPreflightSurface({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        plan: preflightModule.buildActivitySurfacesPreflightPlan(),
        probeVisibleSelectors: async () => [],
        probeRootState: async () => {
            rootStateCalls.push(rootStateCalls.length + 1);
            if (rootStateCalls.length === 1) {
                throw new Error('transient root-state disconnect');
            }
            return {
                pathname: '/',
                rootText: 'Start\nWelcome to Happier',
                visibleTestIds: [
                    'onboarding-wizard',
                    'onboarding-wizard-welcome-auth',
                    'onboarding-wizard-skip',
                ],
            };
        },
        captureStructureSnapshot: async ({ selector }) => {
            snapshotCalls.push(selector ?? null);
            return '';
        },
        isSelectorVisible: async () => false,
    });

    assert.deepEqual(result, {
        kind: 'blocked',
        blocker: 'auth',
        message: 'The app reached the auth welcome surface before settings. Sign in or seed a post-auth state, then rerun the activity-surfaces QA capture.',
    });
    assert.equal(rootStateCalls.length, 2);
    assert.deepEqual(snapshotCalls, []);
});

test('tauri activity-surfaces QA preflight treats Metro bundle failures in root text as explicit blockers before retry navigation', async () => {
    assert.equal(typeof qaModule.probeActivitySurfacesPreflightSurface, 'function');

    const result = await qaModule.probeActivitySurfacesPreflightSurface({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        plan: preflightModule.buildActivitySurfacesPreflightPlan(),
        probeVisibleSelectors: async () => [],
        probeRootState: async () => ({
            pathname: '/',
            rootText: [
                'Web Bundling failed',
                'Unable to resolve "../../sync/domains/server/url/shouldHoldUnauthenticatedShellForWebServerOverride"',
                'Import stack:',
            ].join('\n'),
            visibleTestIds: [],
        }),
        captureStructureSnapshot: async () => {
            throw new Error('snapshot should not run when the bundle failure is already visible in root text');
        },
        isSelectorVisible: async () => false,
    });

    assert.deepEqual(result, {
        kind: 'blocked',
        blocker: 'bundle-failure',
        message: 'The app failed to bundle before the desktop settings shell loaded. Fix the Expo/Metro bundle error, then rerun the activity-surfaces QA capture.',
    });
});

test('tauri activity-surfaces QA waits for the fast selector probe to settle before starting root-state enrichment', async () => {
    assert.equal(typeof qaModule.probeActivitySurfacesPreflightSurface, 'function');

    let resolveVisibleSelectors;
    const visibleSelectorsPromise = new Promise((resolve) => {
        resolveVisibleSelectors = resolve;
    });
    let rootStateStartedBeforeSelectorSettled = false;
    let selectorProbeSettled = false;

    const probePromise = qaModule.probeActivitySurfacesPreflightSurface({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        plan: preflightModule.buildActivitySurfacesPreflightPlan(),
        probeVisibleSelectors: async () => {
            await visibleSelectorsPromise;
            selectorProbeSettled = true;
            return [
                '[data-testid="onboarding-wizard"]',
                '[data-testid="onboarding-wizard-skip"]',
                '[data-testid="onboarding-wizard-primary"]',
            ];
        },
        probeRootState: async () => {
            if (!selectorProbeSettled) {
                rootStateStartedBeforeSelectorSettled = true;
            }
            return {
                pathname: '/',
                visibleTestIds: [
                    'onboarding-wizard',
                    'onboarding-wizard-skip',
                    'onboarding-wizard-primary',
                    'onboarding-wizard-relay-diagram',
                    'onboarding-wizard-relay:cloud',
                ],
            };
        },
        captureStructureSnapshot: async () => '',
    });

    await Promise.resolve();
    assert.equal(rootStateStartedBeforeSelectorSettled, false);
    resolveVisibleSelectors();

    await assert.doesNotReject(probePromise);
    assert.deepEqual(await probePromise, {
        kind: 'action',
        selector: '[data-testid="onboarding-wizard-relay:cloud"]',
    });
    assert.equal(selectorProbeSettled, true);
});

test('tauri activity-surfaces QA uses a full-window onboarding snapshot when relay selectors only appear outside the onboarding root snapshot', async () => {
    assert.equal(typeof qaModule.probeActivitySurfacesPreflightSurface, 'function');

    const captureCalls = [];
    const result = await qaModule.probeActivitySurfacesPreflightSurface({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        plan: preflightModule.buildActivitySurfacesPreflightPlan(),
        probeVisibleSelectors: async () => [
            '[data-testid="onboarding-wizard"]',
            '[data-testid="onboarding-wizard-skip"]',
            '[data-testid="onboarding-wizard-primary"]',
        ],
        probeRootState: async () => null,
        captureStructureSnapshot: async (options) => {
            captureCalls.push(options);
            if (options.selector == null) {
                return [
                    'data-testid=onboarding-wizard',
                    'data-testid=onboarding-wizard-skip',
                    'data-testid=onboarding-wizard-primary',
                    'data-testid=onboarding-wizard-relay-diagram',
                    'data-testid=onboarding-wizard-relay:remoteComputer',
                ].join('\n');
            }
            return [
                'data-testid=onboarding-wizard',
                'data-testid=onboarding-wizard-skip',
                'data-testid=onboarding-wizard-primary',
            ].join('\n');
        },
    });

    assert.deepEqual(result, {
        kind: 'action',
        selector: '[data-testid="onboarding-wizard-relay:remoteComputer"]',
    });
    assert.deepEqual(captureCalls, [
        {
            appIdentifier: 9223,
            driverSession: null,
            env: { EXISTING: 'value' },
            windowId: 'main',
            selector: '[data-testid="onboarding-wizard"]',
            timeoutMs: preflightModule.buildActivitySurfacesPreflightPlan().structureSnapshotProbeTimeoutMs,
        },
        {
            appIdentifier: 9223,
            driverSession: null,
            env: { EXISTING: 'value' },
            windowId: 'main',
            selector: null,
            timeoutMs: preflightModule.buildActivitySurfacesPreflightPlan().structureSnapshotProbeTimeoutMs,
        },
    ]);
});

test('tauri activity-surfaces QA retries relay-only selector probing before falling back to generic onboarding actions', async () => {
    assert.equal(typeof qaModule.probeActivitySurfacesPreflightSurface, 'function');

    const selectorCalls = [];
    const snapshotCalls = [];
    const plan = preflightModule.buildActivitySurfacesPreflightPlan();

    const result = await qaModule.probeActivitySurfacesPreflightSurface({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        plan,
        probeVisibleSelectors: async ({ selectors }) => {
            selectorCalls.push(selectors);
            if (selectorCalls.length === 1) {
                return [
                    '[data-testid="onboarding-wizard-card"]',
                    '[data-testid="onboarding-wizard"]',
                    '[data-testid="onboarding-wizard-skip"]',
                    '[data-testid="onboarding-wizard-primary"]',
                ];
            }
            return [
                '[data-testid="onboarding-wizard-relay-diagram"]',
                '[data-testid="onboarding-wizard-relay:cloud"]',
                '[data-testid="onboarding-wizard-relay:thisComputer"]',
            ];
        },
        probeRootState: async () => null,
        captureStructureSnapshot: async ({ selector }) => {
            snapshotCalls.push(selector ?? null);
            if (snapshotCalls.length === 1) {
                return [
                    'data-testid=onboarding-wizard-card',
                    'data-testid=onboarding-wizard',
                    'data-testid=onboarding-wizard-skip',
                    'data-testid=onboarding-wizard-primary',
                ].join('\n');
            }
            return [
                'data-testid=onboarding-wizard-card',
                'data-testid=onboarding-wizard',
                'data-testid=onboarding-wizard-skip',
                'data-testid=onboarding-wizard-primary',
                'data-testid=onboarding-wizard-relay-diagram',
                'data-testid=onboarding-wizard-relay:cloud',
                'data-testid=onboarding-wizard-relay:thisComputer',
            ].join('\n');
        },
    });

    assert.deepEqual(result, {
        kind: 'action',
        selector: '[data-testid="onboarding-wizard-relay:cloud"]',
    });
    assert.equal(selectorCalls.length, 1);
    assert.deepEqual(snapshotCalls, [
        '[data-testid="onboarding-wizard-card"]',
        null,
    ]);
});

test('tauri activity-surfaces QA recognizes settings index selectors from the fast probe as settings-shell ready', async () => {
    assert.equal(typeof qaModule.probeActivitySurfacesPreflightSurface, 'function');

    const plan = preflightModule.buildActivitySurfacesPreflightPlan();

    const result = await qaModule.probeActivitySurfacesPreflightSurface({
        appIdentifier: 9224,
        env: { EXISTING: 'value' },
        plan,
        probeVisibleSelectors: async ({ selectors }) =>
            selectors.filter((selector) => selector === '[data-testid="settings-system-status-item"]'),
        probeRootState: async () => {
            throw new Error('root-state probe should not run when the fast selector probe matches');
        },
        captureStructureSnapshot: async () => {
            throw new Error('snapshot should not run when the fast selector probe matches');
        },
    });

    assert.deepEqual(result, { kind: 'ready' });
});

test('tauri activity-surfaces QA probes bounded fallback selectors in parallel when JS probes miss', async () => {
    assert.equal(typeof qaModule.probeActivitySurfacesPreflightSurface, 'function');

    let activeCalls = 0;
    let maxActiveCalls = 0;

    const result = await qaModule.probeActivitySurfacesPreflightSurface({
        appIdentifier: 9224,
        env: { EXISTING: 'value' },
        plan: preflightModule.buildActivitySurfacesPreflightPlan(),
        probeVisibleSelectors: async () => [],
        probeRootState: async () => null,
        captureStructureSnapshot: async () => '',
        isSelectorVisible: async () => {
            activeCalls += 1;
            maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
            await new Promise((resolve) => setTimeout(resolve, 5));
            activeCalls -= 1;
            return false;
        },
    });

    assert.deepEqual(result, {
        kind: 'navigate',
        targetPath: '/settings/desktop',
        reason: 'settings-shell-not-visible-yet',
    });
    assert.equal(maxActiveCalls > 1, true);
});

test('tauri activity-surfaces QA falls back to bounded selector probes for settings index surfaces and treats the settings shell as ready', async () => {
    assert.equal(typeof qaModule.probeActivitySurfacesPreflightSurface, 'function');

    const selectorCalls = [];

    const result = await qaModule.probeActivitySurfacesPreflightSurface({
        appIdentifier: 9224,
        env: { EXISTING: 'value' },
        plan: preflightModule.buildActivitySurfacesPreflightPlan(),
        probeVisibleSelectors: async () => [],
        probeRootState: async () => null,
        captureStructureSnapshot: async () => '',
        isSelectorVisible: async (selector) => {
            selectorCalls.push(selector);
            return selector === '[data-testid="settings-system-status-item"]';
        },
    });

    assert.deepEqual(result, { kind: 'ready' });
    assert.equal(selectorCalls.includes('[data-testid="settings-system-status-item"]'), true);
});

test('tauri activity-surfaces QA falls back to bounded selector probes for the welcome restore auth surface when the fast probe returns empty', async () => {
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
            return selector === '[data-testid="welcome-restore"]';
        },
        captureStructureSnapshot: async ({ selector }) => {
            snapshotCalls.push(selector ?? null);
            return '';
        },
    });

    assert.deepEqual(result, {
        kind: 'blocked',
        blocker: 'auth',
        message: 'The app reached the auth welcome surface before settings. Sign in or seed a post-auth state, then rerun the activity-surfaces QA capture.',
    });
    assert.deepEqual(snapshotCalls, [null]);
    assert.deepEqual(selectorCalls, [
        '[data-testid="onboarding-wizard-welcome-auth"]',
        '[data-testid="welcome-create-account"]',
        '[data-testid="welcome-restore"]',
        '[data-testid="app-blocking-logo"]',
        '[data-testid="app-crash-restart"]',
        '[data-testid="onboarding-wizard-card"]',
        '[data-testid="onboarding-wizard"]',
        '[data-testid="setupWizard.surface"]',
        '[data-testid="setupWizard.surface-skip"]',
        '[data-testid="settings-shell.sidebarPane"]',
        '[data-testid="settings-desktop-entry"]',
        '[data-testid="settings-add-your-phone-shortcut"]',
        '[data-testid="settings-mcp-servers-item"]',
        '[data-testid="settings-system-status-item"]',
        '[data-testid="settings-desktop-overlay-enabled"]',
    ]);
});

test('tauri activity-surfaces QA returns a settings navigation retry when bounded fallback probes stay empty', async () => {
    assert.equal(typeof qaModule.probeActivitySurfacesPreflightSurface, 'function');

    const selectorCalls = [];
    const snapshotCalls = [];
    const plan = preflightModule.buildActivitySurfacesPreflightPlan();

    const result = await qaModule.probeActivitySurfacesPreflightSurface({
        appIdentifier: 9224,
        env: { EXISTING: 'value' },
        plan,
        probeVisibleSelectors: async () => [],
        probeRootState: async () => ({
            pathname: '/settings',
            rootText: 'shell mounted',
        }),
        isSelectorVisible: async (selector) => {
            selectorCalls.push(selector);
            return false;
        },
        captureStructureSnapshot: async ({ selector }) => {
            snapshotCalls.push(selector ?? null);
            return '';
        },
    });

    assert.deepEqual(result, {
        kind: 'navigate',
        targetPath: '/settings/desktop',
        reason: 'settings-shell-not-visible-yet',
    });
    assert.deepEqual(snapshotCalls, [null]);
    assert.deepEqual(selectorCalls, [
        '[data-testid="onboarding-wizard-welcome-auth"]',
        '[data-testid="welcome-create-account"]',
        '[data-testid="welcome-restore"]',
        '[data-testid="app-blocking-logo"]',
        '[data-testid="app-crash-restart"]',
        '[data-testid="onboarding-wizard-card"]',
        '[data-testid="onboarding-wizard"]',
        '[data-testid="setupWizard.surface"]',
        '[data-testid="setupWizard.surface-skip"]',
        '[data-testid="settings-shell.sidebarPane"]',
        '[data-testid="settings-desktop-entry"]',
        '[data-testid="settings-add-your-phone-shortcut"]',
        '[data-testid="settings-mcp-servers-item"]',
        '[data-testid="settings-system-status-item"]',
        '[data-testid="settings-desktop-overlay-enabled"]',
    ]);
});

test('tauri activity-surfaces QA short-circuits blank-root snapshots before bounded fallback probes', async () => {
    assert.equal(typeof qaModule.probeActivitySurfacesPreflightSurface, 'function');

    const selectorCalls = [];
    const snapshotCalls = [];
    const plan = preflightModule.buildActivitySurfacesPreflightPlan();

    const result = await qaModule.probeActivitySurfacesPreflightSurface({
        appIdentifier: 9224,
        env: { EXISTING: 'value' },
        plan,
        probeVisibleSelectors: async () => [],
        probeRootState: async () => ({
            pathname: '/settings',
            rootText: 'shell mounted',
        }),
        isSelectorVisible: async (selector) => {
            selectorCalls.push(selector);
            return false;
        },
        captureStructureSnapshot: async ({ selector }) => {
            snapshotCalls.push(selector ?? null);
            return [
                '- body [ref=e0]:',
                '  - div#root [ref=e1]',
            ].join('\n');
        },
    });

    assert.deepEqual(result, {
        kind: 'navigate',
        targetPath: '/settings/desktop',
        reason: 'settings-shell-not-visible-yet',
    });
    assert.deepEqual(snapshotCalls, [null]);
    assert.deepEqual(selectorCalls, []);
});

test('tauri activity-surfaces QA short-circuits a fast blank-root probe before taking a full-window snapshot', async () => {
    assert.equal(typeof qaModule.probeActivitySurfacesPreflightSurface, 'function');

    const selectorCalls = [];
    const snapshotCalls = [];
    const rootProbeCalls = [];
    const plan = preflightModule.buildActivitySurfacesPreflightPlan();

    const result = await qaModule.probeActivitySurfacesPreflightSurface({
        appIdentifier: 9224,
        env: { EXISTING: 'value' },
        plan,
        isSelectorVisible: async (selector) => {
            selectorCalls.push(selector);
            return false;
        },
        probeRootState: async ({ appIdentifier, windowId }) => {
            rootProbeCalls.push({ appIdentifier, windowId });
            return {
                pathname: '/',
                rootText: '',
            };
        },
        captureStructureSnapshot: async ({ selector }) => {
            snapshotCalls.push(selector ?? null);
            return 'unexpected snapshot';
        },
    });

    assert.deepEqual(result, {
        kind: 'navigate',
        targetPath: '/settings/desktop',
        reason: 'settings-shell-not-visible-yet',
    });
    assert.deepEqual(snapshotCalls, []);
    assert.deepEqual(selectorCalls, []);
});

test('tauri activity-surfaces QA uses the plan timeout budgets for selector and root JS probes', async () => {
    assert.equal(typeof qaModule.probeActivitySurfacesPreflightSurface, 'function');

    const plan = {
        ...preflightModule.buildActivitySurfacesPreflightPlan(),
        selectorPresenceProbeTimeoutMs: 4_321,
        rootStateProbeTimeoutMs: 1_234,
    };
    const selectorProbeCalls = [];
    const rootProbeCalls = [];

    const result = await qaModule.probeActivitySurfacesPreflightSurface({
        appIdentifier: 9224,
        env: { EXISTING: 'value' },
        plan,
        probeVisibleSelectors: async ({ timeoutMs }) => {
            selectorProbeCalls.push(timeoutMs);
            return [];
        },
        probeRootState: async ({ timeoutMs }) => {
            rootProbeCalls.push(timeoutMs);
            return {
                pathname: '/',
                rootText: '',
            };
        },
        captureStructureSnapshot: async () => {
            throw new Error('snapshot should not run for a blank root');
        },
    });

    assert.deepEqual(result, {
        kind: 'navigate',
        targetPath: '/settings/desktop',
        reason: 'settings-shell-not-visible-yet',
    });
    assert.deepEqual(selectorProbeCalls, [4_321]);
    assert.deepEqual(rootProbeCalls, [1_234]);
});

test('tauri activity-surfaces QA treats root-state test ids on the desktop settings page as ready when the fast selector probe misses', async () => {
    assert.equal(typeof qaModule.probeActivitySurfacesPreflightSurface, 'function');

    const snapshotCalls = [];
    const selectorCalls = [];

    const result = await qaModule.probeActivitySurfacesPreflightSurface({
        appIdentifier: 9224,
        env: { EXISTING: 'value' },
        plan: preflightModule.buildActivitySurfacesPreflightPlan(),
        probeVisibleSelectors: async () => [],
        probeRootState: async () => ({
            pathname: '/settings/desktop',
            rootText: 'Desktop app\nEnable desktop overlay',
            visibleTestIds: ['settings-desktop-overlay-enabled'],
        }),
        captureStructureSnapshot: async ({ selector }) => {
            snapshotCalls.push(selector ?? null);
            return '';
        },
        isSelectorVisible: async (selector) => {
            selectorCalls.push(selector);
            return false;
        },
    });

    assert.deepEqual(result, {
        kind: 'ready',
    });
    assert.deepEqual(snapshotCalls, []);
    assert.deepEqual(selectorCalls, []);
});

test('tauri activity-surfaces QA analyzes a full-window snapshot before bounded fallback probes when the fast probe returns empty', async () => {
    assert.equal(typeof qaModule.probeActivitySurfacesPreflightSurface, 'function');

    const selectorCalls = [];
    const snapshotCalls = [];
    const plan = preflightModule.buildActivitySurfacesPreflightPlan();

    const result = await qaModule.probeActivitySurfacesPreflightSurface({
        appIdentifier: 9224,
        env: { EXISTING: 'value' },
        plan,
        probeVisibleSelectors: async () => [],
        probeRootState: async () => ({
            pathname: '/settings',
            rootText: 'shell mounted',
        }),
        isSelectorVisible: async (selector) => {
            selectorCalls.push(selector);
            return false;
        },
        captureStructureSnapshot: async ({ selector }) => {
            snapshotCalls.push(selector ?? null);
            return [
                '- body [ref=e0]:',
                '  - div [ref=e1] [data-testid=setupWizard.surface]',
                '  - button [ref=e2] [data-testid=setupWizard.surface-skip]',
            ].join('\n');
        },
    });

    assert.deepEqual(result, {
        kind: 'action',
        selector: '[data-testid="setupWizard.surface-skip"]',
    });
    assert.deepEqual(snapshotCalls, [null]);
    assert.deepEqual(selectorCalls, []);
});

test('tauri activity-surfaces QA analyzes a full-window snapshot even when both JS probes fail', async () => {
    assert.equal(typeof qaModule.probeActivitySurfacesPreflightSurface, 'function');

    const selectorCalls = [];
    const snapshotCalls = [];
    const result = await qaModule.probeActivitySurfacesPreflightSurface({
        appIdentifier: 9224,
        env: { EXISTING: 'value' },
        plan: preflightModule.buildActivitySurfacesPreflightPlan(),
        probeVisibleSelectors: async () => [],
        probeRootState: async () => null,
        captureStructureSnapshot: async ({ selector }) => {
            snapshotCalls.push(selector ?? null);
            return [
                '- body [ref=e0]:',
                '  - div [ref=e1] [data-testid=onboarding-wizard-welcome-auth]',
                '  - div [ref=e2] [data-testid=onboarding-wizard-welcome-showcase]',
            ].join('\n');
        },
        isSelectorVisible: async (selector) => {
            selectorCalls.push(selector);
            return selector === '[data-testid="setupWizard.surface"]'
                || selector === '[data-testid="setupWizard.surface-skip"]';
        },
    });

    assert.deepEqual(result, {
        kind: 'blocked',
        blocker: 'auth',
        message: 'The app reached the auth welcome surface before settings. Sign in or seed a post-auth state, then rerun the activity-surfaces QA capture.',
    });
    assert.deepEqual(snapshotCalls, [null, null]);
    assert.deepEqual(selectorCalls, []);
});

test('tauri activity-surfaces QA falls back to bounded selectors when both JS probes fail and the full-window snapshot is unavailable', async () => {
    assert.equal(typeof qaModule.probeActivitySurfacesPreflightSurface, 'function');

    const selectorCalls = [];
    const snapshotCalls = [];
    const result = await qaModule.probeActivitySurfacesPreflightSurface({
        appIdentifier: 9224,
        env: { EXISTING: 'value' },
        plan: preflightModule.buildActivitySurfacesPreflightPlan(),
        probeVisibleSelectors: async () => [],
        probeRootState: async () => null,
        captureStructureSnapshot: async ({ selector }) => {
            snapshotCalls.push(selector ?? null);
            throw new Error('snapshot unavailable');
        },
        isSelectorVisible: async (selector) => {
            selectorCalls.push(selector);
            return selector === '[data-testid="setupWizard.surface"]'
                || selector === '[data-testid="setupWizard.surface-skip"]';
        },
    });

    assert.deepEqual(result, {
        kind: 'action',
        selector: '[data-testid="setupWizard.surface-skip"]',
    });
    assert.deepEqual(snapshotCalls, [null]);
    assert.deepEqual(selectorCalls, [
        '[data-testid="onboarding-wizard-welcome-auth"]',
        '[data-testid="welcome-create-account"]',
        '[data-testid="welcome-restore"]',
        '[data-testid="app-blocking-logo"]',
        '[data-testid="app-crash-restart"]',
        '[data-testid="onboarding-wizard-card"]',
        '[data-testid="onboarding-wizard"]',
        '[data-testid="setupWizard.surface"]',
        '[data-testid="setupWizard.surface-skip"]',
        '[data-testid="settings-shell.sidebarPane"]',
        '[data-testid="settings-desktop-entry"]',
        '[data-testid="settings-add-your-phone-shortcut"]',
        '[data-testid="settings-mcp-servers-item"]',
        '[data-testid="settings-system-status-item"]',
        '[data-testid="settings-desktop-overlay-enabled"]',
    ]);
});

test('tauri activity-surfaces QA rethrows transient fallback selector disconnects instead of misclassifying them as missing selectors', async () => {
    assert.equal(typeof qaModule.probeActivitySurfacesPreflightSurface, 'function');

    await assert.rejects(
        qaModule.probeActivitySurfacesPreflightSurface({
            appIdentifier: 9224,
            env: { EXISTING: 'value' },
            plan: preflightModule.buildActivitySurfacesPreflightPlan(),
            probeVisibleSelectors: async () => [],
            probeRootState: async () => null,
            captureStructureSnapshot: async () => {
                throw new Error('snapshot unavailable');
            },
            isSelectorVisible: async (selector, options) =>
                qaModule.isSelectorPresent(selector, {
                    ...options,
                    runCli: async () => {
                        throw new Error('JavaScript execution failed: WebView execution failed: Not connected to plugin and reconnection failed');
                    },
                }),
        }),
        /Not connected to plugin and reconnection failed/u,
    );
});

test('tauri activity-surfaces QA preflight treats non-settings routes as retryable settings navigation', () => {
    assert.equal(typeof preflightModule.analyzeActivitySurfacesPreflightSurface, 'function');
    const nonSettingsSnapshot = [
        'data-testid=session-list',
        'data-testid=home-shell',
    ].join('\n');

    assert.deepEqual(preflightModule.analyzeActivitySurfacesPreflightSurface(nonSettingsSnapshot), {
        kind: 'navigate',
        targetPath: '/settings/desktop',
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

test('tauri activity-surfaces QA root-state probing uses a bounded timeout instead of the generic interact timeout', async () => {
    assert.equal(typeof qaModule.probeActivitySurfacesRootState, 'function');

    const cliCalls = [];
    const result = await qaModule.probeActivitySurfacesRootState({
        appIdentifier: 9224,
        env: { EXISTING: 'value' },
        timeoutMs: 4_567,
        runCli: async (args, options) => {
            cliCalls.push({ args, options });
            return {
                stdout: '{"pathname":"/","rootText":""}',
            };
        },
    });

    assert.deepEqual(result, {
        pathname: '/',
        rootText: '',
    });
    assert.equal(cliCalls.length, 1);
    assert.equal(cliCalls[0].args[0], 'webview-execute-js');
    assert.equal(cliCalls[0].options.timeoutMs, 4_567);
});

test('tauri activity-surfaces QA does not derive a guessed stack-owned Tauri identifier into mcp child env from the stack name alone', () => {
    assert.equal(typeof qaModule.resolveActivitySurfacesMcpCliEnv, 'function');
    const env = qaModule.resolveActivitySurfacesMcpCliEnv({
        HAPPIER_STACK_STACK: 'activity-surfaces-qa',
        HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
    });

    assert.equal(env.HAPPIER_STACK_TAURI_IDENTIFIER, undefined);
    assert.equal(env.HAPPIER_TAURI_MCP_APP_IDENTIFIER, undefined);
});

test('tauri activity-surfaces QA preserves an explicit stack-owned Tauri identifier in mcp child env', () => {
    assert.equal(typeof qaModule.resolveActivitySurfacesMcpCliEnv, 'function');
    const env = qaModule.resolveActivitySurfacesMcpCliEnv({
        HAPPIER_STACK_STACK: 'activity-surfaces-qa',
        HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
        HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.custom-override',
    });

    assert.equal(env.HAPPIER_STACK_TAURI_IDENTIFIER, 'com.happier.stack.custom-override');
    assert.equal(env.HAPPIER_TAURI_MCP_APP_IDENTIFIER, 'com.happier.stack.custom-override');
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

test('tauri activity-surfaces QA records the desktop overlay enablement payload when artifacts are enabled', async () => {
    assert.equal(typeof qaModule.enableDesktopOverlayIfNeeded, 'function');

    const writes = [];
    const warnings = [];

    await qaModule.enableDesktopOverlayIfNeeded({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        runCli: async () => ({
            stdout: JSON.stringify({
                ok: true,
                via: 'mcp-bridge',
                bridgeResult: { ok: true, overlaySyncOk: false, overlaySyncError: 'boom' },
            }),
        }),
        writeArtifact: async (filePath, contents) => {
            writes.push({ filePath, contents });
        },
        appendWarning: async (_artifactRoot, text) => {
            warnings.push(text);
        },
    });

    assert.equal(writes.some((entry) => String(entry.filePath).includes('99-overlay-enable.desktopOverlayEnabled.json')), true);
    assert.equal(warnings.some((text) => String(text).includes('desktop overlay enablement flush reported failure')), true);
});

test('tauri activity-surfaces QA uses the pinned stack wrapper for stack happier commands when a stack name is present', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesStackCli, 'function');

    const calls = [];
    const result = await qaModule.runActivitySurfacesStackCli(['session', 'create', '--json'], {
        env: {
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
            HAPPIER_HOME_DIR: '',
        },
        execFileImpl: async (command, args, options) => {
            calls.push({ command, args, options });
            return { stdout: '{"ok":true}\n', stderr: '' };
        },
    });

    assert.equal(result.stdout, '{"ok":true}\n');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, process.execPath);
    assert.deepEqual(
        calls[0].args.slice(-6),
        ['stack.mjs', 'happier', 'activity-surfaces-qa', '--', 'session', 'create', '--json'].slice(-6),
    );
    assert.equal(calls[0].options.env.HAPPIER_HOME_DIR, '/tmp/happier-stack/cli');
    assert.equal(calls[0].options.env.HAPPIER_STACK_CLI_HOME_DIR, '/tmp/happier-stack/cli');
});

test('tauri activity-surfaces QA falls back to the direct happier script when no pinned stack name is present', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesStackCli, 'function');

    const calls = [];
    await qaModule.runActivitySurfacesStackCli(['auth', 'status', '--json'], {
        env: {
            HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
            HAPPIER_HOME_DIR: '',
        },
        execFileImpl: async (command, args, options) => {
            calls.push({ command, args, options });
            return { stdout: '{"ok":true}\n', stderr: '' };
        },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, process.execPath);
    assert.equal(String(calls[0].args[0]).endsWith('/apps/stack/scripts/happier.mjs'), true);
    assert.deepEqual(calls[0].args.slice(1), ['auth', 'status', '--json']);
    assert.equal(calls[0].options.env.HAPPIER_HOME_DIR, '/tmp/happier-stack/cli');
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
            ['session', 'create', '--path', '/Users/leeroy/Documents/Development/happier/dev', '--backend', 'codex'],
            ['session', 'send', 'sess_seeded_overlay', 'Please post a brief status update so the desktop overlay becomes visible.'],
        ],
    );
    assert.equal(calls[0].options.env.HAPPIER_HOME_DIR, '/tmp/happier-stack/cli');
    assert.equal(calls[0].options.env.HAPPIER_STACK_CLI_HOME_DIR, '/tmp/happier-stack/cli');
    assert.equal(calls[1].options.env.HAPPIER_HOME_DIR, '/tmp/happier-stack/cli');
    assert.equal(calls[1].options.env.HAPPIER_STACK_CLI_HOME_DIR, '/tmp/happier-stack/cli');
});

test('tauri activity-surfaces QA hydrates the seeded session route before overlay capture', async () => {
    assert.equal(typeof qaModule.hydrateActivitySurfacesSeededSessionForOverlayCapture, 'function');

    const calls = [];
    await qaModule.hydrateActivitySurfacesSeededSessionForOverlayCapture({
        sessionId: 'sess_seeded_overlay',
        appIdentifier: 9223,
        env: {
            HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
            HAPPIER_HOME_DIR: '',
        },
        driverSession: { driverSessionPort: 9223 },
        ensureSessionVisible: async (request) => {
            calls.push({ kind: 'ensureSessionVisible', request });
            return true;
        },
        navigateWebview: async (pathname, options = {}) => {
            calls.push({ pathname, options });
        },
        waitForPathname: async (pathname, options = {}) => {
            calls.push({ kind: 'waitForPathname', pathname, options });
            return true;
        },
        wait: async (ms) => {
            calls.push({ kind: 'delay', ms });
        },
    });

    assert.deepEqual(
        calls.map((entry) => {
            if ('kind' in entry) {
                if (entry.kind === 'ensureSessionVisible') {
                    return [
                        entry.kind,
                        entry.request.sessionId,
                        entry.request.appIdentifier,
                        entry.request.driverSession?.driverSessionPort ?? null,
                        entry.request.windowId ?? null,
                    ];
                }
                if (entry.kind === 'waitForPathname') {
                    return [entry.kind, entry.pathname, entry.options.windowId ?? null];
                }
                return ['delay', entry.ms];
            }
            return [entry.pathname, entry.options.windowId ?? null];
        }),
        [
            ['ensureSessionVisible', 'sess_seeded_overlay', 9223, 9223, 'main'],
            ['/session/sess_seeded_overlay', 'main'],
            ['waitForPathname', '/session/sess_seeded_overlay', 'main'],
            ['/settings/desktop', 'main'],
            ['delay', 500],
        ],
    );
});

test('tauri activity-surfaces QA falls back to direct session-route hydration when the MCP session-visibility hook is unavailable', async () => {
    assert.equal(typeof qaModule.hydrateActivitySurfacesSeededSessionForOverlayCapture, 'function');

    const calls = [];
    await qaModule.hydrateActivitySurfacesSeededSessionForOverlayCapture({
        sessionId: 'sess_seeded_overlay',
        appIdentifier: 9223,
        env: {
            HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
            HAPPIER_HOME_DIR: '',
        },
        driverSession: { driverSessionPort: 9223 },
        ensureSessionVisible: async (request) => {
            calls.push({ kind: 'ensureSessionVisible', request });
            throw new Error('Unable to hydrate the seeded session into the app runtime: missing-session-visibility-hook');
        },
        navigateWebview: async (pathname, options = {}) => {
            calls.push({ pathname, options });
        },
        waitForPathname: async (pathname, options = {}) => {
            calls.push({ kind: 'waitForPathname', pathname, options });
            return true;
        },
        wait: async (ms) => {
            calls.push({ kind: 'delay', ms });
        },
    });

    assert.deepEqual(
        calls.map((entry) => {
            if ('kind' in entry) {
                if (entry.kind === 'ensureSessionVisible') {
                    return [
                        entry.kind,
                        entry.request.sessionId,
                        entry.request.appIdentifier,
                        entry.request.driverSession?.driverSessionPort ?? null,
                        entry.request.windowId ?? null,
                    ];
                }
                if (entry.kind === 'waitForPathname') {
                    return [
                        entry.kind,
                        entry.pathname,
                        entry.options.windowId ?? null,
                    ];
                }
                return ['delay', entry.ms];
            }
            return [entry.pathname, entry.options.windowId ?? null];
        }),
        [
            ['ensureSessionVisible', 'sess_seeded_overlay', 9223, 9223, 'main'],
            ['/session/sess_seeded_overlay', 'main'],
            ['delay', 500],
            ['/settings/desktop', 'main'],
            ['delay', 500],
        ],
    );
});

test('tauri activity-surfaces QA falls back to direct session-route hydration when the MCP session-visibility hook reports the session as unavailable', async () => {
    assert.equal(typeof qaModule.hydrateActivitySurfacesSeededSessionForOverlayCapture, 'function');

    const calls = [];
    await qaModule.hydrateActivitySurfacesSeededSessionForOverlayCapture({
        sessionId: 'sess_seeded_overlay',
        appIdentifier: 9223,
        env: {
            HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
            HAPPIER_HOME_DIR: '',
        },
        driverSession: { driverSessionPort: 9223 },
        ensureSessionVisible: async (request) => {
            calls.push({ kind: 'ensureSessionVisible', request });
            throw new Error('Unable to hydrate the seeded session into the app runtime: session-visibility-unavailable');
        },
        navigateWebview: async (pathname, options = {}) => {
            calls.push({ pathname, options });
        },
        waitForPathname: async (pathname, options = {}) => {
            calls.push({ kind: 'waitForPathname', pathname, options });
            return true;
        },
        wait: async (ms) => {
            calls.push({ kind: 'delay', ms });
        },
    });

    assert.deepEqual(
        calls.map((entry) => {
            if ('kind' in entry) {
                if (entry.kind === 'ensureSessionVisible') {
                    return [
                        entry.kind,
                        entry.request.sessionId,
                        entry.request.appIdentifier,
                        entry.request.driverSession?.driverSessionPort ?? null,
                        entry.request.windowId ?? null,
                    ];
                }
                if (entry.kind === 'waitForPathname') {
                    return [
                        entry.kind,
                        entry.pathname,
                        entry.options.windowId ?? null,
                    ];
                }
                return ['delay', entry.ms];
            }
            return [entry.pathname, entry.options.windowId ?? null];
        }),
        [
            ['ensureSessionVisible', 'sess_seeded_overlay', 9223, 9223, 'main'],
            ['/session/sess_seeded_overlay', 'main'],
            ['delay', 500],
            ['/settings/desktop', 'main'],
            ['delay', 500],
        ],
    );
});

test('tauri activity-surfaces QA falls back to direct session-route hydration when the MCP session-visibility hook times out', async () => {
    assert.equal(typeof qaModule.hydrateActivitySurfacesSeededSessionForOverlayCapture, 'function');

    const calls = [];
    await qaModule.hydrateActivitySurfacesSeededSessionForOverlayCapture({
        sessionId: 'sess_seeded_overlay',
        appIdentifier: 9223,
        env: {
            HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
            HAPPIER_HOME_DIR: '',
        },
        driverSession: { driverSessionPort: 9223 },
        ensureSessionVisible: async (request) => {
            calls.push({ kind: 'ensureSessionVisible', request });
            throw new Error('Error: JavaScript execution failed: WebView execution failed: Script execution timeout');
        },
        navigateWebview: async (pathname, options = {}) => {
            calls.push({ pathname, options });
        },
        waitForPathname: async (pathname, options = {}) => {
            calls.push({ kind: 'waitForPathname', pathname, options });
            return true;
        },
        wait: async (ms) => {
            calls.push({ kind: 'delay', ms });
        },
    });

    assert.deepEqual(
        calls.map((entry) => {
            if ('kind' in entry) {
                if (entry.kind === 'ensureSessionVisible') {
                    return [
                        entry.kind,
                        entry.request.sessionId,
                        entry.request.appIdentifier,
                        entry.request.driverSession?.driverSessionPort ?? null,
                        entry.request.windowId ?? null,
                    ];
                }
                if (entry.kind === 'waitForPathname') {
                    return [
                        entry.kind,
                        entry.pathname,
                        entry.options.windowId ?? null,
                    ];
                }
                return ['delay', entry.ms];
            }
            return [entry.pathname, entry.options.windowId ?? null];
        }),
        [
            ['ensureSessionVisible', 'sess_seeded_overlay', 9223, 9223, 'main'],
            ['/session/sess_seeded_overlay', 'main'],
            ['delay', 500],
            ['/settings/desktop', 'main'],
            ['delay', 500],
        ],
    );
});

test('tauri activity-surfaces QA retries the MCP session-visibility hook after a transient WebView execution failure before falling back', async () => {
    assert.equal(typeof qaModule.hydrateActivitySurfacesSeededSessionForOverlayCapture, 'function');

    const calls = [];
    let ensureAttempts = 0;

    await qaModule.hydrateActivitySurfacesSeededSessionForOverlayCapture({
        sessionId: 'sess_seeded_overlay',
        appIdentifier: 9223,
        env: {
            HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
            HAPPIER_HOME_DIR: '',
        },
        driverSession: { driverSessionPort: 9223, resolvedAppIdentifier: 'com.happier.stack.activity-surfaces-qa' },
        ensureSessionVisible: async (request) => {
            calls.push({ kind: 'ensureSessionVisible', request });
            ensureAttempts += 1;
            if (ensureAttempts === 1) {
                throw new Error('Error: JavaScript execution failed: WebView execution failed:');
            }
            return true;
        },
        recoverDriverSession: async (driverSession, options = {}) => {
            calls.push({ kind: 'recoverDriverSession', driverSession, options });
            return { restarted: true, resolvedAppIdentifier: 'com.happier.stack.activity-surfaces-qa' };
        },
        navigateWebview: async (pathname, options = {}) => {
            calls.push({ kind: 'navigate', pathname, options });
        },
        waitForPathname: async (pathname, options = {}) => {
            calls.push({ kind: 'waitForPathname', pathname, options });
            return true;
        },
        wait: async (ms) => {
            calls.push({ kind: 'delay', ms });
        },
    });

    assert.equal(ensureAttempts, 2);
    assert.equal(calls.some((entry) => entry.kind === 'recoverDriverSession'), true);

    const recorded = calls.map((entry) => {
        if (entry.kind === 'ensureSessionVisible') {
            return ['ensureSessionVisible', entry.request.sessionId, entry.request.windowId ?? null];
        }
        if (entry.kind === 'recoverDriverSession') {
            return ['recoverDriverSession', entry.options?.forceRestart === true];
        }
        if (entry.kind === 'navigate') {
            return ['navigate', entry.pathname, entry.options.windowId ?? null];
        }
        if (entry.kind === 'waitForPathname') {
            return ['waitForPathname', entry.pathname, entry.options.windowId ?? null];
        }
        if (entry.kind === 'delay') {
            return ['delay', entry.ms];
        }
        return entry.kind;
    });

    assert.deepEqual(recorded, [
        ['ensureSessionVisible', 'sess_seeded_overlay', 'main'],
        ['recoverDriverSession', true],
        ['ensureSessionVisible', 'sess_seeded_overlay', 'main'],
        ['navigate', '/session/sess_seeded_overlay', 'main'],
        ['waitForPathname', '/session/sess_seeded_overlay', 'main'],
        ['navigate', '/settings/desktop', 'main'],
        ['delay', 500],
    ]);
});

test('tauri activity-surfaces QA treats a seeded-session pathname timeout as best-effort after the MCP session-visibility hook reports the session as unavailable', async () => {
    assert.equal(typeof qaModule.hydrateActivitySurfacesSeededSessionForOverlayCapture, 'function');

    const calls = [];
    await qaModule.hydrateActivitySurfacesSeededSessionForOverlayCapture({
        sessionId: 'sess_seeded_overlay',
        appIdentifier: 9223,
        env: {
            HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
            HAPPIER_HOME_DIR: '',
        },
        driverSession: { driverSessionPort: 9223 },
        ensureSessionVisible: async (request) => {
            calls.push({ kind: 'ensureSessionVisible', request });
            throw new Error('Unable to hydrate the seeded session into the app runtime: session-visibility-unavailable');
        },
        navigateWebview: async (pathname, options = {}) => {
            calls.push({ pathname, options });
        },
        wait: async (ms) => {
            calls.push({ kind: 'delay', ms });
        },
    });

    assert.deepEqual(
        calls.map((entry) => {
            if ('kind' in entry) {
                if (entry.kind === 'ensureSessionVisible') {
                    return [
                        entry.kind,
                        entry.request.sessionId,
                        entry.request.appIdentifier,
                        entry.request.driverSession?.driverSessionPort ?? null,
                        entry.request.windowId ?? null,
                    ];
                }
                return ['delay', entry.ms];
            }
            return [entry.pathname, entry.options.windowId ?? null];
        }),
        [
            ['ensureSessionVisible', 'sess_seeded_overlay', 9223, 9223, 'main'],
            ['/session/sess_seeded_overlay', 'main'],
            ['delay', 500],
            ['/settings/desktop', 'main'],
            ['delay', 500],
        ],
    );
});

test('tauri activity-surfaces QA retries direct session-route hydration when the first pathname wait times out', async () => {
    assert.equal(typeof qaModule.hydrateActivitySurfacesSeededSessionForOverlayCapture, 'function');

    const calls = [];
    let waitAttempts = 0;
    await qaModule.hydrateActivitySurfacesSeededSessionForOverlayCapture({
        sessionId: 'sess_seeded_overlay',
        appIdentifier: 9223,
        env: {
            HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
            HAPPIER_HOME_DIR: '',
        },
        driverSession: { driverSessionPort: 9223 },
        ensureSessionVisible: async () => true,
        navigateWebview: async (pathname, options = {}) => {
            calls.push({ kind: 'navigate', pathname, options });
        },
        waitForPathname: async (pathname, options = {}) => {
            calls.push({ kind: 'waitForPathname', pathname, options });
            waitAttempts += 1;
            if (waitAttempts === 1) {
                throw new Error(`Timed out waiting for the seeded session route to settle on ${pathname}.`);
            }
            return true;
        },
        wait: async (ms) => {
            calls.push({ kind: 'delay', ms });
        },
    });

    assert.deepEqual(
        calls.map((entry) => {
            if (entry.kind === 'navigate') {
                return ['navigate', entry.pathname, entry.options.windowId ?? null];
            }
            if (entry.kind === 'waitForPathname') {
                return ['waitForPathname', entry.pathname, entry.options.windowId ?? null];
            }
            return ['delay', entry.ms];
        }),
        [
            ['navigate', '/session/sess_seeded_overlay', 'main'],
            ['waitForPathname', '/session/sess_seeded_overlay', 'main'],
            ['navigate', '/session/sess_seeded_overlay', 'main'],
            ['waitForPathname', '/session/sess_seeded_overlay', 'main'],
            ['navigate', '/settings/desktop', 'main'],
            ['delay', 500],
        ],
    );
});

test('tauri activity-surfaces QA treats repeated seeded route settle timeouts as best-effort after MCP hydration succeeds', async () => {
    assert.equal(typeof qaModule.hydrateActivitySurfacesSeededSessionForOverlayCapture, 'function');

    const calls = [];
    await qaModule.hydrateActivitySurfacesSeededSessionForOverlayCapture({
        sessionId: 'sess_seeded_overlay',
        appIdentifier: 9223,
        env: {
            HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
            HAPPIER_HOME_DIR: '',
        },
        driverSession: { driverSessionPort: 9223 },
        ensureSessionVisible: async () => true,
        navigateWebview: async (pathname, options = {}) => {
            calls.push({ kind: 'navigate', pathname, options });
        },
        waitForPathname: async (pathname, options = {}) => {
            calls.push({ kind: 'waitForPathname', pathname, options });
            throw new Error(`Timed out waiting for the seeded session route to settle on ${pathname}.`);
        },
        wait: async (ms) => {
            calls.push({ kind: 'delay', ms });
        },
    });

    assert.deepEqual(
        calls.map((entry) => {
            if (entry.kind === 'navigate') {
                return ['navigate', entry.pathname, entry.options.windowId ?? null];
            }
            if (entry.kind === 'waitForPathname') {
                return ['waitForPathname', entry.pathname, entry.options.windowId ?? null];
            }
            return ['delay', entry.ms];
        }),
        [
            ['navigate', '/session/sess_seeded_overlay', 'main'],
            ['waitForPathname', '/session/sess_seeded_overlay', 'main'],
            ['navigate', '/session/sess_seeded_overlay', 'main'],
            ['waitForPathname', '/session/sess_seeded_overlay', 'main'],
            ['navigate', '/settings/desktop', 'main'],
            ['delay', 500],
        ],
    );
});

test('tauri activity-surfaces QA hydrates seeded sessions through the MCP session-visibility hook', async () => {
    assert.equal(typeof qaModule.ensureActivitySurfacesSessionVisibleForRoute, 'function');

    const calls = [];
    const result = await qaModule.ensureActivitySurfacesSessionVisibleForRoute({
        sessionId: 'sess_seeded_overlay',
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        runCli: async (args, options = {}) => {
            calls.push({ args, options });
            return {
                stdout: '{"ok":true,"sessionId":"sess_seeded_overlay"}',
            };
        },
    });

    assert.equal(result, true);
    assert.equal(String(calls[0]?.args?.[2]).includes('ensureHappierSessionVisible'), true);
    assert.deepEqual(calls[0]?.options?.windowId, 'main');
});

test('tauri activity-surfaces QA waits for the seeded session route pathname before returning to settings', async () => {
    assert.equal(typeof qaModule.waitForActivitySurfacesPathname, 'function');

    const pathnames = ['/', '/session/sess_seeded_overlay'];
    const waits = [];
    const timeouts = [];
    const result = await qaModule.waitForActivitySurfacesPathname('/session/sess_seeded_overlay', {
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        probeRootState: async (options = {}) => {
            timeouts.push(options.timeoutMs ?? null);
            return {
            pathname: pathnames.shift() ?? '/session/sess_seeded_overlay',
            };
        },
        wait: async (ms) => {
            waits.push(ms);
        },
    });

    assert.equal(result, true);
    assert.deepEqual(waits, [350]);
    assert.deepEqual(timeouts, [2_000, 2_000]);
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
            ['session', 'create', '--path', '/Users/leeroy/Documents/Development/happier/dev', '--backend', 'codex'],
            ['session', 'stop', 'sess_attention_only'],
            ['session', 'send', 'sess_attention_only', 'Please post a brief status update so the desktop overlay becomes visible.'],
        ],
    );
    assert.equal(calls[0].options.env.HAPPIER_HOME_DIR, '/tmp/happier-stack/cli');
    assert.equal(calls[1].options.env.HAPPIER_HOME_DIR, '/tmp/happier-stack/cli');
    assert.equal(calls[2].options.env.HAPPIER_HOME_DIR, '/tmp/happier-stack/cli');
});

test('tauri activity-surfaces QA retries seeded session creation after auto-starting the current stack runtime when daemon state is missing', async () => {
    assert.equal(typeof qaModule.seedActivitySurfacesOverlaySession, 'function');

    const calls = [];
    const prerequisiteCalls = [];
    let createAttempts = 0;

    const result = await qaModule.seedActivitySurfacesOverlaySession({
        env: {
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
            HAPPIER_HOME_DIR: '',
        },
        ensureSessionCreateReady: async ({ env }) => {
            prerequisiteCalls.push(env.HAPPIER_STACK_STACK ?? null);
        },
        runCliJson: async (args, options) => {
            calls.push({ args, options });
            if (args[0] === 'session' && args[1] === 'create') {
                createAttempts += 1;
                if (createAttempts === 1) {
                    throw Object.assign(
                        new Error('Command failed: node apps/stack/scripts/happier.mjs session create --json'),
                        {
                            stdout: '{"v":1,"ok":false,"kind":"session_create","error":{"code":"unknown_error","message":"No daemon running, no state file found"}}\n',
                            stderr: '',
                        },
                    );
                }
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
    assert.deepEqual(prerequisiteCalls, ['activity-surfaces-qa']);
    assert.deepEqual(
        calls.map(({ args }) => args),
        [
            ['session', 'create', '--path', '/Users/leeroy/Documents/Development/happier/dev', '--backend', 'codex'],
            ['session', 'create', '--path', '/Users/leeroy/Documents/Development/happier/dev', '--backend', 'codex'],
            ['session', 'send', 'sess_seeded_overlay', 'Please post a brief status update so the desktop overlay becomes visible.'],
        ],
    );
});

test('tauri activity-surfaces QA can auto-start the current stack runtime before seeded session creation', async () => {
    assert.equal(typeof qaModule.ensureActivitySurfacesStackRuntimeReadyForSessionSeed, 'function');

    const calls = [];
    const result = await qaModule.ensureActivitySurfacesStackRuntimeReadyForSessionSeed({
        env: {
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
            HAPPIER_HOME_DIR: '',
        },
        runStackControlCli: async (args, options) => {
            calls.push({ args, options });
            return { stdout: 'started' };
        },
    });

    assert.equal(result, true);
    assert.deepEqual(calls.map(({ args }) => args), [
        ['stack', 'start', 'activity-surfaces-qa', '--background', '--runtime', '--no-browser'],
    ]);
    assert.equal(calls[0].options.env.HAPPIER_HOME_DIR, '/tmp/happier-stack/cli');
});

test('tauri activity-surfaces QA can derive the current stack name from a stack-owned app identifier before auto-starting the runtime', async () => {
    assert.equal(typeof qaModule.ensureActivitySurfacesStackRuntimeReadyForSessionSeed, 'function');

    const calls = [];
    const result = await qaModule.ensureActivitySurfacesStackRuntimeReadyForSessionSeed({
        appIdentifier: 'com.happier.stack.activity-surfaces-qa',
        env: {
            HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
            HAPPIER_HOME_DIR: '',
        },
        runStackControlCli: async (args, options) => {
            calls.push({ args, options });
            return { stdout: 'started' };
        },
    });

    assert.equal(result, true);
    assert.deepEqual(calls.map(({ args }) => args), [
        ['stack', 'start', 'activity-surfaces-qa', '--background', '--runtime', '--no-browser'],
    ]);
    assert.equal(calls[0].options.env.HAPPIER_STACK_STACK, 'activity-surfaces-qa');
});

test('tauri activity-surfaces QA retries seeded session creation by deriving the stack name from the connected app identifier when daemon state is missing', async () => {
    assert.equal(typeof qaModule.seedActivitySurfacesOverlaySession, 'function');

    const calls = [];
    const prerequisiteCalls = [];
    let createAttempts = 0;

    const result = await qaModule.seedActivitySurfacesOverlaySession({
        appIdentifier: 'com.happier.stack.activity-surfaces-qa',
        env: {
            HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
            HAPPIER_HOME_DIR: '',
        },
        ensureSessionCreateReady: async ({ env, appIdentifier }) => {
            prerequisiteCalls.push({
                stackName: env.HAPPIER_STACK_STACK ?? null,
                appIdentifier,
            });
        },
        runCliJson: async (args, options) => {
            calls.push({ args, options });
            if (args[0] === 'session' && args[1] === 'create') {
                createAttempts += 1;
                if (createAttempts === 1) {
                    throw Object.assign(
                        new Error('Command failed: node apps/stack/scripts/happier.mjs session create --json'),
                        {
                            stdout: '{"v":1,"ok":false,"kind":"session_create","error":{"code":"unknown_error","message":"No daemon running, no state file found"}}\n',
                            stderr: '',
                        },
                    );
                }
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
    assert.deepEqual(prerequisiteCalls, [
        {
            stackName: 'activity-surfaces-qa',
            appIdentifier: 'com.happier.stack.activity-surfaces-qa',
        },
    ]);
    assert.deepEqual(
        calls.map(({ args }) => args),
        [
            ['session', 'create', '--path', '/Users/leeroy/Documents/Development/happier/dev', '--backend', 'codex'],
            ['session', 'create', '--path', '/Users/leeroy/Documents/Development/happier/dev', '--backend', 'codex'],
            ['session', 'send', 'sess_seeded_overlay', 'Please post a brief status update so the desktop overlay becomes visible.'],
        ],
    );
});

test('tauri activity-surfaces QA falls back to the direct happier CLI when the named stack does not exist but a compose-backed server URL is configured', async () => {
    assert.equal(typeof qaModule.seedActivitySurfacesOverlaySession, 'function');

    const calls = [];
    const prerequisiteCalls = [];
    let createAttempts = 0;

    const result = await qaModule.seedActivitySurfacesOverlaySession({
        env: {
            HAPPIER_STACK_STACK: 'compose-desktop-qa',
            HAPPIER_STACK_CLI_HOME_DIR: '/tmp/happier-stack/cli',
            HAPPIER_HOME_DIR: '',
            HAPPIER_SERVER_URL: 'http://127.0.0.1:57279',
            HAPPIER_TAURI_WEB_RUNTIME_SERVER_CONTEXT: 'stack',
        },
        ensureSessionCreateReady: async (request) => {
            prerequisiteCalls.push(request);
        },
        runCliJson: async (args, options) => {
            calls.push({ args, options });
            if (args[0] === 'session' && args[1] === 'create') {
                createAttempts += 1;
                if (createAttempts === 1) {
                    throw Object.assign(
                        new Error('Command failed: node apps/stack/scripts/stack.mjs happier compose-desktop-qa -- session create --json'),
                        {
                            stdout: '',
                            stderr: 'stack "compose-desktop-qa" does not exist yet',
                        },
                    );
                }
                return {
                    ok: true,
                    kind: 'session_create',
                    data: {
                        created: true,
                        session: {
                            id: 'sess_compose_seeded_overlay',
                        },
                    },
                };
            }
            if (args[0] === 'session' && args[1] === 'send') {
                return {
                    ok: true,
                    kind: 'session_send',
                    data: {
                        sessionId: 'sess_compose_seeded_overlay',
                        localId: 'local_1',
                        waited: false,
                    },
                };
            }
            throw new Error(`Unexpected seed command: ${args.join(' ')}`);
        },
    });

    assert.equal(result.sessionId, 'sess_compose_seeded_overlay');
    assert.deepEqual(prerequisiteCalls, []);
    assert.deepEqual(
        calls.map(({ args, options }) => ({
            args,
            stackName: options.env.HAPPIER_STACK_STACK ?? null,
            serverUrl: options.env.HAPPIER_SERVER_URL ?? null,
            homeDir: options.env.HAPPIER_HOME_DIR ?? null,
            forceWebsocket: options.env.HAPPIER_SOCKET_FORCE_WEBSOCKET ?? null,
        })),
        [
            {
                args: ['session', 'create', '--path', '/Users/leeroy/Documents/Development/happier/dev', '--backend', 'codex'],
                stackName: 'compose-desktop-qa',
                serverUrl: 'http://127.0.0.1:57279',
                homeDir: '/tmp/happier-stack/cli',
                forceWebsocket: null,
            },
            {
                args: ['session', 'create', '--path', '/Users/leeroy/Documents/Development/happier/dev', '--backend', 'codex'],
                stackName: null,
                serverUrl: 'http://127.0.0.1:57279',
                homeDir: '/tmp/happier-stack/cli',
                forceWebsocket: '1',
            },
            {
                args: ['session', 'send', 'sess_compose_seeded_overlay', 'Please post a brief status update so the desktop overlay becomes visible.'],
                stackName: null,
                serverUrl: 'http://127.0.0.1:57279',
                homeDir: '/tmp/happier-stack/cli',
                forceWebsocket: '1',
            },
        ],
    );
});

test('tauri activity-surfaces QA seeds through the direct happier CLI first when a compose-backed server URL is configured without stack runtime context', async () => {
    assert.equal(typeof qaModule.seedActivitySurfacesOverlaySession, 'function');

    const calls = [];

    const result = await qaModule.seedActivitySurfacesOverlaySession({
        appIdentifier: 'com.happier.stack.compose-desktop-qa',
        env: {
            HAPPIER_STACK_STACK: 'compose-desktop-qa',
            HAPPIER_SERVER_URL: 'http://127.0.0.1:57279',
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
                            id: 'sess_compose_direct_first',
                        },
                    },
                };
            }
            if (args[0] === 'session' && args[1] === 'send') {
                return {
                    ok: true,
                    kind: 'session_send',
                    data: {
                        sessionId: 'sess_compose_direct_first',
                        localId: 'local_1',
                        waited: false,
                    },
                };
            }
            throw new Error(`Unexpected seed command: ${args.join(' ')}`);
        },
    });

    assert.equal(result.sessionId, 'sess_compose_direct_first');
    assert.deepEqual(
        calls.map(({ args, options }) => ({
            args,
            stackName: options.env.HAPPIER_STACK_STACK ?? null,
            serverUrl: options.env.HAPPIER_SERVER_URL ?? null,
            forceWebsocket: options.env.HAPPIER_SOCKET_FORCE_WEBSOCKET ?? null,
        })),
        [
            {
                args: ['session', 'create', '--path', '/Users/leeroy/Documents/Development/happier/dev', '--backend', 'codex'],
                stackName: null,
                serverUrl: 'http://127.0.0.1:57279',
                forceWebsocket: '1',
            },
            {
                args: ['session', 'send', 'sess_compose_direct_first', 'Please post a brief status update so the desktop overlay becomes visible.'],
                stackName: null,
                serverUrl: 'http://127.0.0.1:57279',
                forceWebsocket: '1',
            },
        ],
    );
});

test('tauri activity-surfaces QA retries direct session seeding after materializing CLI auth from the authenticated app when compose-backed direct auth returns 401', async () => {
    assert.equal(typeof qaModule.seedActivitySurfacesOverlaySession, 'function');

    const calls = [];
    const authMaterializationCalls = [];
    let createAttempts = 0;

    const result = await qaModule.seedActivitySurfacesOverlaySession({
        appIdentifier: 'com.happier.stack.compose-desktop-qa',
        env: {
            HAPPIER_STACK_STACK: 'compose-desktop-qa',
            HAPPIER_SERVER_URL: 'http://127.0.0.1:57279',
            HAPPIER_TAURI_WEB_RUNTIME_SERVER_CONTEXT: 'stack',
        },
        materializeDirectCliAuth: async (request) => {
            authMaterializationCalls.push(request);
            return '/tmp/happier-compose-cli-home';
        },
        runCliJson: async (args, options) => {
            calls.push({ args, options });
            if (args[0] === 'session' && args[1] === 'create') {
                createAttempts += 1;
                if (createAttempts === 1) {
                    throw Object.assign(
                        new Error('Command failed: node apps/stack/scripts/stack.mjs happier compose-desktop-qa -- session create --json'),
                        {
                            stdout: '',
                            stderr: 'stack "compose-desktop-qa" does not exist yet',
                        },
                    );
                }
                if (createAttempts === 2) {
                    throw Object.assign(
                        new Error('Command failed: node apps/stack/scripts/happier.mjs session create --json'),
                        {
                            stdout: '',
                            stderr: '[local] daemon credentials were rejected by the server (401).',
                        },
                    );
                }
                return {
                    ok: true,
                    kind: 'session_create',
                    data: {
                        created: true,
                        session: {
                            id: 'sess_compose_reauthed',
                        },
                    },
                };
            }
            if (args[0] === 'session' && args[1] === 'send') {
                return {
                    ok: true,
                    kind: 'session_send',
                    data: {
                        sessionId: 'sess_compose_reauthed',
                        localId: 'local_2',
                        waited: false,
                    },
                };
            }
            throw new Error(`Unexpected seed command: ${args.join(' ')}`);
        },
    });

    assert.equal(result.sessionId, 'sess_compose_reauthed');
    assert.deepEqual(
        authMaterializationCalls.map((request) => ({
            appIdentifier: request.appIdentifier,
            cliHomeDir: request.cliHomeDir ?? null,
            serverUrl: request.env.HAPPIER_SERVER_URL ?? null,
            stackName: request.env.HAPPIER_STACK_STACK ?? null,
            forceWebsocket: request.env.HAPPIER_SOCKET_FORCE_WEBSOCKET ?? null,
        })),
        [
            {
                appIdentifier: 'com.happier.stack.compose-desktop-qa',
                cliHomeDir: null,
                serverUrl: 'http://127.0.0.1:57279',
                stackName: null,
                forceWebsocket: '1',
            },
        ],
    );
    assert.deepEqual(
        calls.map(({ args, options }) => ({
            args,
            stackName: options.env.HAPPIER_STACK_STACK ?? null,
            homeDir: options.env.HAPPIER_HOME_DIR ?? null,
            stackCliHomeDir: options.env.HAPPIER_STACK_CLI_HOME_DIR ?? null,
            forceWebsocket: options.env.HAPPIER_SOCKET_FORCE_WEBSOCKET ?? null,
        })),
        [
            {
                args: ['session', 'create', '--path', '/Users/leeroy/Documents/Development/happier/dev', '--backend', 'codex'],
                stackName: 'compose-desktop-qa',
                homeDir: null,
                stackCliHomeDir: null,
                forceWebsocket: null,
            },
            {
                args: ['session', 'create', '--path', '/Users/leeroy/Documents/Development/happier/dev', '--backend', 'codex'],
                stackName: null,
                homeDir: null,
                stackCliHomeDir: null,
                forceWebsocket: '1',
            },
            {
                args: ['session', 'create', '--path', '/Users/leeroy/Documents/Development/happier/dev', '--backend', 'codex'],
                stackName: null,
                homeDir: '/tmp/happier-compose-cli-home',
                stackCliHomeDir: '/tmp/happier-compose-cli-home',
                forceWebsocket: '1',
            },
            {
                args: ['session', 'send', 'sess_compose_reauthed', 'Please post a brief status update so the desktop overlay becomes visible.'],
                stackName: null,
                homeDir: '/tmp/happier-compose-cli-home',
                stackCliHomeDir: '/tmp/happier-compose-cli-home',
                forceWebsocket: '1',
            },
        ],
    );
});

test('tauri activity-surfaces QA materializes compose-backed direct CLI credentials using standard base64 encoding', async () => {
    assert.equal(typeof qaModule.materializeActivitySurfacesCliAuthFromWebStorage, 'function');

    const tempRoot = mkdtempSync(join(process.cwd(), '.project/tmp/materialize-activity-cli-auth-test-'));
    try {
        const cliHomeDir = join(tempRoot, 'cli-home');
        const expectedSecretBytes = Buffer.from([251, 255, 254, 250, 239, 191, 190, 173]);
        const expectedSecretBase64Url = expectedSecretBytes.toString('base64url');
        assert.equal(/[\\-_]/u.test(expectedSecretBase64Url), true);

        const result = await qaModule.materializeActivitySurfacesCliAuthFromWebStorage({
            appIdentifier: 'com.happier.stack.compose-desktop-qa',
            cliHomeDir,
            env: {
                HAPPIER_SERVER_URL: 'http://127.0.0.1:57279',
            },
            runCli: async () => ({
                stdout: JSON.stringify({
                    ok: true,
                    activeServerId: 'env_1c620c9a',
                    sourceKey: 'auth_credentials__srv_env_1c620c9a',
                    credentials: {
                        token: 'compose-token',
                        secret: expectedSecretBase64Url,
                    },
                }),
            }),
        });

        assert.equal(result, cliHomeDir);

        const legacyAccessKey = JSON.parse(readFileSync(join(cliHomeDir, 'access.key'), 'utf8'));
        const scopedAccessKey = JSON.parse(
            readFileSync(join(cliHomeDir, 'servers', 'env_1c620c9a', 'access.key'), 'utf8'),
        );

        assert.equal(legacyAccessKey.token, 'compose-token');
        assert.equal(scopedAccessKey.token, 'compose-token');
        assert.equal(legacyAccessKey.secret.includes('-'), false);
        assert.equal(legacyAccessKey.secret.includes('_'), false);
        assert.equal(scopedAccessKey.secret.includes('-'), false);
        assert.equal(scopedAccessKey.secret.includes('_'), false);
        assert.equal(Buffer.from(legacyAccessKey.secret, 'base64').equals(expectedSecretBytes), true);
        assert.equal(Buffer.from(scopedAccessKey.secret, 'base64').equals(expectedSecretBytes), true);
    } finally {
        rmSync(tempRoot, { recursive: true, force: true });
    }
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

test('tauri activity-surfaces QA parses the final JSON line after stack daemon status prefixes', () => {
    assert.equal(typeof qaModule.parseStructuredJsonPayload, 'function');

    const payload = qaModule.parseStructuredJsonPayload([
        '[local] daemon auth scope: activeServerId=stack_overlay-v2-20260418__id_default',
        '[local] daemon already running for stack home (pid=82230)',
        '{"v":1,"ok":true,"kind":"session_create","data":{"session":{"id":"sess_json_line"}}}',
    ].join('\n'));

    assert.deepEqual(payload, {
        v: 1,
        ok: true,
        kind: 'session_create',
        data: {
            session: {
                id: 'sess_json_line',
            },
        },
    });
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

test('tauri activity-surfaces QA can persist desktop overlay presentation mode directly for mode-specific capture', async () => {
    assert.equal(typeof qaModule.enableDesktopOverlayPresentationMode, 'function');

    const calls = [];
    const result = await qaModule.enableDesktopOverlayPresentationMode({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        presentationMode: 'floating_overlay',
        windowId: 'activity_overlay',
        runCli: async (args, options) => {
            calls.push({ args, options });
            return { stdout: '{"ok":true,"targetLabel":"Floating overlay","targetValue":"floating_overlay","appliedValue":"floating_overlay"}' };
        },
    });

    assert.equal(result, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[0], 'webview-execute-js');
    assert.equal(String(calls[0].args[2]).includes('desktopOverlayPresentationMode'), true);
    assert.equal(calls[0].options.windowId, 'activity_overlay');
});

test('tauri activity-surfaces QA rejects notch captures when overlay placement diagnostics do not reach the notch contract', () => {
    assert.equal(typeof qaModule.assertActivitySurfacesOverlayPlacementContract, 'function');

    assert.throws(
        () => qaModule.assertActivitySurfacesOverlayPlacementContract(
            {
                placementDiagnostics: {
                    hostMode: 'notch_integrated',
                    computedPosition: { x: 576, y: 0 },
                    displayContext: {
                        screenFrame: {
                            x: 0,
                            y: 0,
                            width: 1512,
                            height: 982,
                        },
                    },
                    appliedNativeFrame: {
                        x: 576,
                        y: 66,
                        width: 320,
                        height: 72,
                    },
                },
            },
            {
                expectedHostMode: 'notch_integrated',
                requireComputedTopEdge: true,
                requireAppliedNativeFrame: true,
                label: 'overlay_collapsed',
            },
        ),
        /native frame top edge/i,
    );
});

test('tauri activity-surfaces QA accepts notch captures when the applied native frame hugs the display top edge', () => {
    assert.equal(typeof qaModule.assertActivitySurfacesOverlayPlacementContract, 'function');

    const diagnostics = qaModule.assertActivitySurfacesOverlayPlacementContract(
        {
            placementDiagnostics: {
                hostMode: 'notch_integrated',
                computedPosition: { x: 576, y: 0 },
                displayContext: {
                    screenFrame: {
                        x: 0,
                        y: 0,
                        width: 1512,
                        height: 982,
                    },
                },
                appliedNativeFrame: {
                    x: 576,
                    y: 910,
                    width: 320,
                    height: 72,
                },
            },
        },
        {
            expectedHostMode: 'notch_integrated',
            requireComputedTopEdge: true,
            requireAppliedNativeFrame: true,
            label: 'overlay_collapsed',
        },
    );

    assert.equal(diagnostics.hostMode, 'notch_integrated');
});

test('tauri activity-surfaces QA rejects notch captures when the applied native frame does not reach the monitor top edge', () => {
    assert.equal(typeof qaModule.assertActivitySurfacesOverlayPlacementContract, 'function');

    assert.throws(
        () => qaModule.assertActivitySurfacesOverlayPlacementContract(
            {
                placementDiagnostics: {
                    hostMode: 'notch_integrated',
                    effectiveMonitor: {
                        x: 0,
                        y: 0,
                        width: 1512,
                        height: 982,
                    },
                    computedPosition: { x: 576, y: 0 },
                    appliedNativeFrame: {
                        x: 576,
                        y: 848,
                        width: 360,
                        height: 68,
                    },
                },
            },
            {
                expectedHostMode: 'notch_integrated',
                requireComputedTopEdge: true,
                requireAppliedNativeFrame: true,
                label: 'overlay_collapsed',
            },
        ),
        /native frame top edge/i,
    );
});

test('tauri activity-surfaces QA rejects notch captures when the applied native frame does not hug the top screen edge', () => {
    assert.equal(typeof qaModule.assertActivitySurfacesOverlayPlacementContract, 'function');

    assert.throws(
        () => qaModule.assertActivitySurfacesOverlayPlacementContract(
            {
                placementDiagnostics: {
                    hostMode: 'notch_integrated',
                    computedPosition: { x: 576, y: 0 },
                    displayContext: {
                        screenFrame: { x: 0, y: 0, width: 1512, height: 982 },
                    },
                    appliedNativeFrame: { x: 576, y: 860, width: 360, height: 68 },
                },
            },
            {
                expectedHostMode: 'notch_integrated',
                requireComputedTopEdge: true,
                requireAppliedNativeFrame: true,
                label: 'overlay_collapsed',
            },
        ),
        /expected native frame top edge/i,
    );
});

test('tauri activity-surfaces QA rejects notch captures when the applied native frame does not hug the display top edge', () => {
    assert.equal(typeof qaModule.assertActivitySurfacesOverlayPlacementContract, 'function');

    assert.throws(
        () => qaModule.assertActivitySurfacesOverlayPlacementContract(
            {
                placementDiagnostics: {
                    hostMode: 'notch_integrated',
                    computedPosition: { x: 576, y: 0 },
                    displayContext: {
                        screenFrame: { x: 0, y: 0, width: 1512, height: 982 },
                    },
                    appliedNativeFrame: { x: 576, y: 816, width: 360, height: 100 },
                },
            },
            {
                expectedHostMode: 'notch_integrated',
                requireComputedTopEdge: true,
                requireAppliedNativeFrame: true,
                label: 'overlay_collapsed',
            },
        ),
        /native frame top edge/i,
    );
});

test('tauri activity-surfaces QA accepts a small native frame top-edge delta for notch-integrated panel chrome', () => {
    assert.equal(typeof qaModule.assertActivitySurfacesOverlayPlacementContract, 'function');

    assert.doesNotThrow(() => qaModule.assertActivitySurfacesOverlayPlacementContract(
        {
            placementDiagnostics: {
                hostMode: 'notch_integrated',
                computedPosition: { x: 576, y: 0 },
                displayContext: {
                    screenFrame: { x: 0, y: 0, width: 1512, height: 982 },
                },
                appliedNativeFrame: { x: 576, y: 914, width: 360, height: 72 },
            },
        },
        {
            expectedHostMode: 'notch_integrated',
            requireComputedTopEdge: true,
            requireAppliedNativeFrame: true,
            label: 'overlay_collapsed',
        },
    ));
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

test('tauri activity-surfaces QA explicitly targets the main window for webview mcp commands', async () => {
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
            windowId: 'main',
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
        'main',
    ]);
});

function createSyntheticOverlayWindowState({
    hostMode = 'notch_integrated',
    requestedHostMode = hostMode === 'floating' ? 'floating' : 'notch_integrated',
    proofMode = 'session_overview',
    expanded = false,
} = {}) {
    const screenFrame = { x: 0, y: 0, width: 1512, height: 982 };
    const computedY = hostMode === 'notch_integrated' ? 0 : 18;
    const normalizedProofMode = proofMode === 'idle' ? 'idle_state' : proofMode;
    const rows = normalizedProofMode === 'multi_session_list'
        ? [
            { sessionId: 'session-1', title: 'Session One', subtitle: 'Repo', statusText: 'Running', previewText: 'Primary' },
            { sessionId: 'session-2', title: 'Session Two', subtitle: 'Repo', statusText: 'Ready', previewText: 'Secondary' },
        ]
        : normalizedProofMode === 'session_overview'
            ? [
                { sessionId: 'session-1', title: 'Session One', subtitle: 'Repo', statusText: 'Needs attention', previewText: 'Primary' },
            ]
            : [];
    const cards = (() => {
        switch (normalizedProofMode) {
            case 'idle_state':
                return [{ id: 'idle', kind: 'idle_state', title: 'No active sessions' }];
            case 'permission_request':
                return [{ id: 'permission:qa-permission-request', kind: 'permission_request', requestId: 'qa-permission-request', sessionId: 'session-1' }];
            case 'user_question':
                return [{ id: 'question:qa-user-question', kind: 'user_question', requestId: 'qa-user-question', sessionId: 'session-1' }];
            case 'quota_summary':
                return [{ id: 'qa-quota-summary', kind: 'quota_summary', title: 'Quota' }];
            case 'completion_state':
                return [{ id: 'qa-completion-state', kind: 'completion_state', sessionId: 'session-1' }];
            case 'multi_session_list':
                return [{ id: 'list', kind: 'multi_session_list', rows }];
            case 'session_overview':
            default:
                return [{ id: 'session:session-1', kind: 'session_overview', sessionId: 'session-1', title: 'Session One', active: true, updatedAt: 1 }];
        }
    })();

    return {
        expanded,
        policy: { enabled: true },
        model: {
            isExpanded: expanded,
            collapsed: {
                primaryCardKind: normalizedProofMode,
            },
            expanded: {
                rows,
                cards,
            },
        },
        placementDiagnostics: {
            requestedHostMode,
            hostMode,
            hostFallbackReason: requestedHostMode === 'notch_integrated' && hostMode === 'floating'
                ? 'panel_host_apply_failed'
                : null,
            nativeHostPath: hostMode === 'notch_integrated' ? 'panel' : 'window',
            effectiveMonitor: screenFrame,
            displayContext: {
                screenFrame,
            },
            computedPosition: { x: 576, y: computedY },
            appliedNativeFrame: {
                x: 576,
                y: hostMode === 'notch_integrated' ? 914 : 892,
                width: 320,
                height: 72,
            },
        },
    };
}

test('tauri activity-surfaces QA captures the full deterministic overlay proof matrix before restoring settings', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    let currentOverlayHostMode = 'notch_integrated';
    let currentRequestedHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';
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
        captureRequired: async (stepId, captureOptions = {}) => {
            calls.push(['capture', stepId, captureOptions.selectorOverride ?? null]);
            return { stepId };
        },
        enableDesktopOverlay: async (options = {}) => {
            calls.push(['enable-overlay', options.windowId ?? null]);
        },
        enableDesktopOverlayVisibility: async ({ visibilityMode, windowId }) => {
            calls.push(['visibility', visibilityMode, windowId ?? null]);
            return true;
        },
        setOverlayAutoHideEnabled: async ({ enabled, windowId }) => {
            calls.push(['auto-hide', enabled, windowId ?? null]);
            return { previousValue: true };
        },
        setOverlayPresentationMode: async ({ presentationMode, windowId }) => {
            calls.push(['presentation', presentationMode, windowId ?? null]);
            currentRequestedHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded, options = {}) => {
            calls.push(['set-expanded', expanded, options.windowId ?? null]);
            currentExpanded = expanded === true;
        },
        seedOverlayProofState: async ({ mode, windowId }) => {
            calls.push(['seed-overlay', mode, windowId ?? null]);
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        getOverlayWindowState: async (options = {}) => {
            calls.push(['get-overlay-state', options.windowId ?? null]);
            return createSyntheticOverlayWindowState({
                hostMode: currentOverlayHostMode,
                requestedHostMode: currentRequestedHostMode,
                proofMode: currentProofMode,
                expanded: currentExpanded,
            });
        },
        clickCollapsedOverlay: async (selector) => {
            calls.push(['click', selector]);
            currentExpanded = true;
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
        isSelectorVisible: async () => false,
        isSelectorVisibleByDomQuery: async (selector, options = {}) => {
            if (activeCaptureStepId !== 'overlay_idle') {
                return true;
            }
            idleCaptureEvents.push(`dom-query:${selector}:${options.windowId ?? null}`);
            return selector === '[data-testid="desktop-activity-overlay-card-idle-idle"]'
                && idleSelectorProbeCount >= 2;
        },
        appendWarning: async () => {
            throw new Error('unexpected warning');
        },
    });

    assert.deepEqual(result, createExpectedOverlayCaptureLaneResult());
    const openSettingsIndex = calls.findIndex((entry) => entry[0] === 'open-settings-page');
    assert.ok(openSettingsIndex >= 0);
    assert.equal(
        calls.findIndex((entry) => entry[0] === 'capture' && entry[1] === 'settings_overlay')
        < calls.findIndex((entry) => entry[0] === 'enable-overlay'),
        true,
    );
    const visibilityModes = calls.filter((entry) => entry[0] === 'visibility').map((entry) => entry[1]);
    assert.equal(visibilityModes[0], 'always_when_enabled');
    assert.equal(visibilityModes[visibilityModes.length - 1], 'active_sessions');
    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'auto-hide').map((entry) => entry.slice(1)),
        [
            [false, 'main'],
            [true, 'main'],
        ],
    );
    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'set-expanded').map((entry) => entry.slice(1)),
        [
            [false, 'main'],
            [true, 'main'],
            [false, 'main'],
            [true, 'main'],
        ],
    );
    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'presentation').map((entry) => entry.slice(1)),
        [
            ['notch_integrated', 'main'],
            ['floating_overlay', 'main'],
            ['automatic', 'main'],
        ],
    );
    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'capture').map((entry) => entry[1]),
        [
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
        ],
    );
    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'seed-overlay').map((entry) => entry.slice(1)),
        [
            ['idle', 'main'],
            ['idle', 'main'],
            ['permission_request', 'main'],
            ['permission_request', 'main'],
            ['user_question', 'main'],
            ['user_question', 'main'],
            ['quota_summary', 'main'],
            ['quota_summary', 'main'],
            ['multi_session_list', 'main'],
            ['multi_session_list', 'main'],
            ['completion_state', 'main'],
            ['completion_state', 'main'],
        ],
    );
    assert.equal(calls.some((entry) => entry[0] === 'click' && entry[1] === '[data-testid="desktop-activity-overlay-collapsed"]'), true);
    assert.equal(
        calls.some((entry) => (
            entry[0] === 'capture'
            && entry[1] === 'overlay_collapsed'
            && entry[2] === '[data-testid="desktop-activity-overlay-collapsed-notch"]'
        )),
        true,
    );
});

test('tauri activity-surfaces QA captures deterministic seeded overlay proof states instead of opportunistic card snapshots', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    let currentOverlayHostMode = 'notch_integrated';
    let currentRequestedHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';
    const captures = [];
    const seededModes = [];
    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async () => {},
        openDesktopAppSettingsPage: async () => true,
        captureRequired: async (stepId) => {
            captures.push(stepId);
            return { stepId };
        },
        enableDesktopOverlay: async () => {},
        enableDesktopOverlayVisibility: async () => true,
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentRequestedHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded) => {
            currentExpanded = expanded === true;
        },
        seedOverlayProofState: async ({ mode }) => {
            seededModes.push(mode);
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        getOverlayWindowState: async () => createSyntheticOverlayWindowState({
            hostMode: currentOverlayHostMode,
            requestedHostMode: currentRequestedHostMode,
            proofMode: currentProofMode,
            expanded: currentExpanded,
        }),
        clickCollapsedOverlay: async (selector, options = {}) => {
            calls.push(['click', selector, options.windowId ?? null]);
            currentExpanded = true;
        },
        isSelectorVisible: async () => true,
        isSelectorVisibleByDomQuery: async (selector, options = {}) => {
            if (activeCaptureStepId !== 'overlay_idle') {
                return true;
            }
            idleCaptureEvents.push(`dom-query:${selector}:${options.windowId ?? null}`);
            return selector === '[data-testid="desktop-activity-overlay-card-idle-idle"]'
                && idleSelectorProbeCount >= 2;
        },
        wait: async () => {},
        appendWarning: async (artifactRoot, warning) => {
            if (String(warning).includes('reassert expanded desktop overlay state')) {
                throw new Error(String(warning));
            }
        },
    });

    assert.deepEqual(
        result.optionalStepArtifacts,
        createExpectedOverlayCaptureLaneResult().optionalStepArtifacts,
    );
    assert.deepEqual(seededModes, [
        'idle',
        'idle',
        'permission_request',
        'permission_request',
        'user_question',
        'user_question',
        'quota_summary',
        'quota_summary',
        'multi_session_list',
        'multi_session_list',
        'completion_state',
        'completion_state',
    ]);
    assert.deepEqual(captures, [
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
    ]);
});

test('tauri activity-surfaces QA reseeds deterministic proof state while waiting for native state to catch up', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    let currentOverlayHostMode = 'notch_integrated';
    let currentRequestedHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';
    let idleSeedCount = 0;
    const captures = [];

    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async () => {},
        openDesktopAppSettingsPage: async () => true,
        captureRequired: async (stepId) => {
            captures.push(stepId);
            return { stepId };
        },
        enableDesktopOverlay: async () => {},
        enableDesktopOverlayVisibility: async () => true,
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentRequestedHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded) => {
            currentExpanded = expanded === true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            if (mode === 'idle') {
                idleSeedCount += 1;
            }
            return { ok: true, mode };
        },
        getOverlayWindowState: async () => createSyntheticOverlayWindowState({
            hostMode: currentOverlayHostMode,
            requestedHostMode: currentRequestedHostMode,
            proofMode: currentProofMode === 'idle' && idleSeedCount < 3
                ? 'session_overview'
                : currentProofMode,
            expanded: currentExpanded,
        }),
        clickCollapsedOverlay: async () => {
            currentExpanded = true;
        },
        isSelectorVisible: async () => false,
        isSelectorVisibleByDomQuery: async () => true,
        wait: async () => {},
        appendWarning: async () => {},
    });

    assert.equal(idleSeedCount >= 3, true);
    assert.equal(captures.includes('overlay_idle'), true);
    assert.equal(result.optionalStepArtifacts.overlay_idle.stepId, 'overlay_idle');
});

test('tauri activity-surfaces QA reports the last observed overlay state when deterministic proof state never matches', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    let currentOverlayHostMode = 'notch_integrated';
    let currentRequestedHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';

    await assert.rejects(
        () => qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
            appIdentifier: 9223,
            env: { EXISTING: 'value' },
            driverSession: { driverSessionPort: 9223 },
            artifactRoot: '/tmp/activity-surfaces-artifacts',
            navigateToPath: async () => {},
            openDesktopAppSettingsPage: async () => true,
            captureRequired: async (stepId) => ({ stepId }),
            enableDesktopOverlay: async () => {},
            enableDesktopOverlayVisibility: async () => true,
            setOverlayPresentationMode: async ({ presentationMode }) => {
                currentRequestedHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
                currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
                return true;
            },
            setOverlayExpanded: async (expanded) => {
                currentExpanded = expanded === true;
            },
            seedOverlayProofState: async ({ mode }) => {
                currentProofMode = mode;
                currentExpanded = true;
                return { ok: true, mode };
            },
            getOverlayWindowState: async () => createSyntheticOverlayWindowState({
                hostMode: currentOverlayHostMode,
                requestedHostMode: currentRequestedHostMode,
                proofMode: currentProofMode === 'idle' ? 'session_overview' : currentProofMode,
                expanded: currentExpanded,
            }),
            clickCollapsedOverlay: async () => {
                currentExpanded = true;
            },
            isSelectorVisible: async () => false,
            isSelectorVisibleByDomQuery: async () => false,
            wait: async () => {},
            appendWarning: async () => {},
        }),
        /Desktop overlay proof state never matched overlay_idle.*session_overview/s,
    );
});

test('tauri activity-surfaces QA does not reassert expansion through the main runtime during seeded proof captures', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    let currentOverlayHostMode = 'notch_integrated';
    let currentRequestedHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';
    let seededProofCaptureActive = false;
    const seededModeCalls = [];
    const permissionCaptureEvents = [];
    let activeCaptureStepId = null;

    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async () => {},
        openDesktopAppSettingsPage: async () => true,
        captureRequired: async (stepId, captureOptions = {}) => {
            activeCaptureStepId = stepId;
            if (typeof captureOptions.beforeSelectorCapture === 'function') {
                if (stepId === 'overlay_permission_request') permissionCaptureEvents.push('selector:start');
                await captureOptions.beforeSelectorCapture();
                if (stepId === 'overlay_permission_request') permissionCaptureEvents.push('selector:end');
            }
            if (typeof captureOptions.beforeScreenshotCapture === 'function') {
                if (stepId === 'overlay_permission_request') permissionCaptureEvents.push('screenshot:start');
                await captureOptions.beforeScreenshotCapture();
                if (stepId === 'overlay_permission_request') permissionCaptureEvents.push('screenshot:end');
            }
            if (typeof captureOptions.beforeStructureCapture === 'function') {
                if (stepId === 'overlay_permission_request') permissionCaptureEvents.push('structure:start');
                await captureOptions.beforeStructureCapture();
                if (stepId === 'overlay_permission_request') permissionCaptureEvents.push('structure:end');
            }
            if (typeof captureOptions.beforeAccessibilityCapture === 'function') {
                if (stepId === 'overlay_permission_request') permissionCaptureEvents.push('accessibility:start');
                await captureOptions.beforeAccessibilityCapture();
                if (stepId === 'overlay_permission_request') permissionCaptureEvents.push('accessibility:end');
            }
            activeCaptureStepId = null;
            return { stepId };
        },
        enableDesktopOverlay: async () => {},
        enableDesktopOverlayVisibility: async () => true,
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentRequestedHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded) => {
            if (seededProofCaptureActive) {
                throw new Error('seeded proof payload must not be overwritten by main-runtime expansion sync');
            }
            currentExpanded = expanded === true;
        },
        seedOverlayProofState: async ({ mode }) => {
            if (activeCaptureStepId === 'overlay_permission_request') {
                permissionCaptureEvents.push(`seed:${mode}`);
            }
            seededModeCalls.push(mode);
            currentProofMode = mode;
            currentExpanded = true;
            seededProofCaptureActive = true;
            return { ok: true, mode };
        },
        getOverlayWindowState: async () => createSyntheticOverlayWindowState({
            hostMode: currentOverlayHostMode,
            requestedHostMode: currentRequestedHostMode,
            proofMode: currentProofMode,
            expanded: currentExpanded,
        }),
        clickCollapsedOverlay: async () => {
            currentExpanded = true;
        },
        isSelectorVisible: async () => true,
        isSelectorVisibleByDomQuery: async () => true,
        wait: async (ms) => {
            if (activeCaptureStepId === 'overlay_permission_request') {
                permissionCaptureEvents.push(`wait:${ms}`);
            }
        },
        appendWarning: async (artifactRoot, warning) => {
            if (String(warning).includes('reassert expanded desktop overlay state')) {
                throw new Error(String(warning));
            }
        },
    });

    assert.equal(result.optionalStepArtifacts.overlay_idle.stepId, 'overlay_idle');
    assert.equal(seededModeCalls.filter((mode) => mode === 'permission_request').length > 1, true);
    assert.deepEqual(permissionCaptureEvents, [
        'selector:start',
        'seed:permission_request',
        'wait:350',
        'selector:end',
        'screenshot:start',
        'seed:permission_request',
        'wait:350',
        'screenshot:end',
        'structure:start',
        'seed:permission_request',
        'wait:350',
        'structure:end',
        'accessibility:start',
        'seed:permission_request',
        'wait:350',
        'accessibility:end',
    ]);
});

test('tauri activity-surfaces QA waits for seeded overlay DOM readiness before capture hooks resolve', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    let currentOverlayHostMode = 'notch_integrated';
    let currentRequestedHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';
    let activeCaptureStepId = null;
    let idleSelectorProbeCount = 0;
    const idleCaptureEvents = [];

    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async () => {},
        openDesktopAppSettingsPage: async () => true,
        captureRequired: async (stepId, captureOptions = {}) => {
            activeCaptureStepId = stepId;
            try {
                if (stepId === 'overlay_idle') {
                    idleCaptureEvents.push('screenshot:start');
                    assert.equal(typeof captureOptions.beforeScreenshotCapture, 'function');
                    await captureOptions.beforeScreenshotCapture();
                    idleCaptureEvents.push('screenshot:end');
                    idleCaptureEvents.push('structure:start');
                    assert.equal(typeof captureOptions.beforeStructureCapture, 'function');
                    await captureOptions.beforeStructureCapture();
                    idleCaptureEvents.push('structure:end');
                }
                return { stepId };
            } finally {
                activeCaptureStepId = null;
            }
        },
        enableDesktopOverlay: async () => {},
        enableDesktopOverlayVisibility: async () => true,
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentRequestedHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded) => {
            currentExpanded = expanded === true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            if (activeCaptureStepId === 'overlay_idle') {
                idleCaptureEvents.push(`seed:${mode}`);
            }
            return { ok: true, mode };
        },
        getOverlayWindowState: async () => createSyntheticOverlayWindowState({
            hostMode: currentOverlayHostMode,
            requestedHostMode: currentRequestedHostMode,
            proofMode: currentProofMode,
            expanded: currentExpanded,
        }),
        clickCollapsedOverlay: async () => {
            currentExpanded = true;
        },
        isSelectorVisible: async (selector, options = {}) => {
            if (activeCaptureStepId !== 'overlay_idle') {
                return true;
            }
            idleCaptureEvents.push(`probe:${selector}:${options.windowId ?? null}`);
            if (selector !== '[data-testid="desktop-activity-overlay-card-idle-idle"]') {
                return false;
            }
            idleSelectorProbeCount += 1;
            return idleSelectorProbeCount >= 2;
        },
        isSelectorVisibleByDomQuery: async (selector, options = {}) => {
            if (activeCaptureStepId !== 'overlay_idle') {
                return true;
            }
            idleCaptureEvents.push(`dom-query:${selector}:${options.windowId ?? null}`);
            return selector === '[data-testid="desktop-activity-overlay-card-idle-idle"]'
                && idleSelectorProbeCount >= 2;
        },
        wait: async (ms) => {
            if (activeCaptureStepId === 'overlay_idle') {
                idleCaptureEvents.push(`wait:${ms}`);
            }
        },
        appendWarning: async () => {},
    });

    assert.equal(result.optionalStepArtifacts.overlay_idle.stepId, 'overlay_idle');
    assert.deepEqual(idleCaptureEvents, [
        'screenshot:start',
        'seed:idle',
        'wait:350',
        'probe:[data-testid="desktop-activity-overlay-card-idle-idle"]:activity_overlay',
        'dom-query:[data-testid="desktop-activity-overlay-card-idle-idle"]:activity_overlay',
        'wait:250',
        'probe:[data-testid="desktop-activity-overlay-card-idle-idle"]:activity_overlay',
        'dom-query:[data-testid="desktop-activity-overlay-card-idle-idle"]:activity_overlay',
        'screenshot:end',
        'structure:start',
        'seed:idle',
        'wait:350',
        'probe:[data-testid="desktop-activity-overlay-card-idle-idle"]:activity_overlay',
        'dom-query:[data-testid="desktop-activity-overlay-card-idle-idle"]:activity_overlay',
        'structure:end',
    ]);
});

test('tauri activity-surfaces QA does not treat a stale selector wait as seeded overlay DOM readiness', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    let currentOverlayHostMode = 'notch_integrated';
    let currentRequestedHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';
    let activeCaptureStepId = null;
    let idleDomQueryCount = 0;
    const idleCaptureEvents = [];

    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async () => {},
        openDesktopAppSettingsPage: async () => true,
        captureRequired: async (stepId, captureOptions = {}) => {
            activeCaptureStepId = stepId;
            try {
                if (stepId === 'overlay_idle') {
                    idleCaptureEvents.push('screenshot:start');
                    assert.equal(typeof captureOptions.beforeScreenshotCapture, 'function');
                    await captureOptions.beforeScreenshotCapture();
                    idleCaptureEvents.push('screenshot:end');
                }
                return { stepId };
            } finally {
                activeCaptureStepId = null;
            }
        },
        enableDesktopOverlay: async () => {},
        enableDesktopOverlayVisibility: async () => true,
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentRequestedHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded) => {
            currentExpanded = expanded === true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            if (activeCaptureStepId === 'overlay_idle') {
                idleCaptureEvents.push(`seed:${mode}`);
            }
            return { ok: true, mode };
        },
        getOverlayWindowState: async () => createSyntheticOverlayWindowState({
            hostMode: currentOverlayHostMode,
            requestedHostMode: currentRequestedHostMode,
            proofMode: currentProofMode,
            expanded: currentExpanded,
        }),
        clickCollapsedOverlay: async () => {
            currentExpanded = true;
        },
        isSelectorVisible: async (selector, options = {}) => {
            if (activeCaptureStepId === 'overlay_idle') {
                idleCaptureEvents.push(`wait-for:${selector}:${options.windowId ?? null}`);
            }
            return selector === '[data-testid="desktop-activity-overlay-card-idle-idle"]';
        },
        isSelectorVisibleByDomQuery: async (selector, options = {}) => {
            if (activeCaptureStepId !== 'overlay_idle') {
                return true;
            }
            idleCaptureEvents.push(`dom-query:${selector}:${options.windowId ?? null}`);
            if (selector !== '[data-testid="desktop-activity-overlay-card-idle-idle"]') {
                return false;
            }
            idleDomQueryCount += 1;
            return idleDomQueryCount >= 2;
        },
        wait: async (ms) => {
            if (activeCaptureStepId === 'overlay_idle') {
                idleCaptureEvents.push(`wait:${ms}`);
            }
        },
        appendWarning: async () => {},
    });

    assert.equal(result.optionalStepArtifacts.overlay_idle.stepId, 'overlay_idle');
    assert.deepEqual(idleCaptureEvents, [
        'screenshot:start',
        'seed:idle',
        'wait:350',
        'wait-for:[data-testid="desktop-activity-overlay-card-idle-idle"]:activity_overlay',
        'dom-query:[data-testid="desktop-activity-overlay-card-idle-idle"]:activity_overlay',
        'wait:250',
        'wait-for:[data-testid="desktop-activity-overlay-card-idle-idle"]:activity_overlay',
        'dom-query:[data-testid="desktop-activity-overlay-card-idle-idle"]:activity_overlay',
        'screenshot:end',
    ]);
});

test('tauri activity-surfaces QA fails closed when forced notch presentation never reports placement diagnostics', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    await assert.rejects(
        () => qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
            appIdentifier: 9223,
            env: { EXISTING: 'value' },
            driverSession: { driverSessionPort: 9223 },
            artifactRoot: '/tmp/activity-surfaces-artifacts',
            navigateToPath: async () => {},
            openDesktopAppSettingsPage: async () => true,
            captureRequired: async (stepId) => ({ stepId }),
            enableDesktopOverlay: async () => {},
            enableDesktopOverlayVisibility: async () => true,
            setOverlayPresentationMode: async () => true,
            setOverlayExpanded: async () => {},
            getOverlayWindowState: async () => ({
                policy: { enabled: true },
            }),
            wait: async () => {},
            appendWarning: async () => {},
        }),
        /never reported placement diagnostics after forcing notch presentation mode/i,
    );
});

test('tauri activity-surfaces QA accepts floating host fallback when forced notch presentation is unsupported', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    const warnings = [];
    let currentOverlayHostMode = 'floating';
    let currentRequestedHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';

    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async () => {},
        openDesktopAppSettingsPage: async () => true,
        captureRequired: async (stepId, captureOptions = {}) => {
            calls.push(['capture', stepId, captureOptions.selectorOverride ?? null, captureOptions.snapshotSelector ?? null]);
            return { stepId };
        },
        enableDesktopOverlay: async () => {},
        enableDesktopOverlayVisibility: async () => true,
        setOverlayPresentationMode: async ({ presentationMode }) => {
            calls.push(['presentation', presentationMode]);
            currentRequestedHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            currentOverlayHostMode = 'floating';
            return true;
        },
        setOverlayExpanded: async (expanded) => {
            calls.push(['set-expanded', expanded]);
            currentExpanded = expanded === true;
        },
        getOverlayWindowState: async () => createSyntheticOverlayWindowState({
            hostMode: currentOverlayHostMode,
            requestedHostMode: currentRequestedHostMode,
            proofMode: currentProofMode,
            expanded: currentExpanded,
        }),
        clickCollapsedOverlay: async (selector, options = {}) => {
            calls.push(['click', selector, options.windowId ?? null]);
            currentExpanded = true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async () => {},
        appendWarning: async (_artifactRoot, text) => {
            warnings.push(text);
        },
    });

    assert.deepEqual(result, createExpectedOverlayCaptureLaneResult());
    assert.equal(
        warnings.some((text) => text.includes('resolved to floating host mode')),
        true,
    );
    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'capture').map((entry) => entry.slice(1)),
        [
            ['settings_overlay', null, null],
            ['overlay_route', null, null],
            ['overlay_collapsed', '[data-testid="desktop-activity-overlay-collapsed-floating"]', '[data-testid="desktop-activity-overlay-collapsed-floating"]'],
            ['overlay_expanded', '[data-testid="desktop-activity-overlay-expanded-floating"]', '[data-testid="desktop-activity-overlay-expanded-floating"]'],
            ['overlay_floating_fallback', '[data-testid="desktop-activity-overlay-collapsed-floating"]', '[data-testid="desktop-activity-overlay-collapsed-floating"]'],
            ['overlay_floating_expanded', '[data-testid="desktop-activity-overlay-expanded-floating"]', '[data-testid="desktop-activity-overlay-expanded-floating"]'],
            ['overlay_idle', '[data-testid="desktop-activity-overlay-card-idle-idle"]', '[data-testid="desktop-activity-overlay-card-idle-idle"]'],
            ['overlay_permission_request', '[data-testid="desktop-activity-overlay-card-permission_request-qa-permission-request"]', '[data-testid="desktop-activity-overlay-card-permission_request-qa-permission-request"]'],
            ['overlay_user_question', '[data-testid="desktop-activity-overlay-card-user_question-qa-user-question"]', '[data-testid="desktop-activity-overlay-card-user_question-qa-user-question"]'],
            ['overlay_quota_summary', '[data-testid="desktop-activity-overlay-card-quota_summary-qa-quota-summary"]', '[data-testid="desktop-activity-overlay-card-quota_summary-qa-quota-summary"]'],
            ['overlay_multi_session_list', '[data-testid="desktop-activity-overlay-card-multi_session_list-list"]', '[data-testid="desktop-activity-overlay-card-multi_session_list-list"]'],
            ['overlay_completion_state', '[data-testid="desktop-activity-overlay-card-completion_state-qa-completion-state"]', '[data-testid="desktop-activity-overlay-card-completion_state-qa-completion-state"]'],
        ],
    );
});

test('tauri activity-surfaces QA restores the requested presentation mode when capture aborts mid-run', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    let currentOverlayHostMode = 'notch_integrated';
    let currentRequestedHostMode = 'notch_integrated';
    let currentExpanded = false;

    await assert.rejects(
        () => qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
            appIdentifier: 9223,
            env: { EXISTING: 'value' },
            driverSession: { driverSessionPort: 9223 },
            artifactRoot: '/tmp/activity-surfaces-artifacts',
            navigateToPath: async () => {},
            openDesktopAppSettingsPage: async () => true,
            captureRequired: async (stepId) => {
                calls.push(['capture', stepId]);
                if (stepId === 'overlay_floating_fallback') {
                    throw new Error('synthetic overlay_floating_fallback failure');
                }
                return { stepId };
            },
            enableDesktopOverlay: async () => {},
            enableDesktopOverlayVisibility: async ({ visibilityMode }) => {
                calls.push(['visibility', visibilityMode]);
                return true;
            },
            setOverlayPresentationMode: async ({ presentationMode }) => {
                calls.push(['presentation', presentationMode]);
                currentRequestedHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
                currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
                return true;
            },
            setOverlayExpanded: async (expanded) => {
                currentExpanded = expanded === true;
            },
            seedOverlayProofState: async ({ mode }) => ({ ok: true, mode }),
            getOverlayWindowState: async () => ({
                ...createSyntheticOverlayWindowState({
                    hostMode: currentOverlayHostMode,
                    requestedHostMode: currentRequestedHostMode,
                    expanded: currentExpanded,
                }),
            }),
            clickCollapsedOverlay: async () => {
                currentExpanded = true;
            },
            wait: async () => {},
            appendWarning: async () => {},
        }),
        /synthetic overlay_floating_fallback failure/i,
    );

    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'presentation').map((entry) => entry[1]),
        ['notch_integrated', 'floating_overlay', 'automatic'],
    );
});

test('tauri activity-surfaces QA falls back to clicking the collapsed overlay when native expand does not surface the expanded selector', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    let expandedCaptureAttempts = 0;
    let currentOverlayHostMode = 'notch_integrated';
    let currentRequestedHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';
    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async (pathname) => {
            calls.push(['navigate', pathname]);
        },
        openDesktopAppSettingsPage: async () => true,
        captureRequired: async (stepId) => {
            calls.push(['capture', stepId]);
            if (stepId === 'overlay_expanded') {
                expandedCaptureAttempts += 1;
                if (expandedCaptureAttempts === 1) {
                    throw new Error('Unable to find a matching selector for step overlay_expanded: [data-testid="desktop-activity-overlay-expanded"]');
                }
            }
            return { stepId };
        },
        enableDesktopOverlay: async () => {
            calls.push(['enable-overlay']);
        },
        enableDesktopOverlayVisibility: async ({ visibilityMode }) => {
            calls.push(['visibility', visibilityMode]);
            return true;
        },
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentRequestedHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded, options = {}) => {
            calls.push(['set-expanded', expanded, options.windowId ?? null]);
            currentExpanded = expanded === true;
        },
        getOverlayWindowState: async (options = {}) => {
            calls.push(['get-overlay-state', options.windowId ?? null]);
            return createSyntheticOverlayWindowState({
                hostMode: currentOverlayHostMode,
                requestedHostMode: currentRequestedHostMode,
                proofMode: currentProofMode,
                expanded: currentExpanded,
            });
        },
        clickCollapsedOverlay: async (selector, options = {}) => {
            calls.push(['click', selector, options.windowId ?? null]);
            currentExpanded = true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
        appendWarning: async () => {
            throw new Error('unexpected warning');
        },
    });

    assert.deepEqual(result, createExpectedOverlayCaptureLaneResult());
    assert.equal(expandedCaptureAttempts, 2);
    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'click'),
        [
            ['click', '[data-testid="desktop-activity-overlay-collapsed"]', 'activity_overlay'],
            ['click', '[data-testid="desktop-activity-overlay-collapsed-floating"]', 'activity_overlay'],
        ],
    );
});

test('tauri activity-surfaces QA recovers notch expansion when the collapsed click leaves the overlay collapsed', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    let currentOverlayHostMode = 'notch_integrated';
    let currentRequestedHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';
    let trueExpansionAttempts = 0;

    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async (pathname) => {
            calls.push(['navigate', pathname]);
        },
        openDesktopAppSettingsPage: async () => true,
        captureRequired: async (stepId) => {
            calls.push(['capture', stepId]);
            return { stepId };
        },
        enableDesktopOverlay: async () => {
            calls.push(['enable-overlay']);
        },
        enableDesktopOverlayVisibility: async ({ visibilityMode }) => {
            calls.push(['visibility', visibilityMode]);
            return true;
        },
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentRequestedHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded, options = {}) => {
            calls.push(['set-expanded', expanded, options.windowId ?? null]);
            if (expanded === true) {
                trueExpansionAttempts += 1;
                currentExpanded = trueExpansionAttempts > 1;
            } else {
                currentExpanded = false;
            }
        },
        getOverlayWindowState: async (options = {}) => {
            calls.push(['get-overlay-state', options.windowId ?? null]);
            return createSyntheticOverlayWindowState({
                hostMode: currentOverlayHostMode,
                requestedHostMode: currentRequestedHostMode,
                proofMode: currentProofMode,
                expanded: currentExpanded,
            });
        },
        clickCollapsedOverlay: async (selector, options = {}) => {
            calls.push(['click', selector, options.windowId ?? null]);
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
        appendWarning: async () => {
            throw new Error('unexpected warning');
        },
    });

    assert.deepEqual(result.expandedArtifacts, { stepId: 'overlay_expanded' });
    assert.equal(
        calls.some((entry) => entry[0] === 'set-expanded' && entry[1] === true && entry[2] === 'main'),
        true,
    );
});

test('tauri activity-surfaces QA degrades overlay expand timeouts into a warning and continues with click fallback', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    const warnings = [];
    let expandedCaptureAttempts = 0;
    let currentOverlayHostMode = 'notch_integrated';
    let currentRequestedHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';

    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async (pathname) => {
            calls.push(['navigate', pathname]);
        },
        openDesktopAppSettingsPage: async () => true,
        captureRequired: async (stepId) => {
            calls.push(['capture', stepId]);
            if (stepId === 'overlay_expanded') {
                expandedCaptureAttempts += 1;
                if (expandedCaptureAttempts === 1) {
                    throw new Error('Unable to find a matching selector for step overlay_expanded: [data-testid="desktop-activity-overlay-expanded"]');
                }
            }
            return { stepId };
        },
        enableDesktopOverlay: async () => {
            calls.push(['enable-overlay']);
        },
        enableDesktopOverlayVisibility: async ({ visibilityMode }) => {
            calls.push(['visibility', visibilityMode]);
            return true;
        },
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentRequestedHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded, options = {}) => {
            calls.push(['set-expanded', expanded, options.windowId ?? null]);
            currentExpanded = expanded === true;
            if (expanded === true && currentRequestedHostMode === 'notch_integrated') {
                throw new Error('Error: JavaScript execution failed: WebView execution failed: Script execution timeout');
            }
        },
        getOverlayWindowState: async (options = {}) => {
            calls.push(['get-overlay-state', options.windowId ?? null]);
            return createSyntheticOverlayWindowState({
                hostMode: currentOverlayHostMode,
                requestedHostMode: currentRequestedHostMode,
                proofMode: currentProofMode,
                expanded: currentExpanded,
            });
        },
        clickCollapsedOverlay: async (selector, options = {}) => {
            calls.push(['click', selector, options.windowId ?? null]);
            currentExpanded = true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
        appendWarning: async (_artifactRoot, text) => {
            warnings.push(text);
        },
    });

    assert.deepEqual(result.expandedArtifacts, { stepId: 'overlay_expanded' });
    assert.equal(expandedCaptureAttempts, 2);
    assert.equal(warnings.some((text) => text.includes('Script execution timeout')), true);
    assert.equal(calls.some((entry) => entry[0] === 'click'), true);
});

test('tauri activity-surfaces QA falls back to an unscoped expanded capture when the DOM snapshot cannot find the expanded selector', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    let expandedCaptureAttempts = 0;
    let currentOverlayHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';

    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async (pathname) => {
            calls.push(['navigate', pathname]);
        },
        openDesktopAppSettingsPage: async () => true,
        captureRequired: async (stepId) => {
            calls.push(['capture', stepId]);
            if (stepId === 'overlay_expanded') {
                expandedCaptureAttempts += 1;
                if (expandedCaptureAttempts === 1) {
                    throw new Error('dom-structure:overlay_expanded failed after 2 attempts: Error: No elements found matching selector \"[data-testid=\\\"desktop-activity-overlay-expanded\\\"]\" (strategy: css)');
                }
            }
            return { stepId };
        },
        captureUnscoped: async (stepId) => {
            calls.push(['capture-unscoped', stepId]);
            return { stepId, unscoped: true };
        },
        enableDesktopOverlay: async () => {
            calls.push(['enable-overlay']);
        },
        enableDesktopOverlayVisibility: async ({ visibilityMode }) => {
            calls.push(['visibility', visibilityMode]);
            return true;
        },
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded, options = {}) => {
            calls.push(['set-expanded', expanded, options.windowId ?? null]);
            currentExpanded = expanded === true;
        },
        getOverlayWindowState: async (options = {}) => {
            calls.push(['get-overlay-state', options.windowId ?? null, options.timeoutMs ?? null]);
            return createSyntheticOverlayWindowState({
                hostMode: currentOverlayHostMode,
                proofMode: currentProofMode,
                expanded: currentExpanded,
            });
        },
        clickCollapsedOverlay: async (selector, options = {}) => {
            calls.push(['click', selector, options.windowId ?? null]);
            currentExpanded = true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
        appendWarning: async () => {
            throw new Error('unexpected warning');
        },
    });

    assert.deepEqual(result.expandedArtifacts, { stepId: 'overlay_expanded', unscoped: true });
    assert.equal(expandedCaptureAttempts, 1);
    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'click'),
        [
            ['click', '[data-testid="desktop-activity-overlay-collapsed"]', 'activity_overlay'],
            ['click', '[data-testid="desktop-activity-overlay-collapsed-floating"]', 'activity_overlay'],
        ],
    );
});

test('tauri activity-surfaces QA retries floating expanded proof capture via the collapsed floating surface when the floating DOM selector disappears', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    let floatingExpandedCaptureAttempts = 0;
    let currentOverlayHostMode = 'notch_integrated';
    let currentRequestedHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';

    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async () => {},
        openDesktopAppSettingsPage: async () => true,
        captureRequired: async (stepId) => {
            calls.push(['capture', stepId]);
            if (stepId === 'overlay_floating_expanded') {
                floatingExpandedCaptureAttempts += 1;
                if (floatingExpandedCaptureAttempts === 1) {
                    currentExpanded = false;
                    throw new Error('dom-structure:overlay_floating_expanded failed after 2 attempts: Error: No elements found matching selector \"[data-testid=\\\"desktop-activity-overlay-expanded-floating\\\"]\" (strategy: css)');
                }
            }
            return { stepId };
        },
        enableDesktopOverlay: async () => {},
        enableDesktopOverlayVisibility: async () => true,
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentRequestedHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded, options = {}) => {
            calls.push(['set-expanded', expanded, options.windowId ?? null]);
            currentExpanded = expanded === true;
        },
        getOverlayWindowState: async () => createSyntheticOverlayWindowState({
            hostMode: currentOverlayHostMode,
            requestedHostMode: currentRequestedHostMode,
            proofMode: currentProofMode,
            expanded: currentExpanded,
        }),
        clickCollapsedOverlay: async (selector, options = {}) => {
            calls.push(['click', selector, options.windowId ?? null]);
            currentExpanded = true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async () => {},
        appendWarning: async () => {},
    });

    assert.deepEqual(result.optionalStepArtifacts.overlay_floating_expanded, { stepId: 'overlay_floating_expanded' });
    assert.equal(floatingExpandedCaptureAttempts, 2);
    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'click'),
        [
            ['click', '[data-testid="desktop-activity-overlay-collapsed"]', 'activity_overlay'],
            ['click', '[data-testid="desktop-activity-overlay-collapsed-floating"]', 'activity_overlay'],
            ['click', '[data-testid="desktop-activity-overlay-collapsed-floating"]', 'activity_overlay'],
        ],
    );
    const firstFloatingClickIndex = calls.findIndex(
        (entry) => entry[0] === 'click' && entry[1] === '[data-testid="desktop-activity-overlay-collapsed-floating"]',
    );
    const firstFloatingExpandedCaptureIndex = calls.findIndex(
        (entry) => entry[0] === 'capture' && entry[1] === 'overlay_floating_expanded',
    );
    assert.ok(firstFloatingClickIndex >= 0);
    assert.ok(firstFloatingClickIndex < firstFloatingExpandedCaptureIndex);
});

test('tauri activity-surfaces QA reasserts expanded state during expanded overlay proof captures', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    let currentOverlayHostMode = 'notch_integrated';
    let currentRequestedHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';

    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async () => {},
        openDesktopAppSettingsPage: async () => true,
        captureRequired: async (stepId, captureOptions = {}) => {
            calls.push([
                'capture',
                stepId,
                typeof captureOptions.beforeSelectorCapture,
                typeof captureOptions.beforeStructureCapture,
                typeof captureOptions.beforeAccessibilityCapture,
            ]);
            if (stepId === 'overlay_floating_expanded') {
                currentExpanded = false;
                assert.equal(typeof captureOptions.beforeSelectorCapture, 'function');
                await captureOptions.beforeSelectorCapture();
                assert.equal(currentExpanded, true);
                currentExpanded = false;
                assert.equal(typeof captureOptions.beforeStructureCapture, 'function');
                await captureOptions.beforeStructureCapture();
                assert.equal(currentExpanded, true);
                currentExpanded = false;
                assert.equal(typeof captureOptions.beforeAccessibilityCapture, 'function');
                await captureOptions.beforeAccessibilityCapture();
                assert.equal(currentExpanded, true);
            }
            return { stepId };
        },
        enableDesktopOverlay: async () => {},
        enableDesktopOverlayVisibility: async () => true,
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentRequestedHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded, options = {}) => {
            calls.push(['set-expanded', expanded, options.windowId ?? null]);
            currentExpanded = expanded === true;
        },
        getOverlayWindowState: async () => createSyntheticOverlayWindowState({
            hostMode: currentOverlayHostMode,
            requestedHostMode: currentRequestedHostMode,
            proofMode: currentProofMode,
            expanded: currentExpanded,
        }),
        clickCollapsedOverlay: async (selector, options = {}) => {
            calls.push(['click', selector, options.windowId ?? null]);
            currentExpanded = true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
        appendWarning: async () => {},
    });

    assert.deepEqual(result.optionalStepArtifacts.overlay_floating_expanded, { stepId: 'overlay_floating_expanded' });
    assert.equal(
        calls.some((entry) => entry[0] === 'set-expanded' && entry[1] === true && entry[2] === 'main'),
        true,
    );
    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'capture' && entry[1] === 'overlay_floating_expanded'),
        [['capture', 'overlay_floating_expanded', 'function', 'function', 'function']],
    );
});

test('tauri activity-surfaces QA backs up floating click expansion with the canonical main-window expanded state', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    let currentOverlayHostMode = 'notch_integrated';
    let currentRequestedHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';

    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async () => {},
        openDesktopAppSettingsPage: async () => true,
        captureRequired: async (stepId) => {
            calls.push(['capture', stepId]);
            return { stepId };
        },
        enableDesktopOverlay: async () => {},
        enableDesktopOverlayVisibility: async () => true,
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentRequestedHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded, options = {}) => {
            calls.push(['set-expanded', expanded, options.windowId ?? null]);
            currentExpanded = expanded === true;
        },
        getOverlayWindowState: async () => createSyntheticOverlayWindowState({
            hostMode: currentOverlayHostMode,
            requestedHostMode: currentRequestedHostMode,
            proofMode: currentProofMode,
            expanded: currentExpanded,
        }),
        clickCollapsedOverlay: async (selector, options = {}) => {
            calls.push(['click', selector, options.windowId ?? null]);
            if (selector === '[data-testid="desktop-activity-overlay-collapsed"]') {
                currentExpanded = true;
            }
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async () => {},
        appendWarning: async () => {},
    });

    assert.deepEqual(result.optionalStepArtifacts.overlay_floating_expanded, { stepId: 'overlay_floating_expanded' });
    const floatingClickIndex = calls.findIndex(
        (entry) => entry[0] === 'click' && entry[1] === '[data-testid="desktop-activity-overlay-collapsed-floating"]',
    );
    const floatingExpandedSyncIndex = calls.findIndex(
        (entry, index) => (
            index > floatingClickIndex
            && entry[0] === 'set-expanded'
            && entry[1] === true
            && entry[2] === 'main'
        ),
    );
    const floatingCaptureIndex = calls.findIndex(
        (entry) => entry[0] === 'capture' && entry[1] === 'overlay_floating_expanded',
    );
    assert.ok(floatingClickIndex >= 0);
    assert.ok(floatingExpandedSyncIndex > floatingClickIndex);
    assert.ok(floatingCaptureIndex > floatingExpandedSyncIndex);
});

test('tauri activity-surfaces QA writes overlay-route diagnostics and retries overlay-route capture under always_when_enabled when selectors never appear', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    const warnings = [];
    const writes = [];
    let overlayRouteAttempts = 0;
    let currentOverlayHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';

    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async (pathname) => {
            calls.push(['navigate', pathname]);
        },
        openDesktopAppSettingsPage: async () => true,
        captureRequired: async (stepId) => {
            calls.push(['capture', stepId]);
            if (stepId === 'overlay_route') {
                overlayRouteAttempts += 1;
                if (overlayRouteAttempts === 1) {
                    throw new Error('Unable to find a matching selector for step overlay_route: [data-testid="desktop-activity-overlay-collapsed"]');
                }
            }
            return { stepId };
        },
        captureUnscoped: async (stepId) => {
            calls.push(['capture-unscoped', stepId]);
            return { stepId, unscoped: true };
        },
        writeArtifact: async (path, text) => {
            writes.push({ path, text });
        },
        enableDesktopOverlay: async () => {
            calls.push(['enable-overlay']);
        },
        enableDesktopOverlayVisibility: async ({ visibilityMode }) => {
            calls.push(['visibility', visibilityMode]);
            return true;
        },
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded) => {
            currentExpanded = expanded === true;
        },
        getOverlayWindowState: async () => createSyntheticOverlayWindowState({
            hostMode: currentOverlayHostMode,
            proofMode: currentProofMode,
            expanded: currentExpanded,
        }),
        clickCollapsedOverlay: async (selector, options = {}) => {
            calls.push(['click', selector, options.windowId ?? null]);
            currentExpanded = true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async () => {},
        appendWarning: async (_artifactRoot, text) => {
            warnings.push(text);
        },
    });

    assert.deepEqual(result.overlayRouteArtifacts, { stepId: 'overlay_route' });
    assert.equal(overlayRouteAttempts, 2);
    assert.equal(
        warnings.some((text) => String(text).includes('overlay route selector miss')),
        true,
    );
    assert.equal(
        warnings.some((text) => String(text).includes('overlay window unavailable (overlay_route)')),
        true,
    );
    assert.equal(
        writes.some((entry) => String(entry.path).endsWith('/99-overlay-route-open.root-state.json')),
        true,
    );
    assert.equal(
        writes.some((entry) => String(entry.path).endsWith('/99-overlay-route-open.selector-fallback.json')),
        true,
    );
    assert.equal(
        calls.some((entry) => entry[0] === 'visibility' && entry[1] === 'always_when_enabled'),
        true,
    );
});

test('tauri activity-surfaces QA retries overlay-route capture with a selector confirmed by root-state diagnostics', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    const warnings = [];
    let currentOverlayHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';
    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async (pathname) => {
            calls.push(['navigate', pathname]);
        },
        openDesktopAppSettingsPage: async () => true,
        probeRootState: async (_options = {}) => ({
            pathname: '/desktop/activity-overlay',
            visibleTestIds: [
                'desktop-activity-overlay-diagnostics',
                'desktop-activity-overlay-collapsed',
            ],
        }),
        captureRequired: async (stepId, captureOptions = {}) => {
            calls.push(['capture', stepId, captureOptions.selectorOverride ?? null]);
            if (stepId === 'overlay_route' && !captureOptions.selectorOverride) {
                throw new Error('Unable to find a matching selector for step overlay_route: [data-testid="desktop-activity-overlay-collapsed"]');
            }
            return { stepId, selectorOverride: captureOptions.selectorOverride ?? null };
        },
        captureUnscoped: async (stepId) => {
            calls.push(['capture-unscoped', stepId]);
            return { stepId, unscoped: true };
        },
        writeArtifact: async () => {},
        enableDesktopOverlay: async () => {
            calls.push(['enable-overlay']);
        },
        enableDesktopOverlayVisibility: async ({ visibilityMode }) => {
            calls.push(['visibility', visibilityMode]);
            return true;
        },
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded) => {
            currentExpanded = expanded === true;
        },
        getOverlayWindowState: async () => createSyntheticOverlayWindowState({
            hostMode: currentOverlayHostMode,
            proofMode: currentProofMode,
            expanded: currentExpanded,
        }),
        clickCollapsedOverlay: async () => {
            currentExpanded = true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async () => {},
        appendWarning: async (_artifactRoot, text) => {
            warnings.push(text);
        },
    });

    assert.deepEqual(result.overlayRouteArtifacts, {
        stepId: 'overlay_route',
        selectorOverride: '[data-testid="desktop-activity-overlay-collapsed"]',
    });
    assert.equal(
        calls.some((entry) => (
            entry[0] === 'capture'
            && entry[1] === 'overlay_route'
            && entry[2] === '[data-testid="desktop-activity-overlay-collapsed"]'
        )),
        true,
    );
    assert.equal(
        warnings.some((text) => String(text).includes('overlay route root-state confirmed selector')),
        true,
    );
});

test("tauri activity-surfaces QA pokes overlay expansion state when the overlay window CDP target disappears (Window 'activity_overlay' not found)", async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    let overlayRouteAttempts = 0;
    let currentOverlayHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';

    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async (pathname, { windowId } = {}) => {
            calls.push(['navigate', pathname, windowId ?? null]);
        },
        openDesktopAppSettingsPage: async () => true,
        captureRequired: async (stepId) => {
            calls.push(['capture', stepId]);
            if (stepId === 'overlay_route') {
                overlayRouteAttempts += 1;
                if (overlayRouteAttempts === 1) {
                    throw new Error("WebView execution failed: Window 'activity_overlay' not found");
                }
            }
            return { stepId };
        },
        captureUnscoped: async (stepId) => {
            calls.push(['capture-unscoped', stepId]);
            return { stepId, unscoped: true };
        },
        writeArtifact: async () => {},
        enableDesktopOverlay: async () => {
            calls.push(['enable-overlay']);
        },
        enableDesktopOverlayVisibility: async ({ visibilityMode }) => {
            calls.push(['visibility', visibilityMode]);
            return true;
        },
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded, { windowId } = {}) => {
            calls.push(['set-expanded', expanded === true, windowId ?? null]);
            currentExpanded = expanded === true;
        },
        getOverlayWindowState: async () => createSyntheticOverlayWindowState({
            hostMode: currentOverlayHostMode,
            proofMode: currentProofMode,
            expanded: currentExpanded,
        }),
        clickCollapsedOverlay: async () => {
            currentExpanded = true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async () => {},
        appendWarning: async () => {},
    });

    assert.deepEqual(result.overlayRouteArtifacts, { stepId: 'overlay_route' });
    assert.equal(overlayRouteAttempts, 2);
    assert.equal(
        calls.some((entry) => entry[0] === 'set-expanded' && entry[1] === false && entry[2] === 'main'),
        true,
    );
});

test('tauri activity-surfaces QA probes overlay window state after requesting expansion', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    let currentOverlayHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';
    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async (pathname) => {
            calls.push(['navigate', pathname]);
        },
        openDesktopAppSettingsPage: async () => true,
        captureRequired: async (stepId) => {
            calls.push(['capture', stepId]);
            return { stepId };
        },
        enableDesktopOverlay: async () => {
            calls.push(['enable-overlay']);
        },
        enableDesktopOverlayVisibility: async ({ visibilityMode }) => {
            calls.push(['visibility', visibilityMode]);
            return true;
        },
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded, options = {}) => {
            calls.push(['set-expanded', expanded, options.windowId ?? null]);
            currentExpanded = expanded === true;
        },
        getOverlayWindowState: async (options = {}) => {
            calls.push(['get-overlay-state', options.windowId ?? null, options.timeoutMs ?? null]);
            return createSyntheticOverlayWindowState({
                hostMode: currentOverlayHostMode,
                proofMode: currentProofMode,
                expanded: currentExpanded,
            });
        },
        clickCollapsedOverlay: async (selector, options = {}) => {
            calls.push(['click', selector, options.windowId ?? null]);
            currentExpanded = true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
        appendWarning: async () => {
            throw new Error('unexpected warning');
        },
    });

    assert.equal(result.expandedArtifacts.stepId, 'overlay_expanded');
    const expandRequestIndex = calls.findIndex(
        (entry) => (entry[0] === 'set-expanded' && entry[1] === true)
            || (entry[0] === 'click' && entry[1] === '[data-testid="desktop-activity-overlay-collapsed"]'),
    );
    const getStateIndex = calls.findIndex(
        (entry, index) => index > expandRequestIndex && entry[0] === 'get-overlay-state' && entry[1] === 'activity_overlay',
    );
    assert.ok(expandRequestIndex >= 0);
    assert.ok(getStateIndex > expandRequestIndex);
    assert.equal(calls[getStateIndex][2], 1_500);
});

test('tauri activity-surfaces QA validates expanded notch proof before slow overlay-window diagnostics can collapse it', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    let currentOverlayHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';

    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async () => {},
        openDesktopAppSettingsPage: async () => true,
        captureRequired: async (stepId) => {
            calls.push(['capture', stepId]);
            return { stepId };
        },
        enableDesktopOverlay: async () => {},
        enableDesktopOverlayVisibility: async () => true,
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded, options = {}) => {
            calls.push(['set-expanded', expanded, options.windowId ?? null]);
            currentExpanded = expanded === true;
        },
        getOverlayWindowState: async (options = {}) => {
            calls.push(['get-overlay-state', options.windowId ?? null]);
            if (options.windowId === 'activity_overlay') {
                currentExpanded = false;
            }
            return createSyntheticOverlayWindowState({
                hostMode: currentOverlayHostMode,
                proofMode: currentProofMode,
                expanded: currentExpanded,
            });
        },
        clickCollapsedOverlay: async (selector, options = {}) => {
            calls.push(['click', selector, options.windowId ?? null]);
            currentExpanded = true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async () => {},
        appendWarning: async () => {},
    });

    assert.equal(result.expandedArtifacts.stepId, 'overlay_expanded');
    const expandedCaptureIndex = calls.findIndex((entry) => entry[0] === 'capture' && entry[1] === 'overlay_expanded');
    const overlayDiagnosticIndex = calls.findIndex((entry) => entry[0] === 'get-overlay-state' && entry[1] === 'activity_overlay');
    assert.ok(expandedCaptureIndex >= 0);
    assert.ok(overlayDiagnosticIndex > expandedCaptureIndex);
});

test('tauri activity-surfaces QA backs up notch click expansion before probing expanded state', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    let currentOverlayHostMode = 'notch_integrated';
    let currentRequestedHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';

    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async () => {},
        openDesktopAppSettingsPage: async () => true,
        captureRequired: async (stepId) => {
            calls.push(['capture', stepId]);
            return { stepId };
        },
        enableDesktopOverlay: async () => {},
        enableDesktopOverlayVisibility: async () => true,
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentRequestedHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded, options = {}) => {
            calls.push(['set-expanded', expanded, options.windowId ?? null]);
            currentExpanded = expanded === true;
        },
        getOverlayWindowState: async (options = {}) => {
            calls.push(['get-overlay-state', options.windowId ?? null]);
            return createSyntheticOverlayWindowState({
                hostMode: currentOverlayHostMode,
                requestedHostMode: currentRequestedHostMode,
                proofMode: currentProofMode,
                expanded: currentExpanded,
            });
        },
        clickCollapsedOverlay: async (selector, options = {}) => {
            calls.push(['click', selector, options.windowId ?? null]);
            if (selector === '[data-testid="desktop-activity-overlay-collapsed-floating"]') {
                currentExpanded = true;
            }
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async () => {},
        appendWarning: async () => {},
    });

    assert.deepEqual(result.expandedArtifacts, { stepId: 'overlay_expanded' });
    const notchClickIndex = calls.findIndex(
        (entry) => entry[0] === 'click' && entry[1] === '[data-testid="desktop-activity-overlay-collapsed"]',
    );
    const expandedSyncIndex = calls.findIndex(
        (entry, index) => (
            index > notchClickIndex
            && entry[0] === 'set-expanded'
            && entry[1] === true
            && entry[2] === 'main'
        ),
    );
    const postClickStateProbeIndex = calls.findIndex(
        (entry, index) => index > notchClickIndex && entry[0] === 'get-overlay-state',
    );
    assert.ok(notchClickIndex >= 0);
    assert.ok(expandedSyncIndex > notchClickIndex);
    assert.ok(postClickStateProbeIndex > expandedSyncIndex);
});

test('tauri activity-surfaces QA retries the desktop settings opener only after the initial settings capture fails', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    let settingsCaptureAttempts = 0;
    let traceSelectorProbeSeen = false;
    let currentOverlayHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';
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
            traceSelectorProbeSeen = typeof options.traceSelectorProbe === 'function';
            if (traceSelectorProbeSeen) {
                await options.traceSelectorProbe({
                    ts: '2026-04-06T00:00:00.000Z',
                    kind: 'selector',
                    source: 'test',
                    selector: '[data-testid="settings-desktop-overlay-enabled"]',
                    windowId: options.windowId ?? null,
                    timeoutMs: 1_000,
                    result: false,
                });
            }
            return true;
        },
        captureRequired: async (stepId) => {
            calls.push(['capture', stepId]);
            if (stepId === 'settings_overlay') {
                settingsCaptureAttempts += 1;
                if (settingsCaptureAttempts === 1) {
                    throw new Error('Unable to find a matching selector for step settings_overlay');
                }
            }
            return { stepId };
        },
        enableDesktopOverlay: async (options = {}) => {
            calls.push(['enable-overlay', options.windowId ?? null]);
        },
        enableDesktopOverlayVisibility: async ({ visibilityMode, windowId }) => {
            calls.push(['visibility', visibilityMode, windowId ?? null]);
            return true;
        },
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded, options = {}) => {
            calls.push(['set-expanded', expanded, options.windowId ?? null]);
            currentExpanded = expanded === true;
        },
        getOverlayWindowState: async (options = {}) => {
            calls.push(['get-overlay-state', options.windowId ?? null]);
            return createSyntheticOverlayWindowState({
                hostMode: currentOverlayHostMode,
                proofMode: currentProofMode,
                expanded: currentExpanded,
            });
        },
        clickCollapsedOverlay: async () => {
            currentExpanded = true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
        appendWarning: async () => {
            throw new Error('unexpected warning');
        },
    });

    assert.deepEqual(result, createExpectedOverlayCaptureLaneResult());
    assert.equal(settingsCaptureAttempts, 2);
    assert.equal(traceSelectorProbeSeen, true);
    const openSettingsIndices = calls
        .map((entry, index) => (entry[0] === 'open-settings-page' ? index : -1))
        .filter((index) => index >= 0);
    const firstSettingsCaptureIndex = calls.findIndex((entry) => entry[0] === 'capture' && entry[1] === 'settings_overlay');
    assert.ok(openSettingsIndices.length >= 2);
    assert.equal(openSettingsIndices[0] < firstSettingsCaptureIndex, true);
    assert.equal(openSettingsIndices[openSettingsIndices.length - 1] > firstSettingsCaptureIndex, true);
});

test('tauri activity-surfaces QA retries the dedicated desktop settings opener when the desktop route is present but the settings shell selector is still missing', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    let settingsCaptureAttempts = 0;
    let currentOverlayHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';
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
        probeRootState: async () => ({
            pathname: '/settings/desktop',
            visibleTestIds: [],
        }),
        captureRequired: async (stepId) => {
            calls.push(['capture', stepId]);
            if (stepId === 'settings_overlay') {
                settingsCaptureAttempts += 1;
                if (settingsCaptureAttempts === 1) {
                    throw new Error('Unable to find a matching selector for step settings_overlay');
                }
            }
            return { stepId };
        },
        enableDesktopOverlay: async (options = {}) => {
            calls.push(['enable-overlay', options.windowId ?? null]);
        },
        enableDesktopOverlayVisibility: async ({ visibilityMode, windowId }) => {
            calls.push(['visibility', visibilityMode, windowId ?? null]);
            return true;
        },
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded, options = {}) => {
            calls.push(['set-expanded', expanded, options.windowId ?? null]);
            currentExpanded = expanded === true;
        },
        getOverlayWindowState: async (options = {}) => {
            calls.push(['get-overlay-state', options.windowId ?? null]);
            return createSyntheticOverlayWindowState({
                hostMode: currentOverlayHostMode,
                proofMode: currentProofMode,
                expanded: currentExpanded,
            });
        },
        clickCollapsedOverlay: async (selector) => {
            calls.push(['click', selector]);
            currentExpanded = true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
        appendWarning: async () => {
            throw new Error('unexpected warning');
        },
    });

    assert.deepEqual(result, createExpectedOverlayCaptureLaneResult());
    assert.equal(settingsCaptureAttempts, 2);
    assert.equal(calls.some((entry) => entry[0] === 'open-settings-page'), true);
    assert.equal(calls.some((entry) => entry[0] === 'enable-overlay'), true);
});

test('tauri activity-surfaces QA falls back to unscoped settings artifacts when scoped settings capture keeps missing', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    const warnings = [];
    let settingsCaptureAttempts = 0;
    let currentOverlayHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';
    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async (pathname) => {
            calls.push(['navigate', pathname]);
        },
        openDesktopAppSettingsPage: async () => {
            calls.push(['open-settings-page']);
            return true;
        },
        probeRootState: async () => ({
            pathname: '/settings/desktop',
            visibleTestIds: ['settings-desktop-overlay-enabled'],
        }),
        captureRequired: async (stepId) => {
            calls.push(['capture', stepId]);
            if (stepId === 'settings_overlay') {
                settingsCaptureAttempts += 1;
                throw new Error('Unable to find a matching selector for step settings_overlay');
            }
            return { stepId };
        },
        captureUnscoped: async (stepId) => {
            calls.push(['capture-unscoped', stepId]);
            return { stepId, unscoped: true };
        },
        enableDesktopOverlay: async (options = {}) => {
            calls.push(['enable-overlay', options.windowId ?? null]);
        },
        enableDesktopOverlayVisibility: async ({ visibilityMode, windowId }) => {
            calls.push(['visibility', visibilityMode, windowId ?? null]);
            return true;
        },
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded, options = {}) => {
            calls.push(['set-expanded', expanded, options.windowId ?? null]);
            currentExpanded = expanded === true;
        },
        getOverlayWindowState: async (options = {}) => {
            calls.push(['get-overlay-state', options.windowId ?? null]);
            return createSyntheticOverlayWindowState({
                hostMode: currentOverlayHostMode,
                proofMode: currentProofMode,
                expanded: currentExpanded,
            });
        },
        clickCollapsedOverlay: async (selector) => {
            calls.push(['click', selector]);
            currentExpanded = true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
        appendWarning: async (_artifactRoot, message) => {
            warnings.push(message);
        },
    });

    assert.deepEqual(result.settingsArtifacts, { stepId: 'settings_overlay', unscoped: true });
    assert.equal(settingsCaptureAttempts >= 2, true);
    assert.equal(calls.some((entry) => entry[0] === 'capture-unscoped' && entry[1] === 'settings_overlay'), true);
    assert.equal(calls.some((entry) => entry[0] === 'enable-overlay'), true);
    assert.equal(
        warnings.some((message) => String(message).includes('unable to capture scoped settings overlay snapshot')),
        true,
    );
});

test('tauri activity-surfaces QA recovers a main-window crash during overlay settings capture before retrying the desktop settings opener', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    let settingsCaptureAttempts = 0;
    let openSettingsAttempts = 0;
    let currentOverlayHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';
    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async (pathname) => {
            calls.push(['navigate', pathname]);
        },
        openDesktopAppSettingsPage: async (options = {}) => {
            openSettingsAttempts += 1;
            calls.push(['open-settings-page', openSettingsAttempts, options.windowId ?? null]);
            return openSettingsAttempts > 2;
        },
        probeRootState: async () => null,
        captureRequired: async (stepId) => {
            calls.push(['capture', stepId]);
            if (stepId === 'settings_overlay') {
                settingsCaptureAttempts += 1;
                if (settingsCaptureAttempts === 1) {
                    throw new Error('Unable to find a matching selector for step settings_overlay');
                }
            }
            return { stepId };
        },
        isSelectorVisible: async (selector) => selector === '[data-testid="app-crash-restart"]',
        recoverAppCrash: async () => {
            calls.push(['recover-app-crash']);
            return true;
        },
        enableDesktopOverlay: async (options = {}) => {
            calls.push(['enable-overlay', options.windowId ?? null]);
        },
        enableDesktopOverlayVisibility: async ({ visibilityMode, windowId }) => {
            calls.push(['visibility', visibilityMode, windowId ?? null]);
            return true;
        },
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded, options = {}) => {
            calls.push(['set-expanded', expanded, options.windowId ?? null]);
            currentExpanded = expanded === true;
        },
        getOverlayWindowState: async (options = {}) => {
            calls.push(['get-overlay-state', options.windowId ?? null]);
            return createSyntheticOverlayWindowState({
                hostMode: currentOverlayHostMode,
                proofMode: currentProofMode,
                expanded: currentExpanded,
            });
        },
        clickCollapsedOverlay: async (selector) => {
            calls.push(['click', selector]);
            currentExpanded = true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
        appendWarning: async () => {
            throw new Error('unexpected warning');
        },
    });

    assert.deepEqual(result, createExpectedOverlayCaptureLaneResult());
    assert.equal(settingsCaptureAttempts, 2);
    assert.equal(openSettingsAttempts, 3);
    assert.equal(calls.some((entry) => entry[0] === 'recover-app-crash'), true);
});

test('tauri activity-surfaces QA detects an overlay-settings crash through a DOM-query fallback before retrying recovery', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    let settingsCaptureAttempts = 0;
    let openSettingsAttempts = 0;
    let currentOverlayHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';
    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async (pathname) => {
            calls.push(['navigate', pathname]);
        },
        openDesktopAppSettingsPage: async () => {
            openSettingsAttempts += 1;
            return openSettingsAttempts > 2;
        },
        probeRootState: async () => null,
        captureRequired: async (stepId) => {
            if (stepId === 'settings_overlay') {
                settingsCaptureAttempts += 1;
                if (settingsCaptureAttempts === 1) {
                    throw new Error('Unable to find a matching selector for step settings_overlay');
                }
            }
            return { stepId };
        },
        isSelectorVisible: async () => false,
        isSelectorVisibleByDomQuery: async (selector) => selector === '[data-testid="app-crash-restart"]',
        recoverAppCrash: async () => {
            calls.push(['recover-app-crash']);
            return true;
        },
        enableDesktopOverlay: async () => {},
        enableDesktopOverlayVisibility: async () => true,
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded) => {
            currentExpanded = expanded === true;
        },
        getOverlayWindowState: async () => createSyntheticOverlayWindowState({
            hostMode: currentOverlayHostMode,
            proofMode: currentProofMode,
            expanded: currentExpanded,
        }),
        clickCollapsedOverlay: async () => {
            currentExpanded = true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async () => {},
        appendWarning: async () => {
            throw new Error('unexpected warning');
        },
    });

    assert.deepEqual(result.settingsArtifacts, { stepId: 'settings_overlay' });
    assert.equal(openSettingsAttempts, 3);
    assert.equal(calls.some((entry) => entry[0] === 'recover-app-crash'), true);
});

test('tauri activity-surfaces QA skips the dedicated desktop settings opener when the direct desktop route is already confirmed', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    let currentOverlayHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';
    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async (pathname) => {
            calls.push(['navigate', pathname]);
        },
        probeRootState: async () => ({
            pathname: '/settings/desktop',
            visibleTestIds: ['settings-desktop-overlay-enabled'],
        }),
        openDesktopAppSettingsPage: async () => {
            throw new Error('desktop page opener should not run when the direct route is already confirmed');
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
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded, options = {}) => {
            calls.push(['set-expanded', expanded, options.windowId ?? null]);
            currentExpanded = expanded === true;
        },
        getOverlayWindowState: async (options = {}) => {
            calls.push(['get-overlay-state', options.windowId ?? null]);
            return createSyntheticOverlayWindowState({
                hostMode: currentOverlayHostMode,
                proofMode: currentProofMode,
                expanded: currentExpanded,
            });
        },
        clickCollapsedOverlay: async () => {
            currentExpanded = true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
        appendWarning: async () => {
            throw new Error('unexpected warning');
        },
    });

    assert.deepEqual(result, createExpectedOverlayCaptureLaneResult());
    assert.equal(calls.some((entry) => entry[0] === 'capture' && entry[1] === 'settings_overlay'), true);
    assert.equal(calls.some((entry) => entry[0] === 'enable-overlay'), true);
});

test('tauri activity-surfaces QA accepts a successful settings overlay capture when desktop settings route probing is inconclusive', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    let currentOverlayHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';
    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async (pathname) => {
            calls.push(['navigate', pathname]);
        },
        openDesktopAppSettingsPage: async () => false,
        probeRootState: async () => ({
            pathname: '/settings',
            visibleTestIds: [],
        }),
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
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded, options = {}) => {
            calls.push(['set-expanded', expanded, options.windowId ?? null]);
            currentExpanded = expanded === true;
        },
        getOverlayWindowState: async (options = {}) => {
            calls.push(['get-overlay-state', options.windowId ?? null]);
            return createSyntheticOverlayWindowState({
                hostMode: currentOverlayHostMode,
                proofMode: currentProofMode,
                expanded: currentExpanded,
            });
        },
        clickCollapsedOverlay: async () => {
            currentExpanded = true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
        appendWarning: async () => {
            throw new Error('unexpected warning');
        },
    });

    assert.deepEqual(result, createExpectedOverlayCaptureLaneResult());
    assert.equal(calls.some((entry) => entry[0] === 'capture' && entry[1] === 'settings_overlay'), true);
    assert.equal(
        calls.findIndex((entry) => entry[0] === 'capture' && entry[1] === 'settings_overlay')
        < calls.findIndex((entry) => entry[0] === 'enable-overlay'),
        true,
    );
});

test('tauri activity-surfaces QA continues overlay capture when the desktop settings page cannot be confirmed', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const warnings = [];
    const calls = [];
    let currentOverlayHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';
    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async (pathname) => {
            calls.push(['navigate', pathname]);
        },
        openDesktopAppSettingsPage: async () => false,
        probeRootState: async () => ({
            pathname: '/settings',
            visibleTestIds: ['settings-desktop-entry'],
        }),
        captureRequired: async (stepId) => {
            calls.push(['capture', stepId]);
            if (stepId === 'settings_overlay') {
                throw new Error('Unable to find a matching selector for step settings_overlay: [data-testid="settings-desktop-overlay-enabled"]');
            }
            return { stepId };
        },
        enableDesktopOverlay: async (options = {}) => {
            calls.push(['enable-overlay', options.windowId ?? null]);
        },
        enableDesktopOverlayVisibility: async ({ visibilityMode, windowId }) => {
            calls.push(['visibility', visibilityMode, windowId ?? null]);
            return true;
        },
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded, options = {}) => {
            calls.push(['set-expanded', expanded, options.windowId ?? null]);
            currentExpanded = expanded === true;
        },
        getOverlayWindowState: async (options = {}) => {
            calls.push(['get-overlay-state', options.windowId ?? null]);
            return createSyntheticOverlayWindowState({
                hostMode: currentOverlayHostMode,
                proofMode: currentProofMode,
                expanded: currentExpanded,
            });
        },
        clickCollapsedOverlay: async (selector) => {
            calls.push(['click', selector]);
            currentExpanded = true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
        appendWarning: async (_artifactRoot, text) => {
            warnings.push(text);
        },
    });

    assert.equal(result.settingsArtifacts, null);
    assert.equal(warnings.some((text) => String(text).includes('continuing with overlay capture')), true);
    assert.equal(calls.some((entry) => entry[0] === 'capture' && entry[1] === 'overlay_route'), true);
    assert.equal(calls.some((entry) => entry[0] === 'enable-overlay'), true);
});

test('tauri activity-surfaces QA falls back to always_when_enabled when the overlay route stays unavailable under active_sessions', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesDesktopOverlayCaptureLane, 'function');

    const calls = [];
    let overlayRouteAttempts = 0;
    let currentOverlayHostMode = 'notch_integrated';
    let currentExpanded = false;
    let currentProofMode = 'session_overview';
    const result = await qaModule.runActivitySurfacesDesktopOverlayCaptureLane({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateToPath: async (pathname, options = {}) => {
            calls.push(['navigate', pathname, options.windowId ?? null]);
        },
        openDesktopAppSettingsPage: async () => true,
        captureRequired: async (stepId) => {
            calls.push(['capture', stepId]);
            if (stepId === 'overlay_route') {
                overlayRouteAttempts += 1;
                if (overlayRouteAttempts === 1) {
                    throw new Error('Unable to find a matching selector for step overlay_route: [data-testid="desktop-activity-overlay-collapsed"]');
                }
            }
            return { stepId };
        },
        enableDesktopOverlay: async () => {
            calls.push(['enable-overlay']);
        },
        enableDesktopOverlayVisibility: async ({ visibilityMode }) => {
            calls.push(['visibility', visibilityMode]);
            return true;
        },
        setOverlayPresentationMode: async ({ presentationMode }) => {
            currentOverlayHostMode = presentationMode === 'floating_overlay' ? 'floating' : 'notch_integrated';
            return true;
        },
        setOverlayExpanded: async (expanded, options = {}) => {
            calls.push(['set-expanded', expanded, options.windowId ?? null]);
            currentExpanded = expanded === true;
        },
        getOverlayWindowState: async (options = {}) => {
            calls.push(['get-overlay-state', options.windowId ?? null]);
            return createSyntheticOverlayWindowState({
                hostMode: currentOverlayHostMode,
                proofMode: currentProofMode,
                expanded: currentExpanded,
            });
        },
        clickCollapsedOverlay: async (selector) => {
            calls.push(['click', selector]);
            currentExpanded = true;
        },
        seedOverlayProofState: async ({ mode }) => {
            currentProofMode = mode;
            currentExpanded = true;
            return { ok: true, mode };
        },
        appendWarning: async (artifactRoot, line) => {
            calls.push(['warning', artifactRoot, line]);
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
    });

    assert.deepEqual(result, createExpectedOverlayCaptureLaneResult());
    const visibilityModes = calls.filter((entry) => entry[0] === 'visibility').map((entry) => entry[1]);
    assert.equal(visibilityModes[0], 'always_when_enabled');
    assert.equal(visibilityModes[visibilityModes.length - 1], 'active_sessions');
    assert.equal(calls.some((entry) => entry[0] === 'warning' && String(entry[2]).includes('always_when_enabled')), true);
    assert.equal(overlayRouteAttempts, 2);
});

test('tauri activity-surfaces QA records stage-trace entries across the orchestrated capture flow', async () => {
    assert.equal(typeof qaModule.runTauriActivitySurfacesQaCapture, 'function');

    const stageTrace = [];
    const writes = [];
    const steps = [
        { id: 'settings_overlay' },
        { id: 'overlay_route' },
        { id: 'overlay_collapsed' },
        { id: 'overlay_expanded' },
    ];

    const result = await qaModule.runTauriActivitySurfacesQaCapture({
        plan: {
            artifactRoot: '/tmp/activity-surfaces-artifacts',
            trackerPath: '/tmp/activity-surfaces-tracker.md',
            steps,
            preflight: { settingsPath: '/settings' },
            manual: [],
        },
        env: { EXISTING: 'value' },
        ensureWorkspaceBuilt: async () => {},
        ensureArtifactDir: async () => {},
        startDriverSessionImpl: async () => ({
            driverSessionPort: 9223,
            resolvedAppIdentifier: 9223,
            driverSessionCommand: 'driver-session-start',
            driverSessionResponseFile: '/tmp/driver-session.json',
            driverSessionStatusCommand: 'driver-session-status',
            driverSessionStatusResponseFile: '/tmp/driver-session-status.json',
        }),
        runCli: async (args) => {
            assert.deepEqual(args, ['ipc-get-backend-state', '--json', '--app-identifier', '9223']);
            return { stdout: '{"ok":true}' };
        },
        writeArtifact: async (path, contents) => {
            writes.push({ path, contents });
        },
        ensureSettingsReady: async () => ({ ok: true, attempts: 1 }),
        seedSession: async () => ({ sessionId: 'sess_seeded_overlay' }),
        hydrateSeededSession: async () => true,
        runOverlayCapture: async () => createCompleteSyntheticQaOverlayCaptureResult(),
        appendTracker: async () => {},
        appendStageTrace: async (_artifactRoot, entry) => {
            stageTrace.push(entry);
        },
    });

    assert.deepEqual(stageTrace.map((entry) => `${entry.stage}:${entry.status}`), [
        'driver_session:start',
        'driver_session:done',
        'backend_state:start',
        'backend_state:done',
        'settings_preflight:start',
        'settings_preflight:done',
        'seed_overlay_session:start',
        'seed_overlay_session:done',
        'hydrate_seeded_session:start',
        'hydrate_seeded_session:done',
        'overlay_capture:start',
        'overlay_capture:done',
        'manual_steps_artifact:start',
        'manual_steps_artifact:done',
        'tracker_evidence:start',
        'tracker_evidence:done',
    ]);
    assert.equal(writes.some((entry) => entry.path.endsWith('/00-backend-state.json')), true);
    assert.equal(writes.some((entry) => entry.path.endsWith('/00-seeded-session.json')), true);
    assert.equal(result.seededSession.sessionId, 'sess_seeded_overlay');
    assert.deepEqual(result.steps, canonicalActivitySurfacesRequiredProofStepIds);
});

test('tauri activity-surfaces QA marks missing required step artifacts as incomplete', async () => {
    assert.equal(typeof qaModule.runTauriActivitySurfacesQaCapture, 'function');

    const tmpRoot = mkdtempSync('/tmp/happier-activity-surfaces-qa-');
    try {
        const artifactRoot = join(tmpRoot, 'artifacts');
        const trackerPath = join(tmpRoot, 'tracker.md');

        const result = await qaModule.runTauriActivitySurfacesQaCapture({
            plan: {
                artifactRoot,
                trackerPath,
                steps: [
                    { id: 'settings_overlay' },
                    { id: 'overlay_route' },
                    { id: 'overlay_collapsed' },
                    { id: 'overlay_expanded' },
                ],
                preflight: { settingsPath: '/settings' },
                manual: [],
            },
            env: { EXISTING: 'value' },
            ensureWorkspaceBuilt: async () => {},
            ensureArtifactDir: async (path) => mkdirSync(path, { recursive: true }),
            startDriverSessionImpl: async () => ({
                driverSessionPort: 9223,
                resolvedAppIdentifier: 9223,
                driverSessionCommand: 'driver-session-start',
                driverSessionResponseFile: '/tmp/driver-session.json',
                driverSessionStatusCommand: 'driver-session-status',
                driverSessionStatusResponseFile: '/tmp/driver-session-status.json',
            }),
            runCli: async () => ({ stdout: '{"ok":true}' }),
            writeArtifact: async () => {},
        ensureSettingsReady: async () => ({ ok: true, attempts: 1 }),
        seedSession: async () => ({ sessionId: 'sess_seeded_overlay' }),
        hydrateSeededSession: async () => true,
        runOverlayCapture: async () => ({
            settingsArtifacts: null,
            overlayRouteArtifacts: { screenshotPath: '/tmp/route.png', structurePath: '/tmp/route.txt', a11yPath: '/tmp/route-a11y.txt' },
            collapsedArtifacts: { screenshotPath: '/tmp/collapsed.png', structurePath: '/tmp/collapsed.txt', a11yPath: '/tmp/collapsed-a11y.txt' },
            expandedArtifacts: { screenshotPath: '/tmp/expanded.png', structurePath: '/tmp/expanded.txt', a11yPath: '/tmp/expanded-a11y.txt' },
            floatingFallbackArtifacts: { screenshotPath: '/tmp/fallback.png', structurePath: '/tmp/fallback.txt', a11yPath: '/tmp/fallback-a11y.txt' },
            overlayVisibilityEnabled: true,
            optionalStepArtifacts: createCompleteSyntheticQaOverlayCaptureResult().optionalStepArtifacts,
        }),
            appendStageTrace: async () => {},
        });

        assert.equal(result.ok, false);
        assert.equal(result.blocker, 'missing_required_step_artifacts');
        const trackerContents = readFileSync(trackerPath, 'utf8');
        assert.match(trackerContents, /overlay_route/);
        assert.match(trackerContents, /settings_overlay/);
        assert.match(trackerContents, /missing/);
        assert.match(trackerContents, /2026-04-07-activity-surfaces-premium-finalization-plan\.md/);
    } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('tauri activity-surfaces QA marks an empty proof plan as incomplete instead of greening it', async () => {
    assert.equal(typeof qaModule.runTauriActivitySurfacesQaCapture, 'function');

    const result = await qaModule.runTauriActivitySurfacesQaCapture({
        plan: {
            artifactRoot: '/tmp/activity-surfaces-empty-plan-artifacts',
            trackerPath: '/tmp/activity-surfaces-empty-plan-tracker.md',
            steps: [],
            preflight: { settingsPath: '/settings' },
            manual: [],
        },
        env: { EXISTING: 'value' },
        ensureWorkspaceBuilt: async () => {},
        ensureArtifactDir: async () => {},
        startDriverSessionImpl: async () => ({
            driverSessionPort: 9223,
            resolvedAppIdentifier: 9223,
            driverSessionCommand: 'driver-session-start',
            driverSessionResponseFile: '/tmp/driver-session.json',
            driverSessionStatusCommand: 'driver-session-status',
            driverSessionStatusResponseFile: '/tmp/driver-session-status.json',
        }),
        runCli: async () => ({ stdout: '{"ok":true}' }),
        writeArtifact: async () => {},
        ensureSettingsReady: async () => ({ ok: true, attempts: 1 }),
        seedSession: async () => ({ sessionId: 'sess_seeded_overlay' }),
        hydrateSeededSession: async () => true,
        runOverlayCapture: async () => createCompleteSyntheticQaOverlayCaptureResult(),
        appendStageTrace: async () => {},
    });

    assert.equal(result.ok, false);
    assert.equal(result.blocker, 'missing_required_step_artifacts');
    assert.deepEqual(result.steps, canonicalActivitySurfacesRequiredProofStepIds);
});

test('tauri activity-surfaces QA uses deterministic idle proof seeding instead of stack session creation when idle mode is requested', async () => {
    assert.equal(typeof qaModule.runTauriActivitySurfacesQaCapture, 'function');

    const stageTrace = [];
    let seedCalls = 0;
    let hydrateCalls = 0;
    let overlayCaptureSeedStrategy = null;

    const result = await qaModule.runTauriActivitySurfacesQaCapture({
        plan: {
            artifactRoot: '/tmp/activity-surfaces-artifacts',
            trackerPath: '/tmp/activity-surfaces-tracker.md',
            steps: canonicalActivitySurfacesProofStepIds.map((id) => ({
                id,
                required: canonicalActivitySurfacesRequiredProofStepIds.includes(id),
            })),
            preflight: { settingsPath: '/settings' },
            manual: [],
        },
        env: {
            EXISTING: 'value',
            HAPPIER_TAURI_ACTIVITY_SURFACES_QA_SEED_STRATEGY: 'idle',
        },
        ensureWorkspaceBuilt: async () => {},
        ensureArtifactDir: async () => {},
        startDriverSessionImpl: async () => ({
            driverSessionPort: 9223,
            resolvedAppIdentifier: 9223,
            driverSessionCommand: 'driver-session-start',
            driverSessionResponseFile: '/tmp/driver-session.json',
            driverSessionStatusCommand: 'driver-session-status',
            driverSessionStatusResponseFile: '/tmp/driver-session-status.json',
        }),
        runCli: async () => ({ stdout: '{"ok":true}' }),
        writeArtifact: async () => {},
        ensureSettingsReady: async () => ({ ok: true, attempts: 1 }),
        seedSession: async () => {
            seedCalls += 1;
            return { sessionId: 'sess_seeded_overlay' };
        },
        hydrateSeededSession: async () => {
            hydrateCalls += 1;
            return true;
        },
        runOverlayCapture: async ({ seedStrategy }) => {
            overlayCaptureSeedStrategy = seedStrategy;
            return createCompleteSyntheticQaOverlayCaptureResult();
        },
        appendTracker: async () => {},
        appendStageTrace: async (_artifactRoot, entry) => {
            stageTrace.push(entry);
        },
    });

    assert.equal(result.ok, true);
    assert.equal(seedCalls, 0);
    assert.equal(hydrateCalls, 0);
    assert.equal(overlayCaptureSeedStrategy, 'idle');
    assert.equal(result.seededSession, null);
    assert.equal(result.seededSessionId, null);
    assert.deepEqual(stageTrace.map((entry) => `${entry.stage}:${entry.status}`), [
        'driver_session:start',
        'driver_session:done',
        'backend_state:start',
        'backend_state:done',
        'settings_preflight:start',
        'settings_preflight:done',
        'overlay_capture:start',
        'overlay_capture:done',
        'manual_steps_artifact:start',
        'manual_steps_artifact:done',
        'tracker_evidence:start',
        'tracker_evidence:done',
    ]);
});

test('tauri activity-surfaces QA deduplicates explicitly required overlay card proof steps', async () => {
    assert.equal(typeof qaModule.runTauriActivitySurfacesQaCapture, 'function');

    const result = await qaModule.runTauriActivitySurfacesQaCapture({
        plan: {
            artifactRoot: '/tmp/activity-surfaces-artifacts',
            trackerPath: '/tmp/activity-surfaces-tracker.md',
            steps: canonicalActivitySurfacesProofStepIds.map((id) => ({
                id,
                required: canonicalActivitySurfacesRequiredProofStepIds.includes(id),
            })),
            preflight: { settingsPath: '/settings' },
            manual: [],
        },
        env: {
            EXISTING: 'value',
            HAPPIER_TAURI_ACTIVITY_SURFACES_QA_REQUIRE_STEPS: 'overlay_completion_state',
        },
        ensureWorkspaceBuilt: async () => {},
        ensureArtifactDir: async () => {},
        startDriverSessionImpl: async () => ({
            driverSessionPort: 9223,
            resolvedAppIdentifier: 9223,
            driverSessionCommand: 'driver-session-start',
            driverSessionResponseFile: '/tmp/driver-session.json',
            driverSessionStatusCommand: 'driver-session-status',
            driverSessionStatusResponseFile: '/tmp/driver-session-status.json',
        }),
        runCli: async () => ({ stdout: '{"ok":true}' }),
        writeArtifact: async () => {},
        ensureSettingsReady: async () => ({ ok: true, attempts: 1 }),
        seedSession: async () => ({ sessionId: 'sess_seeded_overlay' }),
        hydrateSeededSession: async () => true,
        runOverlayCapture: async () => createCompleteSyntheticQaOverlayCaptureResult({
            includeCompletionState: true,
        }),
        appendStageTrace: async () => {},
    });

    assert.equal(result.ok, true);
    assert.equal(result.blocker, null);
    assert.deepEqual(result.steps, canonicalActivitySurfacesRequiredProofStepIds);
});

test('tauri activity-surfaces QA exits non-zero when main receives incomplete proof', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriActivitySurfacesMcpQa.mjs');
    const module = await import(pathToFileURL(scriptPath).href);

    assert.equal(typeof module.main, 'function');

    const processApi = { exitCode: 0 };
    const writes = [];
    await module.main([], {
        runCapture: async () => ({
            ok: false,
            blocker: 'missing_required_step_artifacts',
            steps: [],
        }),
        stdout: {
            write: (text) => {
                writes.push(text);
            },
        },
        stderr: {
            write: (text) => {
                writes.push(text);
            },
        },
        processApi,
    });

    assert.equal(processApi.exitCode, 1);
    assert.equal(writes.length > 0, true);
});

test('tauri activity-surfaces QA exits non-zero when the default script path receives an incomplete proof fixture', async () => {
    const scriptsDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(scriptsDir, 'tauriActivitySurfacesMcpQa.mjs');
    const tmpRoot = mkdtempSync(join('/tmp', 'activity-surfaces-default-main-'));

    try {
        try {
            await execFileAsync(process.execPath, [scriptPath], {
                cwd: dirname(dirname(scriptsDir)),
                env: {
                    ...process.env,
                    HAPPIER_TAURI_ACTIVITY_SURFACES_QA_CAPTURE_FIXTURE: 'incomplete-proof',
                    HAPPIER_TAURI_QA_OUTDIR: join(tmpRoot, 'artifacts'),
                    HAPPIER_TAURI_QA_TRACKER_PATH: join(tmpRoot, 'tracker.md'),
                },
                encoding: 'utf8',
                timeout: 3_000,
            });
            assert.fail('expected the default script path to exit non-zero for the incomplete-proof fixture');
        } catch (error) {
            assert.equal(error?.code, 1);
            assert.match(String(error.stdout ?? ''), /"blocker":\s*"missing_required_step_artifacts"/);
            assert.match(String(error.stdout ?? ''), /"ok":\s*false/);
        }
    } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('tauri activity-surfaces QA degrades backend-state MCP error envelopes into warnings so the capture can continue', async () => {
    assert.equal(typeof qaModule.runTauriActivitySurfacesQaCapture, 'function');

    const stageTrace = [];
    const writes = [];
    let overlayCaptureRan = false;

    const result = await qaModule.runTauriActivitySurfacesQaCapture({
        plan: {
            artifactRoot: '/tmp/activity-surfaces-artifacts',
            trackerPath: '/tmp/activity-surfaces-tracker.md',
            steps: minimalActivitySurfacesCaptureStepIds.map((id) => ({ id })),
            preflight: { settingsPath: '/settings' },
            manual: [],
        },
        env: { EXISTING: 'value' },
        ensureWorkspaceBuilt: async () => {},
        ensureArtifactDir: async () => {},
        startDriverSessionImpl: async () => ({
            driverSessionPort: 9223,
            resolvedAppIdentifier: 9223,
            driverSessionCommand: 'driver-session-start',
            driverSessionResponseFile: '/tmp/driver-session.json',
            driverSessionStatusCommand: 'driver-session-status',
            driverSessionStatusResponseFile: '/tmp/driver-session-status.json',
        }),
        runCli: async (args) => {
            assert.deepEqual(args, ['ipc-get-backend-state', '--json', '--app-identifier', '9223']);
            return {
                stdout: JSON.stringify({
                    text: 'Error: Failed to get backend state: Unknown error',
                    markdown: null,
                    structuredContent: null,
                    content: [{ type: 'text', text: 'Error: Failed to get backend state: Unknown error' }],
                    files: [],
                }),
            };
        },
        writeArtifact: async (path, contents) => {
            writes.push({ path, contents });
        },
        ensureSettingsReady: async () => ({ ok: true, attempts: 1 }),
        seedSession: async () => ({ sessionId: 'sess_seeded_overlay' }),
        hydrateSeededSession: async () => true,
        runOverlayCapture: async () => {
            overlayCaptureRan = true;
            return createCompleteSyntheticQaOverlayCaptureResult();
        },
        appendTracker: async () => {},
        appendStageTrace: async (_artifactRoot, entry) => {
            stageTrace.push(entry);
        },
    });

    assert.equal(result.ok, true);

    assert.deepEqual(stageTrace.map((entry) => `${entry.stage}:${entry.status}`), [
        'driver_session:start',
        'driver_session:done',
        'backend_state:start',
        'backend_state:done',
        'settings_preflight:start',
        'settings_preflight:done',
        'seed_overlay_session:start',
        'seed_overlay_session:done',
        'hydrate_seeded_session:start',
        'hydrate_seeded_session:done',
        'overlay_capture:start',
        'overlay_capture:done',
        'manual_steps_artifact:start',
        'manual_steps_artifact:done',
        'tracker_evidence:start',
        'tracker_evidence:done',
    ]);
    assert.equal(overlayCaptureRan, true);
    assert.equal(writes.some((entry) => entry.path.endsWith('/00-backend-state.json')), true);
    assert.equal(
        writes.some((entry) => entry.path.endsWith('/00-backend-state.json') && entry.contents.includes('Failed to get backend state')),
        true,
    );
    assert.equal(writes.some((entry) => entry.path.endsWith('/00-backend-state.diagnostics.json')), true);
});

test('tauri activity-surfaces QA records the failing stage when orchestrated capture aborts mid-flow', async () => {
    assert.equal(typeof qaModule.runTauriActivitySurfacesQaCapture, 'function');

    const stageTrace = [];

    await assert.rejects(
        qaModule.runTauriActivitySurfacesQaCapture({
            plan: {
                artifactRoot: '/tmp/activity-surfaces-artifacts',
                trackerPath: '/tmp/activity-surfaces-tracker.md',
                steps: canonicalActivitySurfacesProofStepIds.map((id) => ({ id })),
                preflight: { settingsPath: '/settings' },
                manual: [],
            },
            env: { EXISTING: 'value' },
            ensureWorkspaceBuilt: async () => {},
            ensureArtifactDir: async () => {},
            startDriverSessionImpl: async () => ({
                driverSessionPort: 9223,
                resolvedAppIdentifier: 9223,
                driverSessionCommand: 'driver-session-start',
                driverSessionResponseFile: '/tmp/driver-session.json',
                driverSessionStatusCommand: 'driver-session-status',
                driverSessionStatusResponseFile: '/tmp/driver-session-status.json',
            }),
            runCli: async () => ({ stdout: '{"ok":true}' }),
            writeArtifact: async () => {},
            ensureSettingsReady: async () => {
                throw new Error('settings blocked');
            },
            seedSession: async () => {
                throw new Error('seed should not run');
            },
            hydrateSeededSession: async () => true,
            runOverlayCapture: async () => ({}),
            appendTracker: async () => {},
            appendStageTrace: async (_artifactRoot, entry) => {
                stageTrace.push(entry);
            },
        }),
        /settings blocked/,
    );

    assert.deepEqual(stageTrace.map((entry) => `${entry.stage}:${entry.status}`), [
        'driver_session:start',
        'driver_session:done',
        'backend_state:start',
        'backend_state:done',
        'settings_preflight:start',
        'settings_preflight:error',
    ]);
});

test('tauri activity-surfaces QA writes structured backend-state diagnostics when the MCP backend-state probe fails', async () => {
    assert.equal(typeof qaModule.runTauriActivitySurfacesQaCapture, 'function');

    const stageTrace = [];
    const writes = [];

    const result = await qaModule.runTauriActivitySurfacesQaCapture({
        plan: {
            artifactRoot: '/tmp/activity-surfaces-artifacts',
            trackerPath: '/tmp/activity-surfaces-tracker.md',
                steps: canonicalActivitySurfacesProofStepIds.map((id) => ({ id })),
            preflight: { settingsPath: '/settings' },
            manual: [],
        },
        env: { EXISTING: 'value' },
        ensureWorkspaceBuilt: async () => {},
        ensureArtifactDir: async () => {},
        startDriverSessionImpl: async () => ({
            driverSessionPort: 9223,
            resolvedAppIdentifier: 9223,
            driverSessionCommand: 'driver-session-start',
            driverSessionResponseFile: '/tmp/driver-session.json',
            driverSessionStatusCommand: 'driver-session-status',
            driverSessionStatusResponseFile: '/tmp/driver-session-status.json',
        }),
        runCli: async (args) => {
            assert.deepEqual(args, ['ipc-get-backend-state', '--json', '--app-identifier', '9223']);
            return {
                stdout: JSON.stringify({
                    text: 'Error: Failed to get backend state: Unknown error',
                    structuredContent: null,
                    content: [
                        {
                            type: 'text',
                            text: 'Error: Failed to get backend state: Unknown error',
                        },
                    ],
                }),
            };
        },
        writeArtifact: async (path, contents) => {
            writes.push({ path, contents });
        },
        ensureSettingsReady: async () => ({ ok: true, attempts: 1 }),
        seedSession: async () => ({ sessionId: 'sess_seeded_overlay' }),
        hydrateSeededSession: async () => true,
        runOverlayCapture: async () => createCompleteSyntheticQaOverlayCaptureResult(),
        appendTracker: async () => {},
        appendStageTrace: async (_artifactRoot, entry) => {
            stageTrace.push(entry);
        },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(stageTrace.map((entry) => `${entry.stage}:${entry.status}`), [
        'driver_session:start',
        'driver_session:done',
        'backend_state:start',
        'backend_state:done',
        'settings_preflight:start',
        'settings_preflight:done',
        'seed_overlay_session:start',
        'seed_overlay_session:done',
        'hydrate_seeded_session:start',
        'hydrate_seeded_session:done',
        'overlay_capture:start',
        'overlay_capture:done',
        'manual_steps_artifact:start',
        'manual_steps_artifact:done',
        'tracker_evidence:start',
        'tracker_evidence:done',
    ]);
    assert.equal(writes.some((entry) => entry.path.endsWith('/00-backend-state.json')), true);
    assert.equal(
        writes.some((entry) =>
            entry.path.endsWith('/00-backend-state.json')
            && entry.contents.includes('Failed to get backend state')),
        true,
    );
    assert.equal(writes.some((entry) => entry.path.endsWith('/00-backend-state.diagnostics.json') && entry.contents.includes('Failed to get backend state')), true);
});

test('tauri activity-surfaces backend-state retries classify opaque failures as proof-channel disconnects when a follow-up probe hits the plugin reconnect error', async () => {
    assert.equal(typeof qaModule.readActivitySurfacesBackendStateWithRetries, 'function');

    const result = await qaModule.readActivitySurfacesBackendStateWithRetries({
        appIdentifier: 'com.happier.stack.activity-surfaces-qa',
        env: { EXISTING: 'value' },
        attempts: 1,
        runCli: async () => ({
            stdout: JSON.stringify({
                text: 'Error: Failed to get backend state: Unknown error',
                markdown: null,
                structuredContent: null,
                content: [{ type: 'text', text: 'Error: Failed to get backend state: Unknown error' }],
                files: [],
            }),
        }),
        probeProofChannel: async () => {
            throw new Error('WebView execution failed: Not connected to plugin and reconnection failed');
        },
    });

    assert.equal(result.ok, false);
    assert.match(String(result.error), /Failed to get backend state/u);
    assert.equal(result.blocker, 'proof_channel_disconnect');
});

test('tauri activity-surfaces backend-state proof probe keeps the raw MCP transport but still targets the active driver-session port for disconnect classification', async () => {
    assert.equal(typeof qaModule.readActivitySurfacesBackendStateWithRetries, 'function');

    const rawProbeCalls = [];
    const result = await qaModule.readActivitySurfacesBackendStateWithRetries({
        appIdentifier: 'com.happier.stack.activity-surfaces-qa',
        env: { EXISTING: 'value' },
        driverSession: {
            driverSessionPort: 9225,
            resolvedAppIdentifier: 'com.happier.stack.activity-surfaces-qa',
        },
        attempts: 1,
        runCli: async () => ({
            stdout: JSON.stringify({
                text: 'Error: Failed to get backend state: Unknown error',
                markdown: null,
                structuredContent: null,
                content: [{ type: 'text', text: 'Error: Failed to get backend state: Unknown error' }],
                files: [],
            }),
        }),
        runProbeCli: async (args, options) => {
            rawProbeCalls.push({ args, options });
            return {
                stdout: JSON.stringify({
                    text: 'Error: JavaScript execution failed: WebView execution failed: Not connected to plugin and reconnection failed',
                    markdown: null,
                    structuredContent: null,
                    content: [{ type: 'text', text: 'Error: JavaScript execution failed: WebView execution failed: Not connected to plugin and reconnection failed' }],
                    files: [],
                }),
            };
        },
    });

    assert.equal(result.ok, false);
    assert.equal(result.blocker, 'proof_channel_disconnect');
    assert.deepEqual(rawProbeCalls, [{
        args: [
            'webview-execute-js',
            '--script',
            '(() => true)()',
            '--app-identifier',
            'com.happier.stack.activity-surfaces-qa',
            '--json',
        ],
        options: {
            appIdentifier: 'com.happier.stack.activity-surfaces-qa',
            env: {
                EXISTING: 'value',
                HAPPIER_TAURI_MCP_PORT: '9225',
            },
            timeoutMs: 2_000,
        },
    }]);
});

test('tauri activity-surfaces backend-state retries once after a proof-channel disconnect by force-restarting the driver session', async () => {
    assert.equal(typeof qaModule.readActivitySurfacesBackendStateWithRetries, 'function');

    const runCliCalls = [];
    const recoverCalls = [];
    let recovered = false;

    const result = await qaModule.readActivitySurfacesBackendStateWithRetries({
        appIdentifier: 'com.happier.stack.activity-surfaces-qa',
        env: { EXISTING: 'value' },
        driverSession: {
            driverSessionPort: 9225,
            resolvedAppIdentifier: 'com.happier.stack.activity-surfaces-qa',
        },
        attempts: 1,
        runCli: async (args, options) => {
            runCliCalls.push({ args, options, recovered });
            if (!recovered) {
                return {
                    stdout: JSON.stringify({
                        text: 'Error: Failed to get backend state: Unknown error',
                        markdown: null,
                        structuredContent: null,
                        content: [{ type: 'text', text: 'Error: Failed to get backend state: Unknown error' }],
                        files: [],
                    }),
                };
            }
            return { stdout: '{"ok":true,"source":"after-restart"}' };
        },
        runProbeCli: async () => ({
            stdout: JSON.stringify({
                text: 'Error: JavaScript execution failed: WebView execution failed: Not connected to plugin and reconnection failed',
                markdown: null,
                structuredContent: null,
                content: [{ type: 'text', text: 'Error: JavaScript execution failed: WebView execution failed: Not connected to plugin and reconnection failed' }],
                files: [],
            }),
        }),
        recoverDriverSession: async (driverSession, options) => {
            recoverCalls.push({ driverSession, options });
            recovered = true;
            return {
                restarted: true,
                resolvedAppIdentifier: 'com.happier.stack.activity-surfaces-qa',
            };
        },
    });

    assert.deepEqual(result, {
        ok: true,
        response: { stdout: '{"ok":true,"source":"after-restart"}' },
        error: null,
        recoveredDriverSession: true,
    });
    assert.equal(recoverCalls.length, 1);
    assert.equal(recoverCalls[0].options?.forceRestart, true);
    assert.equal(runCliCalls.length, 2);
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
    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'navigate'),
        [],
    );
});

test('tauri activity-surfaces QA dismisses the setup wizard modal before confirming the dedicated desktop app settings page', async () => {
    assert.equal(typeof qaModule.openActivitySurfacesDesktopAppSettingsPage, 'function');

    const calls = [];
    let setupWizardVisible = true;
    let desktopPageVisible = false;

    const result = await qaModule.openActivitySurfacesDesktopAppSettingsPage({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        navigateWebview: async (pathname) => {
            calls.push(['navigate', pathname]);
        },
        click: async (selector) => {
            calls.push(['click', selector]);
            if (selector === '[data-testid="setupWizard.surface-skip"]') {
                setupWizardVisible = false;
                desktopPageVisible = true;
            }
        },
        isSelectorVisible: async (selector) => {
            calls.push(['visible', selector, setupWizardVisible, desktopPageVisible]);
            if (selector === '[data-testid="setupWizard.surface-skip"]') {
                return setupWizardVisible;
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
    assert.equal(
        calls.some((entry) => entry[0] === 'click' && entry[1] === '[data-testid="setupWizard.surface-skip"]'),
        true,
    );
});

test('tauri activity-surfaces QA restarts from the crash recovery screen before opening the dedicated desktop app settings page', async () => {
    assert.equal(typeof qaModule.openActivitySurfacesDesktopAppSettingsPage, 'function');

    const calls = [];
    let crashVisible = true;
    let desktopPageVisible = false;
    let snapshotCount = 0;

    const result = await qaModule.openActivitySurfacesDesktopAppSettingsPage({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateWebview: async (pathname) => {
            calls.push(['navigate', pathname]);
            desktopPageVisible = pathname === '/settings/desktop';
        },
        click: async (selector) => {
            calls.push(['click', selector]);
            if (selector === '[data-testid="app-crash-restart"]') {
                crashVisible = false;
            }
            if (selector === '[data-testid="settings-desktop-entry"]') {
                desktopPageVisible = true;
            }
        },
        captureSnapshot: async (options) => {
            snapshotCount += 1;
            calls.push(['snapshot', options?.label ?? null]);
        },
        isSelectorVisible: async (selector) => {
            calls.push(['visible', selector]);
            if (selector === '[data-testid="app-crash-restart"]') {
                return crashVisible;
            }
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
    assert.equal(
        calls.some((entry) => entry[0] === 'click' && entry[1] === '[data-testid="app-crash-restart"]'),
        true,
    );
    assert.equal(snapshotCount, 1);
    assert.equal(
        calls.some((entry) => entry[0] === 'snapshot' && String(entry[1]).startsWith('desktop-settings-crash.')),
        true,
    );
});

test('tauri activity-surfaces QA prefers the real settings tab and desktop entry before mutating settings routes directly', async () => {
    assert.equal(typeof qaModule.openActivitySurfacesDesktopAppSettingsPage, 'function');

    const calls = [];
    let settingsTabOpened = false;
    let desktopPageVisible = false;

    const result = await qaModule.openActivitySurfacesDesktopAppSettingsPage({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        navigateWebview: async (pathname) => {
            calls.push(['navigate', pathname]);
        },
        click: async (selector) => {
            calls.push(['click', selector]);
            if (selector === '[data-testid="tabbar-tab-settings"]') {
                settingsTabOpened = true;
                return;
            }
            if (selector === '[data-testid="settings-desktop-entry"]') {
                desktopPageVisible = true;
            }
        },
        isSelectorVisible: async (selector) => {
            calls.push(['visible', selector, settingsTabOpened, desktopPageVisible]);
            if (selector === '[data-testid="settings-desktop-overlay-enabled"]') {
                return desktopPageVisible;
            }
            if (selector === '[data-testid="tabbar-tab-settings"]') {
                return true;
            }
            if (selector === '[data-testid="settings-desktop-entry"]') {
                return settingsTabOpened;
            }
            return false;
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
    });

    assert.equal(result, true);
    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'click'),
        [
            ['click', '[data-testid="tabbar-tab-settings"]'],
            ['click', '[data-testid="settings-desktop-entry"]'],
        ],
    );
    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'navigate'),
        [],
    );
});

test('tauri activity-surfaces QA force-reloads /settings/desktop as a last resort when the real settings shell is available but the desktop entry never appears', async () => {
    assert.equal(typeof qaModule.openActivitySurfacesDesktopAppSettingsPage, 'function');

    const calls = [];
    let settingsTabOpened = false;
    let desktopPageVisible = false;

    const result = await qaModule.openActivitySurfacesDesktopAppSettingsPage({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        navigateWebview: async (pathname, options) => {
            calls.push(['navigate', pathname, options?.forceReload === true]);
            if (pathname === '/settings/desktop') {
                desktopPageVisible = true;
            }
        },
        click: async (selector) => {
            calls.push(['click', selector]);
            if (selector === '[data-testid="tabbar-tab-settings"]') {
                settingsTabOpened = true;
            }
        },
        isSelectorVisibleByDomQuery: async () => false,
        probeRootState: async () => null,
        isSelectorVisible: async (selector) => {
            calls.push(['visible', selector, settingsTabOpened, desktopPageVisible]);
            if (selector === '[data-testid="tabbar-tab-settings"]') {
                return true;
            }
            if (selector === '[data-testid="settings-desktop-entry"]') {
                return false;
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
    assert.equal(
        calls.some((entry) => entry[0] === 'click' && entry[1] === '[data-testid="tabbar-tab-settings"]'),
        true,
    );
    assert.equal(
        calls.some((entry) => entry[0] === 'navigate' && entry[1] === '/settings/desktop' && entry[2] === true),
        true,
    );
});

test('tauri activity-surfaces QA fails closed when the real settings shell is available but the desktop entry never appears', async () => {
    assert.equal(typeof qaModule.openActivitySurfacesDesktopAppSettingsPage, 'function');

    const calls = [];

    const result = await qaModule.openActivitySurfacesDesktopAppSettingsPage({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        navigateWebview: async (pathname, options) => {
            calls.push(['navigate', pathname, options?.forceReload === true]);
        },
        click: async (selector) => {
            calls.push(['click', selector]);
        },
        isSelectorVisibleByDomQuery: async () => false,
        probeRootState: async () => null,
        isSelectorVisible: async (selector) => {
            calls.push(['visible', selector]);
            if (selector === '[data-testid="tabbar-tab-settings"]') {
                return true;
            }
            return false;
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
    });

    assert.equal(result, false);
    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'click'),
        [['click', '[data-testid="tabbar-tab-settings"]']],
    );
    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'navigate'),
        [['navigate', '/settings/desktop', true]],
    );
});

test('tauri activity-surfaces QA falls back to the settings index before opening the dedicated desktop app settings page', async () => {
    assert.equal(typeof qaModule.openActivitySurfacesDesktopAppSettingsPage, 'function');

    const calls = [];
    let currentPath = '/';
    let desktopPageVisible = false;

    const result = await qaModule.openActivitySurfacesDesktopAppSettingsPage({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        navigateWebview: async (pathname) => {
            calls.push(['navigate', pathname]);
            currentPath = pathname;
        },
        click: async (selector) => {
            calls.push(['click', selector]);
            if (selector === '[data-testid="settings-desktop-entry"]') {
                desktopPageVisible = true;
            }
        },
        isSelectorVisible: async (selector) => {
            calls.push(['visible', selector, currentPath]);
            if (selector === '[data-testid="settings-desktop-overlay-enabled"]') {
                return desktopPageVisible;
            }
            if (selector === '[data-testid="settings-desktop-entry"]') {
                return currentPath === '/settings';
            }
            return false;
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
    });

    assert.equal(result, true);
    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'navigate'),
        [['navigate', '/settings/desktop'], ['navigate', '/settings']],
    );
    assert.equal(calls.some((entry) => entry[0] === 'click' && entry[1] === '[data-testid="settings-desktop-entry"]'), true);
});

test('tauri activity-surfaces QA retries the settings-index desktop entry after force-reloading /settings', async () => {
    assert.equal(typeof qaModule.openActivitySurfacesDesktopAppSettingsPage, 'function');

    const calls = [];
    let currentPath = '/';
    let desktopEntryProbeCount = 0;
    let desktopPageVisible = false;

    const result = await qaModule.openActivitySurfacesDesktopAppSettingsPage({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        navigateWebview: async (pathname, options) => {
            calls.push(['navigate', pathname, options?.forceReload === true]);
            currentPath = pathname;
        },
        click: async (selector) => {
            calls.push(['click', selector]);
            if (selector === '[data-testid="settings-desktop-entry"]') {
                desktopPageVisible = true;
            }
        },
        isSelectorVisibleByDomQuery: async () => false,
        isSelectorVisible: async (selector) => {
            calls.push(['visible', selector, currentPath]);
            if (selector === '[data-testid="settings-desktop-overlay-enabled"]') {
                return desktopPageVisible;
            }
            if (selector === '[data-testid="settings-desktop-entry"]' && currentPath === '/settings') {
                desktopEntryProbeCount += 1;
                return desktopEntryProbeCount >= 3;
            }
            return false;
        },
        probeRootState: async () => null,
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
    });

    assert.equal(result, true);
    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'navigate'),
        [['navigate', '/settings/desktop', false], ['navigate', '/settings', false]],
    );
    assert.equal(
        calls.filter((entry) => entry[0] === 'visible' && entry[1] === '[data-testid="settings-desktop-entry"]' && entry[2] === '/settings').length >= 2,
        true,
    );
    assert.equal(calls.some((entry) => entry[0] === 'click' && entry[1] === '[data-testid="settings-desktop-entry"]'), true);
});

test('tauri activity-surfaces QA avoids force-reloading direct settings fallback navigation before giving up on the desktop settings page', async () => {
    assert.equal(typeof qaModule.openActivitySurfacesDesktopAppSettingsPage, 'function');

    const navigateCalls = [];

    const result = await qaModule.openActivitySurfacesDesktopAppSettingsPage({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        navigateWebview: async (pathname, options) => {
            navigateCalls.push({ pathname, options });
        },
        click: async () => {},
        isSelectorVisible: async () => false,
        wait: async () => {},
    });

    assert.equal(result, false);
    assert.deepEqual(navigateCalls, [
        { pathname: '/settings/desktop', options: { appIdentifier: 9223, env: { EXISTING: 'value' }, driverSession: { driverSessionPort: 9223 }, windowId: 'main', forceReload: false } },
        { pathname: '/settings', options: { appIdentifier: 9223, env: { EXISTING: 'value' }, driverSession: { driverSessionPort: 9223 }, windowId: 'main', forceReload: false } },
    ]);
});

test('tauri activity-surfaces QA writes root-state diagnostics when it cannot confirm the desktop settings page', async () => {
    assert.equal(typeof qaModule.openActivitySurfacesDesktopAppSettingsPage, 'function');

    const warnings = [];
    const artifacts = [];

    const result = await qaModule.openActivitySurfacesDesktopAppSettingsPage({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        driverSession: { driverSessionPort: 9223 },
        navigateWebview: async () => {},
        click: async () => {},
        isSelectorVisible: async () => false,
        isSelectorVisibleByDomQuery: async () => false,
        probeRootState: async () => ({ pathname: '/settings', visibleTestIds: [], rootText: '' }),
        appendWarning: async (_artifactRoot, text) => {
            warnings.push(text);
        },
        writeArtifact: async (filePath, contents) => {
            artifacts.push({ filePath, contents });
        },
        wait: async () => {},
    });

    assert.equal(result, false);
    assert.equal(warnings.some((text) => String(text).includes('unable to confirm the dedicated desktop app settings page')), true);
    assert.equal(
        artifacts.some((entry) => String(entry.filePath).includes('99-desktop-settings-open.root-state.json')),
        true,
    );
    assert.equal(
        artifacts.some((entry) => String(entry.filePath).includes('99-desktop-settings-open.structure.txt')),
        true,
    );

    const selectorProbeArtifact = artifacts.find((entry) => String(entry.filePath).includes('99-desktop-settings-open.selector-probes.json'));
    assert.equal(Boolean(selectorProbeArtifact), true);
    const selectorProbePayload = JSON.parse(selectorProbeArtifact.contents);
    assert.equal(selectorProbePayload.ok, false);
    assert.equal(selectorProbePayload.rootState.pathname, '/settings');
    assert.equal(Array.isArray(selectorProbePayload.selectorProbes), true);
    assert.equal(
        selectorProbePayload.selectorProbes.some(
            (entry) => entry.kind === 'selector' && entry.selector === '[data-testid="settings-desktop-overlay-enabled"]',
        ),
        true,
    );
    assert.equal(
        selectorProbePayload.selectorProbes.some(
            (entry) => entry.kind === 'root-state' && entry.context === 'desktop-entry',
        ),
        true,
    );
});

test('tauri activity-surfaces QA retries the desktop entry briefly after direct settings fallback navigation', async () => {
    assert.equal(typeof qaModule.openActivitySurfacesDesktopAppSettingsPage, 'function');

    const calls = [];
    let currentPath = '/';
    let desktopEntryProbeCount = 0;
    let desktopPageVisible = false;

    const result = await qaModule.openActivitySurfacesDesktopAppSettingsPage({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        navigateWebview: async (pathname, options) => {
            calls.push(['navigate', pathname, options?.forceReload === true]);
            currentPath = pathname;
        },
        click: async (selector) => {
            calls.push(['click', selector]);
            if (selector === '[data-testid="settings-desktop-entry"]') {
                desktopPageVisible = true;
            }
        },
        isSelectorVisible: async (selector) => {
            calls.push(['visible', selector, currentPath]);
            if (selector === '[data-testid="settings-desktop-overlay-enabled"]') {
                return desktopPageVisible;
            }
            if (selector === '[data-testid="settings-desktop-entry"]' && currentPath === '/settings') {
                desktopEntryProbeCount += 1;
                return desktopEntryProbeCount >= 2;
            }
            return false;
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
    });

    assert.equal(result, true);
    assert.equal(desktopEntryProbeCount >= 2, true);
    assert.equal(calls.some((entry) => entry[0] === 'click' && entry[1] === '[data-testid="settings-desktop-entry"]'), true);
});

test('tauri activity-surfaces QA reuses the full desktop-page confirmation after opening the desktop entry from the settings index', async () => {
    assert.equal(typeof qaModule.openActivitySurfacesDesktopAppSettingsPage, 'function');

    const calls = [];
    let currentPath = '/';
    let desktopEntryClicked = false;

    const result = await qaModule.openActivitySurfacesDesktopAppSettingsPage({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        navigateWebview: async (pathname) => {
            calls.push(['navigate', pathname]);
            currentPath = pathname;
        },
        click: async (selector) => {
            calls.push(['click', selector]);
            if (selector === '[data-testid="settings-desktop-entry"]') {
                desktopEntryClicked = true;
            }
        },
        isSelectorVisible: async (selector) => {
            calls.push(['visible', selector, currentPath, desktopEntryClicked]);
            if (selector === '[data-testid="settings-desktop-entry"]') {
                return currentPath === '/settings';
            }
            return false;
        },
        probeRootState: async () => {
            if (!desktopEntryClicked) {
                return null;
            }
            return {
                pathname: '/settings/desktop',
                visibleTestIds: ['settings-desktop-autostart-enabled'],
            };
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
    });

    assert.equal(result, true);
    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'navigate'),
        [['navigate', '/settings/desktop'], ['navigate', '/settings']],
    );
    assert.equal(calls.some((entry) => entry[0] === 'click' && entry[1] === '[data-testid="settings-desktop-entry"]'), true);
});

test('tauri activity-surfaces QA retries the dedicated desktop app settings page probe when the page appears after a short delay', async () => {
    assert.equal(typeof qaModule.openActivitySurfacesDesktopAppSettingsPage, 'function');

    const calls = [];
    let desktopProbeCount = 0;

    const result = await qaModule.openActivitySurfacesDesktopAppSettingsPage({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        navigateWebview: async (pathname) => {
            calls.push(['navigate', pathname]);
        },
        click: async (selector) => {
            calls.push(['click', selector]);
        },
        isSelectorVisible: async (selector) => {
            calls.push(['visible', selector]);
            if (selector === '[data-testid="settings-desktop-overlay-enabled"]') {
                desktopProbeCount += 1;
                return desktopProbeCount >= 3;
            }
            return false;
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
    });

    assert.equal(result, true);
    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'navigate'),
        [['navigate', '/settings/desktop']],
    );
    assert.equal(
        calls.filter((entry) => entry[0] === 'visible' && entry[1] === '[data-testid="settings-desktop-overlay-enabled"]').length >= 3,
        true,
    );
});

test('tauri activity-surfaces QA treats the desktop route as confirmed when the page is already on /settings/desktop even if the selector stays hidden', async () => {
    assert.equal(typeof qaModule.openActivitySurfacesDesktopAppSettingsPage, 'function');

    const calls = [];

    const result = await qaModule.openActivitySurfacesDesktopAppSettingsPage({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        navigateWebview: async (pathname) => {
            calls.push(['navigate', pathname]);
        },
        click: async (selector) => {
            calls.push(['click', selector]);
        },
        isSelectorVisible: async (selector) => {
            calls.push(['visible', selector]);
            return false;
        },
        probeRootState: async () => {
            return {
                pathname: '/settings/desktop',
                visibleTestIds: [],
            };
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
    });

    assert.equal(result, true);
    assert.deepEqual(
        calls.filter((entry) => entry[0] === 'navigate'),
        [['navigate', '/settings/desktop']],
    );
    assert.equal(
        calls.some((entry) => entry[0] === 'navigate' && entry[1] === '/settings'),
        false,
    );
    assert.equal(
        calls.some((entry) => entry[0] === 'click'),
        false,
    );
});

test('tauri activity-surfaces QA accepts the dedicated desktop app settings page when root-state probing finds another desktop settings row', async () => {
    assert.equal(typeof qaModule.openActivitySurfacesDesktopAppSettingsPage, 'function');

    const calls = [];

    const result = await qaModule.openActivitySurfacesDesktopAppSettingsPage({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        navigateWebview: async (pathname) => {
            calls.push(['navigate', pathname]);
        },
        click: async (selector) => {
            calls.push(['click', selector]);
        },
        isSelectorVisible: async (selector) => {
            calls.push(['visible', selector]);
            return false;
        },
        probeRootState: async () => ({
            pathname: '/settings/desktop',
            visibleTestIds: ['settings-desktop-autostart-enabled'],
        }),
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
    });

    assert.equal(result, true);
    assert.equal(calls.some((entry) => entry[0] === 'click'), false);
    assert.equal(calls.some((entry) => entry[0] === 'visible' && entry[1] === '[data-testid="settings-desktop-overlay-enabled"]'), true);
});

test('tauri activity-surfaces QA can open the desktop settings entry when root-state sees it even if selector visibility probing misses it', async () => {
    assert.equal(typeof qaModule.openActivitySurfacesDesktopAppSettingsPage, 'function');

    const calls = [];
    let desktopEntryClicked = false;

    const result = await qaModule.openActivitySurfacesDesktopAppSettingsPage({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        navigateWebview: async (pathname) => {
            calls.push(['navigate', pathname]);
        },
        click: async (selector) => {
            calls.push(['click', selector]);
            if (selector === '[data-testid="settings-desktop-entry"]') {
                desktopEntryClicked = true;
            }
        },
        isSelectorVisible: async (selector) => {
            calls.push(['visible', selector]);
            return selector === '[data-testid="settings-desktop-overlay-enabled"]' ? false : false;
        },
        probeRootState: async () => {
            if (!desktopEntryClicked) {
                return {
                    pathname: '/settings',
                    visibleTestIds: ['settings-desktop-entry'],
                };
            }
            return {
                pathname: '/settings/desktop',
                visibleTestIds: ['settings-desktop-autostart-enabled'],
            };
        },
        wait: async (ms) => {
            calls.push(['delay', ms]);
        },
    });

    assert.equal(result, true);
    assert.equal(calls.some((entry) => entry[0] === 'click' && entry[1] === '[data-testid="settings-desktop-entry"]'), true);
});

test('tauri activity-surfaces QA retries the desktop settings page probe after a transient plugin disconnect', async () => {
    assert.equal(typeof qaModule.openActivitySurfacesDesktopAppSettingsPage, 'function');

    let attempt = 0;
    let sawThrowOnTransientDisconnect = false;
    const result = await qaModule.openActivitySurfacesDesktopAppSettingsPage({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        isSelectorVisible: async (_selector, options) => {
            attempt += 1;
            sawThrowOnTransientDisconnect = sawThrowOnTransientDisconnect || options?.throwOnTransientDisconnect === true;
            if (attempt === 1) {
                if (options?.throwOnTransientDisconnect === true) {
                    throw new Error('WebView execution failed: Not connected to plugin and reconnection failed');
                }
                return false;
            }
            return true;
        },
        probeRootState: async () => null,
        wait: async () => {},
    });

    assert.equal(result, true);
    assert.equal(attempt >= 2, true);
    assert.equal(sawThrowOnTransientDisconnect, true);
});

test('tauri activity-surfaces QA falls back to a direct DOM query when selector waiting misses the desktop settings page', async () => {
    assert.equal(typeof qaModule.openActivitySurfacesDesktopAppSettingsPage, 'function');

    const domQueryCalls = [];
    const result = await qaModule.openActivitySurfacesDesktopAppSettingsPage({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        driverSession: { driverSessionPort: 9223 },
        isSelectorVisible: async () => false,
        isSelectorVisibleByDomQuery: async (selector, options) => {
            domQueryCalls.push({ selector, timeoutMs: options?.timeoutMs ?? null });
            return selector === '[data-testid="settings-desktop-overlay-enabled"]';
        },
        probeRootState: async () => null,
        wait: async () => {},
    });

    assert.equal(result, true);
    assert.deepEqual(domQueryCalls, [
        {
            selector: '[data-testid="setupWizard.surface-skip"]',
            timeoutMs: 1_200,
        },
        {
            selector: '[data-testid="settings-desktop-overlay-enabled"]',
            timeoutMs: 1_200,
        },
    ]);
});

test('tauri activity-surfaces QA retries backend-state MCP error envelopes before succeeding', async () => {
    assert.equal(typeof qaModule.readActivitySurfacesBackendStateWithRetries, 'function');

    const calls = [];
    let attempts = 0;
    const result = await qaModule.readActivitySurfacesBackendStateWithRetries({
        appIdentifier: 9224,
        env: { EXISTING: 'value' },
        attempts: 3,
        delayMs: 0,
        runCli: async (args, options) => {
            calls.push({ args, options });
            attempts += 1;
            if (attempts < 3) {
                return {
                    stdout: '{"text":"Error: Failed to get backend state: Unknown error"}',
                };
            }
            return { stdout: '{"ok":true}' };
        },
    });

    assert.deepEqual(result, {
        ok: true,
        response: { stdout: '{"ok":true}' },
        error: null,
    });
    assert.deepEqual(calls.map((entry) => entry.args), [
        ['ipc-get-backend-state', '--json', '--app-identifier', '9224'],
        ['ipc-get-backend-state', '--json', '--app-identifier', '9224'],
        ['ipc-get-backend-state', '--json', '--app-identifier', '9224'],
    ]);
});

test('tauri activity-surfaces QA marks exhausted transient backend-state probes as a proof-channel disconnect', async () => {
    assert.equal(typeof qaModule.readActivitySurfacesBackendStateWithRetries, 'function');

    const result = await qaModule.readActivitySurfacesBackendStateWithRetries({
        appIdentifier: 9224,
        env: { EXISTING: 'value' },
        attempts: 2,
        delayMs: 0,
        runCli: async () => {
            throw new Error('WebView execution failed: Not connected to plugin and reconnection failed');
        },
        wait: async () => {},
    });

    assert.deepEqual(result, {
        ok: false,
        blocker: 'proof_channel_disconnect',
        response: null,
        error: 'WebView execution failed: Not connected to plugin and reconnection failed',
    });
});

test('tauri activity-surfaces QA records backend-state failure when MCP only returns an error envelope', async () => {
    assert.equal(typeof qaModule.runTauriActivitySurfacesQaCapture, 'function');

    const stageTrace = [];
    const writes = [];

    const result = await qaModule.runTauriActivitySurfacesQaCapture({
        plan: {
            artifactRoot: '/tmp/activity-surfaces-artifacts',
            trackerPath: '/tmp/activity-surfaces-tracker.md',
            steps: minimalActivitySurfacesCaptureStepIds.map((id) => ({ id })),
            preflight: { settingsPath: '/settings' },
            manual: [],
        },
        env: { EXISTING: 'value' },
        ensureWorkspaceBuilt: async () => {},
        ensureArtifactDir: async () => {},
        startDriverSessionImpl: async () => ({
            driverSessionPort: 9223,
            resolvedAppIdentifier: 9223,
            driverSessionCommand: 'driver-session-start',
            driverSessionResponseFile: '/tmp/driver-session.json',
            driverSessionStatusCommand: 'driver-session-status',
            driverSessionStatusResponseFile: '/tmp/driver-session-status.json',
        }),
        runCli: async (args) => {
            assert.deepEqual(args, ['ipc-get-backend-state', '--json', '--app-identifier', '9223']);
            return { stdout: '{"text":"Error: Failed to get backend state: Unknown error"}' };
        },
        writeArtifact: async (path, contents) => {
            writes.push({ path, contents });
        },
        ensureSettingsReady: async () => ({ ok: true, attempts: 1 }),
        seedSession: async () => ({ sessionId: 'sess_seeded_overlay' }),
        hydrateSeededSession: async () => true,
        runOverlayCapture: async () => createCompleteSyntheticQaOverlayCaptureResult(),
        appendTracker: async () => {},
        appendStageTrace: async (_artifactRoot, entry) => {
            stageTrace.push(entry);
        },
    });

    assert.equal(result.ok, true);
    const backendDoneEntry = stageTrace.find((entry) => entry.stage === 'backend_state' && entry.status === 'done');
    assert.equal(backendDoneEntry?.backendStateOk, false);
    assert.equal(
        writes.some((entry) =>
            entry.path.endsWith('/00-backend-state.json')
            && entry.contents.includes('Failed to get backend state'),
        ),
        true,
    );
    assert.equal(writes.some((entry) => entry.path.endsWith('/00-backend-state.diagnostics.json')), true);
    assert.equal(stageTrace.some((entry) => entry.stage === 'settings_preflight'), true);
});

test('tauri activity-surfaces QA still enters settings preflight after degraded backend-state capture', async () => {
    assert.equal(typeof qaModule.runTauriActivitySurfacesQaCapture, 'function');

    const stageTrace = [];
    let settingsPreflightRan = false;

    const result = await qaModule.runTauriActivitySurfacesQaCapture({
        plan: {
            artifactRoot: '/tmp/activity-surfaces-artifacts',
            trackerPath: '/tmp/activity-surfaces-tracker.md',
            steps: minimalActivitySurfacesCaptureStepIds.map((id) => ({ id })),
            preflight: { settingsPath: '/settings' },
            manual: [],
        },
        env: { EXISTING: 'value' },
        ensureWorkspaceBuilt: async () => {},
        ensureArtifactDir: async () => {},
        startDriverSessionImpl: async () => ({
            driverSessionPort: 9223,
            resolvedAppIdentifier: 9223,
            driverSessionCommand: 'driver-session-start',
            driverSessionResponseFile: '/tmp/driver-session.json',
            driverSessionStatusCommand: 'driver-session-status',
            driverSessionStatusResponseFile: '/tmp/driver-session-status.json',
        }),
        runCli: async () => ({
            stdout: '{"text":"Error: Failed to get backend state: Unknown error"}',
        }),
        writeArtifact: async () => {},
        ensureSettingsReady: async () => {
            settingsPreflightRan = true;
            return { ok: true, attempts: 1 };
        },
        seedSession: async () => ({ sessionId: 'sess_seeded_overlay' }),
        hydrateSeededSession: async () => true,
        runOverlayCapture: async () => createCompleteSyntheticQaOverlayCaptureResult(),
        appendTracker: async () => {},
        appendStageTrace: async (_artifactRoot, entry) => {
            stageTrace.push(entry);
        },
    });

    assert.equal(result.ok, true);
    assert.equal(settingsPreflightRan, true);
    assert.equal(stageTrace.some((entry) => entry.stage === 'settings_preflight' && entry.status === 'done'), true);
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

test('tauri activity-surfaces QA confirms selector waits against the DOM before selecting a snapshot scope', async () => {
    assert.equal(typeof qaModule.resolveActivitySurfacesStepSnapshotSelector, 'function');

    const domQueries = [];
    const selector = await qaModule.resolveActivitySurfacesStepSnapshotSelector(
        {
            id: 'overlay_route',
            windowId: 'activity_overlay',
            selectors: [
                '[data-testid="desktop-activity-overlay-expanded"]',
                '[data-testid="desktop-activity-overlay-collapsed"]',
            ],
        },
        {
            appIdentifier: 9223,
            env: {},
            driverSession: { driverSessionPort: 9223 },
            runCli: async () => ({ stdout: '' }),
            isSelectorVisibleByDomQuery: async (candidate, options) => {
                domQueries.push({ candidate, options });
                return candidate === '[data-testid="desktop-activity-overlay-collapsed"]';
            },
        },
    );

    assert.equal(selector, '[data-testid="desktop-activity-overlay-collapsed"]');
    assert.deepEqual(
        domQueries.map((entry) => [entry.candidate, entry.options.windowId]),
        [
            ['[data-testid="desktop-activity-overlay-expanded"]', 'activity_overlay'],
            ['[data-testid="desktop-activity-overlay-collapsed"]', 'activity_overlay'],
        ],
    );
});

test('tauri activity-surfaces QA uses root-state visible test ids when DOM-query selector confirmation is transiently unavailable', async () => {
    assert.equal(typeof qaModule.resolveActivitySurfacesStepSnapshotSelector, 'function');

    const selector = await qaModule.resolveActivitySurfacesStepSnapshotSelector(
        {
            id: 'overlay_route',
            windowId: 'activity_overlay',
            selectors: [
                '[data-testid="desktop-activity-overlay-collapsed"]',
            ],
        },
        {
            appIdentifier: 9223,
            env: {},
            driverSession: { driverSessionPort: 9223 },
            runCli: async () => ({ stdout: '' }),
            isSelectorVisibleByDomQuery: async () => false,
            probeRootState: async (options) => ({
                pathname: '/desktop/activity-overlay',
                probeWindowId: options.windowId,
                visibleTestIds: [
                    'desktop-activity-overlay-diagnostics',
                    'desktop-activity-overlay-collapsed',
                ],
            }),
        },
    );

    assert.equal(selector, '[data-testid="desktop-activity-overlay-collapsed"]');
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

test('tauri activity-surfaces QA records aria-api accessibility snapshot failures without aborting the capture step', async () => {
    assert.equal(typeof qaModule.captureSnapshotArtifacts, 'function');

    const writes = [];
    const result = await qaModule.captureSnapshotArtifacts({
        screenshotPath: '/tmp/settings.png',
        structurePath: '/tmp/settings.structure.yml',
        a11yPath: '/tmp/settings.a11y.yml',
        label: 'overlay_route',
        appIdentifier: 9223,
        runCli: async (args) => {
            if (args[0] === 'webview-screenshot') {
                return { stdout: 'screenshot-ok' };
            }
            if (args[0] === 'webview-dom-snapshot' && args[2] === 'structure') {
                return { stdout: 'structure-ok' };
            }
            throw new Error('WebView execution failed: aria-api library not loaded');
        },
        writeArtifact: async (path, text) => {
            writes.push({ path, text });
        },
    });

    assert.deepEqual(result, {
        screenshotPath: '/tmp/settings.png',
        structurePath: '/tmp/settings.structure.yml',
        a11yPath: '/tmp/settings.a11y.yml',
    });
    assert.deepEqual(writes, [
        { path: '/tmp/settings.structure.yml', text: 'structure-ok' },
        {
            path: '/tmp/settings.a11y.yml',
            text: '# accessibility snapshot unavailable\ndom-accessibility:overlay_route failed after 2 attempts: WebView execution failed: aria-api library not loaded\n',
        },
    ]);
});

test('tauri activity-surfaces QA records transient driver-session accessibility snapshot failures without aborting the capture step', async () => {
    assert.equal(typeof qaModule.captureSnapshotArtifacts, 'function');

    const writes = [];
    const result = await qaModule.captureSnapshotArtifacts({
        screenshotPath: '/tmp/settings.png',
        structurePath: '/tmp/settings.structure.yml',
        a11yPath: '/tmp/settings.a11y.yml',
        label: 'overlay_route',
        appIdentifier: 9223,
        runCli: async (args) => {
            if (args[0] === 'webview-screenshot') {
                return { stdout: 'screenshot-ok' };
            }
            if (args[0] === 'webview-dom-snapshot' && args[2] === 'structure') {
                return { stdout: 'structure-ok' };
            }
            throw new Error('Unable to resolve a connected Tauri app identifier from driver-session status on port 9223.');
        },
        writeArtifact: async (path, text) => {
            writes.push({ path, text });
        },
    });

    assert.deepEqual(result, {
        screenshotPath: '/tmp/settings.png',
        structurePath: '/tmp/settings.structure.yml',
        a11yPath: '/tmp/settings.a11y.yml',
    });
    assert.deepEqual(writes, [
        { path: '/tmp/settings.structure.yml', text: 'structure-ok' },
        {
            path: '/tmp/settings.a11y.yml',
            text: '# accessibility snapshot unavailable\ndom-accessibility:overlay_route failed after 2 attempts: Unable to resolve a connected Tauri app identifier from driver-session status on port 9223.\n',
        },
    ]);
});

test('tauri activity-surfaces QA records timed-out accessibility snapshots without aborting the capture step', async () => {
    assert.equal(typeof qaModule.captureSnapshotArtifacts, 'function');

    const writes = [];
    const result = await qaModule.captureSnapshotArtifacts({
        screenshotPath: '/tmp/settings.png',
        structurePath: '/tmp/settings.structure.yml',
        a11yPath: '/tmp/settings.a11y.yml',
        label: 'overlay_route',
        appIdentifier: 9223,
        runCli: async (args) => {
            if (args[0] === 'webview-screenshot') {
                return { stdout: 'screenshot-ok' };
            }
            if (args[0] === 'webview-dom-snapshot' && args[2] === 'structure') {
                return { stdout: 'structure-ok' };
            }
            throw new Error('Command timed out after 20000ms: yarn -s tauri:mcp:cli webview-dom-snapshot --type accessibility --app-identifier 9223 --window-id activity_overlay');
        },
        writeArtifact: async (path, text) => {
            writes.push({ path, text });
        },
    });

    assert.deepEqual(result, {
        screenshotPath: '/tmp/settings.png',
        structurePath: '/tmp/settings.structure.yml',
        a11yPath: '/tmp/settings.a11y.yml',
    });
    assert.deepEqual(writes, [
        { path: '/tmp/settings.structure.yml', text: 'structure-ok' },
        {
            path: '/tmp/settings.a11y.yml',
            text: '# accessibility snapshot unavailable\ndom-accessibility:overlay_route failed after 2 attempts: Command timed out after 20000ms: yarn -s tauri:mcp:cli webview-dom-snapshot --type accessibility --app-identifier 9223 --window-id activity_overlay\n',
        },
    ]);
});

test('tauri activity-surfaces QA bounds screenshot capture with the same MCP timeout budget as DOM capture', async () => {
    assert.equal(typeof qaModule.captureSnapshotArtifacts, 'function');

    const calls = [];
    await qaModule.captureSnapshotArtifacts({
        screenshotPath: '/tmp/settings.png',
        structurePath: '/tmp/settings.structure.yml',
        a11yPath: '/tmp/settings.a11y.yml',
        label: 'overlay_route',
        appIdentifier: 9223,
        windowId: 'activity_overlay',
        runCli: async (args, options) => {
            calls.push({ args, options });
            return { stdout: 'ok' };
        },
        writeArtifact: async () => {},
    });

    assert.equal(calls[0].args[0], 'webview-screenshot');
    assert.equal(calls[0].options.windowId, 'activity_overlay');
    assert.equal(calls[0].options.timeoutMs, 20_000);
});

test('tauri activity-surfaces QA runs capture stabilization hooks between screenshot and DOM snapshots', async () => {
    assert.equal(typeof qaModule.captureSnapshotArtifacts, 'function');

    const calls = [];
    await qaModule.captureSnapshotArtifacts({
        screenshotPath: '/tmp/settings.png',
        structurePath: '/tmp/settings.structure.yml',
        a11yPath: '/tmp/settings.a11y.yml',
        label: 'overlay_route',
        appIdentifier: 9223,
        windowId: 'activity_overlay',
        beforeScreenshotCapture: async () => {
            calls.push('before-screenshot');
        },
        beforeStructureCapture: async () => {
            calls.push('before-structure');
        },
        beforeAccessibilityCapture: async () => {
            calls.push('before-accessibility');
        },
        runCli: async (args) => {
            if (args[0] === 'webview-screenshot') {
                calls.push('screenshot');
                return { stdout: 'screenshot-ok' };
            }
            if (args[0] === 'webview-dom-snapshot') {
                calls.push(String(args[2]));
                return { stdout: `${String(args[2])}-ok` };
            }
            throw new Error(`Unexpected command: ${String(args[0])}`);
        },
        writeArtifact: async () => {},
    });

    assert.deepEqual(calls, [
        'before-screenshot',
        'screenshot',
        'before-structure',
        'structure',
        'before-accessibility',
        'accessibility',
    ]);
});

test('tauri activity-surfaces QA reruns DOM stabilization before retrying structure snapshots', async () => {
    assert.equal(typeof qaModule.captureSnapshotArtifacts, 'function');

    const calls = [];
    let structureAttempts = 0;
    await qaModule.captureSnapshotArtifacts({
        screenshotPath: '/tmp/settings.png',
        structurePath: '/tmp/settings.structure.yml',
        a11yPath: '/tmp/settings.a11y.yml',
        label: 'overlay_idle',
        appIdentifier: 9223,
        windowId: 'activity_overlay',
        snapshotSelector: '[data-testid="desktop-activity-overlay-card-idle-idle"]',
        beforeStructureCapture: async () => {
            calls.push('before-structure');
        },
        runCli: async (args) => {
            if (args[0] === 'webview-screenshot') {
                calls.push('screenshot');
                return { stdout: 'screenshot-ok' };
            }
            if (args[0] === 'webview-dom-snapshot' && args[2] === 'structure') {
                structureAttempts += 1;
                calls.push(`structure:${structureAttempts}`);
                if (structureAttempts === 1) {
                    throw new Error('No elements found matching selector "[data-testid=\\"desktop-activity-overlay-card-idle-idle\\"]"');
                }
                return { stdout: 'structure-ok' };
            }
            if (args[0] === 'webview-dom-snapshot' && args[2] === 'accessibility') {
                calls.push('accessibility');
                return { stdout: 'accessibility-ok' };
            }
            throw new Error(`Unexpected command: ${String(args[0])}`);
        },
        writeArtifact: async () => {},
    });

    assert.deepEqual(calls, [
        'screenshot',
        'before-structure',
        'structure:1',
        'before-structure',
        'structure:2',
        'accessibility',
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

test('tauri activity-surfaces QA can force a reload when navigating the overlay route', () => {
    assert.equal(typeof qaModule.buildActivitySurfacesNavigationScript, 'function');

    const script = qaModule.buildActivitySurfacesNavigationScript('/desktop/activity-overlay?desktopOverlayWindow=1', {
        forceReload: true,
    });

    assert.equal(script.includes('window.location.reload();'), true);
    assert.equal(script.includes('reloaded: true'), true);
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

    assert.equal(cliCalls.length, 1);
    assert.equal(cliCalls[0].args[0], 'webview-execute-js');
    assert.equal(cliCalls[0].args.includes('--json'), true);
    assert.equal(String(cliCalls[0].args[2]).includes("onboarding-wizard-skip"), true);
    assert.equal(String(cliCalls[0].args[2]).includes('setTimeout'), true);
});

test('tauri activity-surfaces QA retries JS selector clicks when the element is still missing on the first attempt', async () => {
    assert.equal(typeof qaModule.clickActivitySurfacesSelector, 'function');

    const cliCalls = [];
    const waits = [];

    await qaModule.clickActivitySurfacesSelector('[data-testid="setupWizard.surface-skip"]', {
        appIdentifier: 9224,
        env: { EXISTING: 'value' },
        runCli: async (args, options) => {
            cliCalls.push({ args, options });
            if (cliCalls.length === 1) {
                return {
                    stdout: JSON.stringify({ ok: false, reason: 'missing-element', selector: "[data-testid='setupWizard.surface-skip']" }),
                };
            }
            return {
                stdout: JSON.stringify({ ok: true, selector: "[data-testid='setupWizard.surface-skip']" }),
            };
        },
        wait: async (delayMs) => {
            waits.push(delayMs);
        },
    });

    assert.equal(cliCalls.length, 2);
    assert.equal(cliCalls.every((entry) => entry.args[0] === 'webview-execute-js'), true);
    assert.deepEqual(waits, [250]);
});

test('tauri activity-surfaces QA retries JS selector clicks when the command response payload is empty on the first attempt', async () => {
    assert.equal(typeof qaModule.clickActivitySurfacesSelector, 'function');

    const cliCalls = [];
    const waits = [];

    await qaModule.clickActivitySurfacesSelector('[data-testid="onboarding-wizard-skip"]', {
        appIdentifier: 9224,
        env: { EXISTING: 'value' },
        runCli: async (args, options) => {
            cliCalls.push({ args, options });
            if (cliCalls.length === 1) {
                return { stdout: '' };
            }
            return {
                stdout: JSON.stringify({ ok: true, selector: "[data-testid='onboarding-wizard-skip']" }),
            };
        },
        wait: async (delayMs) => {
            waits.push(delayMs);
        },
    });

    assert.equal(cliCalls.length, 2);
    assert.equal(cliCalls.every((entry) => entry.args[0] === 'webview-execute-js'), true);
    assert.deepEqual(waits, [250]);
});

test('tauri activity-surfaces QA keeps selector-presence probe timeouts bounded to the requested probe window', async () => {
    assert.equal(typeof qaModule.isSelectorPresent, 'function');

    const cliCalls = [];

    const visible = await qaModule.isSelectorPresent('[data-testid="settings-desktop-overlay-enabled"]', {
        appIdentifier: 9224,
        env: { EXISTING: 'value' },
        timeoutMs: 1_200,
        runCli: async (args, options) => {
            cliCalls.push({ args, options });
            throw new Error('selector missing');
        },
    });

    assert.equal(visible, false);
    assert.deepEqual(cliCalls, [
        {
            args: [
                'webview-wait-for',
                '--type',
                'selector',
                '--strategy',
                'css',
                '--value',
                '[data-testid="settings-desktop-overlay-enabled"]',
                '--timeout',
                '1200',
                '--app-identifier',
                '9224',
            ],
            options: {
                appIdentifier: 9224,
                driverSession: null,
                env: { EXISTING: 'value' },
                windowId: null,
                timeoutMs: 3_000,
            },
        },
    ]);
});

test('tauri activity-surfaces QA parses DOM-query selector presence boolean outputs', async () => {
    assert.equal(typeof qaModule.isSelectorPresentByDomQuery, 'function');

    const cliCalls = [];
    const visible = await qaModule.isSelectorPresentByDomQuery('[data-testid="settings-desktop-overlay-enabled"]', {
        appIdentifier: 9224,
        env: { EXISTING: 'value' },
        windowId: 'main',
        timeoutMs: 1_200,
        runCli: async (args, options) => {
            cliCalls.push({ args, options });
            return { stdout: '{"text":"true"}' };
        },
    });

    assert.equal(visible, true);
    assert.equal(cliCalls.length, 1);
    assert.equal(cliCalls[0].args[0], 'webview-execute-js');
    assert.equal(cliCalls[0].options.windowId, 'main');
    assert.equal(cliCalls[0].options.timeoutMs, 1_200);
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
    assert.deepEqual(jsonOptions.map((options) => options.timeoutMs), [20_000, 20_000, 20_000]);
    assert.deepEqual(cliCalls, [
        {
            args: ['webview-dom-snapshot', '--type', 'structure', '--app-identifier', '9225'],
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
        driverSessionStatusResponse: { text: JSON.stringify({ connected: true, port: 9225, identifier: 9225 }) },
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
            args: ['webview-dom-snapshot', '--type', 'structure', '--app-identifier', '9225'],
            options: {
                appIdentifier: '9225',
                driverSession,
                env: { EXISTING: 'value' },
                timeoutMs: undefined,
            },
        },
    ]);
});

test('tauri activity-surfaces QA revalidates a cached driver session before retrying the first webview command when the status snapshot is missing', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesMcpCli, 'function');

    const stackIdentifier = 'com.happier.stack.activity-surfaces-qa';
    const driverSession = {
        driverSessionPort: 9223,
        resolvedAppIdentifier: stackIdentifier,
    };
    const jsonCalls = [];
    const cliCalls = [];

    const result = await qaModule.runActivitySurfacesMcpCli(
        ['webview-dom-snapshot', '--type', 'structure', '--app-identifier', stackIdentifier, '--window-id', 'main'],
        {
            appIdentifier: stackIdentifier,
            driverSession,
            env: { EXISTING: 'value', HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
            runCli: async (args, options = {}) => {
                cliCalls.push({ args, options });
                if (cliCalls.length === 1 && options.driverSession?.driverSessionPort === 9223) {
                    throw new Error('WebView execution failed: No active session. Call driver_session with action "start" first to connect to a Tauri app.');
                }
                return { stdout: 'snapshot-ready' };
            },
            runCliJson: async (args) => {
                jsonCalls.push(args);
                const port = String(args[args.length - 1] ?? '').trim();
                if (args[0] === 'driver-session' && args[1] === 'status' && port === '9223') {
                    return { text: JSON.stringify({ connected: true, port: 9223, identifier: 'dev.happier.app.publicdev' }) };
                }
                if (args[0] === 'driver-session' && args[1] === 'start' && port === '9223') {
                    return { ok: true };
                }
                if (args[0] === 'driver-session' && args[1] === 'start' && port === '9224') {
                    return { ok: true };
                }
                if (args[0] === 'driver-session' && args[1] === 'status' && port === '9224') {
                    return { text: JSON.stringify({ connected: true, port: 9224, identifier: stackIdentifier }) };
                }
                throw new Error(`Unexpected JSON call: ${args.join(' ')}`);
            },
        },
    );

    assert.equal(result.stdout, 'snapshot-ready');
    assert.equal(driverSession.driverSessionPort, 9224);
    assert.equal(driverSession.resolvedAppIdentifier, stackIdentifier);
    assert.equal(cliCalls.length, 1);
    assert.equal(cliCalls[0].options.driverSession?.driverSessionPort, 9224);
    assert.deepEqual(jsonCalls, [
        ['driver-session', 'status', '--port', '9223'],
        ['driver-session', 'start', '--port', '9223'],
        ['driver-session', 'status', '--port', '9223'],
        ['driver-session', 'status', '--port', '9223'],
        ['driver-session', 'status', '--port', '9223'],
        ['driver-session', 'status', '--port', '9224'],
    ]);
});

test('tauri activity-surfaces QA retries a webview command after a lost driver session error', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesMcpCli, 'function');

    const driverSession = {
        driverSessionPort: 9225,
        resolvedAppIdentifier: 9225,
        driverSessionStatusResponse: { text: JSON.stringify({ connected: true, port: 9225, identifier: 9225 }) },
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
                if (args[0] === 'driver-session' && args[1] === 'stop') {
                    return { ok: true };
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
        ['driver-session', 'stop', '--port', '9225'],
        ['driver-session', 'start', '--port', '9225'],
        ['driver-session', 'status', '--port', '9225'],
    ]);
    assert.deepEqual(jsonOptions.map((options) => options.timeoutMs), [20_000, 20_000, 20_000]);
    assert.deepEqual(cliCalls, [
        {
            args: ['webview-wait-for', '--type', 'selector', '--strategy', 'css', '--value', '[data-testid="foo"]', '--timeout', '8000', '--app-identifier', '9225'],
            options: {
                appIdentifier: '9225',
                driverSession,
                env: { EXISTING: 'value' },
                timeoutMs: undefined,
            },
        },
        {
            args: ['webview-wait-for', '--type', 'selector', '--strategy', 'css', '--value', '[data-testid="foo"]', '--timeout', '8000', '--app-identifier', '9225'],
            options: {
                appIdentifier: 9225,
                driverSession,
                env: { EXISTING: 'value' },
                timeoutMs: undefined,
            },
        },
    ]);
});

test('tauri activity-surfaces QA retries driver-session status briefly after restarting the driver session when the status response is temporarily empty', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesMcpCli, 'function');

    const driverSession = {
        driverSessionPort: 9225,
        resolvedAppIdentifier: 9225,
    };
    const jsonCalls = [];
    const jsonOptions = [];
    const cliCalls = [];
    let statusCalls = 0;

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
                if (args[0] === 'driver-session' && args[1] === 'stop') {
                    return { ok: true };
                }
                if (args[0] === 'driver-session' && args[1] === 'start') {
                    return { ok: true };
                }
                if (args[0] === 'driver-session' && args[1] === 'status') {
                    statusCalls += 1;
                    if (statusCalls === 1) {
                        return { text: JSON.stringify({ connected: true, apps: [] }) };
                    }
                    return { text: JSON.stringify({ connected: true, port: 9225 }) };
                }
                throw new Error(`Unexpected JSON call: ${args.join(' ')}`);
            },
        },
    );

    assert.equal(result.stdout, 'selector-ready');
    assert.equal(driverSession.resolvedAppIdentifier, 9225);
    assert.deepEqual(jsonCalls, [
        ['driver-session', 'status', '--port', '9225'],
        ['driver-session', 'start', '--port', '9225'],
        ['driver-session', 'status', '--port', '9225'],
        ['driver-session', 'stop', '--port', '9225'],
        ['driver-session', 'start', '--port', '9225'],
        ['driver-session', 'status', '--port', '9225'],
    ]);
    assert.equal(jsonCalls.filter((call) => call[0] === 'driver-session' && call[1] === 'status').length >= 2, true);
    assert.deepEqual(jsonOptions.map((options) => options.timeoutMs), [20_000, 20_000, 20_000, 20_000, 20_000, 20_000]);
    assert.equal(cliCalls.length, 2);
});

test('tauri activity-surfaces QA falls back to an alternate driver-session port when the restarted port keeps timing out', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesMcpCli, 'function');

    const driverSession = {
        driverSessionPort: 9225,
        resolvedAppIdentifier: null,
    };
    const jsonCalls = [];
    const cliCalls = [];
    let statusCalls = 0;

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
                jsonCalls.push({ args, options: options ?? {} });
                if (args[0] === 'driver-session' && args[1] === 'status') {
                    const port = String(args[args.length - 1] ?? '').trim();
                    statusCalls += 1;
                    if (statusCalls === 1) {
                        return { text: JSON.stringify({ apps: [] }) };
                    }
                    if (port === '9225') {
                        throw new Error('Command timed out after 20000ms: yarn -s tauri:mcp:cli driver-session status --port 9225 --json');
                    }
                    if (port === '9224') {
                        return { text: JSON.stringify({ connected: true, port: 9224, identifier: 9224 }) };
                    }
                    return { text: JSON.stringify({ connected: false, apps: [] }) };
                }
                if (args[0] === 'driver-session' && args[1] === 'start') {
                    return { ok: true };
                }
                throw new Error(`Unexpected JSON call: ${args.join(' ')}`);
            },
        },
    );

    assert.equal(result.stdout, 'snapshot-ready');
    assert.equal(driverSession.driverSessionPort, 9224);
    assert.equal(String(driverSession.resolvedAppIdentifier), '9224');
    assert.deepEqual(
        jsonCalls.map((entry) => entry.args),
        [
            ['driver-session', 'status', '--port', '9225'],
            ['driver-session', 'start', '--port', '9225'],
            ['driver-session', 'status', '--port', '9225'],
            ['driver-session', 'status', '--port', '9225'],
            ['driver-session', 'status', '--port', '9225'],
            ['driver-session', 'status', '--port', '9223'],
            ['driver-session', 'start', '--port', '9223'],
            ['driver-session', 'status', '--port', '9223'],
            ['driver-session', 'status', '--port', '9223'],
            ['driver-session', 'status', '--port', '9223'],
            ['driver-session', 'status', '--port', '9224'],
        ],
    );
    assert.deepEqual(
        jsonCalls.map((entry) => entry.options.timeoutMs),
        [20_000, 20_000, 20_000, 20_000, 20_000, 20_000, 20_000, 20_000, 20_000, 20_000, 20_000],
    );
    assert.deepEqual(cliCalls, [
        {
            args: ['webview-dom-snapshot', '--type', 'structure', '--app-identifier', '9224'],
            options: {
                appIdentifier: '9224',
                driverSession,
                env: { EXISTING: 'value' },
                timeoutMs: undefined,
            },
        },
    ]);
});

test('tauri activity-surfaces QA can switch driver-session ports when the previous port no longer has a stack-owned session', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesMcpCli, 'function');

    const stackIdentifier = 'com.happier.stack.activity-surfaces-qa';
    const driverSession = {
        driverSessionPort: 9223,
        resolvedAppIdentifier: stackIdentifier,
    };

    const jsonCalls = [];
    const cliCalls = [];

    const result = await qaModule.runActivitySurfacesMcpCli(
        [
            'webview-wait-for',
            '--type',
            'selector',
            '--strategy',
            'css',
            '--value',
            '[data-testid="foo"]',
            '--timeout',
            '8000',
            '--app-identifier',
            stackIdentifier,
            '--window-id',
            'main',
        ],
        {
            appIdentifier: driverSession.resolvedAppIdentifier,
            driverSession,
            env: { EXISTING: 'value', HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
            runCli: async (args, options) => {
                cliCalls.push({ args, options });
                if (cliCalls.length === 1) {
                    throw new Error('Wait failed: WebView execution failed: No active session. Call driver_session with action "start" first to connect to a Tauri app.');
                }
                return { stdout: 'selector-ready' };
            },
            runCliJson: async (args) => {
                jsonCalls.push(args);
                const port = String(args[args.length - 1] ?? '').trim();
                if (args[0] === 'driver-session' && args[1] === 'stop') {
                    return { ok: true };
                }
                if (args[0] === 'driver-session' && args[1] === 'start') {
                    return { ok: true };
                }
                if (args[0] === 'driver-session' && args[1] === 'status') {
                    if (port === '9223') {
                        return { text: JSON.stringify({ connected: true, apps: [] }) };
                    }
                    if (port === '9224') {
                        return { text: JSON.stringify({ connected: true, port: 9224, identifier: stackIdentifier }) };
                    }
                    return { text: JSON.stringify({ connected: false, apps: [] }) };
                }
                throw new Error(`Unexpected JSON call: ${args.join(' ')}`);
            },
        },
    );

    assert.equal(result.stdout, 'selector-ready');
    assert.equal(driverSession.driverSessionPort, 9224);
    assert.equal(driverSession.resolvedAppIdentifier, stackIdentifier);
    assert.equal(cliCalls.length, 2);
    assert.equal(cliCalls[0].options.driverSession?.driverSessionPort, 9224);
    assert.equal(cliCalls[1].options.driverSession?.driverSessionPort, 9224);
    assert.equal(cliCalls[0].args.includes('--app-identifier'), true);
    assert.equal(cliCalls[0].args.includes(stackIdentifier), true);
    assert.equal(cliCalls[1].args.includes('--app-identifier'), true);
    assert.equal(cliCalls[1].args.includes(stackIdentifier), true);
    assert.equal(jsonCalls.some((call) => call[0] === 'driver-session' && call[1] === 'status' && call[2] === '--port' && call[3] === '9223'), true);
    assert.equal(jsonCalls.some((call) => call[0] === 'driver-session' && call[1] === 'stop' && call[3] === '9224'), true);
    assert.equal(jsonCalls.some((call) => call[0] === 'driver-session' && call[1] === 'start' && call[3] === '9224'), true);
    assert.equal(jsonCalls.some((call) => call[0] === 'driver-session' && call[1] === 'status' && call[3] === '9224'), true);
});

test('tauri activity-surfaces QA can switch driver-session ports when the cached stack-owned port times out after restart', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesMcpCli, 'function');

    const stackIdentifier = 'com.happier.stack.activity-surfaces-qa';
    const driverSession = {
        driverSessionPort: 9223,
        resolvedAppIdentifier: stackIdentifier,
    };
    const jsonCalls = [];
    const cliCalls = [];

    const result = await qaModule.runActivitySurfacesMcpCli(
        [
            'webview-wait-for',
            '--type',
            'selector',
            '--strategy',
            'css',
            '--value',
            '[data-testid="foo"]',
            '--timeout',
            '8000',
            '--app-identifier',
            stackIdentifier,
            '--window-id',
            'main',
        ],
        {
            appIdentifier: driverSession.resolvedAppIdentifier,
            driverSession,
            env: { EXISTING: 'value', HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
            runCli: async (args, options) => {
                cliCalls.push({ args, options });
                if (cliCalls.length === 1) {
                    throw new Error('Wait failed: WebView execution failed: No active session. Call driver_session with action "start" first to connect to a Tauri app.');
                }
                return { stdout: 'selector-ready' };
            },
            runCliJson: async (args) => {
                jsonCalls.push(args);
                const port = String(args[args.length - 1] ?? '').trim();
                if (args[0] === 'driver-session' && args[1] === 'stop') {
                    return { ok: true };
                }
                if (args[0] === 'driver-session' && args[1] === 'start') {
                    return { ok: true };
                }
                if (args[0] === 'driver-session' && args[1] === 'status') {
                    if (port === '9223' && jsonCalls.length === 1) {
                        return { text: JSON.stringify({ connected: true, port: 9223, identifier: stackIdentifier }) };
                    }
                    if (port === '9223') {
                        throw new Error('Command timed out after 20000ms: yarn -s tauri:mcp:cli driver-session status --port 9223 --json');
                    }
                    if (port === '9224') {
                        return { text: JSON.stringify({ connected: true, port: 9224, identifier: stackIdentifier }) };
                    }
                    return { text: JSON.stringify({ connected: false, apps: [] }) };
                }
                throw new Error(`Unexpected JSON call: ${args.join(' ')}`);
            },
        },
    );

    assert.equal(result.stdout, 'selector-ready');
    assert.equal(driverSession.driverSessionPort, 9224);
    assert.equal(driverSession.resolvedAppIdentifier, stackIdentifier);
    assert.equal(cliCalls.length, 2);
    assert.equal(cliCalls[0].options.driverSession?.driverSessionPort, 9224);
    assert.equal(cliCalls[1].options.driverSession?.driverSessionPort, 9224);
    assert.deepEqual(jsonCalls, [
        ['driver-session', 'status', '--port', '9223'],
        ['driver-session', 'stop', '--port', '9223'],
        ['driver-session', 'start', '--port', '9223'],
        ['driver-session', 'status', '--port', '9223'],
        ['driver-session', 'status', '--port', '9223'],
        ['driver-session', 'status', '--port', '9223'],
        ['driver-session', 'status', '--port', '9224'],
    ]);
});

test('tauri activity-surfaces QA does not trust a stale cached stack identifier when the live driver-session status has already moved on', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesMcpCli, 'function');

    const stackIdentifier = 'com.happier.stack.activity-surfaces-qa';
    const driverSession = {
        driverSessionPort: 9225,
        resolvedAppIdentifier: stackIdentifier,
    };
    const jsonCalls = [];
    const cliCalls = [];

    const result = await qaModule.runActivitySurfacesMcpCli(
        ['webview-wait-for', '--type', 'selector', '--strategy', 'css', '--value', '[data-testid="foo"]', '--timeout', '8000', '--app-identifier', stackIdentifier, '--window-id', 'main'],
        {
            appIdentifier: driverSession.resolvedAppIdentifier,
            driverSession,
            env: { EXISTING: 'value', HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
            runCli: async (args, options) => {
                cliCalls.push({ args, options });
                if (cliCalls.length === 1) {
                    throw new Error('Wait failed: WebView execution failed: No active session. Call driver_session with action "start" first to connect to a Tauri app.');
                }
                return { stdout: 'selector-ready' };
            },
            runCliJson: async (args) => {
                jsonCalls.push(args);
                const port = String(args[args.length - 1] ?? '').trim();
                if (args[0] === 'driver-session' && args[1] === 'stop') {
                    return { ok: true };
                }
                if (args[0] === 'driver-session' && args[1] === 'start') {
                    return { ok: true };
                }
                if (args[0] === 'driver-session' && args[1] === 'status') {
                    if (port === '9225') {
                        return { text: JSON.stringify({ connected: true, port: 9225, identifier: 'dev.happier.app.publicdev' }) };
                    }
                    if (port === '9224') {
                        return { text: JSON.stringify({ connected: true, port: 9224, identifier: stackIdentifier }) };
                    }
                    return { text: JSON.stringify({ connected: false, apps: [] }) };
                }
                throw new Error(`Unexpected JSON call: ${args.join(' ')}`);
            },
        },
    );

    assert.equal(result.stdout, 'selector-ready');
    assert.equal(driverSession.driverSessionPort, 9224);
    assert.equal(driverSession.resolvedAppIdentifier, stackIdentifier);
    assert.equal(cliCalls.length, 2);
    assert.equal(cliCalls[0].options.driverSession?.driverSessionPort, 9224);
    assert.equal(cliCalls[1].options.driverSession?.driverSessionPort, 9224);
    assert.equal(cliCalls[0].args.includes('--app-identifier'), true);
    assert.equal(cliCalls[0].args.includes(stackIdentifier), true);
    assert.equal(cliCalls[1].args.includes('--app-identifier'), true);
    assert.equal(cliCalls[1].args.includes(stackIdentifier), true);
    assert.equal(jsonCalls.some((call) => call[0] === 'driver-session' && call[1] === 'status' && call[2] === '--port' && call[3] === '9225'), true);
    assert.equal(jsonCalls.some((call) => call[0] === 'driver-session' && call[1] === 'stop' && call[3] === '9224'), true);
    assert.equal(jsonCalls.some((call) => call[0] === 'driver-session' && call[1] === 'start' && call[3] === '9224'), true);
    assert.equal(jsonCalls.some((call) => call[0] === 'driver-session' && call[1] === 'status' && call[3] === '9224'), true);
});

test('tauri activity-surfaces QA does not attach to a different stack-owned app when a preferred stack identifier is expected', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesMcpCli, 'function');

    const expectedStackIdentifier = 'com.happier.stack.overlay-v2-20260418';
    const staleStackIdentifier = 'com.happier.stack.repo-dev-a1cc5e0671';
    const driverSession = {
        driverSessionPort: 9223,
        resolvedAppIdentifier: null,
    };
    const jsonCalls = [];
    const cliCalls = [];

    const result = await qaModule.runActivitySurfacesMcpCli(
        ['webview-wait-for', '--type', 'selector', '--strategy', 'css', '--value', '[data-testid="foo"]', '--timeout', '8000', '--window-id', 'main'],
        {
            appIdentifier: null,
            driverSession,
            env: { EXISTING: 'value', HAPPIER_STACK_STACK: 'overlay-v2-20260418' },
            runCli: async (args, options) => {
                cliCalls.push({ args, options });
                return { stdout: 'selector-ready' };
            },
            runCliJson: async (args) => {
                jsonCalls.push(args);
                const port = String(args[args.length - 1] ?? '').trim();
                if (args[0] === 'driver-session' && args[1] === 'stop') {
                    return { ok: true };
                }
                if (args[0] === 'driver-session' && args[1] === 'start') {
                    return { ok: true };
                }
                if (args[0] === 'driver-session' && args[1] === 'status') {
                    if (port === '9223') {
                        return { text: JSON.stringify({ connected: true, port: 9223, identifier: staleStackIdentifier }) };
                    }
                    if (port === '9224') {
                        return { text: JSON.stringify({ connected: true, port: 9224, identifier: expectedStackIdentifier }) };
                    }
                    return { text: JSON.stringify({ connected: false, apps: [] }) };
                }
                throw new Error(`Unexpected JSON call: ${args.join(' ')}`);
            },
        },
    );

    assert.equal(result.stdout, 'selector-ready');
    assert.equal(driverSession.driverSessionPort, 9224);
    assert.equal(driverSession.resolvedAppIdentifier, expectedStackIdentifier);
    assert.equal(cliCalls.length, 1);
    assert.equal(cliCalls[0].options.driverSession?.driverSessionPort, 9224);
    assert.equal(cliCalls[0].args.includes('--app-identifier'), true);
    assert.equal(cliCalls[0].args.includes(expectedStackIdentifier), true);
    assert.equal(cliCalls[0].args.includes(staleStackIdentifier), false);
    assert.equal(jsonCalls.some((call) => call[0] === 'driver-session' && call[1] === 'status' && call[3] === '9223'), true);
    assert.equal(jsonCalls.some((call) => call[0] === 'driver-session' && call[1] === 'status' && call[3] === '9224'), true);
});

test('tauri activity-surfaces QA retries a webview command after repeated lost driver session errors', async () => {
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
                if (cliCalls.length <= 2) {
                    throw new Error('Wait failed: WebView execution failed: No active session. Call driver_session with action "start" first to connect to a Tauri app.');
                }
                return { stdout: 'selector-ready' };
            },
            runCliJson: async (args, options) => {
                jsonCalls.push(args);
                jsonOptions.push(options ?? {});
                if (args[0] === 'driver-session' && args[1] === 'stop') {
                    return { ok: true };
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
        ['driver-session', 'status', '--port', '9225'],
        ['driver-session', 'stop', '--port', '9225'],
        ['driver-session', 'start', '--port', '9225'],
        ['driver-session', 'status', '--port', '9225'],
        ['driver-session', 'stop', '--port', '9225'],
        ['driver-session', 'start', '--port', '9225'],
        ['driver-session', 'status', '--port', '9225'],
    ]);
    assert.deepEqual(jsonOptions.map((options) => options.timeoutMs), [20_000, 20_000, 20_000, 20_000, 20_000, 20_000, 20_000]);
    assert.equal(cliCalls.length, 3);
});

test('tauri activity-surfaces QA retries a webview command after a transient plugin reconnect failure', async () => {
    assert.equal(typeof qaModule.runActivitySurfacesMcpCli, 'function');

    const driverSession = {
        driverSessionPort: 9225,
        resolvedAppIdentifier: 9225,
    };
    const jsonCalls = [];
    const jsonOptions = [];
    const cliCalls = [];

    const result = await qaModule.runActivitySurfacesMcpCli(
        ['webview-execute-js', '--script', 'document.title', '--app-identifier', '9225', '--window-id', 'main', '--json'],
        {
            appIdentifier: driverSession.resolvedAppIdentifier,
            driverSession,
            env: { EXISTING: 'value' },
            runCli: async (args, options) => {
                cliCalls.push({ args, options });
                if (cliCalls.length === 1) {
                    throw new Error('Error: JavaScript execution failed: WebView execution failed: Not connected to plugin and reconnection failed');
                }
                return { stdout: '{"text":"Happier"}' };
            },
            runCliJson: async (args, options) => {
                jsonCalls.push(args);
                jsonOptions.push(options ?? {});
                if (args[0] === 'driver-session' && args[1] === 'stop') {
                    return { ok: true };
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

    assert.equal(result.stdout, '{"text":"Happier"}');
    assert.equal(driverSession.resolvedAppIdentifier, 9225);
    assert.deepEqual(jsonCalls, [
        ['driver-session', 'status', '--port', '9225'],
        ['driver-session', 'stop', '--port', '9225'],
        ['driver-session', 'start', '--port', '9225'],
        ['driver-session', 'status', '--port', '9225'],
    ]);
    assert.deepEqual(jsonOptions.map((options) => options.timeoutMs), [20_000, 20_000, 20_000, 20_000]);
    assert.deepEqual(cliCalls, [
        {
            args: ['webview-execute-js', '--script', 'document.title', '--app-identifier', '9225', '--json'],
            options: {
                appIdentifier: 9225,
                driverSession,
                env: { EXISTING: 'value' },
                timeoutMs: undefined,
            },
        },
        {
            args: ['webview-execute-js', '--script', 'document.title', '--app-identifier', '9225', '--json'],
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
    const traces = [];

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
        traceAttempt: async (entry) => {
            traces.push(entry);
        },
    });

    assert.deepEqual(result, { ok: true, attempts: 2 });
    assert.deepEqual(navigations, []);
    assert.deepEqual(clicks, ['[data-testid="onboarding-wizard-skip"]']);
    assert.equal(probeCalls.length, 2);
    assert.deepEqual(warnings, []);
    assert.deepEqual(traces, [
        {
            attempt: 1,
            kind: 'attempt_start',
            targetPath: '/settings',
        },
        {
            attempt: 1,
            kind: 'probe_start',
        },
        {
            attempt: 1,
            kind: 'action',
            selector: '[data-testid="onboarding-wizard-skip"]',
        },
        {
            attempt: 2,
            kind: 'attempt_start',
            targetPath: '/settings',
        },
        {
            attempt: 2,
            kind: 'probe_start',
        },
        {
            attempt: 2,
            kind: 'ready',
        },
    ]);
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
    assert.deepEqual(navigations, []);
    assert.deepEqual(clicks, [
        '[data-testid="onboarding-wizard-skip"]',
        '[data-testid="onboarding-wizard-skip"]',
    ]);
    assert.equal(probeCalls.length, 3);
    assert.deepEqual(warnings, []);
});

test('tauri activity-surfaces QA reports each observed preflight surface attempt before settings become ready', async () => {
    assert.equal(typeof qaModule.ensureActivitySurfacesSettingsShellReady, 'function');

    const observations = [];
    const probeCalls = [];
    const result = await qaModule.ensureActivitySurfacesSettingsShellReady({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        preflightPlan: preflightModule.buildActivitySurfacesPreflightPlan(),
        navigateWebview: async () => {},
        click: async () => {},
        appendWarning: async () => {},
        wait: async () => {},
        traceAttempt: async (entry) => {
            observations.push(entry);
        },
        probeSurface: async ({ triedSelectors }) => {
            probeCalls.push(new Set(triedSelectors));
            if (probeCalls.length === 1) {
                return {
                    kind: 'navigate',
                    targetPath: '/settings/desktop',
                    reason: 'settings-desktop-page-not-visible-yet',
                };
            }
            if (probeCalls.length === 2) {
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
    assert.deepEqual(observations, [
        {
            attempt: 1,
            kind: 'attempt_start',
            targetPath: '/settings',
        },
        {
            attempt: 1,
            kind: 'probe_start',
        },
        {
            attempt: 1,
            kind: 'navigate',
            targetPath: '/settings/desktop',
            reason: 'settings-desktop-page-not-visible-yet',
        },
        {
            attempt: 2,
            kind: 'attempt_start',
            targetPath: '/settings',
        },
        {
            attempt: 2,
            kind: 'probe_start',
        },
        {
            attempt: 2,
            kind: 'action',
            selector: '[data-testid="onboarding-wizard-skip"]',
        },
        {
            attempt: 3,
            kind: 'attempt_start',
            targetPath: '/settings',
        },
        {
            attempt: 3,
            kind: 'probe_start',
        },
        {
            attempt: 3,
            kind: 'ready',
        },
    ]);
});

test('tauri activity-surfaces QA probes before raw /settings navigation when the real settings tab is already visible', async () => {
    assert.equal(typeof qaModule.ensureActivitySurfacesSettingsShellReady, 'function');

    const navigations = [];
    const clicks = [];
    let probeCallCount = 0;

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
        appendWarning: async () => {},
        wait: async () => {},
        probeSurface: async () => {
            probeCallCount += 1;
            if (probeCallCount === 1) {
                return {
                    kind: 'action',
                    selector: '[data-testid="tabbar-tab-settings"]',
                };
            }
            return { kind: 'ready' };
        },
    });

    assert.deepEqual(result, { ok: true, attempts: 2 });
    assert.deepEqual(navigations, []);
    assert.deepEqual(clicks, ['[data-testid="tabbar-tab-settings"]']);
});

test('tauri activity-surfaces QA keeps retrying the dedicated desktop settings path when generic shell readiness is still missing', async () => {
    assert.equal(typeof qaModule.ensureActivitySurfacesSettingsShellReady, 'function');

    const navigations = [];
    let probeCallCount = 0;
    const result = await qaModule.ensureActivitySurfacesSettingsShellReady({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        preflightPlan: preflightModule.buildActivitySurfacesPreflightPlan(),
        navigateWebview: async (pathname) => {
            navigations.push(pathname);
        },
        click: async () => {},
        appendWarning: async () => {},
        wait: async () => {},
        probeSurface: async () => {
            probeCallCount += 1;
            if (probeCallCount === 1) {
                return {
                    kind: 'navigate',
                    targetPath: '/settings',
                    reason: 'settings-shell-not-visible-yet',
                };
            }
            return {
                kind: 'ready',
            };
        },
    });

    assert.deepEqual(result, { ok: true, attempts: 2 });
    assert.deepEqual(navigations, []);
});

test('tauri activity-surfaces QA uses a faster retry plan after the first desktop settings shell miss', async () => {
    assert.equal(typeof qaModule.ensureActivitySurfacesSettingsShellReady, 'function');

    const probeCalls = [];
    const result = await qaModule.ensureActivitySurfacesSettingsShellReady({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        preflightPlan: preflightModule.buildActivitySurfacesPreflightPlan(),
        navigateWebview: async () => {},
        click: async () => {},
        appendWarning: async () => {},
        wait: async () => {},
        probeSurface: async (options) => {
            probeCalls.push({
                selectorPresenceProbeTimeoutMs: options.plan.selectorPresenceProbeTimeoutMs,
                rootStateProbeTimeoutMs: options.plan.rootStateProbeTimeoutMs,
                structureSnapshotProbeTimeoutMs: options.plan.structureSnapshotProbeTimeoutMs,
            });
            if (probeCalls.length === 1) {
                return {
                    kind: 'navigate',
                    targetPath: '/settings',
                    reason: 'settings-shell-not-visible-yet',
                };
            }
            return {
                kind: 'ready',
            };
        },
    });

    assert.deepEqual(result, { ok: true, attempts: 2 });
    assert.equal(probeCalls.length, 2);
    assert.deepEqual(probeCalls[0], {
        selectorPresenceProbeTimeoutMs: 4_000,
        rootStateProbeTimeoutMs: 4_000,
        structureSnapshotProbeTimeoutMs: 5_000,
    });
    assert.deepEqual(probeCalls[1], {
        selectorPresenceProbeTimeoutMs: 1_500,
        rootStateProbeTimeoutMs: 1_500,
        structureSnapshotProbeTimeoutMs: 2_000,
    });
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
    assert.deepEqual(navigations, []);
    assert.deepEqual(clicks, [selector, selector]);
    assert.equal(probeCalls.length, 3);
    assert.deepEqual(warnings, []);
});

test('tauri activity-surfaces QA retries settings preflight after a transient probe disconnect', async () => {
    assert.equal(typeof qaModule.ensureActivitySurfacesSettingsShellReady, 'function');

    const warnings = [];
    const navigations = [];
    const traces = [];
    let probeCallCount = 0;

    const result = await qaModule.ensureActivitySurfacesSettingsShellReady({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        preflightPlan: preflightModule.buildActivitySurfacesPreflightPlan(),
        navigateWebview: async (pathname) => {
            navigations.push(pathname);
        },
        appendWarning: async (_artifactRoot, text) => {
            warnings.push(text);
        },
        traceAttempt: async (entry) => {
            traces.push(entry);
        },
        wait: async () => {},
        probeSurface: async () => {
            probeCallCount += 1;
            if (probeCallCount === 1) {
                throw new Error('WebView execution failed: Not connected to plugin and reconnection failed');
            }
            return {
                kind: 'ready',
            };
        },
    });

    assert.deepEqual(result, { ok: true, attempts: 2 });
    assert.deepEqual(navigations, []);
    assert.equal(probeCallCount, 2);
    assert.deepEqual(warnings, []);
    assert.deepEqual(traces, [
        { attempt: 1, kind: 'attempt_start', targetPath: '/settings' },
        { attempt: 1, kind: 'probe_start' },
        { attempt: 2, kind: 'attempt_start', targetPath: '/settings' },
        { attempt: 2, kind: 'probe_start' },
        { attempt: 2, kind: 'ready' },
    ]);
});

test('tauri activity-surfaces QA can recover from an app crash then dismiss setup wizard before confirming settings', async () => {
    assert.equal(typeof qaModule.ensureActivitySurfacesSettingsShellReady, 'function');

    const navigations = [];
    const clicks = [];
    const traces = [];
    const warnings = [];
    let probeCallCount = 0;

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
        traceAttempt: async (entry) => {
            traces.push(entry);
        },
        wait: async () => {},
        recoverAppCrash: async () => true,
        probeSurface: async () => {
            probeCallCount += 1;
            if (probeCallCount === 1) {
                return {
                    kind: 'blocked',
                    blocker: 'app-crash',
                    message: 'crash',
                };
            }
            if (probeCallCount === 2) {
                return {
                    kind: 'action',
                    selector: '[data-testid="setupWizard.surface-skip"]',
                };
            }
            return { kind: 'ready' };
        },
    });

    assert.deepEqual(result, { ok: true, attempts: 3 });
    assert.deepEqual(navigations, []);
    assert.deepEqual(clicks, ['[data-testid="setupWizard.surface-skip"]']);
    assert.equal(warnings.length, 0);
    assert.deepEqual(traces, [
        { attempt: 1, kind: 'attempt_start', targetPath: '/settings' },
        { attempt: 1, kind: 'probe_start' },
        { attempt: 1, kind: 'blocked', blocker: 'app-crash', message: 'crash' },
        { attempt: 2, kind: 'attempt_start', targetPath: '/settings' },
        { attempt: 2, kind: 'probe_start' },
        { attempt: 2, kind: 'action', selector: '[data-testid="setupWizard.surface-skip"]' },
        { attempt: 3, kind: 'attempt_start', targetPath: '/settings' },
        { attempt: 3, kind: 'probe_start' },
        { attempt: 3, kind: 'ready' },
    ]);
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

test('tauri activity-surfaces QA resolves stack boot credentials from stack auth status and the server-scoped access key', async () => {
    assert.equal(typeof qaModule.resolveActivitySurfacesStackBootCredentials, 'function');

    const credentials = await qaModule.resolveActivitySurfacesStackBootCredentials({
        env: {
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
        },
        runStackAuthStatus: async () => ({
            stackName: 'activity-surfaces-qa',
            internalServerUrl: 'http://127.0.0.1:3009',
            auth: {
                ok: true,
                hasAccessKey: true,
                accessKeyPath: '/tmp/cli/servers/stack_activity-surfaces-qa__id_default/access.key',
            },
        }),
        readCredentialFile: async () => JSON.stringify({
            token: 'stack-token',
            encryption: {
                publicKey: 'public-key',
                machineKey: 'machine-key',
            },
        }),
    });

    assert.deepEqual(credentials, {
        authStorageKey: 'auth_credentials__srv_stack_activity-surfaces-qa__id_default',
        authStorageKeys: [
            'auth_credentials__srv_stack_activity-surfaces-qa__id_default',
            'auth_credentials__srv_stack_activity-surfaces-qa_id_default',
        ],
        credentials: {
            token: 'stack-token',
            encryption: {
                publicKey: 'public-key',
                machineKey: 'machine-key',
            },
        },
        internalServerUrl: 'http://127.0.0.1:3009',
    });
});

test('tauri activity-surfaces QA seeds stack credentials into web storage and force-reloads the desktop settings route', async () => {
    assert.equal(typeof qaModule.seedActivitySurfacesAuthFromStackCredentials, 'function');

    const cliCalls = [];
    const navigations = [];
    const waits = [];
    const completed = await qaModule.seedActivitySurfacesAuthFromStackCredentials({
        appIdentifier: 9223,
        env: { HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        resolveStackCredentials: async () => ({
            authStorageKey: 'auth_credentials__srv_stack_activity-surfaces-qa_id_default',
            authStorageKeys: ['auth_credentials__srv_stack_activity-surfaces-qa_id_default'],
            credentials: {
                token: 'stack-token',
                encryption: {
                    publicKey: 'public-key',
                    machineKey: 'machine-key',
                },
            },
            internalServerUrl: 'http://127.0.0.1:3009',
        }),
        runCli: async (args) => {
            cliCalls.push(args);
            return {
                stdout: JSON.stringify({
                    ok: true,
                    authStorageKey: 'auth_credentials__srv_stack_activity-surfaces-qa__id_default',
                }),
            };
        },
        navigateWebview: async (pathname, options) => {
            navigations.push({ pathname, options });
        },
        waitForAuthCompletion: async () => true,
        wait: async (ms) => {
            waits.push(ms);
        },
    });

    assert.equal(completed, true);
    assert.equal(cliCalls.length, 1);
    assert.equal(cliCalls[0]?.[0], 'webview-execute-js');
    assert.equal(String(cliCalls[0]?.[2]).includes('window.localStorage'), true);
    assert.equal(String(cliCalls[0]?.[2]).includes('auth_credentials__srv_stack_activity-surfaces-qa_id_default'), true);
    assert.deepEqual(navigations, [
        {
            pathname: '/settings/desktop',
            options: {
                appIdentifier: 9223,
                driverSession: null,
                env: { HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
                forceReload: true,
                windowId: 'main',
            },
        },
    ]);
    assert.deepEqual(waits, [400]);
});

test('tauri activity-surfaces QA auth recovery prefers stack credential seeding before the manual restore fallback', async () => {
    assert.equal(typeof qaModule.restoreActivitySurfacesAuth, 'function');

    const calls = [];
    const restored = await qaModule.restoreActivitySurfacesAuth({
        appIdentifier: 9223,
        env: { HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        seedStackAuth: async () => {
            calls.push('seed');
            return true;
        },
        restoreWithDevKey: async () => {
            calls.push('manual');
            return true;
        },
    });

    assert.equal(restored, true);
    assert.deepEqual(calls, ['seed']);
});

test('tauri activity-surfaces QA auth recovery falls back to manual restore when stack credential seeding is unavailable', async () => {
    assert.equal(typeof qaModule.restoreActivitySurfacesAuth, 'function');

    const calls = [];
    const restored = await qaModule.restoreActivitySurfacesAuth({
        appIdentifier: 9223,
        env: { HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        seedStackAuth: async () => {
            calls.push('seed');
            return false;
        },
        restoreWithDevKey: async () => {
            calls.push('manual');
            return true;
        },
    });

    assert.equal(restored, true);
    assert.deepEqual(calls, ['seed', 'manual']);
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

test('tauri activity-surfaces QA auth completion does not settle on auth-free polls until a positive post-auth surface is visible', async () => {
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

    assert.equal(completed, false);
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

test('tauri activity-surfaces QA crash recovery hard-resets the main window before retrying preflight', async () => {
    assert.equal(typeof qaModule.recoverActivitySurfacesAppCrash, 'function');

    const navigations = [];
    const clicks = [];
    const selectorChecks = [];

    const recovered = await qaModule.recoverActivitySurfacesAppCrash({
        appIdentifier: 9223,
        env: { HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
        navigateWebview: async (pathname, options) => {
            navigations.push({ pathname, options });
        },
        click: async (selector) => {
            clicks.push(selector);
        },
        isSelectorVisible: async (selector) => {
            selectorChecks.push(selector);
            return false;
        },
        wait: async () => {},
    });

    assert.equal(recovered, true);
    assert.deepEqual(navigations, [
        {
            pathname: '/',
            options: {
                appIdentifier: 9223,
                driverSession: null,
                env: { HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
                forceReload: true,
                windowId: 'main',
            },
        },
    ]);
    assert.deepEqual(selectorChecks, ['[data-testid="app-crash-restart"]']);
    assert.deepEqual(clicks, []);
});

test('tauri activity-surfaces QA crash recovery falls back to the crash restart button when the hard reset still shows the crash screen', async () => {
    assert.equal(typeof qaModule.recoverActivitySurfacesAppCrash, 'function');

    const navigations = [];
    const clicks = [];
    const selectorChecks = [];
    const visibilityPlan = [true, false];

    const recovered = await qaModule.recoverActivitySurfacesAppCrash({
        appIdentifier: 9223,
        env: { HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
        navigateWebview: async (pathname, options) => {
            navigations.push({ pathname, options });
        },
        click: async (selector) => {
            clicks.push(selector);
        },
        isSelectorVisible: async (selector) => {
            selectorChecks.push(selector);
            return visibilityPlan.shift() ?? false;
        },
        wait: async () => {},
    });

    assert.equal(recovered, true);
    assert.deepEqual(navigations, [
        {
            pathname: '/',
            options: {
                appIdentifier: 9223,
                driverSession: null,
                env: { HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
                forceReload: true,
                windowId: 'main',
            },
        },
    ]);
    assert.deepEqual(selectorChecks, [
        '[data-testid="app-crash-restart"]',
        '[data-testid="app-crash-restart"]',
    ]);
    assert.deepEqual(clicks, ['[data-testid="app-crash-restart"]']);
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
    assert.deepEqual(navigations, []);
    assert.equal(restoreCalls.length, 1);
    assert.deepEqual(warnings, []);
});

test('tauri activity-surfaces QA retries settings preflight once after recovering from a stale app crash screen', async () => {
    assert.equal(typeof qaModule.ensureActivitySurfacesSettingsShellReady, 'function');

    const warnings = [];
    const navigations = [];
    const recoverCalls = [];
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
                    blocker: 'app-crash',
                    message: 'The main app window is on the crash recovery screen instead of the settings shell. Fix or clear the app crash, then rerun the activity-surfaces QA capture.',
                };
            }
            return {
                kind: 'ready',
            };
        },
        recoverAppCrash: async (options) => {
            recoverCalls.push(options);
            return true;
        },
    });

    assert.deepEqual(result, { ok: true, attempts: 2 });
    assert.deepEqual(navigations, []);
    assert.equal(recoverCalls.length, 1);
    assert.deepEqual(warnings, []);
});

test('tauri activity-surfaces QA captures a crash snapshot before failing closed when app-crash recovery fails', async () => {
    assert.equal(typeof qaModule.ensureActivitySurfacesSettingsShellReady, 'function');

    const crashCaptures = [];
    const warnings = [];
    const recoverCalls = [];

    await assert.rejects(
        () => qaModule.ensureActivitySurfacesSettingsShellReady({
            appIdentifier: 9223,
            env: { HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
            artifactRoot: '/tmp/activity-surfaces-artifacts',
            preflightPlan: {
                ...preflightModule.buildActivitySurfacesPreflightPlan(),
                maxAttempts: 2,
            },
            navigateWebview: async () => {},
            appendWarning: async (_artifactRoot, text) => {
                warnings.push(text);
            },
            wait: async () => {},
            probeSurface: async () => ({
                kind: 'blocked',
                blocker: 'app-crash',
                message: 'The main app window is on the crash recovery screen instead of the settings shell. Fix or clear the app crash, then rerun the activity-surfaces QA capture.',
            }),
            recoverAppCrash: async (options) => {
                recoverCalls.push(options);
                return false;
            },
            captureBlockedSnapshot: async (options) => {
                crashCaptures.push(options);
            },
        }),
        /crash recovery screen/i,
    );

    assert.equal(recoverCalls.length, 1);
    assert.equal(crashCaptures.length, 1);
    assert.equal(typeof crashCaptures[0].screenshotPath, 'string');
    assert.equal(typeof crashCaptures[0].structurePath, 'string');
    assert.equal(typeof crashCaptures[0].a11yPath, 'string');
    assert.deepEqual(warnings, [
        '- settings preflight blocked (app-crash): The main app window is on the crash recovery screen instead of the settings shell. Fix or clear the app crash, then rerun the activity-surfaces QA capture.',
    ]);
});

test('tauri activity-surfaces QA sanitizes blocked snapshot artifact names to stay within the artifact root', async () => {
    assert.equal(typeof qaModule.ensureActivitySurfacesSettingsShellReady, 'function');

    const crashCaptures = [];
    const artifactRoot = '/tmp/activity-surfaces-artifacts';

    await assert.rejects(
        () => qaModule.ensureActivitySurfacesSettingsShellReady({
            appIdentifier: 9223,
            env: { HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
            artifactRoot,
            preflightPlan: {
                ...preflightModule.buildActivitySurfacesPreflightPlan(),
                maxAttempts: 1,
            },
            navigateWebview: async () => {},
            appendWarning: async () => {},
            wait: async () => {},
            probeSurface: async () => ({
                kind: 'blocked',
                blocker: '../../../evil',
                message: 'blocked',
            }),
            recoverAppCrash: async () => false,
            captureBlockedSnapshot: async (options) => {
                crashCaptures.push(options);
            },
        }),
        /blocked/,
    );

    assert.equal(crashCaptures.length, 1);
    assert.equal(crashCaptures[0].screenshotPath.startsWith(`${artifactRoot}/`), true);
    assert.equal(crashCaptures[0].structurePath.startsWith(`${artifactRoot}/`), true);
    assert.equal(crashCaptures[0].a11yPath.startsWith(`${artifactRoot}/`), true);
});

test('tauri activity-surfaces QA probes the recovered root state before re-navigating after an app-crash recovery', async () => {
    assert.equal(typeof qaModule.ensureActivitySurfacesSettingsShellReady, 'function');

    const warnings = [];
    const navigations = [];
    const clicks = [];
    let probeCallCount = 0;

    const result = await qaModule.ensureActivitySurfacesSettingsShellReady({
        appIdentifier: 9223,
        env: { HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
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
        recoverAppCrash: async () => true,
        probeSurface: async () => {
            probeCallCount += 1;
            if (probeCallCount === 1) {
                return {
                    kind: 'blocked',
                    blocker: 'app-crash',
                    message: 'The main app window is on the crash recovery screen instead of the settings shell. Fix or clear the app crash, then rerun the activity-surfaces QA capture.',
                };
            }
            if (probeCallCount === 2) {
                return {
                    kind: 'action',
                    selector: '[data-testid="setupWizard.surface-skip"]',
                };
            }
            return {
                kind: 'ready',
            };
        },
    });

    assert.deepEqual(result, { ok: true, attempts: 3 });
    assert.deepEqual(navigations, []);
    assert.deepEqual(clicks, ['[data-testid="setupWizard.surface-skip"]']);
    assert.deepEqual(warnings, []);
});

test('tauri activity-surfaces QA degrades repeated desktop-settings navigation into a warning so the dedicated page opener can take over', async () => {
    assert.equal(typeof qaModule.ensureActivitySurfacesSettingsShellReady, 'function');

    const warnings = [];
    const navigations = [];
    let probeCallCount = 0;

    const result = await qaModule.ensureActivitySurfacesSettingsShellReady({
        appIdentifier: 9223,
        env: { EXISTING: 'value' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        preflightPlan: {
            ...preflightModule.buildActivitySurfacesPreflightPlan(),
            maxAttempts: 8,
            desktopSettingsShellMaxAttempts: 2,
        },
        navigateWebview: async (pathname) => {
            navigations.push(pathname);
        },
        appendWarning: async (_artifactRoot, text) => {
            warnings.push(text);
        },
        wait: async () => {},
        probeSurface: async () => {
            probeCallCount += 1;
            return {
                kind: 'navigate',
                targetPath: '/settings/desktop',
                reason: 'settings-shell-not-visible-yet',
            };
        },
    });

    assert.deepEqual(result, { ok: true, attempts: 2 });
    assert.deepEqual(navigations, []);
    assert.equal(probeCallCount, 3);
    assert.deepEqual(warnings, [
        '- settings preflight could not confirm the desktop settings shell after repeated navigation; continuing so the dedicated desktop settings page opener can retry the page directly',
    ]);
});

test('tauri activity-surfaces QA can recover from a crash screen discovered after the desktop settings retry budget is exhausted', async () => {
    assert.equal(typeof qaModule.ensureActivitySurfacesSettingsShellReady, 'function');

    const recoverCalls = [];
    let probeCallCount = 0;

    const result = await qaModule.ensureActivitySurfacesSettingsShellReady({
        appIdentifier: 9223,
        env: { HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        preflightPlan: {
            ...preflightModule.buildActivitySurfacesPreflightPlan(),
            maxAttempts: 8,
            desktopSettingsShellMaxAttempts: 2,
        },
        navigateWebview: async () => {},
        appendWarning: async () => {},
        wait: async () => {},
        recoverAppCrash: async (options) => {
            recoverCalls.push(options);
            return true;
        },
        probeSurface: async () => {
            probeCallCount += 1;
            if (probeCallCount <= 2) {
                return {
                    kind: 'navigate',
                    targetPath: '/settings/desktop',
                    reason: 'settings-shell-not-visible-yet',
                };
            }
            if (probeCallCount === 3) {
                return {
                    kind: 'blocked',
                    blocker: 'app-crash',
                    message: 'crash',
                };
            }
            return { kind: 'ready' };
        },
    });

    assert.equal(result?.ok, true);
    assert.equal(recoverCalls.length, 1);
});

test('tauri activity-surfaces QA bounds the initial driver-session resolution timeout before first artifact capture', async () => {
    assert.equal(typeof qaModule.startDriverSession, 'function');

    const jsonCalls = [];
    const plan = qaModule.buildTauriActivitySurfacesQaPlan({
        env: {
            HAPPIER_TAURI_QA_OUTDIR: '/tmp/happier-activity-surfaces-start-driver-session',
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
        },
    });

    const driverSession = await qaModule.startDriverSession(plan, {
        runCliJson: async (args, options = {}) => {
            jsonCalls.push({ args, options });
            if (args[0] === 'driver-session' && args[1] === 'start') {
                return { text: 'Session started with app: Tauri App (localhost:9223) (localhost:9223) [DEFAULT]' };
            }
            if (args[0] === 'driver-session' && args[1] === 'status') {
                return { text: JSON.stringify({ connected: true, port: 9223, identifier: 'com.happier.stack.repo-dev-a1cc5e0671' }) };
            }
            throw new Error(`Unexpected JSON call: ${args.join(' ')}`);
        },
    });

    assert.equal(driverSession.driverSessionPort, 9223);
    assert.equal(driverSession.resolvedAppIdentifier, 'com.happier.stack.repo-dev-a1cc5e0671');
    assert.equal(String(driverSession.driverSessionStatusResponse?.text ?? '').includes('repo-dev-a1cc5e0671'), true);
    assert.equal(jsonCalls.length >= 1, true);
    assert.equal(
        jsonCalls.every(({ options }) => options.timeoutMs === 20_000),
        true,
    );
});

test('tauri activity-surfaces QA forwards the active QA env into driver-session attach commands', async () => {
    assert.equal(typeof qaModule.startDriverSession, 'function');

    const jsonCalls = [];
    const plan = qaModule.buildTauriActivitySurfacesQaPlan({
        env: {
            HAPPIER_TAURI_QA_OUTDIR: '/tmp/happier-activity-surfaces-start-driver-session-env',
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.activity-surfaces-qa',
        },
    });

    const driverSession = await qaModule.startDriverSession(plan, {
        env: {
            HAPPIER_TAURI_QA_OUTDIR: '/tmp/happier-activity-surfaces-start-driver-session-env',
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.activity-surfaces-qa',
        },
        runCliJson: async (args, options = {}) => {
            jsonCalls.push({ args, options });
            if (args[0] === 'driver-session' && args[1] === 'start') {
                return { text: 'Session started with app: Tauri App (localhost:9223) (localhost:9223) [DEFAULT]' };
            }
            if (args[0] === 'driver-session' && args[1] === 'status') {
                return { text: JSON.stringify({ connected: true, port: 9223, identifier: 'com.happier.stack.activity-surfaces-qa' }) };
            }
            throw new Error(`Unexpected JSON call: ${args.join(' ')}`);
        },
    });

    assert.equal(driverSession.driverSessionPort, 9223);
    assert.equal(driverSession.resolvedAppIdentifier, 'com.happier.stack.activity-surfaces-qa');
    assert.equal(jsonCalls.length >= 1, true);
    assert.equal(
        jsonCalls.every(({ options }) => options.env?.HAPPIER_TAURI_MCP_APP_IDENTIFIER === 'com.happier.stack.activity-surfaces-qa'),
        true,
    );
});

test('tauri activity-surfaces QA retries driver-session bootstrap while the launcher is still becoming attachable', async () => {
    assert.equal(typeof qaModule.runTauriActivitySurfacesQaCapture, 'function');

    const startDriverSessionCalls = [];
    const waits = [];
    const stageTrace = [];

    const result = await qaModule.runTauriActivitySurfacesQaCapture({
        plan: {
            artifactRoot: '/tmp/happier-activity-surfaces-launcher-retry',
            trackerPath: '/tmp/happier-activity-surfaces-tracker.md',
            steps: canonicalActivitySurfacesProofStepIds.map((id) => ({ id })),
            preflight: { settingsPath: '/settings' },
            manual: [],
        },
        env: {
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.activity-surfaces-qa',
        },
        ensureWorkspaceBuilt: async () => {},
        ensureArtifactDir: async () => {},
        wait: async (ms) => {
            waits.push(ms);
        },
        startDriverSessionImpl: async () => {
            startDriverSessionCalls.push(startDriverSessionCalls.length + 1);
            if (startDriverSessionCalls.length === 1) {
                throw new Error('Unable to resolve a connected Tauri app identifier from driver-session status. Tried ports: 9223, 9224, 9225');
            }
            return {
                driverSessionPort: 9223,
                resolvedAppIdentifier: 'com.happier.stack.activity-surfaces-qa',
                driverSessionCommand: 'driver-session-start',
                driverSessionResponseFile: '/tmp/driver-session.json',
                driverSessionStatusCommand: 'driver-session-status',
                driverSessionStatusResponseFile: '/tmp/driver-session-status.json',
            };
        },
        runCli: async () => ({
            stdout: '{"text":"{\\"connected\\":true,\\"apps\\":[{\\"port\\":9223,\\"identifier\\":\\"com.happier.stack.activity-surfaces-qa\\",\\"isDefault\\":true}]}"}',
        }),
        writeArtifact: async () => {},
        ensureSettingsReady: async () => ({ ok: true, attempts: 1 }),
        seedSession: async () => ({ sessionId: 'sess_seeded_overlay' }),
        hydrateSeededSession: async () => true,
        runOverlayCapture: async () => createCompleteSyntheticQaOverlayCaptureResult(),
        appendTracker: async () => {},
        appendStageTrace: async (_artifactRoot, entry) => {
            stageTrace.push(entry);
        },
        driverSessionRetryAttempts: 2,
        driverSessionRetryDelayMs: 0,
    });

    assert.equal(result.ok, true);
    assert.equal(result.appIdentifier, 'com.happier.stack.activity-surfaces-qa');
    assert.equal(startDriverSessionCalls.length, 2);
    assert.deepEqual(waits, [0]);
    assert.deepEqual(stageTrace.slice(0, 2), [
        { stage: 'driver_session', status: 'start' },
        { stage: 'driver_session', status: 'done', driverSessionPort: 9223, appIdentifier: 'com.happier.stack.activity-surfaces-qa' },
    ]);
});

test('tauri activity-surfaces QA restarts the stack runtime before retrying driver-session bootstrap when no Tauri app is found', async () => {
    assert.equal(typeof qaModule.runTauriActivitySurfacesQaCapture, 'function');

    const startDriverSessionCalls = [];
    const ensureDriverSessionReadyCalls = [];

    const result = await qaModule.runTauriActivitySurfacesQaCapture({
        plan: {
            artifactRoot: '/tmp/happier-activity-surfaces-launcher-restart',
            trackerPath: '/tmp/happier-activity-surfaces-tracker.md',
            steps: canonicalActivitySurfacesProofStepIds.map((id) => ({ id })),
            preflight: { settingsPath: '/settings' },
            manual: [],
        },
        env: {
            HAPPIER_STACK_STACK: 'activity-surfaces-qa',
            HAPPIER_STACK_TAURI_IDENTIFIER: 'com.happier.stack.activity-surfaces-qa',
        },
        ensureWorkspaceBuilt: async () => {},
        ensureArtifactDir: async () => {},
        wait: async () => {},
        ensureDriverSessionReady: async (options) => {
            ensureDriverSessionReadyCalls.push(options);
        },
        startDriverSessionImpl: async () => {
            startDriverSessionCalls.push(startDriverSessionCalls.length + 1);
            if (startDriverSessionCalls.length === 1) {
                throw new Error('Session start failed - no Tauri app found');
            }
            return {
                driverSessionPort: 9223,
                resolvedAppIdentifier: 'com.happier.stack.activity-surfaces-qa',
                driverSessionCommand: 'driver-session-start',
                driverSessionResponseFile: '/tmp/driver-session.json',
                driverSessionStatusCommand: 'driver-session-status',
                driverSessionStatusResponseFile: '/tmp/driver-session-status.json',
            };
        },
        runCli: async () => ({
            stdout: '{"text":"{\\"connected\\":true,\\"apps\\":[{\\"port\\":9223,\\"identifier\\":\\"com.happier.stack.activity-surfaces-qa\\",\\"isDefault\\":true}]}"}',
        }),
        writeArtifact: async () => {},
        ensureSettingsReady: async () => ({ ok: true, attempts: 1 }),
        seedSession: async () => ({ sessionId: 'sess_seeded_overlay' }),
        hydrateSeededSession: async () => true,
        runOverlayCapture: async () => createCompleteSyntheticQaOverlayCaptureResult(),
        appendTracker: async () => {},
        appendStageTrace: async () => {},
        driverSessionRetryAttempts: 2,
        driverSessionRetryDelayMs: 0,
    });

    assert.equal(result.ok, true);
    assert.equal(startDriverSessionCalls.length, 2);
    assert.equal(ensureDriverSessionReadyCalls.length, 1);
    assert.equal(ensureDriverSessionReadyCalls[0]?.appIdentifier ?? null, null);
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
        '[data-testid="onboarding-wizard-welcome-auth"]',
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
    assert.equal(visibilityChecks[0], '[data-testid="restore-manual-secret-input"]');
    assert.ok(visibilityChecks.includes('[data-testid="welcome-restore"]'));
    assert.ok(visibilityChecks.includes('[data-testid="restore-manual-secret-input"]'));
});

test('tauri activity-surfaces QA restore helper advances through the auth welcome shell via skip before waiting for restore controls', async () => {
    assert.equal(typeof qaModule.restoreActivitySurfacesAuthWithDevKey, 'function');

    const clicks = [];
    const navigations = [];
    const typed = [];
    const visibilityChecks = [];
    let restoreManualVisible = false;

    const restored = await qaModule.restoreActivitySurfacesAuthWithDevKey({
        appIdentifier: 9223,
        env: { HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateWebview: async (pathname) => {
            navigations.push(pathname);
            if (pathname === '/restore/manual') {
                restoreManualVisible = true;
            }
        },
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
            if (selector === '[data-testid="restore-manual-secret-input"]') {
                return restoreManualVisible;
            }
            if (selector === '[data-testid="restore-open-manual"]') {
                return false;
            }
            if (selector === '[data-testid="welcome-restore"]') {
                return false;
            }
            if (selector === '[data-testid="onboarding-wizard-welcome-auth"]') {
                return !clicks.includes('[data-testid="onboarding-wizard-skip"]');
            }
            if (selector === '[data-testid="onboarding-wizard-skip"]') {
                return !clicks.includes('[data-testid="onboarding-wizard-skip"]');
            }
            return false;
        },
        isSelectorPresentByDomQuery: async () => false,
        waitForAuthCompletion: async () => true,
        wait: async () => {},
    });

    assert.equal(restored, true);
    assert.deepEqual(clicks, [
        '[data-testid="onboarding-wizard-skip"]',
        '[data-testid="restore-manual-submit"]',
    ]);
    assert.deepEqual(navigations, ['/restore/manual']);
    assert.deepEqual(typed, [
        {
            selector: '[data-testid="restore-manual-secret-input"]',
            text: 'AAAAB-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH-IIIII-JJJJJ-KKKKK',
        },
    ]);
    assert.equal(visibilityChecks[0], '[data-testid="restore-manual-secret-input"]');
    assert.ok(visibilityChecks.includes('[data-testid="onboarding-wizard-welcome-auth"]'));
    assert.ok(visibilityChecks.includes('[data-testid="onboarding-wizard-skip"]'));
    assert.ok(visibilityChecks.includes('[data-testid="welcome-restore"]'));
    assert.ok(visibilityChecks.includes('[data-testid="restore-manual-secret-input"]'));
});

test('tauri activity-surfaces QA restore helper falls back to a DOM query when wait-for misses the welcome restore button', async () => {
    assert.equal(typeof qaModule.restoreActivitySurfacesAuthWithDevKey, 'function');

    const clicks = [];
    const typed = [];
    const visibilityChecks = [];
    const domQueryChecks = [];
    const visibilityPlan = new Map([
        ['[data-testid="restore-manual-secret-input"]', [false, true]],
        ['[data-testid="welcome-restore"]', [false, false, false, false, false, false]],
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
        isSelectorPresentByDomQuery: async (selector, options) => {
            domQueryChecks.push({ selector, timeoutMs: options?.timeoutMs ?? null });
            return selector === '[data-testid="welcome-restore"]';
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
    assert.deepEqual(domQueryChecks, [
        {
            selector: '[data-testid="welcome-restore"]',
            timeoutMs: 1_200,
        },
    ]);
});

test('tauri activity-surfaces QA restore helper falls back to the manual restore route when wait-for misses the manual restore button', async () => {
    assert.equal(typeof qaModule.restoreActivitySurfacesAuthWithDevKey, 'function');

    const clicks = [];
    const navigations = [];
    const typed = [];
    const visibilityChecks = [];
    const domQueryChecks = [];
    let restoreManualRouteVisible = false;
    const restored = await qaModule.restoreActivitySurfacesAuthWithDevKey({
        appIdentifier: 9223,
        env: { HAPPIER_STACK_STACK: 'activity-surfaces-qa' },
        artifactRoot: '/tmp/activity-surfaces-artifacts',
        navigateWebview: async (pathname) => {
            navigations.push(pathname);
            if (pathname.startsWith('/restore/manual')) {
                restoreManualRouteVisible = true;
            }
        },
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
            if (selector === '[data-testid="restore-manual-secret-input"]') {
                return restoreManualRouteVisible;
            }
            if (selector === '[data-testid="welcome-restore"]') {
                return false;
            }
            if (selector === '[data-testid="onboarding-wizard-welcome-auth"]') {
                return !clicks.includes('[data-testid="onboarding-wizard-primary"]');
            }
            if (selector === '[data-testid="onboarding-wizard-primary"]') {
                return !clicks.includes('[data-testid="onboarding-wizard-primary"]');
            }
            if (selector === '[data-testid="restore-open-manual"]') {
                return false;
            }
            return false;
        },
        isSelectorPresentByDomQuery: async (selector, options) => {
            domQueryChecks.push({ selector, timeoutMs: options?.timeoutMs ?? null });
            return false;
        },
        waitForAuthCompletion: async () => true,
        wait: async () => {},
    });

    assert.equal(restored, true);
    assert.ok(clicks.includes('[data-testid="restore-manual-submit"]'));
    assert.ok(navigations.some((pathname) => pathname.startsWith('/restore/manual')));
    assert.deepEqual(typed, [
        {
            selector: '[data-testid="restore-manual-secret-input"]',
            text: 'AAAAB-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG-HHHHH-IIIII-JJJJJ-KKKKK',
        },
    ]);
    assert.ok(domQueryChecks.some((entry) => entry.selector === '[data-testid="welcome-restore"]' && entry.timeoutMs === 1_200));
    assert.ok(domQueryChecks.some((entry) => entry.selector === '[data-testid="restore-open-manual"]' && entry.timeoutMs === 1_200));
});

test('tauri activity-surfaces QA restore helper opens manual restore after the welcome restore surface when the secret input is still hidden', async () => {
    assert.equal(typeof qaModule.restoreActivitySurfacesAuthWithDevKey, 'function');

    const clicks = [];
    const typed = [];
    const visibilityChecks = [];
    const visibilityPlan = new Map([
        ['[data-testid="welcome-restore"]', [true]],
        ['[data-testid="restore-open-manual"]', [false, true]],
        ['[data-testid="restore-manual-secret-input"]', [false, false, false, false, true]],
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
        isSelectorPresentByDomQuery: async () => false,
        waitForAuthCompletion: async () => true,
        wait: async () => {},
    });

    assert.equal(restored, true);
    assert.deepEqual(clicks, [
        '[data-testid="welcome-restore"]',
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
        '[data-testid="restore-manual-secret-input"]',
        '[data-testid="restore-manual-secret-input"]',
        '[data-testid="restore-manual-secret-input"]',
        '[data-testid="restore-open-manual"]',
        '[data-testid="restore-open-manual"]',
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
    assert.deepEqual(navigations, ['/settings/desktop']);
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
