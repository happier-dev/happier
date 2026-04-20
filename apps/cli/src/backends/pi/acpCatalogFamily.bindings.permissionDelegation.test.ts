import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PermissionMode } from '@/api/types';
import type { HostSessionRuntimePlan } from '@/agent/runtime/sessionLoop/lifecycle';
import type {
    HostSessionRuntimeFactoryParams,
} from '@/agent/runtime/sessionLoop/runHostSessionRuntime';
import type { HostSessionRuntimeFactoryResult } from '@/agent/runtime/sessionLoop/factoryResult';
import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { CatalogAcpRuntimeCreateCall } from '@/testkit/backends/catalogAcpRuntime';
import { createCatalogAcpBackendSpy, createMessageBufferFixture } from '@/testkit/backends/catalogAcpRuntime';
import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import type { Credentials } from '@/persistence';

import { createPiSessionRuntimePlan } from '@/backends/pi/bindings/session';
import { createQwenSessionRuntimePlan } from '@/backends/qwen/bindings/session';
import { createKimiSessionRuntimePlan } from '@/backends/kimi/bindings/session';
import { createKiloSessionRuntimePlan } from '@/backends/kilo/bindings/session';
import { createCopilotSessionRuntimePlan } from '@/backends/copilot/bindings/session';
import { createAuggieSessionRuntimePlan } from '@/backends/auggie/bindings/session';

type CatalogSessionPlanBuilder = (opts: {
    credentials: Credentials;
    permissionMode?: PermissionMode;
}) => HostSessionRuntimePlan;

type ProviderCase = Readonly<{
    providerId: 'pi' | 'qwen' | 'kimi' | 'kilo' | 'copilot' | 'auggie';
    expectedPermissionMode: PermissionMode;
    createPlan: CatalogSessionPlanBuilder;
    createSession?: () => ReturnType<typeof createApiSessionClientFixture>;
}>;

const credentials: Credentials = {
    token: 'token',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
};

const providerCases: ReadonlyArray<ProviderCase> = [
    {
        providerId: 'pi',
        expectedPermissionMode: 'read-only',
        createPlan: createPiSessionRuntimePlan,
    },
    {
        providerId: 'qwen',
        expectedPermissionMode: 'safe-yolo',
        createPlan: createQwenSessionRuntimePlan,
    },
    {
        providerId: 'kimi',
        expectedPermissionMode: 'read-only',
        createPlan: createKimiSessionRuntimePlan,
        createSession: () => createApiSessionClientFixture({ metadataPermissionMode: 'read-only' }),
    },
    {
        providerId: 'kilo',
        expectedPermissionMode: 'safe-yolo',
        createPlan: createKiloSessionRuntimePlan,
    },
    {
        providerId: 'copilot',
        expectedPermissionMode: 'yolo',
        createPlan: createCopilotSessionRuntimePlan,
    },
    {
        providerId: 'auggie',
        expectedPermissionMode: 'safe-yolo',
        createPlan: createAuggieSessionRuntimePlan,
    },
];

function createFactoryParams(
    session: ReturnType<typeof createApiSessionClientFixture>,
    getPermissionMode: () => PermissionMode,
): HostSessionRuntimeFactoryParams {
    return {
        directory: '/tmp/worktree',
        metadata: createTestMetadata({ path: '/tmp/worktree' }),
        machineId: 'machine-1',
        session,
        transcriptSession: {} as HostSessionRuntimeFactoryParams['transcriptSession'],
        messageBuffer: createMessageBufferFixture(),
        mcpServers: {},
        // The runtime only forwards this fixture to the backend factory in this test.
        permissionHandler: createApprovedPermissionHandler() as unknown as HostSessionRuntimeFactoryParams['permissionHandler'],
        setThinking: vi.fn(),
        getPermissionMode,
        memoryRecallGuidanceEnabled: false,
    };
}

async function startPlanRuntime(
    plan: HostSessionRuntimePlan,
    session: ReturnType<typeof createApiSessionClientFixture>,
    getPermissionMode: () => PermissionMode,
) {
    const createSessionRuntime = plan.config.createSessionRuntime;
    expect(createSessionRuntime).toBeTypeOf('function');
    if (!createSessionRuntime) {
        throw new Error('Expected host session plan to expose createSessionRuntime');
    }

    const createdRuntime = await createSessionRuntime(createFactoryParams(session, getPermissionMode));
    const runtime = normalizeFactoryResult(createdRuntime);

    expect(runtime.nativeRuntime).toBe(runtime.operations);
    await runtime.operations.startOrLoadSession({});
    await runtime.operations.resetOrDisposeRuntime();
}

function normalizeFactoryResult(createdRuntime: HostSessionRuntimeFactoryResult<RuntimeTurnOperations>): {
    operations: NonNullable<Extract<HostSessionRuntimeFactoryResult<RuntimeTurnOperations>, { operations: unknown }>['operations']>;
    nativeRuntime: NonNullable<Extract<HostSessionRuntimeFactoryResult<RuntimeTurnOperations>, { nativeRuntime?: unknown }>['nativeRuntime']>;
} {
    if (!('operations' in createdRuntime) || !createdRuntime.nativeRuntime) {
        throw new Error('Expected catalog host session plan to return operations + nativeRuntime');
    }
    return {
        operations: createdRuntime.operations,
        nativeRuntime: createdRuntime.nativeRuntime,
    };
}

describe('ACP catalog family bindings permission delegation', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('forwards provider-specific permission modes from host session plans into provider-owned runtime factories', async () => {
        for (const provider of providerCases) {
            const createCalls: CatalogAcpRuntimeCreateCall[] = [];
            const createSpy = createCatalogAcpBackendSpy(createCalls);
            const session = provider.createSession?.() ?? createApiSessionClientFixture();
            const permissionMode = provider.providerId === 'kimi' ? undefined : provider.expectedPermissionMode;
            const plan = provider.createPlan({
                credentials,
                ...(permissionMode ? { permissionMode } : {}),
            });

            await startPlanRuntime(
                plan,
                session,
                () => permissionMode ?? provider.expectedPermissionMode,
            );

            expect(createSpy).toHaveBeenCalledTimes(1);
            expect(createCalls).toEqual([
                {
                    agentId: provider.providerId,
                    permissionMode: provider.expectedPermissionMode,
                },
            ]);
        }
    });
});
