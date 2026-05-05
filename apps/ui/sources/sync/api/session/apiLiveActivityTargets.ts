import { z } from 'zod';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { serverFetch } from '@/sync/http/client';
import { runtimeFetchWithServerReachability } from '@/sync/runtime/connectivity/serverReachabilityRuntimeFetch';

const LIVE_ACTIVITY_TARGETS_PATH = '/v1/live-activity-targets';

const LiveActivityTargetRegistrationResponseSchema = z.object({
    success: z.literal(true),
    target: z.object({
        id: z.string().trim().min(1),
    }).passthrough(),
}).passthrough();

const LiveActivityTargetDeleteResponseSchema = z.object({
    success: z.literal(true),
}).passthrough();

export type LiveActivityTargetRegistrationInput = Readonly<{
    deviceId: string;
    serverId: string;
    sessionId: string;
    activityInstanceKey: string;
    activityId: string;
    activityName: 'HappierFocusLiveActivity';
    transportMode: 'hosted_happier_relay' | 'direct_apns' | 'background_wake_best_effort';
    bundleId?: string;
    environment?: 'sandbox' | 'production';
    tokenKind: 'expo_push_token' | 'activitykit_update_token' | 'activitykit_push_to_start_token';
    rawToken?: string;
    expoPushToken?: string;
    clientServerUrl?: string;
}>;

export type LiveActivityTargetRegistrationResult = Readonly<{
    targetId: string;
}>;

type RequestTarget =
    | Readonly<{
        kind: 'active';
        serverUrl: string;
    }>
    | Readonly<{
        kind: 'explicit';
        serverUrl: string;
        token: string;
    }>;

function normalizeBaseUrl(raw: string): string {
    return String(raw ?? '').trim().replace(/\/+$/, '');
}

function normalizeNonEmpty(value: string | null | undefined): string | null {
    const normalized = String(value ?? '').trim();
    return normalized.length > 0 ? normalized : null;
}

async function resolveRequestTarget(serverId: string): Promise<RequestTarget> {
    const requestedServerId = String(serverId ?? '').trim();
    const activeSnapshot = getActiveServerSnapshot();
    if (!requestedServerId || requestedServerId === activeSnapshot.serverId) {
        return {
            kind: 'active',
            serverUrl: normalizeBaseUrl(activeSnapshot.serverUrl),
        };
    }

    const profile = getServerProfileById(requestedServerId);
    const serverUrl = normalizeBaseUrl(profile?.serverUrl ?? '');
    if (!serverUrl) {
        throw new Error('Missing server profile for Live Activity target registration');
    }

    const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, {
        serverId: requestedServerId,
    });
    if (!credentials) {
        throw new Error('Missing server credentials for Live Activity target registration');
    }

    return {
        kind: 'explicit',
        serverUrl,
        token: credentials.token,
    };
}

async function fetchLiveActivityTargetRoute(
    target: RequestTarget,
    path: string,
    init: RequestInit,
): Promise<Response> {
    if (target.kind === 'active') {
        return serverFetch(path, init, { retry: 'none' });
    }

    return runtimeFetchWithServerReachability({
        serverUrl: target.serverUrl,
        token: target.token,
        url: `${target.serverUrl}${path}`,
        init: {
            ...init,
            headers: {
                ...(init.headers ?? {}),
                Authorization: `Bearer ${target.token}`,
            },
        },
    });
}

async function parseJsonResponse(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

function assertSupportedLiveActivityTargetRegistration(input: LiveActivityTargetRegistrationInput): void {
    if (input.tokenKind === 'activitykit_push_to_start_token') {
        throw new Error('Unsupported Live Activity target kind');
    }

    if (input.transportMode === 'background_wake_best_effort') {
        if (input.tokenKind !== 'expo_push_token') {
            throw new Error('Background wake Live Activity targets require Expo push tokens');
        }
        if (!normalizeNonEmpty(input.expoPushToken)) {
            throw new Error('Background wake Live Activity targets require Expo push token payloads');
        }
        return;
    }

    if (input.tokenKind !== 'activitykit_update_token') {
        throw new Error('Remote Live Activity targets require ActivityKit update tokens');
    }
    if (
        !normalizeNonEmpty(input.rawToken)
        || !normalizeNonEmpty(input.bundleId)
        || !normalizeNonEmpty(input.environment)
    ) {
        throw new Error('Remote Live Activity targets require ActivityKit token metadata');
    }
}

export async function registerLiveActivityTarget(
    input: LiveActivityTargetRegistrationInput,
): Promise<LiveActivityTargetRegistrationResult> {
    assertSupportedLiveActivityTargetRegistration(input);

    const target = await resolveRequestTarget(input.serverId);
    const targetServerUrl = normalizeBaseUrl(target.serverUrl);
    const requestInput = input.clientServerUrl || !targetServerUrl
        ? input
        : { ...input, clientServerUrl: targetServerUrl };
    const response = await fetchLiveActivityTargetRoute(target, LIVE_ACTIVITY_TARGETS_PATH, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestInput),
    });

    if (!response.ok) {
        throw new Error(`Failed to register Live Activity target: ${response.status}`);
    }

    const parsed = LiveActivityTargetRegistrationResponseSchema.safeParse(await parseJsonResponse(response));
    if (!parsed.success) {
        throw new Error('Failed to parse Live Activity target registration response');
    }

    return { targetId: parsed.data.target.id };
}

export async function markLiveActivityTargetEnded(
    targetId: string,
    options: Readonly<{ serverId?: string }> = {},
): Promise<void> {
    const normalizedTargetId = String(targetId ?? '').trim();
    if (!normalizedTargetId) {
        throw new Error('Missing Live Activity target id');
    }

    const target = await resolveRequestTarget(options.serverId ?? '');
    const response = await fetchLiveActivityTargetRoute(
        target,
        `${LIVE_ACTIVITY_TARGETS_PATH}/${encodeURIComponent(normalizedTargetId)}`,
        {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
            },
        },
    );

    if (!response.ok) {
        throw new Error(`Failed to mark Live Activity target ended: ${response.status}`);
    }

    if (response.status === 204) return;

    const parsed = LiveActivityTargetDeleteResponseSchema.safeParse(await parseJsonResponse(response));
    if (!parsed.success) {
        throw new Error('Failed to parse Live Activity target delete response');
    }
}
