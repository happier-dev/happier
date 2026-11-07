import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ExternalActionRequestEnvelopeV1Schema, projectDeploymentReadAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { DeploymentEnvironmentHealthFeedV1 } from '@happier-dev/deployments';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, type HomeDomainAnswer } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { environmentHealthObserver } from './observeEnvironmentHealth';

// Replace only Home HTTP/credentials; keep Action admission, Resource and P40 real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let serverId: string;
beforeEach(async () => {
    await homes.reset();
    serverId = await homes.addHome({ name: 'Current edge', serverUrl: 'https://current-edge.test',
        serverIdentityId: 'srv_current_edge', accountId: 'account', currentAccount: true, active: false });
});
afterEach(async () => { await homes.reset(); });

it('pushes the same observer current edge proof into the Environment aggregate and withdraws missing or stale proof', async () => {
    const base = createDeploymentEnvironmentDetailV1();
    const link = createDeploymentTargetLinkHeaderV1({ machines: ['joining'],
        members: [{ machineId: 'joining', installationId: 'joining-installation', state: 'joining' }] });
    const detail = { ...base, environment: { ...base.environment, controllerMachineId: 'controller',
        runtimeTargetLinkId: link.id, ingress: { kind: 'edgeCaddy' as const, edgeMachineId: 'edge' } },
        runtimeTargetLink: link, memberVersions: {} };
    const input = { serverId, machineId: 'controller', environmentId: detail.environment.id, targetLinkId: link.id };
    const reference = { hostRead: 'deployments.health.edge', input };
    const proof = { environmentId: detail.environment.id, targetLinkId: link.id, targetLinkRevision: link.revision,
        machineId: 'edge', role: 'edge', status: 'up', observedAtMs: 100,
        source: { kind: 'domain', observerMachineId: 'controller' } };
    let observation: typeof proof | null = proof;
    const content = () => {
        const bytes = Buffer.from(JSON.stringify({ ok: true, environmentId: detail.environment.id, targetLinkId: link.id, observation }));
        return { bytesBase64: bytes.toString('base64'), digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
    };
    const row = { ...createPlainMachineRowFixture({ id: 'controller', accountId: 'account' }), installationId: 'installation' };
    homes.answer(serverId, 'POST /v1/machines/read-batch', { select: async body => ({
        body: await createMachineReadBatchResponseFixture(body, () => row).json(),
    }) });
    const actionId = 'deployments.health.current';
    const actionPath = `/v1/actions/${actionId}`;
    homes.answer(serverId, `${actionPath}/execution-authorization`, { select: body => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
        return { body: { v: 1, token: 'current-edge-proof', binding: {
            serverIdentityId: 'srv_current_edge', accountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 },
            actionId, requestId: envelope.requestId, target: { kind: 'machine', machineId: 'controller' },
            machineId: 'controller', installationId: 'installation', custodianAccountId: 'account', accountEncryptionMode: 'plain',
            deploymentReadAdmission: projectDeploymentReadAdmissionV1(actionId, input),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } } };
    } });
    let deliver: (() => void) | undefined;
    homes.answer(serverId, actionPath, { select: async (body, request) => {
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse((body as { envelope: unknown }).envelope);
        const continuation = envelope.resourceContinuation;
        if (!continuation) throw new Error('Expected current edge Resource continuation');
        const reply = (result: unknown): HomeDomainAnswer => ({ body: { v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result } } });
        if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ)
            return reply({ ok: true, resource: reference, contentType: 'application/json', ...content() });
        if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN)
            return reply({ ok: true, subscriptionId: continuation.params.subscriptionId, digest: content().digest });
        if (continuation.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE) return reply({ ok: true, closed: true });
        const subscriptionId = continuation.params.subscriptionId;
        return new Promise<HomeDomainAnswer>(resolve => {
            deliver = () => resolve(reply({ ok: true, status: 'event', event: {
                version: 1, kind: 'invalidated', subscriptionId, digest: content().digest,
            } }));
            const abort = () => resolve(reply({ ok: true, status: 'idle' }));
            request.signal?.addEventListener('abort', abort, { once: true });
            if (request.signal?.aborted) abort();
        });
    } });
    let feed: DeploymentEnvironmentHealthFeedV1 | undefined;
    const abort = new AbortController();
    const stop = environmentHealthObserver({ scope: { serverId, accountId: 'account' },
        isCurrent: () => true, onRetire: () => ({ dispose() {} }) })(
        { serverId, accountId: 'account' }, detail, value => { feed = value; }, { signal: abort.signal });
    try {
        await vi.waitFor(() => expect(feed).toMatchObject({ aggregate: { members: [{ machineId: 'edge', status: 'up' }] } }));
        await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
        const first = deliver;
        observation = null;
        first?.();
        await vi.waitFor(() => expect(feed).toMatchObject({ aggregate: { members: [{ machineId: 'edge', status: 'unknown' }] } }));
        await vi.waitFor(() => expect(deliver).not.toBe(first));
        const second = deliver;
        observation = proof;
        second?.();
        await vi.waitFor(() => expect(feed).toMatchObject({ aggregate: { members: [{ machineId: 'edge', status: 'up' }] } }));
        await vi.waitFor(() => expect(deliver).not.toBe(second));
        observation = { ...proof, targetLinkRevision: link.revision + 1 };
        deliver?.();
        await vi.waitFor(() => expect(feed).toMatchObject({ aggregate: { members: [{ machineId: 'edge', status: 'unknown' }] } }));
    } finally { abort.abort(); stop?.(); }
});
