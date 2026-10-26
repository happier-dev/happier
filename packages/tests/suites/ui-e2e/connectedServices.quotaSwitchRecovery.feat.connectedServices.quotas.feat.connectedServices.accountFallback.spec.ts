import { test, expect, type Locator, type Page } from '@playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
    buildConnectedServiceCredentialRecord,
    buildUsageLimitIssueFingerprint,
    buildProviderAccountUsageRecordId,
    ProviderAccountUsageSnapshotV1Schema,
    sealProviderAccountUsageSnapshot,
    sealAccountScopedBlobCiphertext,
    type ConnectedServiceId,
    type ConnectedServiceCredentialHealthV1,
    type SessionRuntimeIssueV1,
    type SessionUsageLimitRecoveryOperationResultV1,
    type ConnectedServiceQuotaRecoveryCreditConsumeResponseV1,
} from '@happier-dev/protocol';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { seedCliAuthForServer } from '../../src/testkit/cliAuth';
import { upsertEncryptedAccountSettingsV2 } from '../../src/testkit/accountSettings';
import { registerMachineIdentity } from '../../src/testkit/machineIdentity';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { decryptLegacyBase64Normalized } from '../../src/testkit/decryptLegacyBase64Normalized';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchMessagesPage, fetchSessionV2 } from '../../src/testkit/sessions';
import { createMachineBoundSessionScopedSocketCollector } from '../../src/testkit/sessionSocketBinding';
import type { SocketCollector } from '../../src/testkit/socketClient';
import { waitFor } from '../../src/testkit/timing';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { setUiFeatureToggle } from '../../src/testkit/uiE2e/setUiFeatureToggle';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { CLAUDE_CODE_E2E_OAUTH_SCOPE } from '../../src/testkit/connectedServicesRecovery';
import { waitForDaemonMachineIdFromCliSettings } from '../../src/testkit/uiE2e/daemonMachineId';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';
import { readUiE2eScopedAccountSettings } from '../../src/testkit/uiE2e/scopedAccountSettingsStorage';
import { attachRelayMachineRpcTap } from '../../src/testkit/uiE2e/desktopSetup/relayMachineRpcTap';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const CONNECTED_SERVICE_FEATURE_ENV = {
    HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1',
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
    metadata?: Readonly<Record<string, unknown>>;
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
                ...params.metadata,
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
            scope: CLAUDE_CODE_E2E_OAUTH_SCOPE,
            tokenType: 'Bearer',
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

    await patchConnectedServiceCredentialHealth({
        baseUrl: params.baseUrl,
        token: params.token,
        serviceId: params.serviceId,
        profileId: params.profileId,
        health: {
            v: 1,
            status: 'connected',
            reconnectRequired: false,
            lastRefreshSuccessAt: now,
        },
    });
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

async function createConnectedServiceAuthGroup(params: Readonly<{
    baseUrl: string;
    token: string;
    serviceId: string;
    groupId: string;
    activeProfileId: string;
    memberProfileIds: readonly string[];
}>): Promise<UnknownRecord> {
    const response = await fetchJson<{ group?: unknown }>(`${params.baseUrl}/v3/connect/${params.serviceId}/groups`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${params.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            groupId: params.groupId,
            members: params.memberProfileIds.map((profileId, index) => ({ profileId, priority: (index + 1) * 10 })),
            activeProfileId: params.activeProfileId,
            policy: {
                autoSwitch: true,
                recoveryMode: 'switch_or_wait',
            },
        }),
        timeoutMs: 20_000,
    });
    expect(response.status).toBe(200);
    const group = asRecord(response.data?.group);
    if (!group) throw new Error('Expected connected service auth group response');
    return group;
}

async function fetchConnectedServiceAuthGroup(params: Readonly<{
    baseUrl: string;
    token: string;
    serviceId: string;
    groupId: string;
}>): Promise<UnknownRecord> {
    const response = await fetchJson<{ group?: unknown }>(
        `${params.baseUrl}/v3/connect/${params.serviceId}/groups/${params.groupId}`,
        {
            headers: { Authorization: `Bearer ${params.token}` },
            timeoutMs: 20_000,
        },
    );
    expect(response.status).toBe(200);
    const group = asRecord(response.data?.group);
    if (!group) throw new Error('Expected connected service auth group response');
    return group;
}

async function expectRealSwitchAttemptSessionEventRecorded(params: Readonly<{
    baseUrl: string;
    token: string;
    sessionId: string;
    secret: Uint8Array;
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
        return messages.some((message) => {
            const record = asRecord(message);
            if (
                record?.messageRole !== 'event'
                || typeof record.localId !== 'string'
                || !record.localId.startsWith('connected-service-account-switch-attempt:failed:')
            ) {
                return false;
            }
            const storedContent = asRecord(record.content);
            let payload: UnknownRecord | null = null;
            if (storedContent?.t === 'plain') {
                payload = asRecord(storedContent.v);
            } else if (storedContent?.t === 'encrypted' && typeof storedContent.c === 'string') {
                payload = asRecord(decryptLegacyBase64Normalized(storedContent.c, params.secret));
            }
            const content = asRecord(payload?.content);
            const data = asRecord(content?.data);
            return payload?.role === 'agent'
                && content?.type === 'event'
                && data?.type === 'connected-service-account-switch-attempt'
                && data.ok === false
                && data.action === 'hot_applied'
                && data.reason === 'usage_limit'
                && data.attemptedContinuityMode === 'hot_apply'
                && data.outcome === 'failed'
                && data.outcomeAction === 'none'
                && data.errorCode === 'hot_apply_restart_required';
        });
    }, {
        timeoutMs: 30_000,
        context: 'usage-limit auth-group switch with restart-required runtime records an attempt event',
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
    provider?: string;
    serviceId?: ConnectedServiceId;
    profileId?: string;
    groupId?: string;
    groupExhausted?: boolean;
    occurredAtMs?: number;
    recoverability?: 'wait' | 'switch_account';
}>): Promise<void> {
    const occurredAt = params.occurredAtMs ?? Date.now();
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
        provider: params.provider ?? 'codex',
        occurredAt,
        sanitizedPreview: 'Provider usage limit reached.',
        usageLimit: {
            v: 1,
            resetAtMs: occurredAt + 3_600_000,
            retryAfterMs: 3_600_000,
            quotaScope: 'account',
            recoverability: params.recoverability ?? 'switch_account',
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
            provider: params.provider ?? 'codex',
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
            provider: params.provider ?? 'codex',
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
                EXPO_PUBLIC_HAPPIER_SOCKET_FORCE_WEBSOCKET: '1',
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
        test.setTimeout(180_000);
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

    test('keeps ready recovery actionable when automatic resume prompts are off', async ({ page }) => {
        test.setTimeout(180_000);
        if (!server || !uiBaseUrl) throw new Error('missing ui e2e fixtures');
        const diagnostics = collectBrowserDiagnostics({ page });
        const tap = await attachRelayMachineRpcTap(page);
        let runtimePublisher: SocketCollector | null = null;
        try {
            await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
            await waitForInitialAppUi({ page, timeoutMs: 180_000 });
            await createAccountIfNeeded(page);
            await enableConnectedServiceQuotaUi({ page, baseUrl: uiBaseUrl });
            const auth = await readLegacyAuthCredentialsFromBrowserStorage(page);
            await upsertEncryptedAccountSettingsV2({
                baseUrl: server.baseUrl, token: auth.token, secret: auth.secret,
                settings: {
                    ...await readUiE2eScopedAccountSettings({ page }),
                    usageLimitRecoverySettingsV1: { v: 1, mode: 'ask', resumePromptMode: 'off' },
                },
            });
            const sessionId = await createPlainSession({ baseUrl: server.baseUrl, token: auth.token });
            await publishProviderUsageRuntimeIssue({ baseUrl: server.baseUrl, token: auth.token, sessionId, recoverability: 'wait' });
            const result = { ok: true, status: 'ready', sessionId, resumePromptMode: 'off' } satisfies SessionUsageLimitRecoveryOperationResultV1;
            tap.setMethodResponse({ method: `${sessionId}:${SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW}`, ack: { ok: true, result } });

            await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionId}?happier_hmr=0`, 180_000);
            await expect(page.getByTestId('session-usageLimit-recovery-checkNow')).toBeVisible({ timeout: 60_000 });
            const publisher = await createMachineBoundSessionScopedSocketCollector({ baseUrl: server.baseUrl, token: auth.token, sessionId });
            runtimePublisher = publisher.socket;
            publisher.socket.connect();
            await waitFor(async () => publisher.socket.isConnected(), { timeoutMs: 20_000, context: 'connect recovery runtime presence fixture' });
            publisher.socket.emit('session-alive', { sid: sessionId, time: Date.now(), thinking: false });
            await waitFor(async () => (await fetchSessionV2(server!.baseUrl, auth.token, sessionId)).active === true, {
                timeoutMs: 20_000, context: 'persist active recovery runtime presence',
            });
            await page.reload({ waitUntil: 'domcontentloaded' });
            await expect(page.getByTestId('session-usageLimit-recovery-checkNow')).toBeVisible({ timeout: 60_000 });
            expect((await fetchSessionV2(server.baseUrl, auth.token, sessionId)).active).toBe(true);
            await page.getByTestId('session-usageLimit-recovery-checkNow').click();
            await expect(page.getByTestId('session-usageLimit-recovery')).toBeVisible();
            await expect(page.getByTestId('session-usageLimit-recovery-resumeNow')).toBeVisible();
            await expect(page.getByTestId('session-usageLimit-status-badge')).toContainText('Ready');
            expect(tap.calls().some((call) => call.injected && call.method.endsWith(`:${SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW}`))).toBe(true);
            const messages = await fetchMessagesPage({ baseUrl: server.baseUrl, token: auth.token, sessionId, afterSeq: 0 });
            expect(messages.messages).toHaveLength(0);
        } catch (error) {
            throw appendBrowserDiagnostics(error, diagnostics());
        } finally {
            runtimePublisher?.close();
        }
    });

    test('settles Apply reset after a rejected connected-service credit operation', async ({ page }) => {
        test.setTimeout(180_000);
        if (!server || !uiBaseUrl) throw new Error('missing ui e2e fixtures');
        const diagnostics = collectBrowserDiagnostics({ page });
        const tap = await attachRelayMachineRpcTap(page);
        try {
            await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
            await waitForInitialAppUi({ page, timeoutMs: 180_000 });
            await createAccountIfNeeded(page);
            await enableConnectedServiceQuotaUi({ page, baseUrl: uiBaseUrl });
            const auth = await readLegacyAuthCredentialsFromBrowserStorage(page);
            const machine = await registerMachineIdentity({
                baseUrl: server.baseUrl, token: auth.token, dataEncryptionKey: null,
                metadata: encryptLegacyBase64({ host: 'recovery-fixture', platform: 'linux', homeDir: '/tmp', happyCliVersion: '0.2.0' }, auth.secret),
            });
            expect(machine.status).toBe(200);
            const occurredAt = Date.now();
            const issue: SessionRuntimeIssueV1 = {
                v: 1, scope: 'primary_session', status: 'failed', code: 'provider_usage_limit',
                source: 'usage_limit', provider: 'codex', occurredAt,
                usageLimit: { v: 1, resetAtMs: occurredAt + 3_600_000, retryAfterMs: 3_600_000, quotaScope: 'account', recoverability: 'wait' },
            };
            const sessionId = await createPlainSession({
                baseUrl: server.baseUrl, token: auth.token,
                metadata: {
                    machineId: machine.machineId,
                    sessionUsageLimitRecoveryV1: {
                        v: 1, status: 'paused', issueFingerprint: buildUsageLimitIssueFingerprint(issue), armedAtMs: occurredAt,
                        resetAtMs: occurredAt + 3_600_000, nextCheckAtMs: null, attemptCount: 0, maxAttempts: 0,
                        lastProbeError: null, resumePromptMode: 'off', selectedAuth: { kind: 'profile', serviceId: 'openai-codex', profileId: 'primary' },
                        recoveryCredits: { kind: 'usage_limit_resets', availableCount: 1, credits: [{ kind: 'usage_limit_reset', status: 'available' }] },
                    },
                },
            });
            await publishProviderUsageRuntimeIssue({ baseUrl: server.baseUrl, token: auth.token, sessionId, occurredAtMs: occurredAt, recoverability: 'wait' });
            const result = { ok: false, errorCode: 'no_recovery_credit_available', error: 'No reset credit is available.' } satisfies ConnectedServiceQuotaRecoveryCreditConsumeResponseV1;
            tap.setMethodResponse({
                method: `${machine.machineId}:${RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME}`,
                ack: { ok: true, result: encryptLegacyBase64(result, auth.secret) },
            });

            await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionId}?happier_hmr=0`, 180_000);
            const applyReset = page.getByTestId('session-usageLimit-recovery-consumeResetCredit');
            await expect(applyReset).toBeVisible({ timeout: 60_000 });
            await applyReset.click();
            await expect(page.getByRole('dialog')).toBeVisible();
            await page.getByRole('button', { name: 'OK', exact: true }).click();
            await expect(applyReset).toBeEnabled();
            await expect(page.getByTestId('session-usageLimit-recovery')).toBeVisible();
            await expect(page.getByTestId('session-usageLimit-status-badge')).not.toContainText('Checking');
            expect(tap.calls().some((call) => call.injected && call.method.endsWith(`:${RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME}`))).toBe(true);
        } catch (error) {
            throw appendBrowserDiagnostics(error, diagnostics());
        }
    });

    test('shows saved Claude resets with unavailable status without allowing consumption', async ({ page }) => {
        test.setTimeout(180_000);
        if (!server || !uiBaseUrl) throw new Error('missing ui e2e fixtures');
        const diagnostics = collectBrowserDiagnostics({ page });
        try {
            await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
            await waitForInitialAppUi({ page, timeoutMs: 180_000 });
            await createAccountIfNeeded(page);
            await enableConnectedServiceQuotaUi({ page, baseUrl: uiBaseUrl });
            const auth = await readLegacyAuthCredentialsFromBrowserStorage(page);
            const serviceId = 'claude-subscription' satisfies ConnectedServiceId;
            const profileId = `saved-reset-${run.runId}`;
            await createConnectedServiceProfile({
                baseUrl: server.baseUrl, token: auth.token, secret: auth.secret,
                serviceId, profileId, providerEmail: 'saved-reset@example.test',
            });
            const now = Date.now();
            const recordKey = {
                providerId: 'claude', accountSubjectId: `acct-${profileId}`,
                subjectKind: 'account' as const, quotaScope: 'account' as const,
            };
            const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({
                v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
                providerId: recordKey.providerId, accountSubject: { kind: 'providerSubject', id: recordKey.accountSubjectId },
                observedAtMs: now, fetchedAtMs: now, staleAfterMs: 60_000,
                source: 'connectedServiceProbe', confidence: 'confirmed', state: 'loaded_data',
                meters: [{
                    meterId: 'weekly', label: 'Weekly', used: 88, limit: 100, unit: 'count',
                    utilizationPct: 88, resetsAt: now + 3_600_000, status: 'ok',
                    details: { providerLimitId: 'seven_day' },
                }],
                recoveryCredits: {
                    kind: 'usage_limit_resets', availableCount: 0,
                    credits: [{ providerCreditId: 'saved-reset', kind: 'rate_limit_reset', status: 'unknown', expiresAtMs: now + 86_400_000 }],
                },
                recoveryCreditDetails: {
                    'saved-reset': {
                        remainingCount: 2,
                        appliesToProviderLimitIds: ['seven_day', 'provider_future_window'],
                        unavailableReason: 'ineligible',
                    },
                },
            });
            const write = await fetchJson<{ success?: boolean }>(`${server.baseUrl}/v2/connect/provider-account-usage/${snapshot.recordId}`, {
                method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    recordKey,
                    sealed: sealProviderAccountUsageSnapshot({ material: { type: 'legacy', secret: auth.secret }, snapshot, randomBytes }),
                    metadata: { fetchedAt: now, staleAfterMs: snapshot.staleAfterMs, status: 'ok' },
                    source: { serviceId, profileId, bindingKind: 'profile' },
                }),
                timeoutMs: 20_000,
            });
            expect(write.status).toBe(200);
            expect(write.data?.success).toBe(true);

            const root = `account-block:${profileId}`;
            const assertSavedReset = async () => {
                const header = page.getByTestId(`${root}:header`);
                await expect(header).toBeVisible({ timeout: 60_000 });
                await expect(page.getByTestId(`${root}:reset-row:saved-reset`)).toBeVisible({ timeout: 60_000 });
                await expect(page.getByTestId(`${root}:reset-count:saved-reset`)).toContainText('2');
                await expect(page.getByTestId(`${root}:reset-applies-to:saved-reset`)).toContainText('Weekly');
                await expect(page.getByTestId(`${root}:reset-applies-to:saved-reset`)).toContainText('provider_future_window');
                await expect(page.getByTestId(`${root}:reset-unavailable:saved-reset`)).toContainText('Not eligible');
                await expect(page.getByTestId(`${root}:reset-use:saved-reset`)).toBeDisabled();
                await expect(page.getByTestId(`${root}:meter:weekly`)).toBeVisible();
                await expect(page.getByTestId(`${root}:quota-error`)).toHaveCount(0);
            };
            await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/connected-services/${serviceId}?happier_hmr=0`, 180_000);
            await assertSavedReset();
            await page.reload({ waitUntil: 'domcontentloaded' });
            await assertSavedReset();
            const use = page.getByTestId(`${root}:reset-use:saved-reset`);
            await use.evaluate((element) => (element as HTMLElement).focus());
            await page.keyboard.press('Enter');
            await page.keyboard.press('Space');
            await assertSavedReset();
            await expect(page.getByRole('dialog')).toHaveCount(0);
        } catch (error) {
            throw appendBrowserDiagnostics(error, diagnostics());
        }
    });

    test('renders connected-service switch event rows and notification topic controls', async ({ page }) => {
        test.setTimeout(180_000);
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
        test.setTimeout(180_000);
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
        await createConnectedServiceAuthGroup({
            baseUrl: server.baseUrl,
            token: authToken,
            serviceId,
            groupId,
            activeProfileId: profileId,
            memberProfileIds: [profileId],
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

        const groupAfterProfileReconnectNavigation = await fetchConnectedServiceAuthGroup({
            baseUrl: server.baseUrl,
            token: authToken,
            serviceId,
            groupId,
        });
        expect(readString(groupAfterProfileReconnectNavigation, 'activeProfileId')).toBe(profileId);

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

        const groupAfterSessionChipReconnectNavigation = await fetchConnectedServiceAuthGroup({
            baseUrl: server.baseUrl,
            token: authToken,
            serviceId,
            groupId,
        });
        expect(readString(groupAfterSessionChipReconnectNavigation, 'activeProfileId')).toBe(profileId);
    });

    test('shows connected-service restart status before inactive resume status', async ({ page }) => {
        test.setTimeout(180_000);
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
        await createConnectedServiceAuthGroup({
            baseUrl: server.baseUrl,
            token: authToken,
            serviceId,
            groupId,
            activeProfileId: profileId,
            memberProfileIds: [profileId],
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
        test.setTimeout(180_000);
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
        await createConnectedServiceAuthGroup({
            baseUrl: server.baseUrl,
            token: authToken,
            serviceId,
            groupId,
            activeProfileId: primaryProfileId,
            memberProfileIds: [primaryProfileId, backupProfileId],
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
                        HAPPIER_CONNECTED_SERVICES_DISABLE_CLAUDE_SUBSCRIPTION_QUOTA_ENDPOINT: '1',
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

            const machineId = await waitForDaemonMachineIdFromCliSettings({ cliHomeDir, timeoutMs: 120_000 });
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
                provider: 'claude',
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
                const group = await fetchConnectedServiceAuthGroup({
                    baseUrl: server!.baseUrl,
                    token: authToken,
                    serviceId,
                    groupId,
                });
                return readString(group, 'activeProfileId') === backupProfileId;
            }, {
                timeoutMs: 30_000,
                context: 'auth-group switch commits backup active profile',
            });
            await expectRealSwitchAttemptSessionEventRecorded({
                baseUrl: server.baseUrl,
                token: authToken,
                sessionId,
                secret,
            });
        } finally {
            await daemon?.stop().catch(() => {});
        }
    });

    test('hides app-server quota affordances for non-app-server Codex sessions', async ({ page }) => {
        test.setTimeout(180_000);
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
