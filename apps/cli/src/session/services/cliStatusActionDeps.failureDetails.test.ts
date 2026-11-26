import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { SessionStatusResultSchema } from '@happier-dev/protocol/sessions/control/contract';

import { configuration } from '@/configuration';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createSessionRecordFixture, createSessionNotificationContextFixture } from '@/testkit/backends/sessionFixtures';

it('retains the captured project-row refusal while withholding the accepted checkout', async () => {
  const sessionId = 'c111111111111111111111111';
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'status-account' })).toString('base64url')}.signature`, encryption: null };
  const metadata = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
    metadata: { path: '/accepted/project', host: 'fixture', machineId: 'status-machine', workspaceId: 'project-checkout', projectId: 'account-project' },
    agentState: {} });
  const session = createSessionRecordFixture({ id: sessionId, share: null, active: false, encryptionMode: 'plain', metadataLayoutVersion: 1,
    metadata: metadata.sharedMetadata.ciphertext, metadataVersion: 0, ownerMetadata: metadata.ownerMetadata, agentState: metadata.agentState,
    ...(metadata.displayProjectionV1 ? { displayProjectionV1: metadata.displayProjectionV1 } : {}),
    effectiveAccess: createSessionNotificationContextFixture(sessionId).effectiveAccess });
  let refused = false;
  const server = createServer((request, response) => {
    let result: unknown;
    let status = 200;
    if (request.url === '/v1/account/encryption/currentness') result = { mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 };
    else if (request.url === '/v1/account/encryption') result = { mode: 'plain', updatedAt: 0 };
    else if (request.url === '/v2/account/settings') result = { version: 1, content: { t: 'plain', v: {} } };
    else if (request.url === `/v2/sessions/${sessionId}`) result = { session };
    else if (request.url === '/v1/account/project-rows/list') {
      if (refused) {
        status = 403;
        // MATRIX-CLOSE-1126/status-probe.log:19, captured Home refusal.
        result = { error: 'credential_scope_denied', authorizationRefusal: 'effect_family' };
      } else {
        const serverId = configuration.activeServerId;
        const key = { kind: 'workspace-ref', serverId, id: 'project-checkout' };
        result = ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', coverage: 'complete', rows: [{ key, revision: 1,
          content: { t: 'plain', v: { key, value: { id: key.id, serverId, machineId: 'status-machine', rootPath: '/accepted/project',
            projectKey: 'account-project', createdAtMs: 1 } } } }] });
      }
    } else { status = 404; result = { error: 'not_found' }; }
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected fixture Home');
  const url = `http://127.0.0.1:${address.port}`;
  try {
    await withConfiguredDaemonTestHome({ prefix: 'status-project-refusal-', env: { HAPPIER_SERVER_URL: url, HAPPIER_WEBAPP_URL: url } }, async () => {
      const executor = createActionExecutor(createCliActionDeps({ credentials, token: credentials.token,
        sessionId: 'cli-global', mode: 'plain', ctx: null }));
      const context = { surface: 'ui', authority: 'present_user' } as const;
      const read = () => executor.execute('session.status.get', { sessionId, includeAcceptedWorkspace: true }, context);
      const control = await read();
      expect(control).toMatchObject({ ok: true, result: { acceptedWorkspace: { checkout: { workspaceId: 'project-checkout' } } } });
      refused = true;
      const result = await read();
      expect(result).toMatchObject({ ok: true, result: { session: { id: sessionId }, projectContextSource: { kind: 'unavailable',
        failureCause: { phase: 'project_rows.read', errorCode: 'credential_scope_denied', nativeErrorReason: 'effect_family', httpStatus: 403 } } } });
      expect(result).not.toHaveProperty('result.acceptedWorkspace');
      if (!result.ok) throw new Error(result.error);
      expect(SessionStatusResultSchema.parse(result.result)).toHaveProperty('projectContextSource.failureCause.errorCode', 'credential_scope_denied');
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
