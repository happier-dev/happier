import { describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import { encodeBase64 } from '@/encryption/base64';
import type { ServerFetch } from '@/sync/http/client';
import {
    createRunnerActivationClient,
    RunnerActivationClientError,
} from './runnerActivationClient';

const artifact = {
    identity: {
        product: 'happier-runner' as const,
        version: '0.3.0',
        target: 'linux-x64' as const,
        sha256: 'a'.repeat(64),
    },
    channel: 'stable',
    url: 'https://home.test/runner.zip',
    checksumsUrl: 'https://home.test/checksums.txt',
    checksumsSignatureUrl: 'https://home.test/checksums.txt.minisig',
    sizeBytes: 123,
    entries: [{ path: 'happier-runner', kind: 'file', sizeBytes: 100, mode: 0o755 }],
};

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('runner activation client', () => {
    it('rejects structurally valid activation reads that do not match the requested identity', async () => {
        const signing = tweetnacl.sign.keyPair();
        const requestedActivationId = '00000000-0000-4000-8000-000000000007';
        const projection = {
            activationId: '00000000-0000-4000-8000-000000000008',
            draftId: 'draft-other',
            homeServerIdentityId: 'srv_home_a',
            creatorAccountId: 'creator',
            creatorTokenEpoch: 0,
            activationExpiresAt: null,
            workspace: { kind: 'choose_on_endpoint' as const },
            sessionId: 'session-a',
            machineId: 'machine-a',
            activationSigningPublicKey: encodeBase64(signing.publicKey, 'base64url'),
            authoringCommitment: 'A'.repeat(43),
            artifact: artifact.identity,
            endpointFactsRecipient: { mode: 'plain' as const, creatorAccountId: 'creator' },
            state: 'pending' as const,
            closeReason: null,
            progressPhase: null,
            claim: null,
            endpointFacts: null,
            review: null,
            consent: null,
            readiness: null,
            materialization: null,
        };
        const client = createRunnerActivationClient(async () => jsonResponse(200, projection));

        await expect(client.read(requestedActivationId)).rejects.toMatchObject({
            code: 'malformed_response',
        });
        await expect(client.readByDraft('draft-requested')).rejects.toMatchObject({
            code: 'malformed_response',
        });
    });

    it('resolves an exact reviewed credential binding through the authenticated pre-Session route', async () => {
        const activationId = '00000000-0000-4000-8000-000000000007';
        const input = {
            v: 1 as const,
            selection: {
                kind: 'team_credential_provider_model' as const,
                resourceId: 'resource-a', teamId: 'team-a', expectedResourceRevision: 7, deliveryMode: 'brokered' as const,
                agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-5',
            },
            application: {
                agentTargetKey: 'agent:happier.agent.codex/codex',
                implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
                endpointTemplateId: 'responses', protocol: 'openai-responses' as const,
            },
            sourceRevision: 'source-a',
            plannedSession: { primaryTeamId: null, teamVisibilityTeamIds: ['team-a'] },
        };
        const output = {
            v: 1 as const, status: 'resolved' as const,
            credentialSelectionBinding: { v: 1 as const, resourceId: 'resource-a', brokerMachineId: 'broker-a', revision: 7,
                application: input.application, sourceRevision: input.sourceRevision },
            displayFacts: { v: 1 as const, homeId: 'home-a', homeName: 'Acme Home', requesterId: 'account-a', requesterName: 'Alice', teamId: 'team-a', teamName: 'Platform' },
        };
        const request = vi.fn<ServerFetch>(async () => jsonResponse(200, output));
        const controller = new AbortController();

        await expect(createRunnerActivationClient(request).resolveCredentialSelection(activationId, input, controller.signal))
            .resolves.toEqual(output);
        const [path, init, options] = request.mock.calls[0] ?? [];
        expect(path).toBe(`/v1/ephemeral-runners/activations/${activationId}/credential-selection`);
        expect(init).toMatchObject({ method: 'POST', signal: controller.signal });
        // The client re-serializes the strictly parsed request, so the property
        // order follows the canonical schema rather than this literal. What the
        // Home must receive is the exact reviewed selection, not exact bytes:
        // comparing the decoded body keeps a dropped or altered field failing
        // while a schema field reordering stays the non-event it is.
        expect(JSON.parse(String(init?.body))).toEqual(input);
        expect(options).toEqual({ includeAuth: true, retry: 'none' });
    });

    it('strictly stores the reviewed manifest and materializes through canonical activation paths', async () => {
        const activationId = '00000000-0000-4000-8000-000000000007';
        const review = {
            sealedLaunchManifest: 'sealed',
            authoringCommitment: encodeBase64(new Uint8Array(32).fill(7), 'base64url'),
            launchManifestCommitment: 'A'.repeat(43),
            endpointFactsProof: {
                activationSignature: encodeBase64(new Uint8Array(64).fill(8), 'base64url'),
                installationSignature: encodeBase64(new Uint8Array(64).fill(9), 'base64url'),
            },
            agentTargetKey: 'agent:happier.agent.codex/codex',
            machineContentKeyBinding: null,
            credentialSelectionBinding: { v: 1 as const, resourceId: 'resource-a', brokerMachineId: 'broker-a', revision: 1,
                application: { agentTargetKey: 'agent:happier.agent.codex/codex', implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' }, endpointTemplateId: 'responses', protocol: 'openai-responses' as const },
                sourceRevision: 'source-a' },
            displayFacts: { v: 1 as const, homeId: 'home-a', homeName: 'Acme Home', requesterId: 'account-a', requesterName: 'Alice', teamId: 'team-a', teamName: 'Platform' },
        };
        const materialization = {
            v: 1 as const,
            activationId,
            launchManifestCommitment: review.launchManifestCommitment,
            consent: { invalid: true },
            readiness: { invalid: true },
            sealedBootstrap: 'sealed-bootstrap',
            session: {},
            machine: {},
            accessKeyData: 'session-machine-control:key',
        };
        const request = vi.fn<ServerFetch>(async (path) => path.endsWith('/review')
            ? jsonResponse(200, { status: 'stored', review })
            : jsonResponse(200, { status: 'materialized', result: { v: 1, activationId, sessionId: 'session-a', machineId: 'machine-a' } }));
        const client = createRunnerActivationClient(request);

        await expect(client.storeReview(activationId, review)).resolves.toEqual(review);
        await expect(client.materialize(materialization as never)).rejects.toMatchObject({ code: 'malformed_request' });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('reads the canonical creator recipient without reconstructing Account keys', async () => {
        const recipient = { mode: 'plain', creatorAccountId: 'account-1' } as const;
        const request = vi.fn<ServerFetch>(async () => jsonResponse(200, recipient));

        await expect(createRunnerActivationClient(request).readCreatorRecipient()).resolves.toEqual(recipient);
        expect(request).toHaveBeenCalledWith(
            '/v1/ephemeral-runners/creator-recipient',
            undefined,
            { includeAuth: true, retry: 'none' },
        );
    });

    it('reads the authenticated canonical artifact projection without inventing publication discovery', async () => {
        const request = vi.fn<ServerFetch>(async () => jsonResponse(200, {
            status: 'available',
            artifacts: [artifact],
        }));

        const result = await createRunnerActivationClient(request).listArtifacts();

        expect(result.artifacts).toEqual([artifact]);
        expect(request).toHaveBeenCalledWith(
            '/v1/ephemeral-runners/artifacts',
            undefined,
            { includeAuth: true, retry: 'none' },
        );

        await createRunnerActivationClient(request).listArtifacts(undefined, '0.3.0');
        expect(request).toHaveBeenLastCalledWith(
            '/v1/ephemeral-runners/artifacts?version=0.3.0',
            undefined,
            { includeAuth: true, retry: 'none' },
        );
    });

    it('creates, cancels, and durably tears down a materialized Runner through the exact Home transport', async () => {
        const signing = tweetnacl.sign.keyPair();
        const activationSigningPublicKey = encodeBase64(signing.publicKey, 'base64url');
        const requestBody = {
            v: 1 as const,
            activationId: '00000000-0000-4000-8000-000000000007',
            draftId: 'draft-a',
            homeServerIdentityId: 'srv_home_a',
            activationSigningPublicKey,
            activationExpiresAt: null,
            workspace: { kind: 'choose_on_endpoint' as const },
            authoringCommitment: 'A'.repeat(43),
            artifact: artifact.identity,
            endpointFactsRecipient: { mode: 'plain' as const, creatorAccountId: 'creator' },
        };
        const { v: _requestVersion, draftId, ...activationBinding } = requestBody;
        const projection = {
            ...activationBinding,
            draftId,
            creatorAccountId: 'creator',
            creatorTokenEpoch: 0,
            sessionId: 'session-a',
            machineId: 'machine-a',
            state: 'pending',
            closeReason: null,
            claim: null,
            endpointFacts: null,
            review: null,
            consent: null,
            readiness: null,
            materialization: null,
        };
        const request = vi.fn<ServerFetch>(async (_path, init) => init?.method === 'DELETE'
                ? jsonResponse(200, { ...projection, state: 'closed', closeReason: 'canceled' })
                : jsonResponse(200, { status: 'created', activation: projection }));
        const client = createRunnerActivationClient(request);

        const created = await client.create(requestBody);
        const canceled = await client.cancel(requestBody.activationId);

        expect(created.state).toBe('pending');
        expect(canceled).toMatchObject({ state: 'closed', closeReason: 'canceled' });
        expect(request.mock.calls[0]?.[0]).toBe('/v1/ephemeral-runners/activations');
        expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual(requestBody);
        expect(request.mock.calls[1]?.[0]).toBe(`/v1/ephemeral-runners/activations/${requestBody.activationId}`);
        expect(request.mock.calls[1]?.[1]?.method).toBe('DELETE');

        for (const replacement of [
            { activationId: '00000000-0000-4000-8000-000000000008' },
            { draftId: 'other-draft' }, { homeServerIdentityId: 'srv_other' },
            { activationSigningPublicKey: encodeBase64(tweetnacl.sign.keyPair().publicKey, 'base64url') },
            { activationExpiresAt: 123 }, { authoringCommitment: 'B'.repeat(42) + 'A' },
            { workspace: { kind: 'endpoint_home' } },
            { artifact: { ...artifact.identity, sha256: 'b'.repeat(64) } },
            { creatorAccountId: 'other', endpointFactsRecipient: { mode: 'plain', creatorAccountId: 'other' } },
        ]) {
            const substituted = createRunnerActivationClient(async () => jsonResponse(200, {
                status: 'created', activation: { ...projection, ...replacement },
            }));
            await expect(substituted.create(requestBody)).rejects.toMatchObject({ code: 'malformed_response' });
        }
    });

    it('threads a caller abort signal into safe read paths only', async () => {
        const controller = new AbortController();
        const request = vi.fn<ServerFetch>(async (path) => (
            path.startsWith('/v1/ephemeral-runners/artifacts')
                ? jsonResponse(200, { status: 'available', artifacts: [artifact] })
                : jsonResponse(200, { mode: 'plain', creatorAccountId: 'account-1' })
        ));
        const client = createRunnerActivationClient(request);

        await client.readCreatorRecipient(controller.signal);
        await client.listArtifacts(controller.signal);

        for (const call of request.mock.calls) {
            expect(call[1]).toMatchObject({ signal: controller.signal });
        }
    });

    it('reports an aborted safe read as cancellation instead of a retryable transport failure', async () => {
        const controller = new AbortController();
        const abortReason = new Error('runner_activation_preparation_canceled');
        const request = vi.fn<ServerFetch>(async () => {
            controller.abort(abortReason);
            throw abortReason;
        });
        const client = createRunnerActivationClient(request);

        await expect(client.read('00000000-0000-4000-8000-000000000007', controller.signal))
            .rejects.toBe(abortReason);
        await expect(client.readByDraft('draft-a', controller.signal)).rejects.toBe(abortReason);
    });

    it('retains the typed publication failure and reset deadline from the Home', async () => {
        const publicationFailure = { reason: 'rate_limited', resetAtMs: 1793788116000 };
        const client = createRunnerActivationClient(async () => jsonResponse(503, {
            error: 'runner_artifact_publication_unavailable', publicationFailure,
        }));
        await expect(client.listArtifacts()).rejects.toMatchObject({
            serverCode: 'runner_artifact_publication_unavailable', publicationFailure,
        });
    });

    it('carries the Home error code so distinct failures stop collapsing into one status class', async () => {
        const unpublished = createRunnerActivationClient(async () => jsonResponse(
            404,
            { error: 'runner_artifact_target_not_published' },
        ));
        await expect(unpublished.read('00000000-0000-4000-8000-000000000007')).rejects.toMatchObject({
            code: 'not_found',
            serverCode: 'runner_artifact_target_not_published',
            retryable: false,
        });

        const briefly = createRunnerActivationClient(async () => jsonResponse(503, { error: 'runner_unavailable' }));
        await expect(briefly.read('00000000-0000-4000-8000-000000000007')).rejects.toMatchObject({
            code: 'unavailable',
            serverCode: 'runner_unavailable',
            retryable: true,
        });

        // A body the Home vocabulary does not own must not be promoted to a code.
        const opaque = createRunnerActivationClient(async () => jsonResponse(409, { error: 'something_else' }));
        await expect(opaque.read('00000000-0000-4000-8000-000000000007')).rejects.toMatchObject({
            code: 'conflict',
            serverCode: null,
        });
    });

    it('keeps offline cancellation retryable and rejects malformed success data', async () => {
        const offline = createRunnerActivationClient(async () => { throw new Error('offline'); });
        await expect(offline.cancel('00000000-0000-4000-8000-000000000007')).rejects.toMatchObject({
            code: 'request_failed',
            retryable: true,
        });

        const malformed = createRunnerActivationClient(async () => jsonResponse(200, { status: 'created' }));
        await expect(malformed.create({ invalid: true } as never)).rejects.toBeInstanceOf(RunnerActivationClientError);
    });
});
