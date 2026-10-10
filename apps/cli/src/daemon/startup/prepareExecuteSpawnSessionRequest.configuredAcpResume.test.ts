import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCustomAcpAdmissionRuntimeFixture } from './customAcpAdmission.testkit';

import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { AcpCatalogRecordV1Schema, type AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

import { prepareExecuteSpawnSessionRequest } from './prepareExecuteSpawnSessionRequest';

let runtime: Awaited<ReturnType<typeof createCustomAcpAdmissionRuntimeFixture>>;
beforeAll(async () => { runtime = await createCustomAcpAdmissionRuntimeFixture(); });
afterAll(async () => { await runtime?.dispose(); });

const CONFIGURED_BACKEND_ID = 'review-bot';
const PROVIDER_SESSION_ID = 'provider-session-42';

function accountSettingsWithConfiguredBackend(supportsLoadSession: boolean) {
    return {
        acpCatalogSettingsV1: {
            v: 2,
            backends: [{
                id: CONFIGURED_BACKEND_ID,
                name: CONFIGURED_BACKEND_ID,
                title: 'Review Bot',
                command: 'review-bot-acp',
                args: ['--stdio'],
                env: {},
                transportProfile: 'generic',
                capabilities: {
                    supportsLoadSession,
                    supportsModes: 'unknown',
                    supportsModels: 'unknown',
                    supportsConfigOptions: 'unknown',
                    promptImageSupport: 'no',
                },
                createdAt: 1,
                updatedAt: 2,
            }],
        },
    } as const;
}

function readyCatalog(supportsLoadSession: boolean): AcpCatalogSnapshotV1 {
    const { transportProfile: _transportProfile, ...definition } = accountSettingsWithConfiguredBackend(supportsLoadSession).acpCatalogSettingsV1.backends[0];
    return { status: 'ready', revision: 4, record: AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [definition] }) };
}

async function prepareConfiguredAcpResume(params: Readonly<{
    accountSettings?: Readonly<Record<string, unknown>>;
    backendId?: string;
    acpCatalogSnapshot?: AcpCatalogSnapshotV1;
}>) {
    return await prepareExecuteSpawnSessionRequest({
        request: {
            options: {
                directory: '/tmp/configured-acp-resume',
                machineId: 'machine-1',
                backendTarget: {
                    kind: 'backend',
                    backendId: params.backendId ?? CONFIGURED_BACKEND_ID,
                    configuredBackendId: params.backendId ?? CONFIGURED_BACKEND_ID,
                    sourceKind: 'configured',
                },
                resume: PROVIDER_SESSION_ID,
                approvedNewDirectoryCreation: true,
            },
            ...(params.accountSettings ? { accountSettings: params.accountSettings } : {}),
            acpCatalogSnapshot: params.acpCatalogSnapshot,
            credentials: { token: 'token', encryption: null },
        },
        validateEnvVarRecordStrict: () => ({ ok: true, env: {} }),
    });
}

describe('prepareExecuteSpawnSessionRequest Account-configured ACP resume admission', () => {
    it('admits native resume when the resolved Account declaration proves load-session support', async () => {
        const result = await prepareConfiguredAcpResume({
            accountSettings: {}, acpCatalogSnapshot: readyCatalog(true),
        });

        expect(result).toMatchObject({
            effectiveResume: PROVIDER_SESSION_ID,
            runtimeDescriptorV1: { agent: { definitionId: CONFIGURED_BACKEND_ID } },
            effectiveBackendTargetV2: expect.objectContaining({
                sourceKind: 'built_in',
            }),
        });
    });

    it('refuses native resume when the Account declaration does not prove load-session support', async () => {
        const result = await prepareConfiguredAcpResume({
            accountSettings: {}, acpCatalogSnapshot: readyCatalog(false),
        });

        expect(result).toEqual({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED,
            errorMessage: `Resume is not supported for configured ACP backend '${CONFIGURED_BACKEND_ID}'.`,
        });
    });

    it('fails closed when the configured backend is absent from the admitted Account snapshot', async () => {
        const result = await prepareConfiguredAcpResume({ acpCatalogSnapshot: { status: 'ready', revision: 4, record: { v: 1, definitions: [] } } });

        expect(result).toEqual({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
            errorMessage: `Configured ACP backend '${CONFIGURED_BACKEND_ID}' is unavailable.`,
        });
    });

    it('refuses unavailable and partial destination facts without activating a retained Settings root', async () => {
        const safeRepairRecord = readyCatalog(true);
        if (safeRepairRecord.status !== 'ready') throw new Error('Expected a ready test record');
        for (const acpCatalogSnapshot of [
            { status: 'unavailable', reason: 'unreachable' },
            { status: 'partial', reason: 'incomplete-inventory', record: safeRepairRecord.record,
                diagnostics: [{ path: 'backends[1]', reason: 'invalid_definition' }] },
        ] satisfies AcpCatalogSnapshotV1[]) {
            expect(await prepareConfiguredAcpResume({ accountSettings: accountSettingsWithConfiguredBackend(true), acpCatalogSnapshot }))
                .toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST });
        }
    });
});
