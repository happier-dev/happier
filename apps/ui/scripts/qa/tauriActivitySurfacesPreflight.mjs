const settingsSurfaceSelectors = [
    '[data-testid="settings-desktop-entry"]',
    '[data-testid="settings-desktop-overlay-enabled"]',
];

const onboardingSurfaceSelectors = [
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
];

const onboardingActionSelectors = [
    '[data-testid="onboarding-wizard-skip"]',
    '[data-testid="welcome-retry-server"]',
    '[data-testid="onboarding-wizard-relay:cloud"]',
    '[data-testid="onboarding-wizard-relay:thisComputer"]',
    '[data-testid="onboarding-wizard-relay:customUrl"]',
    '[data-testid="onboarding-wizard-relay-host-local-checklist-row-installRelayRuntime"]',
    '[data-testid="onboarding-wizard-relay-host-local-checklist-row-startRelayRuntime"]',
    '[data-testid="onboarding-wizard-back"]',
    '[data-testid="onboarding-wizard-primary"]',
];

const authSurfaceSelectors = [
    '[data-testid="welcome-create-account"]',
    '[data-testid="welcome-restore"]',
    '[data-testid="welcome-signup-provider"]',
    '[data-testid="welcome-mtls-login"]',
    '[data-testid="welcome-server-loading"]',
];

const setupWizardSurfaceSelectors = [
    '[data-testid="setupWizard.surface"]',
    '[data-testid="setupWizard-branch:local"]',
    '[data-testid="setupWizard-branch:remote"]',
    '[data-testid="setupWizard.surface-primary"]',
];

const setupWizardActionSelectors = [
    '[data-testid="setupWizard.surface-skip"]',
];

function structureTextIncludes(structureText, needle) {
    const text = String(structureText ?? '');
    const target = String(needle ?? '').trim();
    return target ? text.includes(target) : false;
}

function pickFirstRetryableVisibleSelector(selectors, present, triedSelectors) {
    let firstVisibleSelector = null;

    for (const selector of selectors) {
        if (!present.has(selector)) {
            continue;
        }

        if (firstVisibleSelector == null) {
            firstVisibleSelector = selector;
        }

        if (!triedSelectors.has(selector)) {
            return selector;
        }
    }

    return firstVisibleSelector;
}

export function selectorToTestId(selector) {
    const raw = String(selector ?? '').trim();
    const match = raw.match(/^\[data-testid="(.+)"\]$/u);
    return match ? match[1] : raw;
}

export function buildActivitySurfacesPreflightPlan() {
    return {
        settingsSelectors: [...settingsSurfaceSelectors],
        onboardingSelectors: [...onboardingSurfaceSelectors],
        actionSelectors: [...onboardingActionSelectors],
        authSelectors: [...authSurfaceSelectors],
        setupSelectors: [...setupWizardSurfaceSelectors],
        setupActionSelectors: [...setupWizardActionSelectors],
        settingsPath: '/settings',
        maxAttempts: 8,
        settleDelayMs: 600,
        probeSelectorTimeoutMs: 1_200,
    };
}

export function classifyActivitySurfacesPreflightSelectors(
    presentSelectors,
    plan = buildActivitySurfacesPreflightPlan(),
    options = {},
) {
    const present = presentSelectors instanceof Set ? presentSelectors : new Set();
    const triedSelectors = options.triedSelectors instanceof Set ? options.triedSelectors : new Set();

    if (plan.settingsSelectors.some((selector) => present.has(selector))) {
        return { kind: 'ready' };
    }

    if (plan.authSelectors.some((selector) => present.has(selector))) {
        return {
            kind: 'blocked',
            blocker: 'auth',
            message: 'The app reached the auth welcome surface before settings. Sign in or seed a post-auth state, then rerun the activity-surfaces QA capture.',
        };
    }

    if (plan.setupSelectors.some((selector) => present.has(selector))) {
        const selector = pickFirstRetryableVisibleSelector(plan.setupActionSelectors ?? [], present, triedSelectors);
        if (selector) {
            return {
                kind: 'action',
                selector,
            };
        }
        return {
            kind: 'blocked',
            blocker: 'setup-wizard',
            message: 'The app reached the post-auth setup wizard before settings. Complete or dismiss the setup wizard, then rerun the activity-surfaces QA capture.',
        };
    }

    if (plan.onboardingSelectors.some((selector) => present.has(selector))) {
        const selector = pickFirstRetryableVisibleSelector(plan.actionSelectors, present, triedSelectors);
        if (selector) {
            return {
                kind: 'action',
                selector,
            };
        }
        return {
            kind: 'blocked',
            blocker: 'onboarding',
            message: 'The app is still on an onboarding step that the activity-surfaces QA script cannot advance automatically. Complete the wizard until the main app shell is available, then rerun the activity-surfaces QA capture.',
        };
    }

    return {
        kind: 'navigate',
        targetPath: plan.settingsPath,
        reason: 'settings-shell-not-visible-yet',
    };
}

export function analyzeActivitySurfacesPreflightSurface(
    structureText,
    plan = buildActivitySurfacesPreflightPlan(),
    options = {},
) {
    const text = String(structureText ?? '');
    const presentSelectors = new Set(
        [
            ...plan.settingsSelectors,
            ...plan.onboardingSelectors,
            ...plan.actionSelectors,
            ...plan.authSelectors,
            ...plan.setupSelectors,
            ...(plan.setupActionSelectors ?? []),
        ].filter((selector) => structureTextIncludes(text, selectorToTestId(selector))),
    );
    return classifyActivitySurfacesPreflightSelectors(presentSelectors, plan, options);
}

export function resolveActivitySurfacesPreflightSelector(
    structureText,
    options = {},
) {
    const plan = Array.isArray(options.settingsSelectors) || Array.isArray(options.onboardingSelectors)
        ? options
        : options.plan ?? buildActivitySurfacesPreflightPlan();
    const triedSelectors = options.triedSelectors instanceof Set ? options.triedSelectors : new Set();
    const analysis = analyzeActivitySurfacesPreflightSurface(structureText, plan, { triedSelectors });
    if (analysis.kind !== 'action') {
        return null;
    }

    const text = String(structureText ?? '');
    let firstVisibleActionSelector = null;
    for (const selector of plan.actionSelectors) {
        if (!structureTextIncludes(text, selectorToTestId(selector))) {
            continue;
        }
        if (firstVisibleActionSelector == null) {
            firstVisibleActionSelector = selector;
        }
        if (!triedSelectors.has(selector)) {
            return selector;
        }
    }

    if (firstVisibleActionSelector) {
        return firstVisibleActionSelector;
    }

    let firstVisibleSetupSelector = null;
    for (const selector of plan.setupActionSelectors ?? []) {
        if (!structureTextIncludes(text, selectorToTestId(selector))) {
            continue;
        }
        if (firstVisibleSetupSelector == null) {
            firstVisibleSetupSelector = selector;
        }
        if (!triedSelectors.has(selector)) {
            return selector;
        }
    }

    if (firstVisibleSetupSelector) {
        return firstVisibleSetupSelector;
    }

    return null;
}
