import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { authGetToken } from '@/auth/flows/getToken';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { encodeBase64 } from '@/encryption/base64';
import { getRandomBytesAsync } from '@/platform/cryptoRandom';
import { useLocalDaemonControl } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { useLocalRelayRuntimeControl } from '@/components/settings/server/localControl/useLocalRelayRuntimeControl';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { probeAuthenticatedServerAuthPingEndpoint } from '@/sync/api/capabilities/probeAuthenticatedServerAuthPingEndpoint';
import {
    getActiveServerSnapshot,
    upsertServerProfileOnly,
} from '@/sync/domains/server/serverRuntime';
import {
    listServerProfiles,
    setActiveServerId,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';
import { canonicalizeServerUrl, createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import type { SystemTaskRunState } from '@/components/systemTasks/types';

import { createPersonalHomeBootstrapFacts } from './personalHomeBootstrapFacts';
import type {
    PersonalHomeBootstrapOperation,
    PersonalHomeFacts,
    RelayRuntimeStatusSnapshot,
} from './personalHomeBootstrapTypes';
import { PersonalHomeBootstrapGate } from './PersonalHomeBootstrapGate';
import type { PersonalHomeBootstrapOperationRunner } from './usePersonalHomeBootstrapController';

const DEFAULT_PERSONAL_HOME_URL = 'http://127.0.0.1:3005';

export class PersonalHomeBootstrapBlockedError extends Error {
    readonly code = 'personal_home_endpoint_unavailable';

    constructor(message: string) {
        super(message);
        this.name = 'PersonalHomeBootstrapBlockedError';
    }
}

function normalizeUrl(value: unknown): string {
    const raw = String(value ?? '').trim();
    return canonicalizeServerUrl(raw) || raw.replace(/\/+$/u, '');
}

function profileMatchesUrl(profile: ServerProfile, url: string): boolean {
    const key = createServerUrlComparableKey(url) || normalizeUrl(url);
    return (createServerUrlComparableKey(profile.serverUrl) || normalizeUrl(profile.serverUrl)) === key
        || (createServerUrlComparableKey(profile.canonicalServerUrl ?? '') || normalizeUrl(profile.canonicalServerUrl)) === key;
}

function mapRelayStatus(status: ReturnType<typeof useLocalRelayRuntimeControl>['status'], error: string | null): RelayRuntimeStatusSnapshot | null {
    if (!status) return null;
    const active = status.service.active;
    const healthy = status.healthy === true;
    const state = !status.installed
        ? 'absent'
        : active === false
            ? 'stopped'
            : healthy
                ? 'healthy'
                : 'unhealthy';
    return {
        installed: status.installed,
        healthy: status.healthy,
        serviceActive: active,
        status: state,
        ...(error ? { error } : {}),
    };
}

function readAnonymousSignup(features: Awaited<ReturnType<typeof getServerFeaturesSnapshot>>): 'enabled' | 'disabled' | 'unknown' {
    if (features.status !== 'ready') return 'unknown';
    const methods = features.features.capabilities.auth.signup?.methods;
    if (!Array.isArray(methods)) return 'unknown';
    const anonymous = methods.find((method) => method.id === 'anonymous');
    return anonymous ? (anonymous.enabled ? 'enabled' : 'disabled') : 'unknown';
}

export type PersonalHomeBootstrapRuntime = Readonly<{
    readFacts: () => Promise<PersonalHomeFacts>;
    operations: Partial<Record<PersonalHomeBootstrapOperation, PersonalHomeBootstrapOperationRunner>>;
}>;

/**
 * Composes the existing runtime, Home profile, auth-storage and daemon owners for the
 * Desktop bootstrap gate. It deliberately does not own any state or switch a focused Home
 * except when the local profile is the first Home on the device.
 */
export function usePersonalHomeBootstrapRuntime(): PersonalHomeBootstrapRuntime {
    const auth = useAuth();
    const relay = useLocalRelayRuntimeControl();
    const daemon = useLocalDaemonControl();
    const resolveLocalUrl = React.useCallback(() => {
        const statusUrl = normalizeUrl(relay.status?.relayUrl);
        if (statusUrl) return statusUrl;
        const profiles = listServerProfiles();
        const local = profiles.find((profile) => profile.source === 'desktop-personal-home')
            ?? profiles.find((profile) => profileMatchesUrl(profile, DEFAULT_PERSONAL_HOME_URL));
        return normalizeUrl(local?.canonicalServerUrl ?? local?.serverUrl) || DEFAULT_PERSONAL_HOME_URL;
    }, [relay.status]);

    const readFacts = React.useCallback(async (): Promise<PersonalHomeFacts> => {
        const profiles = listServerProfiles();
        const localUrl = resolveLocalUrl();
        const candidate = profiles.find((profile) => profileMatchesUrl(profile, localUrl)) ?? null;
        const completed = profiles.find((profile) => profile.source === 'desktop-personal-home' && profileMatchesUrl(profile, localUrl)) ?? null;
        let localHomeReachability: PersonalHomeFacts['localHomeReachability'] = 'unknown';
        let localHomeIdentity = candidate?.serverIdentityId ?? null;
        let anonymousSignup: PersonalHomeFacts['anonymousSignup'] = 'unknown';
        let localHomeAuth: PersonalHomeFacts['localHomeAuth'] = 'missing';

        if (candidate) {
            const features = await getServerFeaturesSnapshot({ serverId: candidate.id, force: true }).catch(() => null);
            if (features?.status === 'ready') {
                localHomeReachability = 'reachable';
                localHomeIdentity = features.features.capabilities.serverIdentity.serverIdentityId ?? localHomeIdentity;
                anonymousSignup = readAnonymousSignup(features);
            } else if (features) {
                localHomeReachability = 'unreachable';
            }
            const credentials = await TokenStorage.getCredentialsForServerUrl(localUrl, candidate.serverIdentityId ? { serverId: candidate.serverIdentityId } : {});
            if (credentials?.token) {
                const probe = await probeAuthenticatedServerAuthPingEndpoint({ endpoint: localUrl, token: credentials.token });
                localHomeAuth = probe.status === 'ready' ? 'present' : probe.status === 'auth_failed' ? 'invalid' : 'unknown';
                if (probe.status === 'server_unreachable') localHomeReachability = 'unreachable';
            }
        }

        const activeTask: SystemTaskRunState | null = relay.activeTaskSnapshot ?? daemon.activeTaskSnapshot ?? null;
        return createPersonalHomeBootstrapFacts({
            hostIsDesktop: true,
            isDesktopMainWindow: true,
            completedPersonalHomeProfile: completed,
            candidateLocalProfile: candidate,
            relayRuntime: mapRelayStatus(relay.status, relay.lastErrorMessage),
            localHomeReachability,
            localHomeIdentity,
            localHomeAuth,
            anonymousSignup,
            daemon: daemon.status,
            activeTask,
        });
    }, [daemon.activeTaskSnapshot, daemon.status, relay.activeTaskSnapshot, relay.lastErrorMessage, relay.status, resolveLocalUrl]);

    const prepareHome = React.useCallback<PersonalHomeBootstrapOperationRunner>(async () => {
        const canonicalServerUrl = resolveLocalUrl();
        const taskId = await relay.runTask('relay.runtime.installOrUpdate.v1', {
            purpose: { kind: 'personal-home', canonicalServerUrl },
        });
        if (!taskId) throw new PersonalHomeBootstrapBlockedError('Personal Home runtime task is unavailable.');
    }, [relay, resolveLocalUrl]);

    const connectApp = React.useCallback<PersonalHomeBootstrapOperationRunner>(async (facts) => {
        const localUrl = normalizeUrl(facts.relayRuntime ? resolveLocalUrl() : DEFAULT_PERSONAL_HOME_URL);
        const profilesBefore = listServerProfiles();
        const profile = facts.candidateLocalProfile ?? profilesBefore.find((entry) => profileMatchesUrl(entry, localUrl))
            // Profile classification is a completion receipt owned by the profile lane. Keep the
            // initial adoption write ordinary until the runtime/auth/sign-up facts are verified.
            ?? upsertServerProfileOnly({ serverUrl: localUrl });
        const credentials = await TokenStorage.getCredentialsForServerUrl(localUrl, profile.serverIdentityId ? { serverId: profile.serverIdentityId } : {});
        if (credentials?.token) return;

        const active = getActiveServerSnapshot();
        const unrelatedProfiles = profilesBefore.some((entry) => !profileMatchesUrl(entry, localUrl));
        if (unrelatedProfiles && normalizeUrl(active.serverUrl) !== localUrl) {
            throw new PersonalHomeBootstrapBlockedError('Local Home authentication requires an explicit endpoint while another Home is focused.');
        }

        if (!profileMatchesUrl(profile, active.serverUrl)) {
            setActiveServerId(profile.id);
        }
        const secret = await getRandomBytesAsync(32);
        const token = await authGetToken(secret);
        const encodedSecret = encodeBase64(secret, 'base64url');
        if (!await TokenStorage.setCredentialsForServerUrl(localUrl, { token, secret: encodedSecret }, profile.serverIdentityId ? { serverId: profile.serverIdentityId } : {})) {
            throw new Error('Failed to save Personal Home credentials.');
        }
        await auth.login(token, encodedSecret);
    }, [auth, resolveLocalUrl]);

    const closeSignup = React.useCallback<PersonalHomeBootstrapOperationRunner>(async () => {
        const canonicalServerUrl = resolveLocalUrl();
        // Persist the managed server.env policy through the canonical installer before restart.
        const writeTaskId = await relay.runTask('relay.runtime.installOrUpdate.v1', {
            purpose: { kind: 'personal-home', canonicalServerUrl },
            anonymousSignupEnabled: false,
        });
        if (!writeTaskId) throw new PersonalHomeBootstrapBlockedError('Personal Home signup policy update is unavailable.');
        const taskId = await relay.runTask('relay.runtime.start.v1', {
            purpose: { kind: 'personal-home', canonicalServerUrl },
            anonymousSignupEnabled: false,
        });
        if (!taskId) throw new PersonalHomeBootstrapBlockedError('Personal Home signup-closure task is unavailable.');
    }, [relay, resolveLocalUrl]);

    const prepareComputer = React.useCallback<PersonalHomeBootstrapOperationRunner>(async () => {
        if (daemon.canInstall) await daemon.installBackgroundService();
        if (daemon.canStart) await daemon.startDaemonService();
        else if (daemon.status?.serviceInstalled === true && daemon.status.daemonRunning !== true && !daemon.status.needsAuth) {
            await daemon.startDaemonService();
        }
    }, [daemon]);

    return { readFacts, operations: { 'prepare-home': prepareHome, 'connect-app': connectApp, 'close-signup': closeSignup, 'prepare-computer': prepareComputer } };
}

export function PersonalHomeBootstrapRuntimeMount(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
    const runtime = usePersonalHomeBootstrapRuntime();
    return (
        <PersonalHomeBootstrapGate readFacts={runtime.readFacts} operations={runtime.operations}>
            {props.children}
        </PersonalHomeBootstrapGate>
    );
}
