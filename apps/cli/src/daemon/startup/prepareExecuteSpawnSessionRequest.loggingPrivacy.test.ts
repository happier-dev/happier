import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import {
    mapExternalTakeoverLaunchPlanToSpawnOptions,
} from '@/api/session/external/takeover/mapExternalTakeoverLaunchPlanToSpawnOptions';

const mocks = vi.hoisted(() => ({
    ensureSessionDirectory: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

vi.mock('./ensureSessionDirectory', () => ({
    ensureSessionDirectory: mocks.ensureSessionDirectory,
}));

import { prepareExecuteSpawnSessionRequest } from './prepareExecuteSpawnSessionRequest';
import { executeSpawnSessionRequest } from './executeSpawnSessionRequest';

const PRIVATE_DIRECTORY = '/Users/private-user/work/client-secret-project';
const PRIVATE_MACHINE_ID = 'machine-private-customer-identity';
const PRIVATE_PROFILE_ID = 'profile-private-work-identity';
const PRIVATE_BACKEND_ID = 'backend-private-subscription';
const PRIVATE_ENVIRONMENT_KEY = 'PRIVATE_CUSTOMER_WORKSPACE_TOKEN';
const PRIVATE_ENVIRONMENT_VALUE = 'private-environment-value';

function serializeDiagnostic(value: unknown): string {
    if (value instanceof Error) {
        return `${value.name}:${value.message}:${value.stack ?? ''}`;
    }
    if (Array.isArray(value)) {
        return value.map(serializeDiagnostic).join('|');
    }
    if (value && typeof value === 'object') {
        return Object.entries(value)
            .map(([key, nestedValue]) => `${key}:${serializeDiagnostic(nestedValue)}`)
            .join('|');
    }
    return String(value);
}

function serializedLoggerCalls(): string {
    return serializeDiagnostic({
        debug: vi.mocked(logger.debug).mock.calls,
        debugLargeJson: vi.mocked(logger.debugLargeJson).mock.calls,
        warn: vi.mocked(logger.warn).mock.calls,
    });
}

function expectNoPrivateSpawnFacts(value: unknown): void {
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain(PRIVATE_DIRECTORY);
    expect(serialized).not.toContain(PRIVATE_MACHINE_ID);
    expect(serialized).not.toContain(PRIVATE_PROFILE_ID);
    expect(serialized).not.toContain(PRIVATE_BACKEND_ID);
    expect(serialized).not.toContain(PRIVATE_ENVIRONMENT_KEY);
    expect(serialized).not.toContain(PRIVATE_ENVIRONMENT_VALUE);
}

function mapPrivateExternalTakeoverPlan() {
    const mapped = mapExternalTakeoverLaunchPlanToSpawnOptions({
        plan: {
            directory: PRIVATE_DIRECTORY,
            environmentVariables: {
                [PRIVATE_ENVIRONMENT_KEY]: PRIVATE_ENVIRONMENT_VALUE,
            },
        },
        targetDirectory: PRIVATE_DIRECTORY,
        resolvedIdentity: {
            source: { kind: 'fixtureSource' },
            remoteSessionId: 'private-native-session',
            linkData: {},
        },
        linkedSessionId: 'private-linked-session',
        targetAgent: {
            id: PRIVATE_BACKEND_ID,
            provenance: 'external',
            source: { kind: 'path' },
            hostAccess: {
                required: [{
                    id: 'fixture-process',
                    capability: 'process',
                    reason: 'Fixture process launch.',
                    scope: {
                        executables: [{ kind: 'systemTool', id: 'fixture-tool' }],
                        envKeys: [PRIVATE_ENVIRONMENT_KEY],
                    },
                }],
                optional: [],
            },
        },
    });
    if (!mapped) throw new Error('Expected the takeover launch plan to map');
    return {
        ...mapped,
        machineId: PRIVATE_MACHINE_ID,
        profileId: PRIVATE_PROFILE_ID,
    };
}

describe('prepareExecuteSpawnSessionRequest logging privacy', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('keeps private External Sessions takeover launch facts out of persistent diagnostics', async () => {
        const validationError = `Invalid environment variable ${PRIVATE_ENVIRONMENT_KEY}=${PRIVATE_ENVIRONMENT_VALUE}`;
        const result = await prepareExecuteSpawnSessionRequest({
            request: {
                options: mapPrivateExternalTakeoverPlan(),
                credentials: {
                    token: 'token',
                    encryption: null,
                },
                loadLocalHandoffMetadataByVendorResumeId: async () => null,
            },
            validateEnvVarRecordStrict: () => ({
                ok: false,
                error: validationError,
            }),
        });

        expect(result).toEqual({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_ENVIRONMENT_VARIABLES,
            errorMessage: validationError,
        });
        expect(mocks.ensureSessionDirectory).not.toHaveBeenCalled();
        expectNoPrivateSpawnFacts(serializedLoggerCalls());
        expect(logger.debugLargeJson).toHaveBeenCalledWith(
            '[DAEMON RUN] Preparing session spawn',
            expect.objectContaining({
                hasMachineId: true,
                hasBackendTarget: true,
                hasProfileId: true,
                environmentVariableCount: 1,
                environmentVariablesValid: false,
            }),
        );
    });

    it('logs only bounded result state when directory setup fails', async () => {
        mocks.ensureSessionDirectory.mockResolvedValueOnce({
            ok: false,
            response: {
                type: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.DIRECTORY_CREATE_FAILED,
                errorMessage: `Unable to create directory at '${PRIVATE_DIRECTORY}'.`,
            },
        });

        const result = await prepareExecuteSpawnSessionRequest({
            request: {
                options: {
                    ...mapPrivateExternalTakeoverPlan(),
                    existingSessionId: undefined,
                    resume: undefined,
                },
                credentials: {
                    token: 'token',
                    encryption: null,
                },
                loadLocalHandoffMetadataByVendorResumeId: async () => null,
            },
            validateEnvVarRecordStrict: () => ({ ok: true, env: {} }),
        });

        expect(result).toMatchObject({
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.DIRECTORY_CREATE_FAILED,
        });
        expectNoPrivateSpawnFacts(serializedLoggerCalls());
        expect(logger.debug).toHaveBeenCalledWith(
            '[DAEMON RUN] Session directory setup failed',
            {
                resultType: 'error',
                errorCode: SPAWN_SESSION_ERROR_CODES.DIRECTORY_CREATE_FAILED,
            },
        );
    });

    it('does not persist an unexpected private pre-spawn error and preserves the thrown error', async () => {
        const privateError = new Error(
            `Unexpected failure for ${PRIVATE_DIRECTORY} and ${PRIVATE_ENVIRONMENT_VALUE}`,
        );
        mocks.ensureSessionDirectory.mockRejectedValueOnce(privateError);

        await expect(executeSpawnSessionRequest({
            options: {
                ...mapPrivateExternalTakeoverPlan(),
                existingSessionId: undefined,
                resume: undefined,
            },
            credentials: {
                token: 'token',
                encryption: null,
            },
            api: {},
            loadLocalHandoffMetadataByVendorResumeId: async () => null,
            connectedServicesMaterializationBaseDir: '/tmp/connected-services',
            connectedServiceRefreshCoordinator: null,
            connectedServiceQuotasCoordinator: null,
            connectedServiceRuntimeRegistry: { registerTarget: vi.fn() },
            pidToTrackedSession: new Map(),
            pidToAwaiter: new Map(),
            pidToSpawnResultResolver: new Map(),
            pidToSpawnWebhookTimeout: new Map(),
            resolveCanonicalTrackedSessionId: vi.fn(() => 'never'),
            onChildExited: vi.fn(),
            spawnResourceCleanupByPid: new Map(),
            sessionAttachCleanupByPid: new Map(),
            processEnv: {},
        } as never)).rejects.toBe(privateError);

        expectNoPrivateSpawnFacts(serializedLoggerCalls());
    });
});
