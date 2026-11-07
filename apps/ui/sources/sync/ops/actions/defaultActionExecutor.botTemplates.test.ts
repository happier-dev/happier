import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
await loadSyncSingletonForTests();
const { createDefaultActionExecutor, withDefaultActionExecuteContext } = await import('./defaultActionExecutor');

describe('requester-local template creation', () => {
    beforeEach(async () => { await harness.reset(); });
    afterEach(standardCleanup);
    it('reads a received template with the recipient Account credential after UI consent', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://template-ordinary-copy.test',
            accountId: 'recipient', serverIdentityId: 'srv_template', currentAccount: true, botsEnabled: true });
        const artifactId = '84a6bc9c-0418-44f6-a593-8a751bde13e0';
        let sourceHeaders: Headers | undefined;
        harness.answer(serverId, `/v1/artifacts/${artifactId}`, { select: (_body, http) => {
            sourceHeaders = new Headers(http.init?.headers);
            return { status: 404, body: { error: 'not_found' } };
        } });
        const input = { source: { kind: 'artifact', serverId: 'srv_template', artifactId }, expectedVersion: '1.0.0',
            creation: { creationKey: 'ordinary-copy', executionTarget: { serverId: 'srv_template', machineId: 'selected-machine' },
                directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } };
        const result = await createDefaultActionExecutor().execute('template.instantiate', input,
            { surface: 'ui', authority: 'present_user', serverId });
        expect(result.ok).toBe(false); // The source is absent; the transport must still reach its ordinary read.
        expect(sourceHeaders, JSON.stringify(result)).toBeDefined();
        expect(sourceHeaders?.get('Authorization')).toMatch(/^Bearer /);
        expect(sourceHeaders?.get(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER)).toBeNull();
        expect(harness.requestsFor('/v1/actions/template.instantiate/execution-authorization')).toHaveLength(0);
    });
    it('keeps the admitted Account on generic instructions validation when another Home is focused', async () => {
        const serverId = await harness.addHome({ name: 'Requester', serverUrl: 'https://template-validator.test',
            accountId: 'recipient', serverIdentityId: 'srv_validator', currentAccount: true, botsEnabled: true });
        const artifactId = '84a6bc9c-0418-44f6-a593-8a751bde13e0';
        const input = { source: { kind: 'artifact', serverId: 'srv_validator', artifactId }, expectedVersion: '1.0.0',
            creation: { creationKey: 'validator-copy', executionTarget: { serverId: 'srv_validator', machineId: 'asleep-machine' },
                directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } };
        let validatorHeaders: Headers | undefined;
        harness.answer(serverId, '/v1/artifacts/read', { select: (_body, http) => {
            validatorHeaders = new Headers(http.init?.headers);
            return { status: 404, body: { error: 'not_found' } };
        } });
        await withDefaultActionExecuteContext({}, { serverId }, async (executor, account) => {
            const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId };
            expect((await executor.execute('template.instantiate', input, context)).ok).toBe(false);
            await harness.addHome({ name: 'Other', serverUrl: 'https://other-validator.test',
                accountId: 'other', serverIdentityId: 'srv_other', currentAccount: true });
            const result = await executor.execute('session.instructions.set', { serverId, sessionId: 'newborn-bot',
                expectedMetadataRevision: 0, ref: { kind: 'doc', serverId, artifactId } }, context);
            expect(result.ok).toBe(false); // The addressed Artifact is absent; validation must retain its admitted reader.
            expect(validatorHeaders, JSON.stringify(result)).toBeDefined();
            expect(validatorHeaders?.get('Authorization')).toBe(`Bearer ${account.credentials.token}`);
            expect(validatorHeaders?.get(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER)).toBeNull();
        }, 'template.instantiate');
        expect(harness.requests.filter(request => request.serverUrl === 'https://other-validator.test'
            && request.path === '/v1/artifacts/read')).toHaveLength(0);
        expect(harness.requestsFor('/v2/sessions/newborn-bot')).toHaveLength(0);
    });
});
