/**
 * Composed attached-Run journey for a parent Session holding DIRECT Team
 * credential custody (`teams-lane-10/PLAN.md` §2.3; `02-connected-accounts-
 * and-pools.md` §11.8). Its own file because each composition commits the
 * parent Agent through the process-wide plugin reload controller, which a test
 * file shuts down once. Only true boundaries are substituted; see
 * `attachedRunBrokerComposition.composed.testkit.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol';
import { resolveExecutionRunChildSelection } from '@/agent/runtime/bridges/executionRun/runtime/openInputs';

import { reloadConfiguration } from '@/configuration';
import { PUBLIC_HANDOFF_AGENT_PROVIDER_ENV_KEY } from '@/daemon/agentRuntime/runnerManagedProviderPublicHandoff.fixture';
import { createEnvKeyScope } from '@/testkit/env/envScope';

import {
    composeAttachedRunJourney,
    PARENT_AGENT_ID,
    RUN_AGENT_TARGET_KEY,
} from './attachedRunBrokerComposition.composed.testkit';

const testState = vi.hoisted(() => ({
    controlInputs: new Map<number, unknown>(),
    nextControlPort: 44_310,
    readProcessIdentityByPid: vi.fn(),
    sessionInteractionHosts: [] as unknown[],
}));

// The daemon's loopback HTTP server is the boundary: its dispatcher input is
// captured and every runner request below is routed into it.
vi.mock('@/daemon/controlServer', () => ({
    startDaemonControlServer: vi.fn(async (input: unknown) => {
        const port = testState.nextControlPort;
        testState.nextControlPort += 1;
        testState.controlInputs.set(port, input);
        return {
            port,
            stop: vi.fn(async () => {
                testState.controlInputs.delete(port);
            }),
        };
    }),
}));

// OS boundary: process identity of the runner.
vi.mock('@/daemon/processIdentity', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/daemon/processIdentity')>(),
    readProcessIdentityByPid: testState.readProcessIdentityByPid,
}));

// Home network reads (never reached for a live plain Session in this journey,
// but the Session open may consult them).
vi.mock('@/session/transport/rpc/sessionRpc', () => ({
    callSessionRpc: vi.fn(async () => {
        throw new Error('No Session RPC is part of this journey');
    }),
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
    fetchAccountEncryptionCurrentness: vi.fn(async () => ({
        mode: 'plain' as const,
        version: 1,
        signingKeyFingerprint: null,
        contentKeyFingerprint: null,
        updatedAt: 1,
    })),
}));
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
    fetchSessionById: vi.fn(async ({ sessionId }: { sessionId: string }) => ({ id: sessionId, encryptionMode: 'plain' })),
    fetchSessionByIdCompat: vi.fn(async () => null),
}));
vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => ({
    ...await importOriginal<typeof import('@happier-dev/cli-common/firstPartyRuntime')>(),
    resolveManagedCliReleaseChannel: vi.fn(async () => ({ ringId: 'stable' as const })),
}));

// Observes (never replaces) the Session client's Execution Run registration so
// the test can reach the exact Run host binding production hands the bridge.
vi.mock('@/rpc/handlers/executionRuns', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/rpc/handlers/executionRuns')>();
    return {
        ...actual,
        registerExecutionRunHandlers: (
            ...args: Parameters<typeof actual.registerExecutionRunHandlers>
        ) => {
            testState.sessionInteractionHosts.push(
                (args[1] as { sessionInteractionHost?: unknown }).sessionInteractionHost,
            );
            return actual.registerExecutionRunHandlers(...args);
        },
    };
});

const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);

describe('attached Execution Run Team credential binding (composed runner → daemon)', () => {
    const cleanups: Array<() => void | Promise<void>> = [];

    afterEach(async () => {
        while (cleanups.length > 0) {
            await cleanups.pop()?.();
        }
        testState.controlInputs.clear();
        testState.sessionInteractionHosts.length = 0;
        testState.readProcessIdentityByPid.mockReset();
        vi.unstubAllGlobals();
        envScope.restore();
        reloadConfiguration();
    });

    it('refuses an inheriting Run of a DIRECT Team parent typed, and never launches it natively', async () => {
        const journey = await composeAttachedRunJourney({
            cleanups,
            parentDeliveryMode: 'direct',
            testState,
            envScope,
        });
        const {
            sessionId,
            openTeamCredentialProviderBinding,
            runAgent,
            startRun,
            runOpenOperations,
        } = journey;

        // The parent Session itself opened A over direct delivery.
        expect(openTeamCredentialProviderBinding).toHaveBeenCalledTimes(1);
        expect(openTeamCredentialProviderBinding).toHaveBeenLastCalledWith(expect.objectContaining({
            sessionId,
            resourceId: 'resource-a',
            deliveryMode: 'direct',
        }));

        // Direct custody is material delivered to the parent's own Agent, which a
        // Run cannot consume (the Run owner attests only a Run's OWN direct
        // selection). `02-…` §11.8: a typed operation-local incompatibility, and
        // "No default branch may reinterpret it as native."
        const applied = journey.readAppliedTeamCredentialModel();
        if (!applied) throw new Error('Expected the parent runtime\'s direct Team selection');
        expect(() => resolveExecutionRunChildSelection({
            lifecycle: 'attached', backendTarget: { kind: 'backend', backendId: PARENT_AGENT_ID },
            parent: { status: 'applied', backendTarget: { kind: 'backend', backendId: PARENT_AGENT_ID },
                modelId: applied.modelId, teamCredentialModel: applied, connectedServices: null },
        })).toThrowError(expect.objectContaining({ code: 'execution_run_child_choice_required' }));
        expect(openTeamCredentialProviderBinding).toHaveBeenCalledTimes(1);
        expect(runOpenOperations()).toHaveLength(0);
        expect(runAgent.launches).toHaveLength(0);

        // A Run that selects its own direct credential is unaffected.
        const ownDirect = await startRun('run-own-direct', {
            kind: 'team_credential_provider_model',
            resourceId: 'resource-d',
            teamId: 'team-d',
            expectedResourceRevision: 2,
            agentTargetKey: RUN_AGENT_TARGET_KEY,
            modelId: 'model-d' as TeamCredentialProviderModelSelectionV1['modelId'],
            deliveryMode: 'direct',
        });
        expect(runAgent.launches.at(-1)).toMatchObject({
            runId: 'run-own-direct',
            env: { [PUBLIC_HANDOFF_AGENT_PROVIDER_ENV_KEY]: 'scoped-direct-resource-d' },
        });
        await ownDirect.dispose();
    }, 180_000);
});
