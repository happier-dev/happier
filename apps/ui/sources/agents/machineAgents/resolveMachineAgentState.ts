import type { MachineAgent, MachineAgentState } from './machineAgentTypes';
import { isNewerVersion } from '@/updates/items/updateItem';

/** Readiness is derived here; consumers only choose how to present this state. */
export function resolveMachineAgentState(input: Pick<MachineAgent, 'installed' | 'platform' | 'signIn' | 'dependencies' | 'version' | 'latestVersion' | 'update' | 'job'> & Readonly<{
    known?: boolean;
    checking?: boolean;
    /** Launch must prove the selected credential, unlike aggregate inventory display. */
    requireSignedIn?: boolean;
    /** Selected Provider authorization and compatibility, when that route is used. */
    credentialRouteReady?: boolean;
    /** False only when the admitted Provider replaces the Agent's authentication. */
    authenticationRequired?: boolean;
}>): MachineAgentState {
    if (input.job?.outcome === null) return 'installing';
    if (input.job?.outcome?.kind === 'failed' && input.job.outcome.code !== 'cancelled') return 'failed';
    if (input.known === false) return input.checking ? 'checking' : 'unknown';
    if (!input.platform.supported) return 'unsupported';
    if (!input.installed || input.dependencies.some((dependency) => !dependency.installed)) return 'notInstalled';
    if (input.credentialRouteReady === false) return 'unknown';
    if (input.authenticationRequired !== false) {
        if (input.signIn.status === 'signedOut') return 'needsSignIn';
        if (input.requireSignedIn && input.signIn.status !== 'signedIn') return 'unknown';
    }
    if (input.update?.supported && input.version && input.latestVersion && isNewerVersion(input.version, input.latestVersion)) return 'updateAvailable';
    return 'ready';
}

export function isMachineAgentReady(agent: Pick<MachineAgent, 'state' | 'stale'> | null | undefined): boolean {
    return Boolean(agent && !agent.stale && (agent.state === 'ready' || agent.state === 'updateAvailable'));
}
