import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol';
import { ExternalActionRequestEnvelopeSchema, ExternalActionResponseEnvelopeV1Schema, openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { configuration } from '@/configuration';
import { writeDaemonState } from '@/persistence';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { reconcileExternalActionTarget } from '@/daemon/externalActions/reconcileExternalActionTarget';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

describe('original CLI Session Action delivery', () => {
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    it.each([
        { mode: 'e2ee', method: 'execute', offline: false, selector: 'id' },
        { mode: 'plain', method: 'prepare', offline: false, selector: 'tag' },
        { mode: 'plain', method: 'execute', offline: true, selector: 'id' },
        { mode: 'plain', method: 'execute', offline: false, selector: 'default' },
    ] as const)('delivers a remote visual through its owning Machine ($mode, $method, $selector, offline=$offline)', async ({ mode, method, offline, selector }) => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-cli-session-target-' }, async () => {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 4,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            const secret = new Uint8Array(32).fill(17);
            const credentials = { token, credentialProvenance: 'stored_session' as const,
                encryption: mode === 'e2ee' ? { type: 'legacy' as const, secret } : null };
            const sessionId = 'c123456789012345678901234';
            const machineId = 'machine-b';
            const metadata = { machineId, path: '/workspace', flavor: 'claude' };
            const session = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: mode, share: null,
                metadata: mode === 'e2ee' ? encryptSessionPayload({ ctx: { encryptionKey: secret, encryptionVariant: 'legacy' }, payload: metadata })
                    : JSON.stringify(metadata) });
            writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
                controlToken: 'fixture-control-token', machineId: 'machine-a', accountId: 'owner' });
            const actionId = 'session.board.item.upsert';
            const input = { sessionId, itemId: 'remote-visual', expectedItemRevision: null, destination: 'transcript',
                item: { v: 1, title: 'Remote visual', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
                    source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'On Machine B' } } } } };
            const { sessionId: _sessionId, ...withoutSession } = input;
            const invokedInput = selector === 'default' ? withoutSession : selector === 'tag' ? { ...input, sessionId: 'remote-board' } : input;
            const context = { surface: 'cli' as const, ...(selector === 'default' ? { defaultSessionId: sessionId } : {}) };
            expect(getActionSpec(actionId).inputSchema.safeParse(input).success).toBe(true);
            const execution = { ok: true as const, result: getActionSpec(actionId).outputSchema!.parse({
                v: 1, serverId: 'srv_home', sessionId, destination: null, itemDestination: 'transcript',
                result: { operation: 'upsert_item', itemId: input.itemId, outcome: 'created', itemRevision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ' },
            }) };
            const material = { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) };
            const delivered: unknown[] = [];
            // Substitute HTTP only: keep credentials, Session opening, origin routing,
            // encrypted envelope production and receiver reconciliation real.
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode, version: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                if (url.endsWith(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session } };
                if (url.endsWith('/v2/sessions/remote-board')) return { status: 404, data: { error: 'not_found' } };
                if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 1 } };
                if (url.endsWith('/v1/machines')) return { status: 200, data: [{ id: machineId, active: !offline,
                    kind: 'persistent', revokedAt: null, replacedByMachineId: null,
                    managedMachineRef: null,
                    access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: mode, accessState: 'ready' } }] };
                throw new Error(`Unexpected Home read: ${url}`);
            });
            vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
                if (url.endsWith('/v2/sessions/lookup-by-tags')) return { status: 200, data: { sessions: [session] } };
                expect(url).toBe(`https://home.test/v1/actions/${actionId}`);
                const envelope = ExternalActionRequestEnvelopeSchema.parse(body);
                const target = { kind: 'machine' as const, machineId };
                expect(envelope.target).toEqual(target);
                delivered.push(body);
                if (offline) return { status: 200, data: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId,
                    requestId: envelope.requestId, execution: { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' } }) };
                const binding = { serverIdentityId: 'srv_home', accountId: 'owner', authentication: { kind: 'account' as const, tokenEpoch: 4 },
                    actionId, requestId: envelope.requestId!, target };
                const decoded = envelope.v === 2 ? openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding, material })?.input : envelope.input;
                expect(decoded).toEqual(input);
                expect(reconcileExternalActionTarget({ actionId, rawInput: decoded, target, currentMachineId: machineId }))
                    .toMatchObject({ kind: 'ready', target: { kind: 'session', sessionId } });
                return { status: 200, data: envelope.v === 2
                    ? prepareExternalActionResponseV2({ request: envelope, binding, material, executedMachineId: machineId,
                        randomBytes: length => new Uint8Array(length).fill(6), execution }).response
                    : ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: envelope.requestId, execution }) };
            });
            vi.stubGlobal('fetch', async () => Response.json({ ok: false, errorCode: 'target_not_local', error: 'target_not_local' }));
            const options = { credentials, serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverApiUrl: 'https://home.test',
                externalActionClient: true as const,
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } };
            const executor = createCliActionExecutorFromCredentials(options);
            const result = method === 'execute' ? await executor.execute(actionId, invokedInput, context)
                : await executor.prepare(actionId, invokedInput, context).then(prepared => prepared.kind === 'ready'
                    ? prepared.invocation.run() : prepared.result);
            expect(result).toEqual(offline ? { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' } : execution);
            expect(await executor.execute(actionId, input, { surface: 'cli', externalActionTarget: { kind: 'machine', machineId: 'machine-a' } }))
                .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
            expect(await createCliActionExecutorFromCredentials({ ...options, machineId: 'machine-a' }).execute(actionId, input, { surface: 'cli' }))
                .toMatchObject({ ok: false, errorCode: 'target_unavailable' });
            expect(delivered).toHaveLength(1);
        });
    });
});
