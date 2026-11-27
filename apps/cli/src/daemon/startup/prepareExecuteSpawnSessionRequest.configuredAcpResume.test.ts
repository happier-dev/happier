import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCustomAcpAdmissionRuntimeFixture } from './customAcpAdmission.testkit';

import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { AcpCatalogRecordV1Schema, type AcpCatalogSnapshotV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { MachineResourcesPolicyV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { evaluateSessionEligibility } from '../guard/sessionEligibility';
import type { TrackedSession } from '../types';
import { projectCurrentAgentSessionView } from '@happier-dev/agents';

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

import { prepareExecuteSpawnSessionRequest } from './prepareExecuteSpawnSessionRequest';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

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
                launch: { kind: 'command' as const, command: 'review-bot-acp', args: ['--stdio'] },
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
    readMachineResourcesPolicy?: import('@/processes/toolIdleTimeouts').MachineResourcesPolicyReader;
}>) {
    return await prepareExecuteSpawnSessionRequest({
        request: {
            readMachineResourcesPolicy: params.readMachineResourcesPolicy,
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
        validateEnvVarRecordStrict,
    });
}

describe('prepareExecuteSpawnSessionRequest Account-configured ACP resume admission', () => {
    it.each([true, false])('automatic stop consumes the same configured load-session decision (%s)', async supportsLoadSession => {
        const agent = [...runtime.registry.contributes.agentDefinitionsById.values()]
            .find(value => value.identity?.pluginId === 'happier.agent.custom-acp');
        if (!agent) throw new Error('Admitted configured Agent unavailable');
        const catalog = readyCatalog(supportsLoadSession);
        const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(42), pid: 42, happySessionId: 'configured-session', startedBy: 'daemon' };
        const metadata = projectCurrentAgentSessionView({ machineId: 'machine-1', path: '/tmp/configured-acp-resume' }, {
            agentId: agent.id,
            runtimeDescriptor: RuntimeDescriptorV1Schema.parse({ v: 1, agentId: agent.id, agent: { definitionId: CONFIGURED_BACKEND_ID } }),
            nativeResumeIdentity: { v: 1, vendorResumeId: PROVIDER_SESSION_ID },
            configuredBackend: { v: 1, updatedAt: 1, backendId: CONFIGURED_BACKEND_ID, title: 'Review Bot' },
        });
        const eligibility = await evaluateSessionEligibility({ tracked,
            inventory: { coverage: 'complete', items: (['session', 'input', 'agents', 'attention'] as const).map(category => ({
                category, ownerRef: tracked, attribution: { kind: 'unknown' }, state: 'settled', settledAt: 1,
            })) }, draft: { status: 'absent' },
            resume: { sessionId: tracked.happySessionId!, rawSession: { machineId: 'machine-1', path: '/tmp/configured-acp-resume' }, metadata },
            readAcpCatalogSnapshot: async () => catalog,
        });
        expect(eligibility.eligible).toBe(supportsLoadSession);
        const admission = await prepareConfiguredAcpResume({ acpCatalogSnapshot: catalog });
        expect('type' in admission).toBe(!supportsLoadSession);
        if (!supportsLoadSession) expect(eligibility).toMatchObject({ reasons: [{ kind: 'not_resumable' }] });
    });
    it('carries the current Machine soft ceiling into a native resume launch without a Session fetch', async () => {
        const policy = MachineResourcesPolicyV1Schema.parse({ v: 1, guard: { sessionMemoryCeiling: { bytes: 1048576 } } });
        const result = await prepareConfiguredAcpResume({ accountSettings: {}, acpCatalogSnapshot: readyCatalog(true),
            readMachineResourcesPolicy: () => ({ status: 'ready', source: 'stored', revision: 1, policy }) });
        expect(result).toMatchObject({ effectiveResume: PROVIDER_SESSION_ID, memoryHighBytes: 1048576 });
    });
    it('admits native resume when the resolved Account declaration proves load-session support', async () => {
        const result = await prepareConfiguredAcpResume({
            accountSettings: {}, acpCatalogSnapshot: readyCatalog(true),
        });

        expect(result).toMatchObject({
            effectiveResume: PROVIDER_SESSION_ID,
            runtimeDescriptorV1: { agent: { definitionId: CONFIGURED_BACKEND_ID } },
            effectiveBackendTargetV2: expect.objectContaining({
                sourceKind: 'built_in',
                configuredBackendId: CONFIGURED_BACKEND_ID,
            }),
        });
        if ('type' in result) throw new Error('Expected configured ACP resume admission');
        expect(RuntimeDescriptorV1Schema.parse(result.runtimeDescriptorV1)).toEqual({
            v: 1, agentId: result.catalogAgentId, agent: { definitionId: CONFIGURED_BACKEND_ID },
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

    it('admits a crash respawn that adopts the held Agent without provider load-session support', async () => {
        // The adopted Agent's live Session is re-entered from the held handshake; the provider is never asked to resume.
        const adoptSessionHolder = { socketPath: '/tmp/holder.sock', holderPid: 101, agentPid: 102 };
        const results = await Promise.all([undefined, adoptSessionHolder].map(async adopt => await prepareExecuteSpawnSessionRequest({
            request: {
                options: {
                    directory: '/tmp/configured-acp-resume', machineId: 'machine-1',
                    backendTarget: { kind: 'backend', backendId: CONFIGURED_BACKEND_ID, configuredBackendId: CONFIGURED_BACKEND_ID, sourceKind: 'configured' },
                    resume: PROVIDER_SESSION_ID, approvedNewDirectoryCreation: true, ...(adopt ? { adoptSessionHolder: adopt } : {}),
                },
                accountSettings: {}, acpCatalogSnapshot: readyCatalog(false), credentials: { token: 'token', encryption: null },
            },
            validateEnvVarRecordStrict,
        })));
        const refusals = results.filter(result => 'type' in result && result.type === 'error'
            && result.errorCode === SPAWN_SESSION_ERROR_CODES.RESUME_NOT_SUPPORTED);
        // Only the fresh resume (no held Agent) is refused.
        expect(refusals).toHaveLength(1);
        expect(results[1]).toMatchObject({ effectiveResume: PROVIDER_SESSION_ID });
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
