import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountEncryptionCurrentnessResponseSchema, deriveSessionCreationTagV1, FeaturesResponseSchema } from '@happier-dev/protocol';
import { StoredSessionOwnerMetadataEnvelopeV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import { configuration } from '@/configuration';
import { clearDaemonStateForTestTeardown, readSettings, writeDaemonState, writeSettings } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { runHostSessionRuntime, type HostSessionRuntimeConfig } from './runHostSessionRuntime';

afterEach(() => vi.unstubAllEnvs());

it('publishes each hosted Session profile through real runtime initialization and Session creation', async () => {
    // The CLI runner owns a disposable Home. A live daemon record keeps the
    // real API initializer on the existing registered-Machine startup path.
    const settings = await readSettings();
    await writeSettings({ ...settings, machineId: 'hosted-birth-machine',
        machineIdByServerId: { ...settings.machineIdByServerId, [configuration.activeServerId]: 'hosted-birth-machine' } });
    writeDaemonState({ pid: process.pid, httpPort: 1, startedAt: Date.now(), startedWithCliVersion: 'test', controlToken: 'test-token' });
    vi.stubEnv('HAPPIER_SESSION_PROFILE_ID', 'host-process-profile');

    const requests = new Map<string, unknown>();
    const sessions = ['a', 'b'].map(id => ({ id, tag: deriveSessionCreationTagV1({
        callerCreationNamespace: 'user', creationKey: `hosted-birth-${id}`,
    }) }));
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { encryption: {
        storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain',
    } } });
    const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 0,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 });
    const home = createServer(async (request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.method === 'GET' && request.url === '/v1/features') {
            response.end(JSON.stringify(features));
            return;
        }
        if (request.method === 'GET' && request.url === '/v1/account/encryption/currentness') {
            response.end(JSON.stringify(currentness));
            return;
        }
        if (request.method === 'POST' && request.url === '/v1/sessions') {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (typeof body === 'object' && body !== null && 'tag' in body && typeof body.tag === 'string') {
                requests.set(body.tag, body);
            }
            // Stop at the actual HTTP boundary before creating a server Session
            // or starting an Agent. All metadata and startup owners remain real.
            response.statusCode = 403;
            response.end(JSON.stringify({ error: 'forbidden' }));
            return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'unexpected-test-request' }));
    });
    home.listen(0, '127.0.0.1');
    await once(home, 'listening');
    const address = home.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP Home fixture');
    const config: HostSessionRuntimeConfig = {
        flavor: 'qwen', policyAgentId: 'qwen', backendDisplayName: 'Test Agent', providerName: 'Test Agent',
        uiLogPrefix: '[hosted birth]', waitingForCommandLabel: 'Test Agent', agentMessageType: 'qwen',
        runtimeActivityApplicability: 'not_applicable', processLifecycleOwnership: 'caller',
        machineMetadata: { host: 'test', platform: process.platform, happyCliVersion: 'test',
            homeDir: configuration.happyHomeDir, happyHomeDir: configuration.happyHomeDir, happyLibDir: configuration.happyHomeDir },
        loadTerminalDisplay: async () => () => null, shouldRenderTerminalDisplay: () => false,
        formatPromptErrorMessage: String,
    };
    try {
        await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, () => Promise.all(sessions.map(({ id, tag }) =>
            runAddedHostedSession({ environment: { HAPPIER_SESSION_PROFILE_ID: `profile-${id}` },
                workingDirectory: configuration.happyHomeDir, end: () => undefined }, async () => {
                await Promise.resolve();
                await expect(runHostSessionRuntime({ credentials: { token: 'hosted-birth-test-token', encryption: null },
                    sessionCreationTag: tag, directory: configuration.happyHomeDir, startedBy: 'terminal',
                    permissionMode: 'default' }, config)).rejects.toMatchObject({ response: { status: 403 } });
            }))));
        for (const { id, tag } of sessions) {
            const request = requests.get(tag);
            expect(request).toBeDefined();
            if (typeof request !== 'object' || request === null || !('ownerMetadata' in request)) {
                throw new Error('Expected Session creation owner metadata');
            }
            const envelope = StoredSessionOwnerMetadataEnvelopeV1Schema.parse(request.ownerMetadata);
            expect(envelope).toMatchObject({ t: 'plain', v: { workspace: { profileId: `profile-${id}` } } });
        }
        expect(process.env.HAPPIER_SESSION_PROFILE_ID).toBe('host-process-profile');
    } finally {
        await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
        await clearDaemonStateForTestTeardown();
        await writeSettings(settings);
    }
});
