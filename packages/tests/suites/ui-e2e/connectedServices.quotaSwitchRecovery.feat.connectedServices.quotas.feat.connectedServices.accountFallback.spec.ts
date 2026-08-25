import { test, expect, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
    buildConnectedServiceCredentialRecord,
    sealAccountScopedBlobCiphertext,
    type ConnectedServiceId,
    type ConnectedServiceCredentialHealthV1,
    type SessionRuntimeIssueV1,
} from '@happier-dev/protocol';

import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import {
    createQualifiedConnectedAccountGroup,
    fetchQualifiedConnectedAccountGroup,
} from '../../src/testkit/connectedServicesRecovery';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { setUiFeatureToggle } from '../../src/testkit/uiE2e/setUiFeatureToggle';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const CONNECTED_SERVICE_FEATURE_ENV = {
    HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1',
    HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: '1',
    HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: '1',
    HAPPIER_FEATURE_SESSIONS_USAGE_LIMIT_RECOVERY__ENABLED: '1',
} as const;

type UnknownRecord = Record<string, unknown>;
type SessionTurnMutationResponse = Readonly<{ success?: unknown; reason?: unknown }>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function readString(record: UnknownRecord, key: string): string {
    const value = record[key];
    if (typeof value !== 'string') throw new Error(`Expected string ${key}`);
    return value;
}

function resolveServerLightSqliteDbPath(params: { suiteDir: string }): string {
    return resolve(join(params.suiteDir, 'server-light-data', 'happier-server-light.sqlite'));
}

function readLatestMachineIdFromServerLightDb(params: { suiteDir: string }): string {
    const dbPath = resolveServerLightSqliteDbPath({ suiteDir: params.suiteDir });
    try {
        const raw = execFileSync('sqlite3', ['-json', dbPath, 'select id from Machine order by createdAt desc limit 1;'], {
            encoding: 'utf8',
        });
        const parsed = JSON.parse(raw) as Array<{ id?: unknown }>;
        const id = parsed?.[0]?.id;
        if (typeof id === 'string' && id.trim()) return id.trim();
    } catch {
        // Pollers can retry while the daemon is registering.
    }
    throw new Error(`Failed to read machine id from server light sqlite db: ${dbPath}`);
}

async function waitForLatestMachineId(params: { suiteDir: string; timeoutMs?: number }): Promise<string> {
    const timeoutMs = params.timeoutMs ?? 60_000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        try {
            return readLatestMachineIdFromServerLightDb({ suiteDir: params.suiteDir });
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
    return readLatestMachineIdFromServerLightDb({ suiteDir: params.suiteDir });
}

async function postSessionTurnMutation(params: Readonly<{
    baseUrl: string;
    token: string;
    sessionId: string;
    mutation: Readonly<Record<string, unknown>>;
}>): Promise<void> {
    const response = await fetchJson<SessionTurnMutationResponse>(`${params.baseUrl}/v1/sessions/${params.sessionId}/turns/mutations`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${params.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(params.mutation),
        timeoutMs: 20_000,
    });
    if (response.status !== 200 || response.data?.success !== true) {
        throw new Error(`Failed to post session turn mutation (status=${response.status}, reason=${String(response.data?.reason)})`);
    }
}

async function createAccountIfNeeded(page: Page): Promise<void> {
    await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });
}

async function ensureSwitchEnabled(toggle: Locator): Promise<void> {
    await expect(toggle).toHaveCount(1, { timeout: 60_000 });
    const checked = await toggle.first().getAttribute('aria-checked');
    if (checked !== 'true') {
        await toggle.first().click();
    }
}

async function enableConnectedServiceQuotaUi(params: Readonly<{
    page: Page;
    baseUrl: string;
}>): Promise<void> {
    await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/settings/features?happier_hmr=0`, 180_000);
    await ensureSwitchEnabled(params.page.getByTestId('settings-feature-experiments-toggle'));
    await ensureSwitchEnabled(params.page.getByTestId('settings-feature-toggle-connectedServices'));
    await ensureSwitchEnabled(params.page.getByTestId('settings-feature-toggle-connectedServices.quotas'));
    await setUiFeatureToggle({
        page: params.page,
        baseUrl: params.baseUrl,
        featureId: 'sessions.usageLimitRecovery',
        enabled: true,
    });
    await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/?happier_hmr=0`, 180_000);
    await waitForInitialAppUi({ page: params.page, timeoutMs: 180_000 });
}

async function readAuthTokenFromBrowserStorage(page: Page): Promise<string> {
    const token = await page.evaluate(() => {
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (!key?.startsWith('auth_credentials')) continue;
            const raw = localStorage.getItem(key);
            if (!raw) continue;
            try {
                const parsed = JSON.parse(raw) as { token?: unknown };
                if (typeof parsed.token === 'string' && parsed.token.trim()) {
                    return parsed.token.trim();
                }
            } catch {
                // Keep scanning other auth storage entries.
            }
        }
        return null;
    });

    if (typeof token === 'string' && token.trim()) {
        return token.trim();
    }
    throw new Error('Failed to read auth token from browser storage');
}

async function readLegacyAuthCredentialsFromBrowserStorage(page: Page): Promise<Readonly<{
    token: string;
    secret: Uint8Array;
}>> {
    const credentials = await page.evaluate(() => {
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (!key?.startsWith('auth_credentials')) continue;
            const raw = localStorage.getItem(key);
            if (!raw) continue;
            try {
                const parsed = JSON.parse(raw) as { token?: unknown; secret?: unknown };
                if (
                    typeof parsed.token === 'string'
                    && parsed.token.trim()
                    && typeof parsed.secret === 'string'
                    && parsed.secret.trim()
                ) {
                    return {
                        token: parsed.token.trim(),
                        secret: parsed.secret.trim(),
                    };
                }
            } catch {
                // Keep scanning other auth storage entries.
            }
        }
        return null;
    });

    if (!credentials) {
        throw new Error('Failed to read legacy auth credentials from browser storage');
    }
    return {
        token: credentials.token,
        secret: Buffer.from(credentials.secret, 'base64url'),
    };
}

async function createPlainSession(params: Readonly<{
    baseUrl: string;
    token: string;
    codexBackendMode?: 'appServer' | 'exec';
    providerUsageSourceKind?: string;
}>): Promise<string> {
    const response = await fetchJson<{ session?: { id?: unknown } }>(`${params.baseUrl}/v1/sessions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${params.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            tag: `provider-quota-ui-${run.runId}`,
            metadata: JSON.stringify({
                v: 1,
                name: 'Provider quota UI e2e',
                path: '/tmp/provider-quota-ui-e2e',
                flavor: 'codex',
                codexBackendMode: params.codexBackendMode ?? 'appServer',
                sessionProviderUsageV1: {
                    v: 1,
                    serviceId: 'openai-codex',
                    profileId: 'primary',
                    groupId: 'main-group',
                    sourceKind: params.providerUsageSourceKind ?? 'connected_service_group',
                    capturedAtMs: Date.now(),
                    meters: [
                        {
                            meterId: 'weekly',
                            label: 'Weekly',
                            remainingPct: 12,
                            used: 88,
                            limit: 100,
                            unit: 'count',
                            resetsAtMs: Date.now() + 3_600_000,
                        },
                        {
                            meterId: 'daily',
                            label: 'Daily',
                            remainingPct: 44,
                            used: 56,
                            limit: 100,
                            unit: 'count',
                            resetsAtMs: Date.now() + 1_800_000,
                        },
                    ],
                },
            }),
            agentState: null,
            dataEncryptionKey: null,
            encryptionMode: 'plain',
        }),
        timeoutMs: 20_000,
    });

    const sessionId = response.data?.session?.id;
    if (response.status !== 200 || typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error(`Failed to create provider quota UI session (status=${response.status})`);
    }
    return sessionId;
}

async function createProfileBoundPlainSession(params: Readonly<{
    baseUrl: string;
    token: string;
    serviceId: ConnectedServiceId;
    profileId: string;
    groupId?: string;
    machineId?: string;
    path?: string;
}>): Promise<string> {
    const binding = params.groupId
        ? {
            source: 'connected',
            selection: 'group',
            profileId: params.profileId,
            groupId: params.groupId,
        }
        : {
            source: 'connected',
            selection: 'profile',
            profileId: params.profileId,
        };
    const response = await fetchJson<{ session?: { id?: unknown } }>(`${params.baseUrl}/v1/sessions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${params.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            tag: `connected-auth-chip-ui-${run.runId}`,
            metadata: JSON.stringify({
                v: 1,
                name: 'Connected auth chip UI e2e',
                path: params.path ?? '/tmp/connected-auth-chip-ui-e2e',
                ...(params.machineId ? { machineId: params.machineId } : {}),
                flavor: 'claude',
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        [params.serviceId]: binding,
                    },
                },
            }),
            agentState: null,
            dataEncryptionKey: null,
            encryptionMode: 'plain',
        }),
        timeoutMs: 20_000,
    });

    const sessionId = response.data?.session?.id;
    if (response.status !== 200 || typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error(`Failed to create connected auth chip UI session (status=${response.status})`);
    }
    return sessionId;
}

async function createConnectedServiceProfile(params: Readonly<{
    baseUrl: string;
    token: string;
    secret: Uint8Array;
    serviceId: ConnectedServiceId;
    profileId: string;
    providerEmail: string;
}>): Promise<void> {
    const now = Date.now();
    const record = buildConnectedServiceCredentialRecord({
        now,
        serviceId: params.serviceId,
        profileId: params.profileId,
        kind: 'oauth',
        expiresAt: now + 60 * 60_000,
        oauth: {
            accessToken: `access-${params.profileId}`,
            refreshToken: `refresh-${params.profileId}`,
            idToken: `id-${params.profileId}`,
            scope: null,
            tokenType: null,
            providerAccountId: `acct-${params.profileId}`,
            providerEmail: params.providerEmail,
        },
    });
    const ciphertext = sealAccountScopedBlobCiphertext({
        kind: 'connected_service_credential',
        material: { type: 'legacy', secret: params.secret },
        payload: record,
        randomBytes: (length) => randomBytes(length),
    });

    const response = await fetchJson<{ success?: boolean }>(
        `${params.baseUrl}/v2/connect/${params.serviceId}/profiles/${params.profileId}/credential`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${params.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                sealed: { format: 'account_scoped_v1', ciphertext },
                metadata: {
                    kind: 'oauth',
                    providerEmail: params.providerEmail,
                    providerAccountId: `acct-${params.profileId}`,
                    expiresAt: record.expiresAt,
                },
            }),
            timeoutMs: 20_000,
        },
    );
    expect(response.status).toBe(200);
    expect(response.data?.success).toBe(true);
}

async function patchConnectedServiceCredentialHealth(params: Readonly<{
    baseUrl: string;
    token: string;
    serviceId: ConnectedServiceId;
    profileId: string;
    health: ConnectedServiceCredentialHealthV1;
}>): Promise<void> {
    const response = await fetchJson<{ success?: boolean }>(
        `${params.baseUrl}/v3/connect/${params.serviceId}/profiles/${params.profileId}/credential/health`,
        {
            method: 'PATCH',
            headers: {
                Authorization: `Bearer ${params.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ health: params.health }),
            timeoutMs: 20_000,
        },
    );
    expect(response.status).toBe(200);
    expect(response.data?.success).toBe(true);
}

async function expectRealSwitchSessionEventRecorded(params: Readonly<{
    baseUrl: string;
    token: string;
    sessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
}>): Promise<void> {
    await waitFor(async () => {
        const url = new URL(`${params.baseUrl}/v1/sessions/${params.sessionId}/messages`);
        url.searchParams.set('limit', '100');
        url.searchParams.set('afterSeq', '0');
        url.searchParams.set('scope', 'main');
        url.searchParams.set('roles', 'event,agent');
        const response = await fetchJson<{ messages?: unknown }>(url.toString(), {
            headers: { Authorization: `Bearer ${params.token}` },
            timeoutMs: 20_000,
        });
        expect(response.status).toBe(200);
        const messages = Array.isArray(response.data?.messages) ? response.data.messages : [];
        const localIdPrefix = [
            'connected-service-account-switch',
            params.serviceId,
            params.groupId,
        ].join(':');
        return messages.some((message) => {
            const record = asRecord(message);
            return record?.messageRole === 'event'
                && typeof record.localId === 'string'
                && record.localId.startsWith(`${localIdPrefix}:`);
        });
    }, {
        timeoutMs: 30_000,
        context: 'real auth-group switch path records a session event',
    });
}

async function publishConnectedServiceRestartSwitchEvent(params: Readonly<{
    baseUrl: string;
    token: string;
    sessionId: string;
    serviceId: ConnectedServiceId;
    groupId: string;
    profileId: string;
}>): Promise<void> {
    const eventWrite = await fetchJson(`${params.baseUrl}/v2/sessions/${params.sessionId}/messages`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${params.token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': `connected-service-restart-status-${params.sessionId}`,
        },
        body: JSON.stringify({
            localId: `connected-service-restart-status-${params.sessionId}`,
            messageRole: 'agent',
            content: {
                t: 'plain',
                v: {
                    role: 'agent',
                    content: {
                        type: 'event',
                        id: `event-connected-service-restart-${params.sessionId}`,
                        data: {
                            type: 'connected-service-account-switch',
                            serviceId: params.serviceId,
                            groupId: params.groupId,
                            fromProfileId: params.profileId,
                            toProfileId: params.profileId,
                            reason: 'account_changed',
                            mode: 'restart_resume',
                        },
                    },
                },
            },
        }),
        timeoutMs: 20_000,
    });
    expect(eventWrite.status).toBe(200);
}

async function publishProviderUsageRuntimeIssue(params: Readonly<{
    baseUrl: string;
    token: string;
    sessionId: string;
    agentId?: string;
    serviceId?: ConnectedServiceId;
    profileId?: string;
    groupId?: string;
    groupExhausted?: boolean;
}>): Promise<void> {
    const occurredAt = Date.now();
    const turnId = `turn-${randomUUID()}`;
    const serviceId = params.serviceId ?? 'openai-codex';
    const profileId = params.profileId ?? 'primary';
    const groupId = params.groupId ?? 'main-group';
    const issue: SessionRuntimeIssueV1 = {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'provider_usage_limit',
        source: 'usage_limit',
        agentId: 'codex',
        occurredAt,
        sanitizedPreview: 'Provider usage limit reached.',
        usageLimit: {
            v: 1,
            resetAtMs: occurredAt + 3_600_000,
            retryAfterMs: 3_600_000,
            quotaScope: 'account',
            recoverability: 'switch_account',
            limitCategory: 'usage_limit',
            quotaSnapshotRef: {
                serviceId,
                profileId,
                groupId,
                fetchedAtMs: occurredAt,
            },
            effectiveMeterId: 'weekly',
            effectiveRemainingPct: 12,
            allWindows: [
                { meterId: 'weekly', scope: 'weekly', remainingPct: 12, resetAtMs: occurredAt + 3_600_000, status: 'ok' },
                { meterId: 'daily', scope: 'daily', remainingPct: 44, resetAtMs: occurredAt + 1_800_000, status: 'ok' },
            ],
            connectedService: {
                serviceId,
                profileId,
                groupId,
                groupExhausted: params.groupExhausted ?? false,
            },
        },
    };

    await postSessionTurnMutation({
        ...params,
        mutation: {
            v: 1,
            action: 'begin',
            sessionId: params.sessionId,
            turnId,
            mutationId: `mutation-${randomUUID()}`,
            observedAt: occurredAt,
            agentId: params.agentId ?? 'codex',
        },
    });
    await postSessionTurnMutation({
        ...params,
        mutation: {
            v: 1,
            action: 'fail',
            sessionId: params.sessionId,
            turnId,
            mutationId: `mutation-${randomUUID()}`,
            observedAt: occurredAt + 1,
            agentId: params.agentId ?? 'codex',
            issue,
        },
    });

    await waitFor(async () => {
        const updated = await fetchSessionV2(params.baseUrl, params.token, params.sessionId);
        return updated.lastRuntimeIssue?.usageLimit?.effectiveRemainingPct === 12;
    }, {
        timeoutMs: 20_000,
        context: 'provider usage runtime issue is visible through v2 session',
    });
}

test.describe('ui e2e: connected-service quota switch and recovery surfaces', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('connected-services-quota-switch-recovery-suite');

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;

    test.beforeAll(async () => {
        test.setTimeout(540_000);
        await mkdir(suiteDir, { recursive: true });

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                ...CONNECTED_SERVICE_FEATURE_ENV,
            },
        });

        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                ...process.env,
                EXPO_PUBLIC_DEBUG: '1',
                EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
                EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-connected-services-quota-recovery-${run.runId}`,
            },
        });

        uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterAll(async () => {
        test.setTimeout(60_000);
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    test('shows the provider quota composer badge and remaining-first popover', async ({ page }) => {
        test.setTimeout(540_000);
        if (!server || !uiBaseUrl) throw new Error('missing ui e2e fixtures');

        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
        await waitForInitialAppUi({ page, timeoutMs: 180_000 });
        await createAccountIfNeeded(page);
        await enableConnectedServiceQuotaUi({ page, baseUrl: uiBaseUrl });
        const authToken = await readAuthTokenFromBrowserStorage(page);
        const sessionId = await createPlainSession({ baseUrl: server.baseUrl, token: authToken });
        await publishProviderUsageRuntimeIssue({ baseUrl: server.baseUrl, token: authToken, sessionId });

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionId}?happier_hmr=0`, 180_000);
        const badge = page.getByTestId('agent-input-provider-quota-badge');
        await expect(badge).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('agent-input-provider-usage-value')).toHaveText('12');
        await page.getByTestId('agent-input-provider-usage-badge').click();

        const popover = page.getByTestId('agent-input-provider-usage-popover');
        await expect(popover).toBeVisible({ timeout: 60_000 });
        await expect(popover.getByTestId('agent-input-provider-usage-meter:weekly')).toContainText(/12%/);
        await expect(popover.getByTestId('agent-input-provider-usage-meter:daily')).toContainText(/44%/);
    });

    test('renders connected-service switch event rows and notification topic controls', async ({ page }) => {
        test.setTimeout(540_000);
        if (!server || !uiBaseUrl) throw new Error('missing ui e2e fixtures');
        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
        await waitForInitialAppUi({ page, timeoutMs: 180_000 });
        await createAccountIfNeeded(page);
        await enableConnectedServiceQuotaUi({ page, baseUrl: uiBaseUrl });
        const authToken = await readAuthTokenFromBrowserStorage(page);
        const sessionId = await createPlainSession({ baseUrl: server.baseUrl, token: authToken });

        const eventWrite = await fetchJson(`${server.baseUrl}/v2/sessions/${sessionId}/messages`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${authToken}`,
                'Content-Type': 'application/json',
                'Idempotency-Key': 'connected-service-switch-event-row',
            },
            body: JSON.stringify({
                localId: 'connected-service-switch-event-row',
                messageRole: 'agent',
                content: {
                    t: 'plain',
                    v: {
                        role: 'agent',
                        content: {
                            type: 'event',
                            id: 'event-account-switch',
                            data: {
                                type: 'connected-service-account-switch',
                                serviceId: 'openai-codex',
                                groupId: 'main-group',
                                fromProfileId: 'primary',
                                toProfileId: 'backup',
                                reason: 'usage_limit',
                                mode: 'hot_apply',
                                effectiveRemainingPct: 12,
                            },
                        },
                    },
                },
            }),
            timeoutMs: 20_000,
        });
        expect(eventWrite.status).toBe(200);

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionId}?happier_hmr=0`, 180_000);
        await expect(page.getByTestId('session-event-connected-service-account-switch')).toBeVisible({ timeout: 60_000 });

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/notifications?happier_hmr=0`, 180_000);
        await expect(page.getByTestId('settings-notifications-connected-service-account-switch')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('settings-notifications-connected-service-quota-blocked')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('settings-notifications-connected-service-quota-recovered')).toBeVisible({ timeout: 60_000 });
    });

    test('routes reconnect-required connected profiles through the same profile identity', async ({ page }) => {
        test.setTimeout(540_000);
        if (!server || !uiBaseUrl) throw new Error('missing ui e2e fixtures');

        const serviceId = 'claude-subscription' satisfies ConnectedServiceId;
        const profileId = `work-${run.runId}`;
        const groupId = `work-group-${run.runId}`;
        const secret = Uint8Array.from(randomBytes(32));

        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
        await waitForInitialAppUi({ page, timeoutMs: 180_000 });
        await createAccountIfNeeded(page);
        await enableConnectedServiceQuotaUi({ page, baseUrl: uiBaseUrl });
        const authToken = await readAuthTokenFromBrowserStorage(page);

        await createConnectedServiceProfile({
            baseUrl: server.baseUrl,
            token: authToken,
            secret,
            serviceId,
            profileId,
            providerEmail: 'work@example.test',
        });
        await createQualifiedConnectedAccountGroup({
            serverBaseUrl: server.baseUrl,
            authToken,
            legacyServiceId: serviceId,
            groupId,
            activeConnectedAccountId: profileId,
            memberConnectedAccountIds: [profileId],
        });
        await patchConnectedServiceCredentialHealth({
            baseUrl: server.baseUrl,
            token: authToken,
            serviceId,
            profileId,
            health: {
                v: 1,
                status: 'needs_reauth',
                reconnectRequired: true,
                lastRefreshFailureKind: 'invalid_grant',
                lastRefreshFailureAt: Date.now(),
            },
        });

        await gotoDomContentLoadedWithRetries(
            page,
            `${uiBaseUrl}/settings/connected-services/profile?serviceId=${encodeURIComponent(serviceId)}&profileId=${encodeURIComponent(profileId)}&happier_hmr=0`,
            180_000,
        );
        await page.waitForLoadState('domcontentloaded');
        const reconnectAction = page.getByTestId('connected-services-profile-action:reconnect');
        await expect(reconnectAction).toBeVisible({ timeout: 60_000 });
        await reconnectAction.click();
        await page.waitForURL((url) =>
            url.pathname.endsWith('/settings/connected-services/oauth')
            && url.searchParams.get('serviceId') === serviceId
            && url.searchParams.get('profileId') === profileId,
        { timeout: 60_000 });

        const groupAfterProfileReconnectNavigation = await fetchQualifiedConnectedAccountGroup({
            serverBaseUrl: server.baseUrl,
            authToken,
            legacyServiceId: serviceId,
            groupId,
        });
        expect(groupAfterProfileReconnectNavigation.activeConnectedAccountId).toBe(profileId);

        const sessionId = await createProfileBoundPlainSession({
            baseUrl: server.baseUrl,
            token: authToken,
            serviceId,
            profileId,
            groupId,
        });
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionId}?happier_hmr=0`, 180_000);
        await page.getByTestId('session-connected-services-auth-chip').click();
        await page.getByTestId([
            'new-session.connected-services.selection-list',
            'new-session-connected-services-root',
            'option',
            `connected-service:${encodeURIComponent(serviceId)}:reauth:${encodeURIComponent(profileId)}`,
        ].join(':')).click();
        await page.waitForURL((url) =>
            url.pathname.endsWith('/settings/connected-services/oauth')
            && url.searchParams.get('serviceId') === serviceId
            && url.searchParams.get('profileId') === profileId,
        { timeout: 60_000 });

        const groupAfterSessionChipReconnectNavigation = await fetchQualifiedConnectedAccountGroup({
            serverBaseUrl: server.baseUrl,
            authToken,
            legacyServiceId: serviceId,
            groupId,
        });
        expect(groupAfterSessionChipReconnectNavigation.activeConnectedAccountId).toBe(profileId);
    });

    test('shows connected-service restart status before inactive resume status', async ({ page }) => {
        test.setTimeout(540_000);
        if (!server || !uiBaseUrl) throw new Error('missing ui e2e fixtures');

        const serviceId = 'claude-subscription' satisfies ConnectedServiceId;
        const profileId = `restart-profile-${run.runId}`;
        const groupId = `restart-group-${run.runId}`;
        const secret = Uint8Array.from(randomBytes(32));

        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
        await waitForInitialAppUi({ page, timeoutMs: 180_000 });
        await createAccountIfNeeded(page);
        await enableConnectedServiceQuotaUi({ page, baseUrl: uiBaseUrl });
        const authToken = await readAuthTokenFromBrowserStorage(page);

        await createConnectedServiceProfile({
            baseUrl: server.baseUrl,
            token: authToken,
            secret,
            serviceId,
            profileId,
            providerEmail: 'restart@example.test',
        });
        await createQualifiedConnectedAccountGroup({
            serverBaseUrl: server.baseUrl,
            authToken,
            legacyServiceId: serviceId,
            groupId,
            activeConnectedAccountId: profileId,
            memberConnectedAccountIds: [profileId],
        });
        const sessionId = await createProfileBoundPlainSession({
            baseUrl: server.baseUrl,
            token: authToken,
            serviceId,
            profileId,
            groupId,
        });
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionId}?happier_hmr=0`, 180_000);
        const connectionStatus = page.getByTestId('agent-input-connection-status-text');
        await expect(connectionStatus).toBeVisible({ timeout: 60_000 });

        await publishConnectedServiceRestartSwitchEvent({
            baseUrl: server.baseUrl,
            token: authToken,
            sessionId,
            serviceId,
            groupId,
            profileId,
        });

        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(connectionStatus).toContainText(/Restart/i, { timeout: 60_000 });
        await expect(connectionStatus).not.toContainText(/Resum|Inactiv/i);
    });

    test('records a switch event emitted by the real auth-group switch path', async ({ page }) => {
        test.setTimeout(720_000);
        if (!server || !uiBaseUrl) throw new Error('missing ui e2e fixtures');

        const serviceId = 'claude-subscription' satisfies ConnectedServiceId;
        const groupId = `main-group-${run.runId}`;
        const primaryProfileId = 'primary';
        const backupProfileId = 'backup';
        const daemonTestDir = resolve(join(suiteDir, 'real-auth-group-switch'));
        const cliHomeDir = resolve(join(daemonTestDir, 'cli-home'));
        const workspaceDir = resolve(join(daemonTestDir, 'workspace'));
        const fakeClaudeLogPath = resolve(join(daemonTestDir, 'fake-claude.jsonl'));
        let daemon: StartedDaemon | null = null;
        const previousDaemonSnapshotMode = process.env.HAPPIER_E2E_DAEMON_CLI_SNAPSHOT_MODE;

        await page.setViewportSize({ width: 1440, height: 900 });
        await mkdir(workspaceDir, { recursive: true });
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
        await waitForInitialAppUi({ page, timeoutMs: 180_000 });
        await createAccountIfNeeded(page);
        await enableConnectedServiceQuotaUi({ page, baseUrl: uiBaseUrl });

        const { token: authToken, secret } = await readLegacyAuthCredentialsFromBrowserStorage(page);
        await seedCliAuthForServer({
            cliHome: cliHomeDir,
            serverUrl: server.baseUrl,
            token: authToken,
            secret,
        });
        await createConnectedServiceProfile({
            baseUrl: server.baseUrl,
            token: authToken,
            secret,
            serviceId,
            profileId: primaryProfileId,
            providerEmail: 'primary@example.test',
        });
        await createConnectedServiceProfile({
            baseUrl: server.baseUrl,
            token: authToken,
            secret,
            serviceId,
            profileId: backupProfileId,
            providerEmail: 'backup@example.test',
        });
        await createQualifiedConnectedAccountGroup({
            serverBaseUrl: server.baseUrl,
            authToken,
            legacyServiceId: serviceId,
            groupId,
            activeConnectedAccountId: primaryProfileId,
            memberConnectedAccountIds: [primaryProfileId, backupProfileId],
        });

        try {
            process.env.HAPPIER_E2E_DAEMON_CLI_SNAPSHOT_MODE = 'testdir';
            try {
                daemon = await startTestDaemon({
                    testDir: daemonTestDir,
                    happyHomeDir: cliHomeDir,
                    startupTimeoutMs: 180_000,
                    env: {
                        ...process.env,
                        ...CONNECTED_SERVICE_FEATURE_ENV,
                        CI: '1',
                        HAPPIER_HOME_DIR: cliHomeDir,
                        HAPPIER_SERVER_URL: server.baseUrl,
                        HAPPIER_WEBAPP_URL: uiBaseUrl,
                        HAPPIER_DISABLE_CAFFEINATE: '1',
                        HAPPIER_VARIANT: 'dev',
                        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
                        HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
                        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
                        HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
                        HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
                        HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: 'false',
                        HAPPIER_CONNECTED_SERVICES_LEGACY_CLAUDE_RESTART_SAME_HOME: '1',
                        HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_RESTART_SIGNAL_DELAY_MS: '0',
                    },
                });
            } finally {
                if (previousDaemonSnapshotMode === undefined) {
                    delete process.env.HAPPIER_E2E_DAEMON_CLI_SNAPSHOT_MODE;
                } else {
                    process.env.HAPPIER_E2E_DAEMON_CLI_SNAPSHOT_MODE = previousDaemonSnapshotMode;
                }
            }

            const machineId = await waitForLatestMachineId({ suiteDir, timeoutMs: 120_000 });
            const sessionId = await createProfileBoundPlainSession({
                baseUrl: server.baseUrl,
                token: authToken,
                serviceId,
                groupId,
                profileId: primaryProfileId,
                machineId,
                path: workspaceDir,
            });
            await publishProviderUsageRuntimeIssue({
                baseUrl: server.baseUrl,
                token: authToken,
                sessionId,
                agentId: 'claude',
                serviceId,
                profileId: primaryProfileId,
                groupId,
            });

            await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionId}?happier_hmr=0`, 180_000);
            const recoveryBanner = page.getByTestId('session-usageLimit-recovery');
            await expect(recoveryBanner).toBeVisible({ timeout: 60_000 });
            const switchAccountNow = page.getByTestId('session-usageLimit-recovery-switchAccountNow');
            await expect(switchAccountNow).toBeVisible({ timeout: 60_000 });
            await expect(switchAccountNow).toBeEnabled({ timeout: 60_000 });
            await switchAccountNow.click();

            await waitFor(async () => {
                const group = await fetchQualifiedConnectedAccountGroup({
                    serverBaseUrl: server!.baseUrl,
                    authToken,
                    legacyServiceId: serviceId,
                    groupId,
                });
                return group.activeConnectedAccountId === backupProfileId;
            }, {
                timeoutMs: 30_000,
                context: 'auth-group switch commits backup active profile',
            });
            await expectRealSwitchSessionEventRecorded({
                baseUrl: server.baseUrl,
                token: authToken,
                sessionId,
                serviceId,
                groupId,
            });
        } finally {
            await daemon?.stop().catch(() => {});
        }
    });

    test('hides app-server quota affordances for non-app-server Codex sessions', async ({ page }) => {
        test.setTimeout(540_000);
        if (!server || !uiBaseUrl) throw new Error('missing ui e2e fixtures');
        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
        await waitForInitialAppUi({ page, timeoutMs: 180_000 });
        await createAccountIfNeeded(page);
        await enableConnectedServiceQuotaUi({ page, baseUrl: uiBaseUrl });
        const authToken = await readAuthTokenFromBrowserStorage(page);
        const sessionId = await createPlainSession({
            baseUrl: server.baseUrl,
            token: authToken,
            codexBackendMode: 'exec',
            providerUsageSourceKind: 'unsupported',
        });

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionId}?happier_hmr=0`, 180_000);
        await expect(page.getByTestId('agent-input-provider-quota-badge')).toHaveCount(0, { timeout: 60_000 });
        await expect(page.getByTestId('session-usageLimit-recovery-checkNow')).toHaveCount(0);
    });
});
