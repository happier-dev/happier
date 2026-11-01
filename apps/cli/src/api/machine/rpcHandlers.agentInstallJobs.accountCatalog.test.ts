import axios from 'axios';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { DaemonAgentInstallReadResponseSchema, DaemonAgentInstallStartResponseSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createAgentInstallJobOwner } from '@/capabilities/installJobs/agentInstallJobOwner';
import { resolveAcpLaunch } from '@/agent/acp/catalog/configured/resolveAcpLaunch';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import * as persistence from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { RpcHandler, RpcHandlerContext } from '../rpc/types';
import { registerMachineAgentInstallJobRpcHandlers } from './rpcHandlers.agentInstallJobs';

it.each(['custodian', 'guest'] as const)('installs the admitted %s Account pin independently of the daemon catalog', async caller => {
  const home = await createTempDir('happier-install-account-catalog-');
  const channel = await createRequesterCurrentnessSocketHarness();
  const accountId = caller === 'custodian' ? 'alice' : 'bob';
  const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.fixture`, encryption: null };
  const base = 'https://install-home.invalid';
  const definition = AcpBackendDefinitionV1Schema.parse({ id: 'registry-agent', name: 'registry-agent', title: 'Registry Agent',
    launch: { kind: 'npm', package: '@fixture/acp', version: '2.2.2' }, createdAt: 1, updatedAt: 1 });
  const pnpm = join(home, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
  await writeFile(pnpm, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  await chmod(pnpm, 0o755);
  const env = { ...process.env, HAPPIER_HOME_DIR: home, HAPPIER_PNPM_BIN: pnpm, HAPPIER_JS_RUNTIME_PATH: process.execPath };
  let current = true;
  let catalogAvailable = true;
  // HTTP and package-manager execution are system boundaries. Account custody,
  // row decoding, registered handlers, job ownership and managed promotion stay real.
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/profile') return { status: 200, data: { id: accountId } };
    if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/acp') return catalogAvailable
      ? { status: 200, data: { status: 'present', revision: 2, content: { t: 'plain', v: { v: 1, definitions: [definition] } } } }
      : { status: 403, data: { error: 'forbidden' } };
    throw new Error(`Unexpected Account read: ${path}`);
  });
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-authorization', binding: {
    accountId, principalId: accountId, credentialId: 'pat', custodianAccountId: 'alice', accountEncryptionMode: 'plain',
    serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation',
    actionId: 'machines.agents.install', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
    target: { kind: 'machine', machineId: 'machine' },
    grant: ApiTokenGrantV1Schema.parse({ v: 1, actions: { families: [], ids: ['machines.agents.install'] },
      targets: { sessions: [], machines: ['machine'] }, approve: false, origins: [], models: null, permissionModes: null, create: null }),
  } });
  const owner = createAgentInstallJobOwner({ accountId: 'alice', env, readTrackedSessions: () => [],
    readRegistry: () => ({ agents: [{ id: 'custom-acp', identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1,
      pluginId: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId }] }),
    // The admitted Action just wrote its row; the independent daemon observation
    // still predates that write, even when it belongs to the same Account.
    readAcpCatalog: () => ({ status: 'ready', revision: 1, record: { v: 1, definitions: [] } }),
    installerDeps: { execFileWithDeadline: async (_command, args) => {
      const workspace = args[1]!;
      const packageRoot = join(workspace, 'node_modules', '@fixture', 'acp');
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@fixture/acp', version: '2.2.2', bin: { acp: 'cli.js' } }));
      const bin = join(workspace, 'node_modules', '.bin', process.platform === 'win32' ? 'acp.cmd' : 'acp');
      await mkdir(dirname(bin), { recursive: true });
      await writeFile(bin, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
      await chmod(bin, 0o755);
      return { stdout: '', stderr: '' };
    } },
  });
  let custody: Awaited<ReturnType<typeof admitRequesterAccountActionContext>> = null;
  try {
    custody = await admitRequesterAccountActionContext({ authorization, credentials, serverId: 'home-profile',
      serverIdentityId: 'stable-home', serverHttpBaseUrl: base, isCurrent: async () => current });
    if (!custody) throw new Error('Missing admitted Account custody');
    setActiveAccountSettingsSnapshot({ ...custody.accountSettingsContext,
      acpCatalog: { status: 'ready', revision: 1, record: { v: 1, definitions: [] } } });
    const storedCredentials = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    const handlers = new Map<string, RpcHandler>();
    registerMachineAgentInstallJobRpcHandlers({ owner, rpcHandlerManager: { registerHandler: (method, handler) => { handlers.set(method, handler); } } });
    const context: RpcHandlerContext = { signal: new AbortController().signal,
      ...(caller === 'guest' ? { callerInputAuthorization: custody.authorization } : {}),
      verifyMachineAdmissionCurrent: async () => current, machineAdmission: { actorAccountId: accountId, custodianAccountId: 'alice',
        machineId: 'machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' } };
    const start: RpcHandler = (input, ingress) => runWithServerHttpBaseUrl(base,
      () => handlers.get(RPC_METHODS.DAEMON_AGENTS_INSTALL_START)!(input, ingress));
    const input = { agentId: 'custom-acp', definitionId: definition.id, expectedDefinitionVersion: '2.2.2',
      intent: 'install', consent: { vendorRecipe: false } } as const;
    if (caller === 'custodian') {
      storedCredentials.mockResolvedValue({ token: `e30.${Buffer.from(JSON.stringify({ sub: 'other-account' })).toString('base64url')}.fixture`, encryption: null });
      await expect(start(input, context)).resolves.toMatchObject({ ok: false, errorCode: 'install_unavailable' });
      expect(owner.list()).toEqual({ ok: true, jobs: [] });
      storedCredentials.mockResolvedValue(credentials);
    }
    const accepted = DaemonAgentInstallStartResponseSchema.parse(await start(input, context));
    expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true });
    if (!accepted.ok) return;
    const read = () => owner.read({ jobId: accepted.jobId, cursor: 0 }, accountId);
    await vi.waitFor(() => expect(read()).toMatchObject({ done: true, outcome: { kind: 'succeeded', version: '2.2.2' } }));
    expect(DaemonAgentInstallReadResponseSchema.parse(read())).toMatchObject({ outcome: { kind: 'succeeded' } });
    const ready = await resolveAcpLaunch({ accountId, definition, env, platform: process.platform, arch: process.arch });
    expect(ready.kind).toBe('ready');
    if (ready.kind !== 'ready') return;
    expect(JSON.parse(await readFile(join(dirname(dirname(ready.command)), 'workspace', 'package.json'), 'utf8')))
      .toMatchObject({ happierManagedAcp: { definitionId: definition.id, version: '2.2.2' } });
    const jobsBeforeStaleRequest = owner.list(accountId);
    await expect(start({ ...input, expectedDefinitionVersion: '1.0.0' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'definition_version_changed' });
    expect(owner.list(accountId)).toEqual(jobsBeforeStaleRequest);
    catalogAvailable = false;
    await expect(start(input, context)).resolves.toMatchObject({ ok: false, errorCode: 'install_unavailable' });
    catalogAvailable = true;
    const removed = DaemonAgentInstallStartResponseSchema.parse(await start({ agentId: 'custom-acp', definitionId: definition.id,
      intent: 'uninstall', consent: { vendorRecipe: false } }, context));
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    await vi.waitFor(() => expect(owner.read({ jobId: removed.jobId, cursor: 0 }, accountId)).toMatchObject({ done: true, outcome: { kind: 'succeeded' } }));
    await expect(resolveAcpLaunch({ accountId, definition, env, platform: process.platform, arch: process.arch })).resolves.toMatchObject({ kind: 'needs_install' });
    current = false;
    await expect(start(input, context)).resolves.toMatchObject({ ok: false, errorCode: 'install_unavailable' });
  } finally {
    await owner.shutdown();
    await custody?.dispose();
    await channel.close();
    vi.restoreAllMocks();
    resetActiveAccountSettingsSnapshotForTests();
    await removeTempDir(home);
  }
});
