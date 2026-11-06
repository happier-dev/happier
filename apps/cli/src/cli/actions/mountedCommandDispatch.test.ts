import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import nacl from 'tweetnacl';
import fastify from 'fastify';
import { createActionExecutor, deriveAccountMachineKeyFromRecoverySecret, sealEncryptedDataKeyEnvelopeV1, type ActionExecutorDeps } from '@happier-dev/protocol';
import { encodeBase64 } from '@/api/encryption';
import { ExternalActionRequestEnvelopeV2Schema, EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1 } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { clientActionUnavailable } from '@happier-dev/protocol/actions/clientDispatchV1';
import { SignedRootActionExecuteRequestSchema } from '@/daemon/externalActions/signedRootActionControl';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';

import { listCompiledActionCliCommands } from './compiledCommands';
import { runCompiledActionCliCommand } from './executeCommand';

const { daemonPost } = vi.hoisted(() => ({ daemonPost: vi.fn() }));
// Only the HTTP crossing is substituted; both CLI and answering daemon retain
// the actual schema compiler, credential adapter, admission and executor.
vi.mock('@/daemon/controlHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlHttp')>(), daemonPost,
}));

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const credentials = { token: `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
  sub: 'account-a', session: 'stored-session-a', tokenEpoch: 7,
  provenance: { v: 1, kind: 'account', authority: 'present_user' },
})}.signature`, encryption: null, credentialProvenance: 'stored_session' } as const;
const input = { scope: { serverId: 'home-a', accountId: 'account-a' }, ref: { kind: 'newSession', instanceId: 'composer-a' } };
const listed = { status: 'opened' };

afterEach(() => { daemonPost.mockReset(); process.exitCode = 0; });

describe('compiled mounted-client CLI command daemon ingress', () => {
  it.each(['e2ee', 'plain'] as const)('admits ordinary %s CLI Session input while the live runner is idle', async mode => {
    const sessionId = 'c123456789012345678901234';
    const origin = new URL(resolveServerHttpBaseUrl()).origin;
    const app = fastify();
    const ingressDiagnostics: unknown[] = [];
    app.addHook('onError', async (_request, _reply, error) => { ingressDiagnostics.push(error.message); });
    const secret = new Uint8Array(32).fill(7);
    const dataKey = new Uint8Array(32).fill(19);
    const publicKey = nacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(secret)).publicKey;
    const dataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey, recipientPublicKey: publicKey,
      randomBytes: length => new Uint8Array(length).fill(11),
    }));
    const sessionCredentials = mode === 'e2ee'
      ? { ...credentials, encryption: { type: 'legacy' as const, secret } } : credentials;
    const metadata = { machineId: 'machine-a', path: '/workspace', flavor: 'claude' };
    app.get('/v1/account/encryption', async () => ({ mode, updatedAt: 1 }));
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode }));
    app.get(`/v2/sessions/${sessionId}`, async () => ({ session: createSessionRecordFixture({
      id: sessionId, active: true, encryptionMode: mode, dataEncryptionKey: mode === 'e2ee' ? dataEncryptionKey : null,
      metadata: mode === 'e2ee'
        ? encryptSessionPayload({ ctx: { encryptionKey: dataKey, encryptionVariant: 'dataKey' }, payload: metadata })
        : JSON.stringify(metadata),
      latestTurnId: 'settled-turn', latestTurnStatus: 'completed',
    }) }));
    const httpAdmitted: unknown[] = [];
    app.post(`/v2/sessions/${sessionId}/pending`, async request => {
      const body = request.body as { localId: string; requestedAction: unknown };
      httpAdmitted.push(body);
      return { didWrite: true, pending: { localId: body.localId }, requestedAction: body.requestedAction };
    });
    const admitted: unknown[] = [];
    const daemon = createCliActionExecutorFromCredentials({ credentials: sessionCredentials,
      actionsSettingsProvider: createActionSettingsProvider(),
      machineAdmissionTransport: async request => {
        admitted.push(request);
        return { status: 'accepted', localId: request.localId };
      },
    });
    // Live Sessions receive protected input through the current Account HTTP
    // ingress, not the retired own-daemon signed-root shortcut. Substitute
    // only that remote service; use its real request/response crypto codecs.
    app.post(`${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}session.message.send`, async request => {
      const envelope = ExternalActionRequestEnvelopeV2Schema.parse(request.body);
      const binding = { serverIdentityId: 'srv_home_identity_a', accountId: 'account-a',
        authentication: { kind: 'account' as const, tokenEpoch: 7 },
        actionId: 'session.message.send' as const, requestId: envelope.requestId,
        target: { kind: 'session' as const, sessionId } };
      const material = { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) };
      const opened = openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding, material });
      expect(opened).not.toBeNull();
      const execution = await daemon.execute('session.message.send', opened!.input, {
        surface: 'cli', authority: 'present_user', actionRequestId: envelope.requestId,
      });
      ingressDiagnostics.push(execution);
      return prepareExternalActionResponseV2({ binding, request: envelope, execution, material,
        executedMachineId: 'machine-a',
        randomBytes: length => new Uint8Array(length).fill(13) }).response;
    });
    daemonPost.mockImplementation(async (_path: string, raw: unknown) => {
      const request = SignedRootActionExecuteRequestSchema.parse(raw);
      return await daemon.execute(request.actionId, request.input, {
        surface: 'cli', authority: 'present_user', actionRequestId: request.actionRequestId,
      });
    });
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin });
    const command = listCompiledActionCliCommands().find(row => row.actionId === 'session.message.send')!;
    const output = captureConsoleJsonOutput();
    try {
      await runWithServerHttpBaseUrl(origin, () => runCompiledActionCliCommand({ command,
        argv: [...command.path, sessionId, 'Reply only FX16', '--local-id', 'fx16-idle-input', '--json'],
        deps: { readCredentialsFn: async () => sessionCredentials,
          createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params,
            serverIdentityId: 'srv_home_identity_a',
            actionsSettingsProvider: createActionSettingsProvider(),
          }),
        },
      }));
      const result = output.json();
      expect(result, JSON.stringify({ result, ingressDiagnostics })).toMatchObject({ ok: true, data: { sessionId, localId: 'fx16-idle-input' } });
      if (mode === 'e2ee') {
        expect(admitted).toEqual([expect.objectContaining({ sessionId, targetMachineId: 'machine-a', localId: 'fx16-idle-input' })]);
        expect(httpAdmitted).toEqual([]);
      } else {
        expect(httpAdmitted).toEqual([expect.objectContaining({ targetMachineId: 'machine-a', localId: 'fx16-idle-input' })]);
        expect(admitted).toEqual([]);
        expect(daemonPost).not.toHaveBeenCalled();
      }
    } finally { output.restore(); restore(); await app.close(); }
  });
  it.each([true, false])('preserves the answering daemon result with mounted owner=%s', async (mounted) => {
    const daemon = createActionExecutor({ clientActionExecute: async ({ actionId }) => mounted
      ? { ok: true, result: listed } : clientActionUnavailable(actionId),
    } satisfies Partial<ActionExecutorDeps> as ActionExecutorDeps);
    daemonPost.mockImplementation(async (_path: string, raw: unknown) => {
      const request = SignedRootActionExecuteRequestSchema.parse(raw);
      return await daemon.execute(request.actionId, request.input, {
        surface: 'cli', authority: 'present_user', actionRequestId: request.actionRequestId,
      });
    });
    const command = listCompiledActionCliCommands().find(row => row.actionId === 'composer.attachments.pick')!;
    const output = captureConsoleJsonOutput();
    try {
      await runCompiledActionCliCommand({ command,
        argv: [...command.path, '--input-json', JSON.stringify(input), '--json'],
        deps: {
          readCredentialsFn: async () => credentials,
          createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params,
            actionsSettingsProvider: createActionSettingsProvider(),
          }),
        },
      });
      expect(output.json()).toMatchObject(mounted
        ? { ok: true, data: listed }
        : { ok: false, error: { code: 'unavailable' } });
    } finally { output.restore(); }
  });
});
