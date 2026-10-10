import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accountSettingsParse } from '@happier-dev/protocol';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

import type { StoredCredentials } from '@/persistence';
import { buildConfiguredAcpBackendSessionMetadata } from '@/agent/acp/catalog/configured/sessionMetadata';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import {
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
    getActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

import { prepareExecuteSpawnSessionRequest } from '@/daemon/startup/prepareExecuteSpawnSessionRequest';
import { resolveSessionForkBackendTarget } from './backendTarget';

const RESUMABLE_BACKEND_ID = 'review-bot';
const NON_RESUMABLE_BACKEND_ID = 'draft-bot';
const PROVIDER_SESSION_ID = 'provider-session-42';

const credentials = { token: 'composed-fork-token', encryption: null } satisfies StoredCredentials;

function configuredBackendEntry(params: Readonly<{
    id: string;
    title: string;
    supportsLoadSession: boolean;
}>) {
    return {
        id: params.id,
        name: params.id,
        title: params.title,
        command: `${params.id}-acp`,
        args: ['--stdio'],
        env: {},
        capabilities: {
            supportsLoadSession: params.supportsLoadSession,
            supportsModes: 'unknown',
            supportsModels: 'unknown',
            supportsConfigOptions: 'unknown',
            promptImageSupport: 'no',
        },
        createdAt: 1,
        updatedAt: 2,
    };
}

// One opened catalog feeds fork membership and daemon load-session admission.
// Preferences have no retained ACP root to fall back to.
const ACCOUNT_SETTINGS = accountSettingsParse({});
const ACP_CATALOG = AcpCatalogRecordV1Schema.parse({
        v: 1,
        definitions: [
            configuredBackendEntry({
                id: RESUMABLE_BACKEND_ID,
                title: 'Review Bot',
                supportsLoadSession: true,
            }),
            configuredBackendEntry({
                id: NON_RESUMABLE_BACKEND_ID,
                title: 'Draft Bot',
                supportsLoadSession: false,
            }),
        ],
});

async function forkThenAdmitSpawn(params: Readonly<{
    parentMetadata: Record<string, unknown>;
    resume: string | null;
}>) {
    const forkResolution = await resolveSessionForkBackendTarget({
        parentMetadata: params.parentMetadata,
        credentials,
    });
    if (!forkResolution.ok) {
        return { forkResolution, admission: null } as const;
    }

    const admission = await prepareExecuteSpawnSessionRequest({
        request: {
            options: {
                directory: '/tmp/configured-acp-fork',
                machineId: 'machine-1',
                // The exact ref the fork owner produced crosses into daemon
                // admission unmodified. No test-local target is synthesized.
                backendTarget: forkResolution.backendTargetV2,
                approvedNewDirectoryCreation: true,
                ...(params.resume ? { resume: params.resume } : {}),
            },
            accountSettings: ACCOUNT_SETTINGS,
            acpCatalogSnapshot: getActiveAccountSettingsSnapshot()?.acpCatalog,
            credentials,
        },
        validateEnvVarRecordStrict: () => ({ ok: true, env: {} }),
    });

    return { forkResolution, admission } as const;
}

describe('configured ACP fork composed with daemon spawn admission', () => {
    beforeEach(() => {
        setActiveAccountSettingsSnapshot({
            source: 'cache',
            settings: ACCOUNT_SETTINGS,
            settingsVersion: 7,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey(credentials),
            acpCatalog: { status: 'ready', revision: 2, record: ACP_CATALOG },
        });
    });

    afterEach(() => {
        resetActiveAccountSettingsSnapshotForTests();
    });

    it('admits the fork-resolved configured backend target for native resume when the Account proves load-session support', async () => {
        const { forkResolution, admission } = await forkThenAdmitSpawn({
            parentMetadata: buildConfiguredAcpBackendSessionMetadata({
                backendId: RESUMABLE_BACKEND_ID,
                title: 'Review Bot',
            }) as Record<string, unknown>,
            resume: PROVIDER_SESSION_ID,
        });

        expect(forkResolution).toMatchObject({
            ok: true,
            catalogAgentId: null,
            backendTargetV2: {
                kind: 'backend',
                backendId: RESUMABLE_BACKEND_ID,
                configuredBackendId: RESUMABLE_BACKEND_ID,
                sourceKind: 'configured',
            },
        });
        expect(admission).toMatchObject({
            effectiveResume: PROVIDER_SESSION_ID,
            catalogAgentId: null,
            effectiveBackendTargetV2: {
                sourceKind: 'configured',
                backendId: RESUMABLE_BACKEND_ID,
                configuredBackendId: RESUMABLE_BACKEND_ID,
            },
        });
    });

    it('admits a flavor-only parent whose configured backend the Account still declares', async () => {
        const { forkResolution, admission } = await forkThenAdmitSpawn({
            parentMetadata: { flavor: `acp:${RESUMABLE_BACKEND_ID}` },
            resume: PROVIDER_SESSION_ID,
        });

        expect(forkResolution).toMatchObject({
            ok: true,
            agentHintAgentId: `acp:${RESUMABLE_BACKEND_ID}`,
        });
        expect(admission).toMatchObject({ effectiveResume: PROVIDER_SESSION_ID });
    });

    it('refuses native resume for a fork-resolved backend the Account does not declare resumable', async () => {
        const { admission } = await forkThenAdmitSpawn({
            parentMetadata: buildConfiguredAcpBackendSessionMetadata({
                backendId: NON_RESUMABLE_BACKEND_ID,
                title: 'Draft Bot',
            }) as Record<string, unknown>,
            resume: PROVIDER_SESSION_ID,
        });

        expect(admission).toEqual({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
            errorMessage: `Resume is not supported for configured ACP backend '${NON_RESUMABLE_BACKEND_ID}'.`,
        });
    });

    it('keeps the replay fork fallback admissible for a backend without load-session support', async () => {
        // Replay never carries a provider resume token, so the load-session
        // refusal above must not close the automatic fallback path.
        const { admission } = await forkThenAdmitSpawn({
            parentMetadata: buildConfiguredAcpBackendSessionMetadata({
                backendId: NON_RESUMABLE_BACKEND_ID,
                title: 'Draft Bot',
            }) as Record<string, unknown>,
            resume: null,
        });

        expect(admission).toMatchObject({
            effectiveResume: '',
            catalogAgentId: null,
            effectiveBackendTargetV2: {
                sourceKind: 'configured',
                backendId: NON_RESUMABLE_BACKEND_ID,
            },
        });
    });
});
