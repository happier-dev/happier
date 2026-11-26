import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { projectActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { captureStdout, captureStderr } from '@/testkit/logger/captureOutput';
import { cmdSessionActionsExecute } from './execute';

it.each([true, false])('preserves refused Action diagnostics when supplied: %s', async (withCause) => {
  const failureCause = { phase: 'execution_authorization', errorClass: 'Error',
    errorCode: 'custodian_only', httpStatus: 409, nativeErrorReason: 'machine_admission_refused' } as const;
  const requestId = '5a562b47-3f68-497b-bd73-3a8799f71125';
  const failure = projectActionExecuteFailure({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable',
    ...(withCause ? { failureCause, requestId, effectAttempted: false } : {}) });
  // Only Home HTTP is replaced; parsing, credential transport and CLI presentation stay real.
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const input = JSON.parse(body) as { requestId: string };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ v: 1, actionId: 'session.status.get', requestId: input.requestId, execution: failure }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected fixture Home');
  const url = `http://127.0.0.1:${address.port}`;
  const previousExitCode = process.exitCode;
  try {
    await withConfiguredDaemonTestHome({ prefix: 'actions-execute-cause-', env: {
      HAPPIER_SERVER_URL: url, HAPPIER_WEBAPP_URL: url,
    } }, async () => {
      const deps = { readCredentialsFn: async () => ({
        token: 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43),
        encryption: null, credentialProvenance: 'api_token' as const,
      }) };
      const argv = ['actions', 'execute', 'cmwt2olu5025agbmcwgbp5g3a', 'session.status.get', '--action-request-id', requestId];
      const stdout = captureStdout();
      const stderr = captureStderr();
      try {
        await cmdSessionActionsExecute([...argv, '--json'], deps);
        const envelope = JSON.parse(stdout.text());
        expect(envelope).toMatchObject({ ok: false, kind: 'session_actions_execute', error: {
          code: 'target_unavailable', message: 'target_unavailable', requestId,
          ...(withCause ? { failureCause, requestId, effectAttempted: false } : {}),
        } });
        expect(stderr.text()).toBe('');
        if (!withCause) expect(envelope.error).not.toHaveProperty('failureCause');
        const command = cmdSessionActionsExecute(argv, deps);
        await expect(command).rejects.toHaveProperty('message', expect.stringContaining(requestId));
        if (withCause) {
          for (const diagnostic of [failureCause.phase, failureCause.errorCode, 'HTTP 409',
            failureCause.nativeErrorReason, 'No effect attempted']) {
            await expect(command).rejects.toHaveProperty('message', expect.stringContaining(diagnostic));
          }
        } else {
          await expect(command).rejects.toHaveProperty('message', `target_unavailable\nrequestId: ${requestId}`);
        }
      } finally { stderr.restore(); stdout.restore(); }
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    process.exitCode = previousExitCode;
  }
});
