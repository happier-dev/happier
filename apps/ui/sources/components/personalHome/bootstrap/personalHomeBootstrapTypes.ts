import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import type { SystemTaskRunState } from '@/components/systemTasks/types';

export type PersonalHomeBootstrapPhase =
    | 'checking'
    | 'preparing-home'
    | 'connecting-app'
    | 'closing-signup'
    | 'preparing-computer'
    | 'blocked'
    | 'ready';

export type SetupRowId = 'home' | 'app' | 'computer';
export type SetupRowStatus = 'pending' | 'active' | 'complete' | 'blocked';

export type SetupRowState = Readonly<{
    id: SetupRowId;
    status: SetupRowStatus;
    detail?: string;
}>;

export type NormalizedSetupDetail = Readonly<{
    code?: string;
    message: string;
    retryable: boolean;
}>;

export type RelayRuntimeStatusSnapshot = Readonly<{
    installed: boolean;
    healthy?: boolean | null;
    serviceActive?: boolean | null;
    status?: 'absent' | 'installing' | 'stopped' | 'healthy' | 'unhealthy' | 'needs-repair';
    error?: string | null;
}>;

export type LocalDaemonStatus = Readonly<{
    serviceInstalled: boolean;
    daemonRunning: boolean;
    needsAuth: boolean;
    machineId: string | null;
    daemonMachineRegistered?: boolean | null;
    error?: string | null;
}>;

export type PersonalHomeFacts = Readonly<{
    hostIsDesktop: boolean;
    isDesktopMainWindow: boolean;
    completedPersonalHomeProfile: ServerProfile | null;
    candidateLocalProfile: ServerProfile | null;
    relayRuntime: RelayRuntimeStatusSnapshot | null;
    localHomeReachability: 'unknown' | 'unreachable' | 'reachable';
    localHomeIdentity: string | null;
    localHomeAuth: 'missing' | 'present' | 'invalid' | 'unknown';
    anonymousSignup: 'enabled' | 'disabled' | 'unknown';
    daemon: LocalDaemonStatus | null;
    activeTask: SystemTaskRunState | null;
}>;

export type PersonalHomeBootstrapSnapshot = Readonly<{
    shouldGateShell: boolean;
    homeReady: boolean;
    daemonReady: boolean;
    phase: PersonalHomeBootstrapPhase;
    daemonState: 'not-started' | 'pending' | 'ready' | 'blocked';
    rows: readonly SetupRowState[];
    action: 'none' | 'retry' | 'choose-existing-runtime' | 'use-another-home' | 'open-details';
    detail?: NormalizedSetupDetail;
}>;

export type PersonalHomeBootstrapOperation =
    | 'prepare-home'
    | 'connect-app'
    | 'close-signup'
    | 'prepare-computer';

export type PersonalHomeRegistration = Readonly<{
    homeServerIdentityId: string;
    canonicalServerUrl: string;
    localServerUrl: string;
    profileId: string;
}>;
