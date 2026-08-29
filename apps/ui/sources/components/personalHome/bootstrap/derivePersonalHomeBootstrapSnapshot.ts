import type {
    PersonalHomeBootstrapSnapshot,
    PersonalHomeFacts,
    SetupRowState,
} from './personalHomeBootstrapTypes';

function row(id: SetupRowState['id'], status: SetupRowState['status'], detail?: string): SetupRowState {
    return detail ? { id, status, detail } : { id, status };
}

function runtimeIsHealthy(facts: PersonalHomeFacts): boolean {
    const runtime = facts.relayRuntime;
    if (!runtime?.installed) return false;
    if (runtime.status === 'needs-repair' || runtime.status === 'unhealthy' || runtime.serviceActive === false) return false;
    return runtime.healthy === true || runtime.status === 'healthy';
}

function daemonIsReady(facts: PersonalHomeFacts): boolean {
    const daemon = facts.daemon;
    return daemon?.serviceInstalled === true
        && daemon.daemonRunning === true
        && daemon.needsAuth !== true
        && Boolean(daemon.machineId)
        && daemon.daemonMachineRegistered !== false;
}

function daemonState(facts: PersonalHomeFacts): PersonalHomeBootstrapSnapshot['daemonState'] {
    if (daemonIsReady(facts)) return 'ready';
    if (facts.daemon == null) return 'not-started';
    if (facts.daemon.error || facts.daemon.needsAuth) return 'blocked';
    return 'pending';
}

function blockedDetail(facts: PersonalHomeFacts): { message: string; code?: string } | null {
    if (facts.relayRuntime?.error) return { message: facts.relayRuntime.error, code: 'runtime' };
    if (facts.localHomeAuth === 'invalid') return { message: 'Home authentication needs attention.', code: 'home_auth_invalid' };
    if (facts.daemon?.error) return { message: facts.daemon.error, code: 'daemon' };
    return null;
}

/**
 * Derives the bootstrap presentation from host facts only. This function intentionally has no
 * persistence or I/O: relaunching the app therefore resumes from the first missing invariant.
 */
export function derivePersonalHomeBootstrapSnapshot(facts: PersonalHomeFacts): PersonalHomeBootstrapSnapshot {
    const baseRows: SetupRowState[] = [
        row('home', 'pending'),
        row('app', 'pending'),
        row('computer', 'pending'),
    ];

    if (!facts.hostIsDesktop || !facts.isDesktopMainWindow) {
        return {
            shouldGateShell: false,
            homeReady: true,
            daemonReady: daemonIsReady(facts),
            phase: 'ready',
            daemonState: daemonIsReady(facts) ? 'ready' : 'not-started',
            rows: baseRows,
            action: 'none',
        };
    }

    // A completed profile is the durable completion receipt. It must bypass this first-run gate
    // even when the managed runtime or daemon is temporarily offline.
    const alreadyCompleted = facts.completedPersonalHomeProfile != null;
    const runtimeReady = runtimeIsHealthy(facts) || alreadyCompleted;
    const identityReady = facts.localHomeIdentity != null || alreadyCompleted;
    const authReady = (facts.localHomeAuth === 'present' && facts.localHomeReachability === 'reachable') || alreadyCompleted;
    const signupClosed = facts.anonymousSignup === 'disabled' || alreadyCompleted;
    const daemonReady = daemonIsReady(facts);

    if (!alreadyCompleted && facts.candidateLocalProfile != null && facts.relayRuntime?.installed === true) {
        return {
            shouldGateShell: true,
            homeReady: false,
            daemonReady,
            phase: 'blocked',
            daemonState: daemonState(facts),
            rows: [
                row('home', runtimeReady ? 'complete' : 'active'),
                row('app', 'blocked'),
                row('computer', 'pending'),
            ],
            action: 'choose-existing-runtime',
            detail: {
                message: 'An existing local Home needs a choice before setup can continue.',
                code: 'existing_runtime',
                retryable: false,
            },
        };
    }

    if (!runtimeReady) {
        const detail = blockedDetail(facts);
        return {
            shouldGateShell: true,
            homeReady: false,
            daemonReady,
            phase: detail ? 'blocked' : 'preparing-home',
            daemonState: daemonState(facts),
            rows: [row('home', detail ? 'blocked' : 'active', detail?.message), row('app', 'pending'), row('computer', 'pending')],
            action: detail ? 'retry' : 'none',
            ...(detail ? { detail: { ...detail, retryable: true } } : {}),
        };
    }

    if (!identityReady || !authReady) {
        const detail = blockedDetail(facts);
        return {
            shouldGateShell: true,
            homeReady: false,
            daemonReady,
            phase: detail ? 'blocked' : 'connecting-app',
            daemonState: daemonState(facts),
            rows: [row('home', 'complete'), row('app', detail ? 'blocked' : 'active', detail?.message), row('computer', 'pending')],
            action: detail ? 'retry' : 'none',
            ...(detail ? { detail: { ...detail, retryable: true } } : {}),
        };
    }

    if (!signupClosed) {
        const detail = facts.anonymousSignup === 'unknown' ? null : blockedDetail(facts);
        return {
            shouldGateShell: true,
            homeReady: false,
            daemonReady,
            phase: detail ? 'blocked' : 'closing-signup',
            daemonState: daemonState(facts),
            rows: [row('home', 'complete'), row('app', detail ? 'blocked' : 'complete'), row('computer', 'pending')],
            action: detail ? 'retry' : 'none',
            ...(detail ? { detail: { ...detail, retryable: true } } : {}),
        };
    }

    return {
        shouldGateShell: false,
        homeReady: true,
        daemonReady,
        phase: daemonReady ? 'ready' : 'preparing-computer',
        daemonState: daemonState(facts),
        rows: [row('home', 'complete'), row('app', 'complete'), row('computer', daemonReady ? 'complete' : daemonState(facts) === 'blocked' ? 'blocked' : 'active', facts.daemon?.error ?? undefined)],
        action: 'none',
    };
}
