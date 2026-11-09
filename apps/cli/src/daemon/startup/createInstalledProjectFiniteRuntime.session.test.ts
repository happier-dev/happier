import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { configuration } from '@/configuration';
import { createProjectSessionRuntimeFixture } from '@/daemon/testkit/projectSessionRuntimeFixture';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { resolveActionOperationScope } from '@/daemon/actionOperations/actionOperationRpcHandlers';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';
import { projectRuntimeAccountRowsInput } from '@/workspaces/projectAccountRows';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { createInstalledProjectFiniteRuntime } from './createInstalledProjectFiniteRuntime';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('uses admitted foreign Session custody for installed Project setup without exposing custodian worker ports', async () => {
  const f = await createProjectSessionRuntimeFixture();
  let installedCurrent = true;
  const nativeIo = createProjectNativeIo();
  const operationRuntime = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'custodian' });
  const terminalSessions = createTerminalPtySessionManager({
    ptyProvider: { spawn: () => { throw new Error('No process expected'); } },
    config: readDaemonTerminalPtyConfig({}).sessionManager, env: {}, platform: 'linux',
  });
  onTestFinished(() => terminalSessions.dispose());
  const admission = createProjectWorkerAdmission({ machineId: 'machine', admissionDrain: createDaemonAdmissionDrain(),
    readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: null }, source: 'default', metadataVersion: 1 }) });
  const factory = createInstalledProjectFiniteRuntime({ api: { getMachine: async () => null },
    credentials: { token: 'custodian-token', encryption: null }, externalActionAccountId: 'custodian',
    finiteServerId: 'session-home', finiteServerHttpBaseUrl: 'https://session-home.test', registeredMachineId: 'machine',
    admission, nativeIo, successHomeDir: configuration.happyHomeDir, isCurrent: async () => installedCurrent,
    prepareBetween: async () => { throw new Error('No worker preparation expected'); },
    resolveCurrentMachineExecutionOriginContext: async () => null });
  const ingress = { signal: new AbortController().signal, requesterSessionBootstrap: f.bootstrap };
  const runtime = await factory({ operationRuntime, terminalSessions }, ingress);
  expect(runtime).not.toBeNull();
  expect(runtime?.credentials).toBe(f.bootstrap.credentials);
  expect(runtime?.accountId).toBe('requester');
  expect(runtime?.nativeIo).toBe(nativeIo.commandIo);
  expect(runtime?.environmentIo).toBe(nativeIo.environmentIo);
  expect(runtime?.terminalSessions).toBe(terminalSessions);
  expect(runtime?.operationRuntime).toBe(operationRuntime);
  expect(runtime).not.toHaveProperty('inspectSourceProjectManifest');
  expect(runtime).not.toHaveProperty('resolveWorkerTarget');
  expect(runtime).not.toHaveProperty('prepareDequeue');
  if (!runtime) throw new Error('Missing Session runtime');
  const rows = projectRuntimeAccountRowsInput(runtime);
  expect(rows.sessionCustody).toMatchObject({ serverId: 'session-home', accountId: 'requester', serverHttpBaseUrl: 'https://session-home.test' });
  expect(await rows.sessionCustody?.isCurrent()).toBe(true);
  for (const attribution of [
    { ...f.bootstrap.attribution, serverId: 'other-home' },
    { ...f.bootstrap.attribution, machineId: 'other-machine' },
    { ...f.bootstrap.attribution, installationId: 'other-installation' },
  ]) {
    expect(await factory({ operationRuntime, terminalSessions }, { ...ingress,
      requesterSessionBootstrap: { ...f.bootstrap, attribution } })).toBeNull();
  }
  installedCurrent = false;
  expect(await runtime.isCurrent?.()).toBe(false);
  installedCurrent = true;
  f.retire();
  // Owner ruling 2026-10-29: withdrawal blocks the next admission; admitted
  // finite work retains its requester custody until its local lifetime ends.
  expect(await runtime.isCurrent?.()).toBe(true);
  expect(await factory({ operationRuntime, terminalSessions }, ingress)).not.toBeNull();
  await expect(f.createBootstrap()).rejects.toThrow();
  await f.bootstrap.dispose();
  expect(await runtime.isCurrent?.()).toBe(false);
  expect(await factory({ operationRuntime, terminalSessions }, ingress)).toBeNull();
});

it('scopes private Session operations to the admitted requester and preserves installed attribution', async () => {
  const f = await createProjectSessionRuntimeFixture();
  const context = { signal: new AbortController().signal, requesterSessionBootstrap: f.bootstrap };
  const deps = { machineId: 'machine', resolveAccountId: async () => 'custodian' };
  expect(await resolveActionOperationScope(deps, context, 'session')).toEqual({ accountId: 'requester', machineId: 'machine', sessionId: 'session' });
  const runtime = createHostActionOperationRuntime({ ...deps,
    custodyBinding: { serverId: 'session-home', installationId: f.installation.installationId }, generateOperationId: () => 'operation' });
  await runtime.observeExecution({ actionId: 'projects.prepare', input: {}, sessionId: 'session', rpcContext: context,
    execute: async ({ requesterWorkAttributionV1 }) => {
      expect(requesterWorkAttributionV1).toEqual(f.bootstrap.attribution);
      return { ok: true, result: null };
    } });
  expect(await runtime.handlers.getV2({ operationId: 'operation' }, context)).toMatchObject({ kind: 'found', operation: {
    scope: { accountId: 'requester', machineId: 'machine', sessionId: 'session' } } });
  expect(await runtime.handlers.getV2({ operationId: 'operation' })).toEqual({ kind: 'not_found' });
  const wrongInstallation = createHostActionOperationRuntime({ ...deps, custodyBinding: { serverId: 'session-home', installationId: 'other' } });
  await expect(wrongInstallation.observeExecution({ actionId: 'projects.prepare', input: {}, rpcContext: context,
    execute: async () => { throw new Error('Must refuse before execution'); } })).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
  f.retire();
  expect(await resolveActionOperationScope(deps, context)).toEqual({ accountId: 'requester', machineId: 'machine' });
  expect(await runtime.handlers.getV2({ operationId: 'operation' }, context)).toMatchObject({ kind: 'found', operation: {
    scope: { accountId: 'requester', machineId: 'machine', sessionId: 'session' } } });
  await expect(f.createBootstrap()).rejects.toThrow();
  await f.bootstrap.dispose();
  await expect(resolveActionOperationScope(deps, context)).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
});
