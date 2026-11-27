import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import type { PersonalHomeBootstrapSnapshot } from '@/components/personalHome/bootstrap/personalHomeBootstrapTypes';
import { PersonalHomeSetupSurface } from '@/components/personalHome/setup/PersonalHomeSetupSurface';

const noop = () => {};
const base: PersonalHomeBootstrapSnapshot = {
    shouldGateShell: true,
    homeReady: false,
    daemonReady: false,
    phase: 'ensuring-home',
    daemonState: 'not-started',
    action: 'none',
    progressMilestones: { runtimeHealthy: true, identityVerified: true, authenticated: false, signupClosed: false },
};

/** Every state the first-run setup surface draws, from the canonical snapshot shapes the bootstrap owner publishes. */
const STATES: Readonly<Record<string, PersonalHomeBootstrapSnapshot>> = {
    working: base,
    checking: { ...base, phase: 'checking', progressMilestones: undefined },
    choice: { ...base, phase: 'blocked', action: 'choose-existing-runtime',
        detail: { code: 'existing_runtime', message: 'An existing local Home needs a choice before setup can continue.', retryable: false } },
    credentials: { ...base, phase: 'blocked', action: 'choose-existing-runtime',
        detail: { code: 'existing_runtime_credentials', message: 'Personal Home credentials could not be verified.', retryable: false } },
    'signed-in': { ...base, phase: 'blocked', action: 'choose-signed-in-home', signedInHomeLabel: 'Happier Cloud',
        detail: { code: 'signed_in_other_home', message: 'This computer is already signed in to another Home.', retryable: false } },
    'use-existing-failed': { ...base, phase: 'blocked', action: 'choose-existing-runtime',
        detail: { code: 'existing_runtime_operation_failed', message: 'Personal Home endpoint is not ready yet.', retryable: true } },
    'update-required': { ...base, phase: 'blocked', action: 'choose-existing-runtime',
        detail: { code: 'personal_home_endpoint_update_required', message: 'The local Home at http://127.0.0.1:3005 does not report a Home identity on /v1/features (0.2.6).', retryable: true } },
    unreachable: { ...base, phase: 'blocked', action: 'choose-existing-runtime',
        detail: { code: 'personal_home_endpoint_unreachable', message: 'Personal Home endpoint is not ready yet.', retryable: true } },
    failure: { ...base, phase: 'blocked', action: 'retry',
        detail: { code: 'runtime_unhealthy', message: 'launchctl bootstrap gui/501 exited with status 5: Input/output error', retryable: true } },
    erased: { ...base, phase: 'blocked', action: 'retry',
        detail: { code: 'personal_home_erased', message: 'Your Personal Home was erased. Try again to create a new one.', retryable: true } },
    ready: { ...base, phase: 'ready', homeReady: true, daemonReady: true, daemonState: 'ready', shouldGateShell: false,
        progressMilestones: { runtimeHealthy: true, identityVerified: true, authenticated: true, signupClosed: true } },
};

/** Public dev specimen outside authenticated runtimes: the real setup surface at `?state=<name>`. */
export default function PersonalHomeSetupSpecimen() {
    const { state } = useLocalSearchParams<{ state?: string }>();
    const snapshot = STATES[state ?? 'working'] ?? base;
    const signedIn = snapshot.action === 'choose-signed-in-home';
    return (
        <PersonalHomeSetupSurface
            key={state}
            snapshot={snapshot}
            onRetry={noop}
            onUseExisting={noop}
            onUseAnotherHome={noop}
            {...(signedIn ? { onKeepSignedInHome: noop, onCreatePersonalHome: noop } : {})}
        />
    );
}
