import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountSettingsSchema } from '@happier-dev/protocol';
import { registerAccountHomeHttp, registerPlainArtifactRoutes } from '@/session/actions/widgetApproval.testkit';
import { installAxiosFastifyAdapter, installAxiosRequestMethodAdapter } from '@/testkit/http/axiosAdapter';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createSignedRootActionApprovalAcknowledgement } from '@/daemon/externalActions/signedRootActionApproval';
import { executeLiveCliApprovalRequest } from '@/session/actions/approvals/deferredResult';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { handleActionsCommand } from './actions';

// Home HTTP is the system boundary. Parsing, admission, Artifact storage,
// approval progress, decision and final CLI projection remain real.
afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });
it('shows ordinary-result approval before remote denial and prints its typed result', async () => {
  await withConfiguredDaemonTestHome({ prefix: 'cli-approval-wait-' }, async () => {
    const priorExitCode = process.exitCode;
    const home = Fastify();
    registerPlainArtifactRoutes(home, 'owner');
    const sockets = await createRequesterCurrentnessSocketHarness();
    sockets.server.on('connection', socket => {
      socket.on(SOCKET_RPC_EVENTS.REGISTER, packet => socket.emit(SOCKET_RPC_EVENTS.REGISTERED, packet));
      socket.on(SOCKET_RPC_EVENTS.CALL, (packet, ack) => {
        socket.emit(SOCKET_RPC_EVENTS.REQUEST, { ...packet, callerAuthority: 'present_user' },
          (result: unknown) => ack({ ok: true, result }));
      });
    });
    const features = registerAccountHomeHttp(home, { accountId: 'owner', serverId: 'srv_home' });
    vi.stubGlobal('fetch', async () => Response.json(features));
    installAxiosRequestMethodAdapter();
    const restoreHttp = installAxiosFastifyAdapter({ app: home, origin: 'https://home.test' });
    const owner = createSignedRootActionApprovalAcknowledgement();
    const cancellation = new AbortController();
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`,
      encryption: null, credentialProvenance: 'stored_session' as const };
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
      output += String(chunk);
      const callback = args.find(argument => typeof argument === 'function');
      if (typeof callback === 'function') callback();
      return true;
    });
    const notices = vi.spyOn(console, 'error').mockImplementation(() => {});
    let executor: ReturnType<typeof createCliActionExecutor> | undefined;
    const pending = handleActionsCommand(['invoke', 'account.apiTokens.revoke', '--input-json',
      JSON.stringify({ tokenId: 'dd03e74b-4aae-4a0a-81ee-1c23ddc4525d' }), '--json'], {
      readCredentialsFn: async () => credentials,
      createExecutorFn: params => {
        const createRetainedExecutor = (signal: AbortSignal) => createCliActionExecutor({ ...params, onApprovalRequested: undefined,
          token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
          hostActionApprovalLifetime: { actionId: 'account.apiTokens.revoke', surface: 'cli', signal },
          serverId: 'home', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.test',
          actionsSettingsProvider: createActionSettingsProvider({ allowEnvironmentOverride: false,
            accountSettings: AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1, actions: {
              'account.apiTokens.revoke': { approvalRequiredSurfaces: ['cli'] },
            } } }) }),
        });
        const local = createRetainedExecutor(cancellation.signal);
        return { ...local, execute: (actionId, input, context) => executeLiveCliApprovalRequest({
          execute: (id, input, context) => executor!.execute(id, input, context), context: { ...context, signal: cancellation.signal },
          onApprovalRequested: params.onApprovalRequested!,
          run: (signal, onApprovalRequested) => {
            executor = createRetainedExecutor(signal);
            return owner.execute({ actionId: 'account.apiTokens.revoke', surface: 'cli', signal,
              onApprovalRequested, run: (signal, operationOwnerUpdate) => executor!.execute(actionId, input, { ...context, signal, operationOwnerUpdate }) });
          },
        }) };
      },
    }, cancellation.signal);
    try {
      await expect.poll(() => notices.mock.calls.length > 0 || output.length > 0).toBe(true);
      expect(notices.mock.calls.length, output).toBeGreaterThan(0);
      const notice = JSON.parse(String(notices.mock.calls[0]?.[0]));
      expect(notice).toMatchObject({ data: { kind: 'approval_request_created', actionId: 'account.apiTokens.revoke' } });
      expect(output).toBe('');
      expect(executor).toBeDefined();
      expect(await executor!.execute('approval.request.decide', { artifactId: notice.data.artifactId, decision: 'reject' },
        { surface: 'ui', authority: 'present_user', serverId: 'home' })).toMatchObject({ ok: true });
      await pending;
      expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: 'approval_rejected' } });
    } finally {
      cancellation.abort(); await pending; await owner.close(); restoreHttp(); await home.close(); await sockets.close(); vi.unstubAllGlobals(); process.exitCode = priorExitCode;
    }
  });
});
