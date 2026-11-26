import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';

import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { captureConsoleJsonOutput } from '@/testkit/logger/captureOutput';
import { runBackendTargetStartWorkflow } from './runBackendTargetStartWorkflow';

it('prints the complete typed start refusal after public Action transport', async () => {
  const actionId = 'subagents.delegate.start';
  const failure = { ok: false, errorCode: 'credential_scope_denied', error: 'Start refused',
    requestId: 'start-refusal-request', effectAttempted: false, failureCause: {
      phase: 'execution_run.start', errorClass: 'Error', errorCode: 'RPC_FORBIDDEN', httpStatus: 403,
    } } as const;
  let startRequestId = '';
  // Only the public HTTP boundary and process exit are substituted. Parsing,
  // credential routing, result normalization and text presentation stay real.
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const { requestId } = JSON.parse(body) as { requestId?: string };
    const options = request.url === '/v1/actions/action.options.resolve';
    if (!options) startRequestId = requestId ?? '';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ v: 1, actionId: options ? 'action.options.resolve' : actionId, requestId,
      execution: options ? { ok: true, result: { actionId, fieldPath: 'backendTargetKeys',
        optionsSourceId: 'execution.backends.enabled', options: [{ value: 'agent:happier.agent.codex/codex', label: 'Codex' }] } }
        : failure }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected Action endpoint');
  const url = `http://127.0.0.1:${address.port}`;
  const previousExitCode = process.exitCode;
  try {
    await withConfiguredDaemonTestHome({ prefix: 'backend-start-cause-',
      env: { HAPPIER_SERVER_URL: url, HAPPIER_WEBAPP_URL: url } }, async () => {
      const workflow = { actionId, kind: 'session_delegate_start', usageLine: 'session delegate start', startedLabel: 'started' } as const;
      const argv = ['delegate', 'start', 'c123456789012345678901234', '--machine-id', 'machine-a',
        '--backends', 'agent:happier.agent.codex/codex', '--instructions', 'Delegate.'];
      const deps = { readCredentialsFn: async () => ({
        token: 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43),
        encryption: null, credentialProvenance: 'api_token' as const,
      }) };
      const output = captureConsoleJsonOutput();
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('fixture-process-exit'); });
      try {
        await runBackendTargetStartWorkflow(workflow, [...argv, '--json'], deps);
        expect(output.json()).toMatchObject({ ok: false, error: { code: failure.errorCode,
          failureCause: failure.failureCause, requestId: startRequestId, effectAttempted: false } });
        await expect(runBackendTargetStartWorkflow(workflow, argv, deps)).rejects.toThrow('fixture-process-exit');
        const text = stderr.mock.calls.flat().join(' ');
        for (const diagnostic of ['No effect attempted', 'HTTP 403', 'execution_run.start', 'RPC_FORBIDDEN',
          `requestId: ${startRequestId}`]) expect.soft(text).toContain(diagnostic);
      } finally {
        exit.mockRestore();
        stderr.mockRestore();
        output.restore();
      }
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    process.exitCode = previousExitCode;
  }
});
