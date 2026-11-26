import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';
import {
  AGENT_SIGN_IN_PREPARE_RPC_METHOD,
  AGENT_SIGN_IN_STATUS_RPC_METHOD,
  AgentSignInStatusResponseSchema,
} from '@happier-dev/protocol/daemon/agentSignIn';
import { startMachineAgentSignIn } from '@happier-dev/protocol/daemon/startAgentSignIn';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';

import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { readStoredCredentialsForServerId, writeStoredCredentialsForServerId } from '@/persistence';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { name: 'owner alone', enabled: true, level: null, scope: 'member', confirmationRequired: false },
  { name: 'another Manage person with isolation enabled', enabled: true, level: 'admin', scope: 'machineOwner', confirmationRequired: true },
  { name: 'a Use guest with isolation disabled', enabled: false, level: 'view', scope: 'machineOwner', confirmationRequired: true },
  { name: 'a Use guest with isolation enabled', enabled: true, level: 'view', scope: 'member', confirmationRequired: false },
  { name: 'a Manage person inherited from a controller', enabled: true, level: null, inherited: true, scope: 'machineOwner', confirmationRequired: true },
  { name: 'audience unavailable', enabled: true, level: null, unavailable: true, scope: 'machineOwner', confirmationRequired: true },
] as const)('reviews the owner native sign-in with $name', async scenario => {
  const custodian = { accountId: 'owner', displayName: 'Owner' };
  const guest = { accountId: 'guest', displayName: 'Guest' };
  const provenance = AuthTokenProvenanceSchema.parse({ v: 1, kind: 'terminal', authority: 'account_automation' });
  const claims = Buffer.from(JSON.stringify({ sub: custodian.accountId, provenance })).toString('base64url');
  const credentials = { token: `e30.${claims}.signature`, encryption: null };
  let audienceReads = 0;
  let audienceAuthorization: unknown;
  const f = await createInstalledFilesystemMachineFixture({
    accountId: custodian.accountId,
    credentials,
    agentIsolation: { read: () => ({
      enabled: scenario.enabled,
      status: scenario.enabled ? { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } : { kind: 'disabled' },
      workspaceRoots: [],
    }) },
    async readAdditionalHttpResponse(url, request) {
      if (!url.endsWith('/v1/machines/machine/access')) return undefined;
      audienceReads++;
      audienceAuthorization = request?.headers?.Authorization;
      if ('unavailable' in scenario) throw new Error('Home audience unavailable');
      return { status: 200, data: MachineAccessGrantsListResponseV1Schema.parse({
        machineId: 'machine', custodian,
        access: { custodian, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
        canManage: true, ownDirectGrant: false, ownAccessSources: [],
        currentRequesterDisplayIdentities: scenario.level || 'inherited' in scenario ? [custodian, guest] : [custodian],
        grants: scenario.level ? [{
          machineId: 'machine', principal: { kind: 'account', accountId: guest.accountId }, level: scenario.level,
          display: { name: guest.displayName }, readiness: 'ready',
          audience: [{ ...guest, readiness: 'ready', reason: null, canPrepareKeys: false }],
          removal: { losesAccessAccountIds: [guest.accountId] },
        }] : [],
      }) };
    },
  });
  const runtime = await createAdmittedPluginRuntimeFixture({
    controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.agent.codex'] },
  });
  onTestFinished(() => runtime.dispose());
  await writeStoredCredentialsForServerId(f.serverId, credentials);
  expect((await readStoredCredentialsForServerId(f.serverId))?.token === credentials.token).toBe(true);
  const agentId = 'codex';
  const readStatus = async () => AgentSignInStatusResponseSchema.parse(
    await f.invoke(AGENT_SIGN_IN_STATUS_RPC_METHOD, { agentId }),
  );
  expect(await readStatus()).toMatchObject({ signInScope: 'machineOwner' });
  expect(audienceReads).toBe(0);

  const reviewNativeSignInLaunch = vi.fn(async () => true);
  const result = await startMachineAgentSignIn({ machineId: f.machineId, agentId, method: 'native' }, {
    prepare: request => f.invoke(AGENT_SIGN_IN_PREPARE_RPC_METHOD, request),
    reviewNativeSignInLaunch,
    // Stop at the terminal process boundary. The RPC and launch review are real.
    ensureTerminal: async () => ({ ok: true, terminalId: 'terminal', reused: false }),
    beginConnect: async () => { throw new Error('Expected native sign-in'); },
    closeTerminal: async () => { throw new Error('Expected no terminal cleanup'); },
  });
  expect(result).toMatchObject({ terminalId: 'terminal' });
  expect(reviewNativeSignInLaunch).toHaveBeenCalledExactlyOnceWith({
    signInScope: scenario.scope, confirmationRequired: scenario.confirmationRequired,
  });
  expect(audienceReads).toBe(1);
  expect(audienceAuthorization === `Bearer ${credentials.token}`).toBe(true);
  expect(await readStatus()).toMatchObject({ signInScope: 'machineOwner' });
  expect(audienceReads).toBe(1);
});
