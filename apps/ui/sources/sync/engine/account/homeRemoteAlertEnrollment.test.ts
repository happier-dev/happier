import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerAccountConnectionProbeHttpResponse } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';

const native = vi.hoisted(() => ({
    prepareContext: vi.fn((_serialized: string) => true),
    removeContext: vi.fn((_serverId: string, _accountId: string | null, _registrationId: string | null) => true),
    clearContext: vi.fn(() => true),
}));
const runtimeFetch = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});

vi.mock('../../../../modules/happier-activity-notifications', () => ({
    readActivityNotificationCapabilities: () => ({ v: 1, platform: 'ios', events: ['ready'] }),
    prepareActivityNotificationStorage: () => '/native/activity-alerts',
    prepareActivityNotificationContext: native.prepareContext,
    removeActivityNotificationContext: native.removeContext,
    clearActivityNotificationContext: native.clearContext,
}));

const { reconcileHomeRemoteAlertEnrollment } = await import('./homeRemoteAlertEnrollment');
const { saveLocalSettings } = await import('@/sync/domains/state/settingsPersistence');
const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');

const HOME = {
    serverId: 'srv_home_a',
    accountId: 'account-a',
    apiEndpoint: 'https://home-a.example.test',
    token: 'ExponentPushToken[device]',
    registrationId: 'row-a',
} as const;

const ACCOUNT_SETTINGS = { sessionRemoteAlertsEnabled: true } as const;

function deviceSettings(previewBehavior: 'include_preview' | 'status_only'): Record<string, unknown> {
    return {
        deviceRemoteAlertsEnabled: true,
        attentionDeviceOverridesV1: {
            enabled: true,
            privacy: { previewBehavior },
        },
    };
}

/** The canonical device attention-policy write the settings UI performs. */
function saveDevicePreviewBehavior(previewBehavior: 'include_preview' | 'status_only'): void {
    saveLocalSettings({
        ...localSettingsDefaults,
        deviceRemoteAlertsEnabled: true,
        attentionDeviceOverridesV1: {
            ...localSettingsDefaults.attentionDeviceOverridesV1,
            enabled: true,
            privacy: { previewBehavior },
        },
    });
}

function publishedRemoteAlertBodies(): Array<Record<string, unknown>> {
    return runtimeFetch.mock.calls
        .map(([params]) => (params as { init?: RequestInit }).init?.body)
        .filter((body): body is string => typeof body === 'string')
        .map((body) => JSON.parse(body) as Record<string, unknown>)
        .filter((body) => body.remoteAlerts !== undefined);
}

function preparedPreviewCeilings(): string[] {
    return native.prepareContext.mock.calls.map(([serialized]) => {
        const envelope = JSON.parse(serialized) as { homes: Array<{ previewCeiling: string }> };
        return envelope.homes.map((home) => home.previewCeiling).join(',');
    });
}

type EnrollmentOverrides = Readonly<{
    readCurrentPolicyInputs?: () => Promise<Readonly<{ accountSettings: unknown; localSettings: unknown }> | null>;
    isStillCurrent?: () => Promise<boolean>;
    localSettings?: unknown;
}>;

async function runEnrollment(params: Readonly<{
    scheduleReconciliation: () => void;
    log?: { log: (message: string) => void };
}> & EnrollmentOverrides): Promise<void> {
    await reconcileHomeRemoteAlertEnrollment({
        credentials: { token: 'home-a-token' },
        token: HOME.token,
        apiEndpoint: HOME.apiEndpoint,
        serverId: HOME.serverId,
        accountId: HOME.accountId,
        accountSettings: ACCOUNT_SETTINGS,
        accountConsentKnown: true,
        localSettings: params.localSettings ?? deviceSettings('include_preview'),
        readCurrentPolicyInputs: params.readCurrentPolicyInputs
            ?? (async () => ({ accountSettings: ACCOUNT_SETTINGS, localSettings: deviceSettings('include_preview') })),
        scheduleReconciliation: params.scheduleReconciliation,
        isStillCurrent: params.isStillCurrent ?? (async () => true),
        log: params.log ?? { log: () => undefined },
    });
}

/**
 * Pause the reconciliation at its Account-encryption read — the last await
 * before the captured device policy is prepared and published.
 */
function installHomeResponses(options: Readonly<{
    failPublish?: boolean;
    encryptionCurrentness?: Record<string, unknown>;
}> = {}): {
    releaseEncryptionRead: () => void;
    encryptionReadStarted: Promise<void>;
} {
    const encryptionRead = createDeferred<void>();
    let signalStarted!: () => void;
    const encryptionReadStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    runtimeFetch.mockImplementation(async (params: { url: string; init?: RequestInit }) => {
        const url = String(params.url);
        if (options.failPublish && url.endsWith('/v1/push-tokens') && params.init?.method === 'POST') {
            throw new Error('home unreachable');
        }
        if (url.endsWith('/v1/push-tokens?projectionVersion=2')) {
            return Response.json({
                v: 2,
                accountRemoteAlerts: { settingsVersion: 1, status: 'current' },
                tokens: [{
                    id: HOME.registrationId,
                    token: HOME.token,
                    createdAt: 1,
                    updatedAt: 1,
                    clientServerUrl: null,
                    remoteAlerts: null,
                }],
            });
        }
        if (url.endsWith('/v1/account/encryption/currentness')) {
            signalStarted();
            await encryptionRead.promise;
            return Response.json(options.encryptionCurrentness ?? {
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
            });
        }
        return new Response(null, { status: 204 });
    });
    // `retry: 'none'` requests (currentness read, token registration) travel through the canonical HTTP
    // owner, whose only boundary is the runtime fetch; route it to the same recorder.
    setRuntimeFetch((input, init) => createServerAccountConnectionProbeHttpResponse(new URL(String(input)).pathname)
        ?? runtimeFetch({ url: String(input), init }));
    return { releaseEncryptionRead: () => encryptionRead.resolve(), encryptionReadStarted };
}

describe('exact-Home remote alert enrollment against device policy mutations', () => {
    beforeEach(() => {
        runtimeFetch.mockReset();
        native.prepareContext.mockClear();
        native.removeContext.mockClear();
        native.clearContext.mockClear();
        saveDevicePreviewBehavior('include_preview');
        native.clearContext.mockClear();
    });

    afterEach(() => {
        resetRuntimeFetch();
        vi.clearAllMocks();
    });

    it('publishes the current device policy when it does not move during the cycle', async () => {
        installHomeResponses().releaseEncryptionRead();
        const scheduleReconciliation = vi.fn();

        await runEnrollment({ scheduleReconciliation });

        expect(publishedRemoteAlertBodies()).toEqual([{
            token: HOME.token,
            remoteAlerts: {
                registrationId: HOME.registrationId,
                policy: expect.objectContaining({ enabled: true, previewCeiling: 'include_preview' }),
            },
        }]);
        expect(preparedPreviewCeilings()).toEqual(['include_preview']);
        expect(scheduleReconciliation).not.toHaveBeenCalled();
    });

    it('withdraws enrollment instead of crashing when a Home answers without recipient readiness', async () => {
        // A released Home that predates the readiness projection omits the field. That is
        // "not ready" — dereferencing it would throw out of the whole enrollment cycle.
        installHomeResponses({
            encryptionCurrentness: {
                mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing', contentKeyFingerprint: 'content', updatedAt: 1,
            },
        }).releaseEncryptionRead();
        const scheduleReconciliation = vi.fn();

        await runEnrollment({ scheduleReconciliation });

        expect(preparedPreviewCeilings()).toEqual([]);
        expect(native.removeContext.mock.calls).toEqual([[HOME.serverId, HOME.accountId, HOME.registrationId]]);
    });

    it('never prepares or publishes a captured policy after a device privacy mutation', async () => {
        const responses = installHomeResponses();
        const scheduleReconciliation = vi.fn();

        const run = runEnrollment({ scheduleReconciliation });
        await responses.encryptionReadStarted;
        saveDevicePreviewBehavior('status_only');
        responses.releaseEncryptionRead();
        await run;

        expect(preparedPreviewCeilings()).toEqual([]);
        expect(publishedRemoteAlertBodies()).toEqual([]);
        expect(native.removeContext.mock.calls).toEqual([[HOME.serverId, HOME.accountId, HOME.registrationId]]);
        expect(scheduleReconciliation).toHaveBeenCalledTimes(1);
    });

    it('discards a stale cycle even when the Home policy reread is unavailable', async () => {
        const responses = installHomeResponses();
        const scheduleReconciliation = vi.fn();

        const run = runEnrollment({
            scheduleReconciliation,
            // An unavailable reread cannot prove the captured policy is current.
            readCurrentPolicyInputs: async () => null,
        });
        await responses.encryptionReadStarted;
        saveDevicePreviewBehavior('status_only');
        responses.releaseEncryptionRead();
        await run;

        expect(preparedPreviewCeilings()).toEqual([]);
        expect(publishedRemoteAlertBodies()).toEqual([]);
        expect(native.removeContext.mock.calls).toEqual([[HOME.serverId, HOME.accountId, HOME.registrationId]]);
        expect(scheduleReconciliation).toHaveBeenCalledTimes(1);
    });

    it('never republishes an older prepared context after the exact Account settings persisted during enrollment', async () => {
        const responses = installHomeResponses();
        const scheduleReconciliation = vi.fn();
        const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');

        const run = runEnrollment({ scheduleReconciliation });
        await responses.encryptionReadStarted;
        saveAccountSettings({ serverId: HOME.serverId, accountId: HOME.accountId }, {
            ...settingsDefaults,
            attentionDeliveryPolicyV1: {
                ...settingsDefaults.attentionDeliveryPolicyV1,
                quietHours: {
                    enabled: true,
                    timezone: 'Europe/Zurich',
                    windows: [{ startLocalTime: '22:00', endLocalTime: '07:00' }],
                },
            },
        }, 1);
        responses.releaseEncryptionRead();
        await run;

        expect(preparedPreviewCeilings()).toEqual([]);
        expect(publishedRemoteAlertBodies()).toEqual([]);
        expect(scheduleReconciliation).toHaveBeenCalledTimes(1);
    });

    it('does not reschedule after a failed publish and keeps the current prepared context', async () => {
        installHomeResponses({ failPublish: true }).releaseEncryptionRead();
        const scheduleReconciliation = vi.fn();
        const messages: string[] = [];

        await runEnrollment({ scheduleReconciliation, log: { log: (message) => messages.push(message) } });

        expect(messages.some((message) => message.includes('Failed to publish remote alert enrollment'))).toBe(true);
        expect(preparedPreviewCeilings()).toEqual(['include_preview']);
        expect(native.removeContext).not.toHaveBeenCalled();
        expect(scheduleReconciliation).not.toHaveBeenCalled();
    });
});
