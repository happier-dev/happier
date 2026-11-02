import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { waitForCondition } from '@/testkit/async/waitFor';
import { writeCodexAuthStoreFile } from '../connectedServices/writeCodexAuthStoreFile';
import type { DisposableCodexAppServerClient } from './client/createCodexAppServerClient';
import { createCodexAppServerRuntime } from './runtime';

describe('Codex request identity', () => {
    it.each(['before-request', 'in-flight'] as const)('captures auth at request issuance across a %s switch', async switchPhase => {
        const root = await createTempDir('codex-request-identity-');
        let releaseBegin!: () => void;
        let observeBegin!: () => void;
        const beginObserved = new Promise<void>(resolve => { observeBegin = resolve; });
        const beginReleased = new Promise<void>(resolve => { releaseBegin = resolve; });
        const lifecycle = createSessionTurnLifecycle({
            sessionId: 'request-identity',
            // Mutation delivery is the external persistence boundary, not a mocked lifecycle.
            enqueueSessionTurn: async mutation => {
                if (mutation.action === 'begin' && switchPhase === 'before-request') {
                    observeBegin();
                    await beginReleased;
                }
            },
        });
        const notifications = new Map<string, (payload: unknown) => void | Promise<void>>();
        let turnRequested = false;
        // The app-server transport is the genuine external boundary. Runtime/domain logic stays real.
        const client: DisposableCodexAppServerClient = {
            request: async method => {
                if (method === 'thread/start') return { thread: { id: 'thread-identity' }, model: 'gpt-5.4' };
                if (method === 'account/login/start') return { type: 'chatgptAuthTokens' };
                if (method === 'account/read') return {
                    account: { type: 'chatgpt', email: null, planType: 'plus' },
                    requiresOpenaiAuth: true,
                    workspaceRouting: {
                        chatgptAccountId: 'acct_replacement', backendOrigin: 'https://chatgpt.com',
                        accountRoutingOverride: 'NO_CONSTRAINT',
                    },
                };
                if (method === 'turn/start') {
                    turnRequested = true;
                    return { turn: { id: 'turn-identity' } };
                }
                throw new Error(`Method not found: ${method}`);
            },
            notify: async () => {},
            registerRequestHandler: () => () => {},
            registerNotificationHandler: (method, handler) => {
                notifications.set(method, handler);
                return () => { notifications.delete(method); };
            },
            onExit: () => () => {},
            dispose: async () => {},
        };
        const session = Object.assign(createMutableApiSessionClientFixture({
            overrides: { sessionId: 'request-identity' },
        }), {
            sessionTurnLifecycle: lifecycle,
            // Session message delivery is an external transport boundary.
            sendCodexMessage() {},
            sendSessionEvent() {},
        });
        const runtime = createCodexAppServerRuntime({
            directory: root,
            processEnv: { CODEX_HOME: join(root, 'codex-home') },
            createClient: async () => client,
            initialConnectedServiceRuntimeIdentity: {
                serviceId: 'openai-codex', profileId: 'original', groupId: 'pool', generation: 7,
                activeAccountId: 'acct_original', accountLabel: null,
                credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', credentialFingerprint: 'sha256:11111111',
                source: 'spawn_selection',
            },
            onThinkingChange: () => {},
            onConnectedServiceAuthGenerationApplied: async () => {},
            session,
        });
        const credential = buildConnectedServiceCredentialRecord({
            now: 1_000, serviceId: 'openai-codex', profileId: 'replacement', kind: 'oauth', expiresAt: 2_000,
            oauth: {
                accessToken: 'replacement-access', refreshToken: 'replacement-refresh', idToken: 'replacement-id',
                scope: null, tokenType: null, providerAccountId: 'acct_replacement', providerEmail: null,
            },
        });
        await writeCodexAuthStoreFile({ codexHome: join(root, 'codex-home'), record: credential });
        try {
            await runtime.startOrLoad({});
            const prompt = runtime.sendPrompt('fail after account switch');
            const failure = expect(prompt).rejects.toMatchObject({
                runtimeAuthClassification: {
                    kind: 'usage_limit', groupId: 'pool',
                    profileId: switchPhase === 'before-request' ? 'replacement' : 'original',
                    groupGeneration: switchPhase === 'before-request' ? 8 : 7,
                    credentialRevision: switchPhase === 'before-request'
                        ? 'csr_bbbbbbbbbbbbbbbbbbbbbb' : 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                    sourceProviderAccountId: switchPhase === 'before-request' ? 'acct_replacement' : 'acct_original',
                    failingAccessTokenFingerprint: switchPhase === 'before-request'
                        ? expect.stringMatching(/^sha256:/) : 'sha256:11111111',
                },
            });
            if (switchPhase === 'before-request') await beginObserved;
            else await waitForCondition(() => turnRequested, { timeoutMs: 1_000, label: 'turn issuance' });
            await expect(runtime.applyConnectedServiceAuthGeneration({
                serviceId: 'openai-codex', reason: 'same_provider_account_exhausted',
                expected: { profileId: 'replacement', groupId: 'pool', generation: 8, credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' },
                authGeneration: {
                    credential,
                    selection: { kind: 'group', serviceId: 'openai-codex', groupId: 'pool', activeProfileId: 'replacement', fallbackProfileId: 'original', generation: 8 },
                    forcedWorkspaceId: null,
                },
            })).resolves.toMatchObject({ ok: true });
            releaseBegin();
            await waitForCondition(() => turnRequested, { timeoutMs: 1_000, label: 'turn issuance after preparation' });
            await notifications.get('turn/completed')?.({
                threadId: 'thread-identity',
                turn: { id: 'turn-identity', status: 'failed', error: { message: 'Usage limit reached', codexErrorInfo: 'UsageLimitExceeded' } },
            });
            await failure;
        } finally {
            releaseBegin();
            await runtime.reset();
            await removeTempDir(root);
        }
    });
});
