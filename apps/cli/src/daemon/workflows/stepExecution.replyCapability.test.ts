import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { SessionInputAdmissionResultV1Schema, deriveWorkflowSessionInputLocalIdV2,
  readSessionInputRequest } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionMessageReplyCapabilityV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import { V2SessionByIdNotFoundSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionPendingEnqueueByMachineRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { UserMessageSchema } from '@/api/types';
import { enqueueWorkflowSessionInput } from './stepExecution';

describe('Workflow reply capability through the real HTTP and Session admission owners', () => {
  it.each(['disconnect', 'http503', 'http401', 'http404-session', 'wrong-response'] as const)(
    'holds %s without a permanent update refusal and rejoins the original after recovery', async failure => {
      const sessionId = 'c123456789012345678901234';
      const workflow = { purpose: 'invocation' as const, runId: 'run-1', invocationRecordId: 'capability-input' };
      const localId = deriveWorkflowSessionInputLocalIdV2(workflow);
      let recovered = false;
      const admitted = new Set<string>();
      const session = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'plain',
        machineId: 'machine-1', metadata: JSON.stringify({ machineId: 'machine-1' }) });
      // Home HTTP is the genuine system boundary. Session lookup, capability
      // parsing, Workflow authoring and the Pending consumer schema stay real.
      const home = createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        if (request.url === '/v1/account/encryption/currentness') {
          response.end(JSON.stringify({ mode: 'plain', version: 1, signingKeyFingerprint: null,
            contentKeyFingerprint: null, updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } }));
        } else if (request.url === `/v2/sessions/${sessionId}`) {
          response.end(JSON.stringify({ session }));
        } else if (request.url === `/v2/sessions/${sessionId}/pending`) {
          response.end(JSON.stringify({ pending: [...admitted].map(localId => ({ localId, status: 'queued' })) }));
        } else if (request.url === `/v2/sessions/${sessionId}/messages/reply-capability`) {
          if (recovered) response.end(JSON.stringify(SessionMessageReplyCapabilityV1Schema.parse({ v: 1, protocolVersions: [1] })));
          else if (failure === 'disconnect') request.socket.destroy();
          else if (failure === 'wrong-response') response.end(JSON.stringify({ v: 1, status: 'none' }));
          else if (failure === 'http404-session') {
            // The current Home masks missing Session access with this resource
            // response; it does not prove the capability route is absent.
            response.statusCode = 404;
            response.end(JSON.stringify(V2SessionByIdNotFoundSchema.parse({ error: 'Session not found' })));
          } else {
            response.statusCode = failure === 'http503' ? 503 : 401;
            response.end(JSON.stringify({ error: 'capability_read_unavailable' }));
          }
        } else {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: 'unexpected_request' }));
        }
      });
      await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
      const address = home.address();
      if (!address || typeof address === 'string') throw new Error('Expected HTTP listener');
      try {
        await runWithServerHttpBaseUrl(`http://127.0.0.1:${address.port}`, async () => {
          const send = () => enqueueWorkflowSessionInput({ credentials: { token: 'test-token', encryption: null },
            sessionId, workflow, text: 'Review', machineAdmissionTransport: async raw => {
              const request = SessionPendingEnqueueByMachineRequestV1Schema.parse(raw);
              expect(request.reply).toEqual({ mode: 'wait', workflow });
              if (request.content.t !== 'plain') throw new Error('Expected plain Workflow input');
              expect(readSessionInputRequest(UserMessageSchema.parse(request.content.v).meta)).toMatchObject({ v: 2, producer: 'workflow', workflow });
              const existing = admitted.has(request.localId);
              admitted.add(request.localId);
              return { status: existing ? 'alreadyAccepted' : 'accepted', localId: request.localId };
            } });
          expect(SessionInputAdmissionResultV1Schema.parse(await send())).toMatchObject({ status: 'outcomeUnknown', localId });
          expect(admitted.size).toBe(0);
          recovered = true;
          expect(SessionInputAdmissionResultV1Schema.parse(await send())).toEqual({ status: 'accepted', localId });
          expect(SessionInputAdmissionResultV1Schema.parse(await send())).toEqual({ status: 'alreadyAccepted', localId });
          expect([...admitted]).toEqual([localId]);
        });
      } finally {
        home.closeAllConnections();
        await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
      }
    },
  );
});
