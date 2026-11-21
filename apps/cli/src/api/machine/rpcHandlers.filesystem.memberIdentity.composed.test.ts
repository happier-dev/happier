import { createNativeFilesystemMemberFixture as fixture, nativeFilesystemMemberBoundary, assertNativeInvocation, resetNativeFilesystemMemberBoundary } from './filesystemMemberReceiver.testkit';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod/mini';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { createInstalledFilesystemMachineFixture } from '@/daemon/testkit/installedFilesystemMachineFixture';
import { readAgentIsolationMemberBindingForAccount } from '@/daemon/agentIsolation/memberBindings';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { configuration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { logger } from '@/ui/logger';

const nativeOs = nativeFilesystemMemberBoundary();

afterEach(resetNativeFilesystemMemberBoundary);

async function admittedOwnerAgentFileContext(f: Awaited<ReturnType<typeof createInstalledFilesystemMachineFixture>>): Promise<RpcHandlerContext> {
  const sessionId = 'owner-agent-files';
  expect(f.bootstrap.getBoundSessionId()).toBe(sessionId);
  const context: RpcHandlerContext = { signal: new AbortController().signal, callerAuthority: 'account_automation',
    requesterSessionBootstrap: f.bootstrap,
    machineAdmission: { actorAccountId: f.bootstrap.attribution.accountId, custodianAccountId: 'requester',
      machineId: f.machineId, installationId: f.installation.installationId, role: 'manage', encryptionMode: 'plain' },
    verifyMachineAdmissionCurrent: () => f.bootstrap.isCurrent(),
    localActionContext: { authority: 'account_automation', surface: 'mcp', actionRequestId: 'owner-agent-file-read',
      actionCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 } } };
  const selected = selectHostRequesterExecutionIdentity({ rpcContext: context,
    hostHomeServerIdentityId: f.homeServerIdentityId, hostCustodianAccountId: 'requester',
    hostExecutionTarget: { machineId: f.machineId, installationId: f.installation.installationId },
    sessionRequester: f.bootstrap.attribution, sessionRequesterHomeServerIdentityId: f.bootstrap.homeServerIdentityId,
    sessionCustodianAccountId: 'requester' });
  expect(selected).toEqual({ kind: 'isolated', requester: f.bootstrap.attribution, separationRequired: false });
  return context;
}

async function installCliProbe(f: Awaited<ReturnType<typeof fixture>>, agent: 'claude' | 'codex' = 'claude') {
  const bin = join(f.directory, 'cli-bin');
  const ownerMarker = join(f.directory, 'owner-cli-probe');
  const memberMarker = join(f.directory, 'member-cli-probe');
  await mkdir(bin);
  await writeFile(join(bin, agent), `#!${process.execPath}\n`
    + `const { appendFileSync } = require('node:fs');\n`
    + `const member = [${JSON.stringify(f.member)}, ${JSON.stringify(f.identity.home)}].includes(process.env.HOME);\n`
    + `appendFileSync(member ? ${JSON.stringify(memberMarker)} : ${JSON.stringify(ownerMarker)}, 'probe\\n');\n`
    + `console.log(member ? '2.3.4' : '1.2.3');\n`, { mode: 0o700 });
  const environment = createEnvKeyScope(['PATH', 'HAPPIER_CLAUDE_PATH', 'HAPPIER_CODEX_PATH']);
  environment.patch({ PATH: `${bin}:${process.env.PATH ?? ''}`, HAPPIER_CLAUDE_PATH: undefined, HAPPIER_CODEX_PATH: undefined });
  onTestFinished(() => environment.restore());
  return { ownerMarker, memberMarker, request: {
    requests: [{ id: `cli.${agent}`, params: { bypassCache: true, verifyVersion: true } }],
  } };
}

describe.skipIf(process.platform !== 'linux')('installed Machine filesystem native member receiver (simulated UIDs and RunAs)', () => {
  it('retains a shared Use requesters refused folder and worker UID in the daemon log', async () => {
    const f = await fixture({ legacy: true });
    const warnings = vi.spyOn(logger, 'warnLocalFile');
    expect(await f.invokeFromHome(RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
      { directory: { kind: 'path', path: f.foreign } })).toEqual({ ok: false, code: 'invalid_directory' });
    expect(warnings).toHaveBeenCalledWith('[sessionCreation] Directory preflight refused', expect.objectContaining({
      branch: 'directory_readiness', directoryKind: 'path', requestedDirectory: f.foreign,
      directory: f.foreign, effectiveUid: 2402, transportRequestId: 'filesystem-native-1',
    }));
    assertNativeInvocation(f, true);
  }, 120_000);
  it('keeps a fresh owners reviewed-member background folder status read-only', async () => {
    const f = await fixture({ accountId: 'requester', coldPolicy: 'reviewedMember', startupFailure: true });
    const result = await f.invokeFromHome(RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
      { directory: { kind: 'path', path: '~' } }, 'requester', 'manage');
    expect(f.preparation?.mutations).toEqual([]);
    expect(result).toMatchObject({ code: 'member_not_prepared' });
    expect(f.children).toEqual([]);
    expect(await readAgentIsolationMemberBindingForAccount({ activeServerDir: configuration.activeServerDir,
      homeServerIdentityId: f.homeServerIdentityId, machineId: f.machineId, installationId: f.installation.installationId }, 'requester')).toBeNull();
  }, 120_000);
  it('rejects preparation intent for a fresh owners managed request before native setup', async () => {
    const f = await fixture({ accountId: 'requester', coldPolicy: 'reviewedMember', startupFailure: true });
    const result = await f.invokeFromHome(RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
      { directory: { kind: 'managed' }, prepareAgentIsolationMember: true }, 'requester', 'manage');
    expect(f.preparation?.mutations).toEqual([]);
    expect(f.children).toEqual([]);
    expect(result).not.toMatchObject({ ok: true });
  }, 120_000);
  it('prepares a fresh owners member before a deliberate Session folder preflight', async () => {
    const f = await fixture({ accountId: 'requester', coldPolicy: 'reviewedMember', startupFailure: true });
    const scope = { activeServerDir: configuration.activeServerDir, homeServerIdentityId: f.homeServerIdentityId,
      machineId: f.machineId, installationId: f.installation.installationId };
    expect(await readAgentIsolationMemberBindingForAccount(scope, 'requester')).toBeNull();
    const prepared = await f.invokeFromHome(RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
      { directory: { kind: 'path', path: '~' }, prepareAgentIsolationMember: true }, 'requester', 'manage');
    // The genuine OS child exits at the boundary; internal preparation must
    // already have committed the selected binding before that child starts.
    expect(prepared).toMatchObject({ errorCode: 'filesystem_identity_custody_unavailable' });
    expect(await readAgentIsolationMemberBindingForAccount(scope, 'requester'))
      .toMatchObject({ username: f.identity.username, uid: 2401 });
    expect(f.preparation?.mutations).toContain('agent-account');
    expect(f.runAsUsers).toEqual([f.identity.username]);
  }, 120_000);
  it.each([false, true])('preflights the owners Agent directory as its member (denied=%s)', async denied => {
    const f = await fixture({ accountId: 'requester' });
    const result = await f.invokeFromHome(RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
      { directory: { kind: 'path', path: denied ? f.foreign : '~' } }, 'requester');
    expect(result).toEqual(denied ? { ok: false, code: 'invalid_directory' } : {
      ok: true, directory: f.identity.home, directoryKind: 'path', directoryCreationRequired: false, checkout: null,
    });
    assertNativeInvocation(f);
  }, 120_000);
  it.each(['request', 'trace'] as const)('preflights a Use grantee session directory in its native member home (%s correlation)', async correlation => {
    const f = await fixture();
    expect(await f.invokeFromHome(RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT,
      { directory: { kind: 'path', path: '~' } }, 'member-a', 'use', correlation)).toEqual({
      ok: true, directory: f.identity.home, directoryKind: 'path', directoryCreationRequired: false, checkout: null,
    });
    expect(await f.invokeFromHome(RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE,
      { directory: { kind: 'path', path: '~' } }, 'member-a', 'use')).toMatchObject({ errorCode: 'agent_isolation_unavailable' });
    assertNativeInvocation(f);
  }, 120_000);
  it('detects managed Codex from the public install home as a Use member without borrowing daemon home', async () => {
    const f = await fixture();
    const probe = await installCliProbe(f, 'codex');
    const installHome = join(f.directory, 'public-install');
    const bin = join(installHome, 'tools', 'providers', 'codex', 'current', 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'codex'), await readFile(join(f.directory, 'cli-bin', 'codex')), { mode: 0o755 });
    const environment = createEnvKeyScope(['PATH', 'HAPPIER_FIRST_PARTY_INSTALL_HOME']);
    environment.patch({ PATH: '', HAPPIER_FIRST_PARTY_INSTALL_HOME: installHome });
    onTestFinished(() => environment.restore());
    await expect(f.invoke(RPC_METHODS.CAPABILITIES_DETECT, probe.request, 'member-a', 'use'))
      .resolves.toMatchObject({ results: { 'cli.codex': { ok: true, data: { available: true, version: '2.3.4' } } } });
    expect(await readFile(probe.ownerMarker, 'utf8').catch(() => '')).toBe('');
    expect(await readFile(probe.memberMarker, 'utf8')).not.toBe('');
    assertNativeInvocation(f);
  }, 120_000);
  it('keeps the member setup owners typed refusal in native preparation', async () => {
    const f = await fixture({ coldPolicy: 'managed' });
    if (!f.preparation) throw new Error('Missing member preparation boundary');
    f.machine.registerMachineAgentIsolationRoutes(f.preparation.effects);
    // The installed Machine has no published member policy. Its real setup
    // owner refuses before any native mutation; preserve that decided result.
    const requesterIdentity = { kind: 'isolated' as const, separationRequired: true,
      requester: f.identity.requester, homeServerIdentityId: f.homeServerIdentityId };
    await expect(f.machine.prepareAgentIsolationMember({ requesterIdentity, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'agent_isolation_unavailable', details: {
        reason: 'member_setup_required', phase: 'native_execution_preparation', outcome: 'not_applied', reasonCode: 'denied',
      } });
    expect(f.preparation.mutations).toEqual([]);
  }, 120_000);

  it('prepares first-use Codex model-picker invocation for a Use grantee', async () => {
    const f = await fixture({ coldPolicy: 'managed' });
    const scope = { activeServerDir: configuration.activeServerDir, homeServerIdentityId: f.homeServerIdentityId,
      machineId: f.machineId, installationId: f.installation.installationId };
    expect(await readAgentIsolationMemberBindingForAccount(scope, 'member-a')).toBeNull();
    const result = await f.invoke(RPC_METHODS.CAPABILITIES_INVOKE,
      { id: 'cli.codex', method: 'probeModels', params: {} }, 'member-a', 'use');
    expect(result).toMatchObject({ ok: true });
    expect(await readAgentIsolationMemberBindingForAccount(scope, 'member-a'))
      .toMatchObject({ username: f.identity.username, uid: 2401 });
    expect(nativeOs.readinessProbes).toBe(1);
    assertNativeInvocation(f);
  }, 120_000);

  it.each(['managed', 'legacy'] as const)('prepares first-use Codex for a Use grantee only with reviewed member consent (%s)', async policy => {
    const f = await fixture({ coldPolicy: policy });
    const probe = await installCliProbe(f, 'codex');
    const scope = { activeServerDir: configuration.activeServerDir, homeServerIdentityId: f.homeServerIdentityId,
      machineId: f.machineId, installationId: f.installation.installationId };
    expect(await readAgentIsolationMemberBindingForAccount(scope, 'member-a')).toBeNull();
    const result = await f.invoke(RPC_METHODS.CAPABILITIES_DETECT, probe.request, 'member-a', 'use');
    if (policy === 'legacy') {
      expect(result).toMatchObject({ code: 'agent_isolation_unavailable' });
      expect(f.preparation.mutations).toEqual([]);
      expect(nativeOs.readinessProbes).toBe(0);
      expect(f.runAsUsers).toEqual([]);
      expect(await readAgentIsolationMemberBindingForAccount(scope, 'member-a')).toBeNull();
      expect(await readFile(probe.memberMarker, 'utf8').catch(() => '')).toBe('');
    } else {
      expect(result).toMatchObject({ protocolVersion: 1, results: { 'cli.codex': {
        ok: true, data: { available: true, version: '2.3.4' },
      } } });
      expect(f.preparation.mutations).toContain('agent-account');
      // One member qualification for the whole capability operation, never
      // another Home admission or one native probe per discovery sub-step.
      expect(nativeOs.readinessProbes).toBe(1);
      expect(await readAgentIsolationMemberBindingForAccount(scope, 'member-a'))
        .toMatchObject({ username: f.identity.username, uid: 2401 });
      expect(await readFile(probe.memberMarker, 'utf8')).not.toBe('');
      assertNativeInvocation(f);
    }
    expect(await readFile(probe.ownerMarker, 'utf8').catch(() => '')).toBe('');
  }, 120_000);

  it.each(['launcher-exit', 'cleanup-refused'] as const)('settles native Codex discovery after %s', async failure => {
    const f = await fixture(failure === 'launcher-exit' ? { startupFailure: true } : { cleanupRefused: true });
    const probe = await installCliProbe(f, 'codex');
    const kill = process.kill.bind(process);
    let refused = false;
    // Sudo's root-owned launcher is a genuine OS signal boundary. Ingress,
    // member preparation, framing and channel handling remain real.
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (failure === 'cleanup-refused' && signal && signal !== 0 && f.children.some(child => child.pid === pid)) {
        refused = true;
        throw Object.assign(new Error('Constructed run-as signal refusal'), { code: 'EPERM' });
      }
      return kill(pid, signal);
    });
    try {
      await expect(f.invoke(RPC_METHODS.CAPABILITIES_DETECT, probe.request, 'member-a', 'use'))
        .resolves.toMatchObject(failure === 'launcher-exit' ? { errorCode: 'filesystem_identity_custody_unavailable' } : { code: 'indeterminate' });
      expect(refused).toBe(failure === 'cleanup-refused');
      expect(f.runAsUsers).toEqual([f.identity.username]);
      expect(await readFile(probe.ownerMarker, 'utf8').catch(() => '')).toBe('');
    } finally {
      for (const child of f.children) if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
        child.kill('SIGKILL'); await closed;
      }
    }
  });

  it('settles successful member Codex discovery through EOF without signalling the run-as launcher', async () => {
    // Procfs reports the native run-as principal, not the daemon's. Keep the
    // real census/refusal owner rather than replacing its decision or signals.
    const f = await fixture({ coldPolicy: 'managed', foreignLauncher: true });
    const probe = await installCliProbe(f, 'codex');
    await expect(f.invoke(RPC_METHODS.CAPABILITIES_DETECT, probe.request, 'member-a', 'use'))
      .resolves.toMatchObject({ protocolVersion: 1, results: { 'cli.codex': {
        ok: true, data: { available: true, version: '2.3.4' },
      } } });
    expect(await readFile(probe.memberMarker, 'utf8')).not.toBe('');
    expect(await readFile(probe.ownerMarker, 'utf8').catch(() => '')).toBe('');
    assertNativeInvocation(f);
    expect(f.children.map(child => ({ code: child.exitCode, signal: child.signalCode })))
      .toEqual([{ code: 0, signal: null }]);
  }, 120_000);

  it('refuses the Codex payload when the prepared member fails its native readiness probe', async () => {
    const f = await fixture({ coldPolicy: 'managed' });
    const probe = await installCliProbe(f, 'codex');
    nativeOs.readinessFailure = true;
    expect(await f.invoke(RPC_METHODS.CAPABILITIES_DETECT, probe.request, 'member-a', 'use'))
      .toMatchObject({ errorCode: 'agent_isolation_unavailable',
        failureCause: { errorCode: 'agent_isolation_unavailable', phase: 'rpc.handler' } });
    expect(f.preparation.mutations).toContain('agent-account');
    expect(f.runAsUsers).toEqual([]);
    expect(await readFile(probe.memberMarker, 'utf8').catch(() => '')).toBe('');
    expect(await readFile(probe.ownerMarker, 'utf8').catch(() => '')).toBe('');
  }, 120_000);

  it.each(['owner', 'member'] as const)('detects the normal CLI usefully as the admitted %s without a daemon deputy', async placement => {
    const f = await fixture();
    const probe = await installCliProbe(f);
    // The production cli.claude definition owns private_read + process. This
    // drives its real snapshot/version probe, not a test capability or service.
    const result = await f.invoke(RPC_METHODS.CAPABILITIES_DETECT, probe.request,
      placement === 'owner' ? 'requester' : 'member-a');
    const detection = z.object({ results: z.object({ 'cli.claude': z.object({
      error: z.optional(z.object({ code: z.optional(z.string()), message: z.string() })),
    }) }) }).parse(result).results['cli.claude'];
    expect(detection.error).toBeUndefined();
    expect(result).toMatchObject({ protocolVersion: 1, results: { 'cli.claude': {
      ok: true, data: { available: true, version: placement === 'owner' ? '1.2.3' : '2.3.4' },
    } } });
    const observed = async (path: string) => readFile(path, 'utf8').catch(() => '');
    expect(await observed(placement === 'owner' ? probe.ownerMarker : probe.memberMarker)).not.toBe('');
    expect(await observed(placement === 'owner' ? probe.memberMarker : probe.ownerMarker)).toBe('');
    if (placement === 'member') assertNativeInvocation(f);
    else expect(f.runAsUsers).toHaveLength(0);
  }, 120_000);

  it.each(['unknown', 'foreign'] as const)('refuses %s Machine custody before a capability probe payload', async custody => {
    const f = await fixture();
    const probe = await installCliProbe(f);
    await expect(f.receive({ method: `machine:${RPC_METHODS.CAPABILITIES_DETECT}`, params: probe.request,
      requestId: `capability-${custody}`, callerAuthority: 'present_user',
      ...(custody === 'foreign' ? { machineAdmission: { actorAccountId: 'member-a', custodianAccountId: 'neighbor',
        machineId: f.machineId, installationId: f.installation.installationId, role: 'manage' as const,
        encryptionMode: 'plain' as const } } : {}),
    })).resolves.toMatchObject({ errorCode: custody === 'foreign'
      ? 'RPC_FORBIDDEN' : 'filesystem_identity_custody_unavailable' });
    expect(f.runAsUsers).toHaveLength(0);
    expect(await readFile(probe.ownerMarker, 'utf8').catch(() => '')).toBe('');
    expect(await readFile(probe.memberMarker, 'utf8').catch(() => '')).toBe('');
  }, 120_000);

  it('keeps admitted owner and Use requests on the daemon file path when isolation is off', async () => {
    const f = await createInstalledFilesystemMachineFixture({ boundSessionId: 'owner-agent-files', agentIsolation: {
      read: () => ({ enabled: false, status: { kind: 'disabled' }, workspaceRoots: [] }),
    } });
    const context = await admittedOwnerAgentFileContext(f);
    const path = join(f.directory, 'owner-agent.dat');
    const bytes = Buffer.from([0, 255, 128, 7]);
    await writeFile(path, bytes);
    let nativeSpawns = 0;
    nativeOs.spawn = () => { nativeSpawns++; throw new Error('Disabled isolation cannot launch a native filesystem process'); };
    const before = f.admissionChecks();
    // This is the installed MCP/control-plane delegation route. Its real
    // Session bootstrap remains host-private through the receiving authorizer.
    await expect(f.rpcHandlerManager.invokeLocal(RPC_METHODS.READ_FILE, { path }, {
      signal: context.signal, rpcContext: context, localActionContext: context.localActionContext,
    })).resolves.toMatchObject({ success: true, content: bytes.toString('base64') });
    expect(f.admissionChecks() - before).toBe(1);
    expect(nativeSpawns).toBe(0);
    await expect(f.invoke(RPC_METHODS.READ_FILE, { path }, { actorAccountId: 'member-a', callerAuthority: 'present_user', role: 'use' }))
      .resolves.toMatchObject({ success: true, content: bytes.toString('base64') });
    expect(nativeSpawns).toBe(0);
    expect(await readFile(path)).toEqual(bytes);
  });

  describe.each(['legacy', 'linuxUsersV1'] as const)('admitted owner Agent %s file placement', mode => {
    it.each(['own binary bytes', 'foreign refusal'] as const)('preserves %s without borrowing daemon-private rights', async contract => {
      const f = await fixture({ accountId: 'requester', legacy: mode === 'legacy' });
      const context = await admittedOwnerAgentFileContext(f);
      const before = f.admissionChecks();
      const path = contract === 'own binary bytes' ? join(f.member, 'owned.dat') : join(f.foreign, 'private.dat');
      const result = await f.rpcHandlerManager.invokeLocal(RPC_METHODS.READ_FILE, { path }, {
        signal: context.signal, rpcContext: context, localActionContext: { ...context.localActionContext,
          actionRequestId: `owner-agent-${mode}-${contract}` },
      });
      expect(f.admissionChecks() - before).toBe(1);
      expect(result).toMatchObject(contract === 'own binary bytes' ? { success: true,
        content: Buffer.from([0, 255, 1, 254]).toString('base64') } : { success: false, error: 'constructed native EACCES' });
      assertNativeInvocation(f, mode === 'legacy');
    }, 120_000);
  });

  it('keeps owner reads useful and sends registered member binary reads through the exact native frame', async () => {
    const f = await fixture();
    await expect(f.invoke(RPC_METHODS.READ_FILE, { path: join(f.member, 'owned.dat') }, 'requester'))
      .resolves.toMatchObject({ success: true, content: Buffer.from([0, 255, 1, 254]).toString('base64') });
    expect(f.frames).toHaveLength(0);
    await expect(f.invoke(RPC_METHODS.READ_FILE, { path: join(f.member, 'owned.dat') }))
      .resolves.toMatchObject({ success: true, content: Buffer.from([0, 255, 1, 254]).toString('base64') });
    assertNativeInvocation(f);
  }, 120_000);

  it('lists member-owned files through the registered native receiver', async () => {
    const f = await fixture();
    await expect(f.invoke(RPC_METHODS.LIST_DIRECTORY, { path: f.member }))
      .resolves.toMatchObject({ success: true,
        entries: expect.arrayContaining([expect.objectContaining({ name: 'owned.dat', type: 'file' })]) });
    assertNativeInvocation(f);
  }, 120_000);

  it.each([false, true])('denies foreign private bytes through the registered native receiver (legacy=%s)', async legacy => {
    const f = await fixture({ legacy });
    await expect(f.invoke(RPC_METHODS.READ_FILE, { path: join(f.foreign, 'private.dat') }))
      .resolves.toMatchObject({ success: false, error: 'constructed native EACCES' });
    assertNativeInvocation(f, legacy);
  }, 120_000);

  it('retains one native process across registered encrypted upload phases with one admission per RPC and local copied-ID refusal', async () => {
    const f = await fixture();
    const bytes = Buffer.from([0, 255, 128, 1]);
    const result = await f.invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
      { path: join(f.member, 'uploaded.dat'), sizeBytes: bytes.length, overwrite: false });
    expect(result).toMatchObject({ success: true });
    const opened = z.object({ success: z.literal(true), uploadId: z.string(), recipientPublicKeyBase64: z.string() }).parse(result);
    expect(f.frames).toHaveLength(1);
    const encrypted = createEncryptedTransferChunkEnvelope({ transferId: opened.uploadId, sequence: 0,
      payload: bytes, recipientPublicKeyBase64: opened.recipientPublicKeyBase64 });
    const chunk = { uploadId: opened.uploadId, index: 0, payloadBase64: encrypted.payloadBase64,
      encryptedDataKeyEnvelopeBase64: encrypted.encryptedDataKeyEnvelopeBase64 };
    await expect(f.invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, chunk, 'member-b'))
      .resolves.toMatchObject({ success: false, errorCode: 'FILESYSTEM_TRANSFER_SCOPE_MISMATCH' });
    await expect(f.invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, chunk)).resolves.toMatchObject({ success: true });
    expect(f.frames).toHaveLength(1);
    expect(f.children[0]?.exitCode).toBeNull();
    await expect(f.invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: opened.uploadId })).resolves.toMatchObject({ success: true });
    expect(await readFile(join(f.member, 'uploaded.dat'))).toEqual(bytes);
    expect(f.frames).toHaveLength(1);
    expect(f.children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  }, 120_000);
});
