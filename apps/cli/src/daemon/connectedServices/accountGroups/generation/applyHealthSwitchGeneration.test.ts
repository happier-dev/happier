import { expect, it } from 'vitest';
import { ConnectedServiceRuntimeRegistry } from '../../runtimeRegistry/registry';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../../connectedServiceChildEnvironment';
import { ConnectedServiceAuthGroupGenerationConsumer } from './ConnectedServiceAuthGroupGenerationConsumer';
import { applyHealthSwitchGeneration } from './applyHealthSwitchGeneration';

it('applies a health-driven generation to the affected Account/group through the real durable consumer', async () => {
    const registry = new ConnectedServiceRuntimeRegistry();
    for (const [index, [sessionId, groupId]] of [['source', 'pool'], ['sibling', 'pool'], ['other-group', 'elsewhere'], ['foreign', 'pool']].entries()) {
        registry.registerTarget({ pid: index + 1, agentId: 'codex', sessionId, materializationKey: sessionId,
            connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: { 'openai-codex': {
                source: 'connected', selection: 'group', groupId, profileId: 'work',
            } } },
            connectedServiceSelectionsEnv: { [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                kind: 'group', serviceId: 'openai-codex', groupId, activeProfileId: 'work', fallbackProfileId: 'backup',
                generation: 7, policy: null, credentialRevision: 'csr_abcdefghijklmnopqrstuv',
            }]) },
        });
    }
    const scoped = registry.scopeToRequester(target => target.sessionId !== 'foreign');
    const adopted = new Map<string, string>();
    const cleared: string[] = [];
    const consumer = new ConnectedServiceAuthGroupGenerationConsumer({
        resolveGenerationApplicationScope: async ({ sessionId }) => ({ status: 'supported', scope: 'per_session_runtime', ownerId: sessionId }),
        verifySharedGenerationApplication: async () => null,
        // The runner application/acknowledgement is the process boundary. Keep
        // recipient discovery, fact construction and durable consumption real.
        applyCommittedGeneration: async ({ sessionId, committedGeneration, executionAuthority }) => {
            expect(executionAuthority).toBe('runtime_recovery');
            expect(committedGeneration.provenance).toBe('runtime_failure');
            const target = committedGeneration.decisionCommittedTarget;
            adopted.set(sessionId, `${target.profileId}:${target.generation}`);
            return { reconciliationDisposition: 'converged', errorCode: null,
                providerAdoptedTarget: { ...target, proof: { status: 'verified', source: 'test-runner', credentialRevision: target.credentialRevision } } };
        },
        clearAdoptedGeneration: async ({ sessionId }) => { cleared.push(sessionId); },
    });
    await expect(applyHealthSwitchGeneration({ serviceId: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        groupId: 'pool', activeProfileId: 'backup', generation: 8, credentialRevision: 'csr_bcdefghijklmnopqrstuvw',
    }, { runtimeRegistry: scoped, consume: request => consumer.consume(request) })).resolves.toEqual({ ok: true });
    expect([...adopted]).toEqual([['source', 'backup:8'], ['sibling', 'backup:8']]);
    expect(cleared.sort()).toEqual(['sibling', 'source']);
});
