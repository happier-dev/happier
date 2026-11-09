import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { DaemonAgentInstallCancelRequestSchema, DaemonAgentInstallReadRequestSchema, DaemonAgentInstallStartRequestSchema, DaemonAgentInstallReadResponseSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { getAgentCliRuntimeSpec, getAgentCliSetupRecommendedIds } from '@happier-dev/agents';
import { resolveAgentCliManagedCommandPathForRuntime } from '@happier-dev/cli-common/agents';
import { createAgentInstallJobOwner, type AgentInstallJobOwner } from '@/capabilities/installJobs/agentInstallJobOwner';
import { configuration, reloadConfiguration } from '@/configuration';
import { updateSettings } from '@/persistence';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import type { ActionCliExecutionDeps } from '@/cli/actions/executeCommand';
import { handleAgentsCommand } from './agents';
import { tryHandleAgentCliCommand } from '@/cli/actions/adapters/agentsArgv';
import { listCompiledActionCliCommands } from '@/cli/actions/compiledCommands';
import { createCliMachineActionDeps } from '@/session/actions/cliActionDeps/machine';

// Initialize the real, immutable command projection during source collection;
// invocation budgets should not include its first cold source construction.
listCompiledActionCliCommands();

describe('Agent CLI compiled install jobs', () => {
  let home = '';
  let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
  const invocations = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  beforeEach(async () => {
    home = await createTempDir('happier-agents-actions-');
    envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'PATH']);
    envScope.patch({ HAPPIER_HOME_DIR: home, PATH: join(home, 'bin') });
    reloadConfiguration();
    await updateSettings(settings => ({ ...settings,
      machineIdByServerId: { [configuration.activeServerId]: 'current-machine' },
      machineIdByServerIdByAccountId: { [configuration.activeServerId]: { account: 'current-machine' } },
    }));
  });
  afterEach(async () => {
    for (const controller of controllers) controller.abort();
    await Promise.allSettled([...invocations]);
    controllers.clear();
    vi.restoreAllMocks(); process.exitCode = 0;
    envScope.restore(); reloadConfiguration(); await removeTempDir(home);
  });

  function fixture(requireApproval = false, fail = false, interrupted = false, installOwner?: AgentInstallJobOwner) {
    const controller = new AbortController(); controllers.add(controller);
    const requests: unknown[] = [];
    let readCount = 0;
    const credentials = { token: 'header.eyJzdWIiOiJhY2NvdW50In0.signature', encryption: null };
    const machineDeps = createCliMachineActionDeps({ credentials, token: credentials.token }, {
      isMachineActionServerScopeCurrent: async () => true,
      callMachineAction: async ({ machineId, method, request }) => {
        if (method === RPC_METHODS.DAEMON_AGENTS_INSTALL_START) {
          const job = DaemonAgentInstallStartRequestSchema.parse(request);
          requests.push({ machineId, ...job });
          return installOwner ? installOwner.start(job) : { ok: true, jobId: `job-${job.agentId}` };
        }
        if (method === RPC_METHODS.DAEMON_AGENTS_INSTALL_READ) {
          const job = DaemonAgentInstallReadRequestSchema.parse(request);
          requests.push({ machineId, jobId: job.jobId, cursor: job.cursor });
          if (installOwner) return installOwner.read(job);
          if (interrupted && readCount++ === 0) {
            process.emit('SIGINT');
            return DaemonAgentInstallReadResponseSchema.parse({ ok: true, events: [], steps: [], progress: [], nextCursor: 1,
              done: false, outcome: null });
          }
          return DaemonAgentInstallReadResponseSchema.parse({ ok: true, events: [], steps: [], progress: [], nextCursor: 0,
            done: true, outcome: fail ? { kind: 'failed', code: 'consent_required', stepId: 'cli.claude', message: 'Vendor consent required' }
              : { kind: 'succeeded', version: '1.2.3' } });
        }
        if (method === RPC_METHODS.DAEMON_AGENTS_INSTALL_CANCEL) {
          const job = DaemonAgentInstallCancelRequestSchema.parse(request);
          requests.push({ machineId, cancelledJobId: job.jobId });
          return installOwner ? installOwner.cancel(job) : { ok: true };
        }
        throw new Error(`Unexpected machine method: ${method}`);
      },
    });
    // Only machine transport and credential storage are replaced; the CLI
    // compiler, machine request writer, schemas, approval and executor stay real.
    const executor = createActionExecutor({
      ...createUnavailableActionTransportDeps(),
      ...machineDeps,
      isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, normalizeActionsSettingsV1({ v: 1,
        approvalWaivedSurfaces: requireApproval ? {} : { 'machines.agents.install': ['cli'], 'machines.agents.uninstall': ['cli'], 'machines.agents.install.cancel': ['cli'] },
      }), context),
    });
    const deps: Partial<ActionCliExecutionDeps> = {
      readCredentialsFn: async () => credentials,
      getServerProfileFn: async () => ({ id: 'cloud', name: 'Home', serverUrl: 'https://api.example.test',
        webappUrl: 'https://app.example.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1 }),
      createExecutorFn: async () => ({ ...executor, async resolveSessionTarget() { throw new Error('Unexpected Session'); } }),
    };
    return { requests, deps, run: (args: string[]) => {
      const invocation = handleAgentsCommand(args, { actionExecutionDeps: deps, signal: controller.signal });
      invocations.add(invocation);
      return invocation.finally(() => { invocations.delete(invocation); });
    } };
  }

  it.each(['install', 'update'] as const)('dispatches %s with the current-machine default through the real Action executor', async intent => {
    const owner = fixture(); const output = captureConsoleLogAndMuteStdout();
    try {
      await owner.run([intent, 'codex', '--json']);
      expect(JSON.parse(output.logs.join('\n'))).toMatchObject({ ok: true, kind: `agents_${intent}`, data: { agentId: 'codex', jobId: 'job-codex', version: '1.2.3' } });
      expect(owner.requests).toEqual([
        { machineId: 'current-machine', agentId: 'codex', intent, consent: { vendorRecipe: false } },
        { machineId: 'current-machine', jobId: 'job-codex', cursor: 0 },
      ]);
    } finally { output.restore(); }
  });

  it.skipIf(process.platform === 'win32')('normalizes the documented lowercase Oh My Pi name before admitting an install Action', async () => {
    const spec = getAgentCliRuntimeSpec('ohMyPi');
    const command = resolveAgentCliManagedCommandPathForRuntime(spec, { happyHomeDir: home });
    await mkdir(dirname(command), { recursive: true });
    await writeFile(command, '#!/bin/sh\nprintf "omp 1.2.3\\n"\n');
    await chmod(command, 0o755);
    const installOwner = createAgentInstallJobOwner({ env: { HAPPIER_HOME_DIR: home, PATH: '' },
      readTrackedSessions: () => [], readRegistry: () => ({ agents: [{ id: spec.id, runtimeSpec: spec,
        pluginId: 'happier.agent.ohmypi', identity: { pluginId: 'happier.agent.ohmypi', localId: 'ohmypi' } }] }) });
    const owner = fixture(false, false, false, installOwner); const output = captureConsoleLogAndMuteStdout();
    try {
      await owner.run(['install', 'ohmypi', '--json']);
      expect(owner.requests[0], output.logs.join('\n')).toMatchObject({ agentId: 'ohMyPi', intent: 'install' });
      expect(JSON.parse(output.logs.join('\n'))).toMatchObject({ ok: true, data: { agentId: 'ohMyPi' } });
    } finally { await installOwner.shutdown(); output.restore(); }
  });

  it('retains consent, force, explicit targeting and definition identity', async () => {
    const owner = fixture(); const output = captureConsoleLogAndMuteStdout();
    try {
      await owner.run(['install', 'custom-acp', '--definition-id', 'goose', '--machine', 'remote', '--yes', '--force', '--json']);
      expect(owner.requests[0]).toEqual({ machineId: 'remote', agentId: 'custom-acp', definitionId: 'goose', intent: 'install', consent: { vendorRecipe: true }, force: true });
      expect(JSON.parse(output.logs.join('\n')).ok).toBe(true);
    } finally { output.restore(); }
  });

  it('dry-run through the dispatcher adapter never reads credentials or starts a job', async () => {
    const readCredentialsFn = vi.fn(async () => null);
    const output = captureConsoleLogAndMuteStdout();
    try {
      expect(await tryHandleAgentCliCommand({ argv: ['agents', 'install', 'codex', '--dry-run', '--json'],
        actionExecutionDeps: { readCredentialsFn } })).toBe(true);
      expect(JSON.parse(output.logs.join('\n'))).toMatchObject({ ok: true, data: { plan: { agentId: 'codex' } } });
      expect(readCredentialsFn).not.toHaveBeenCalled();
    } finally { output.restore(); }
  });

  it('keeps default CLI approval in front of every job', async () => {
    const owner = fixture(true); const output = captureConsoleLogAndMuteStdout();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await owner.run(['install', 'codex', '--json']);
      expect(owner.requests).toEqual([]);
      expect(JSON.parse(output.logs.join('\n')).ok).toBe(false);
    } finally { output.restore(); }
  });

  it('preserves terminal owner failures without implying success', async () => {
    const owner = fixture(false, true); const output = captureConsoleLogAndMuteStdout();
    try {
      await owner.run(['install', 'claude', '--json']);
      expect(JSON.parse(output.logs.join('\n'))).toMatchObject({ ok: false, error: { code: 'consent_required' } });
      expect(process.exitCode).toBe(1);
    } finally { output.restore(); }
  });

  it('cancels through the compiled Action and preserves a racing successful terminal outcome', async () => {
    const owner = fixture(false, false, true);
    const listeners = process.listenerCount('SIGINT');
    const output = captureConsoleLogAndMuteStdout();
    try {
      await owner.run(['install', 'codex', '--json']);
      expect(owner.requests).toContainEqual({ machineId: 'current-machine', cancelledJobId: 'job-codex' });
      expect(JSON.parse(output.logs.join('\n'))).toMatchObject({ ok: true, data: { jobId: 'job-codex', version: '1.2.3' } });
      expect(process.listenerCount('SIGINT')).toBe(listeners);
    } finally { output.restore(); }
  });

  it('reports a failed setup dry-run through the canonical error envelope', async () => {
    const output = captureConsoleLogAndMuteStdout();
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!platformDescriptor) throw new Error('Expected OS platform descriptor');
    try {
      // The OS platform is the external boundary; keep real selection and planning.
      Object.defineProperty(process, 'platform', { value: 'aix' });
      await handleAgentsCommand(['setup', '--provider', 'codex', '--dry-run', '--json']);
      expect(JSON.parse(output.logs.join('\n'))).toMatchObject({
        ok: false, kind: 'agents_setup', error: { code: 'install_failed', agents: [
          { agentId: 'codex', ok: false, errorCode: 'unsupported_platform' },
        ] },
      });
      expect(process.exitCode).toBe(1);
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
      output.restore();
    }
  });

  it('setup selects only missing recommended Agents and submits the same compiled jobs', async () => {
    const existing = getAgentCliSetupRecommendedIds()[0];
    if (!existing) throw new Error('Expected recommended Agent');
    const runtimeSpec = getAgentCliRuntimeSpec(existing);
    if (!runtimeSpec) throw new Error('Recommended Agent has no CLI runtime');
    const binary = runtimeSpec.binaryName;
    await mkdir(join(home, 'bin'), { recursive: true });
    await writeFile(join(home, 'bin', process.platform === 'win32' ? `${binary}.cmd` : binary), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const owner = fixture(); const output = captureConsoleLogAndMuteStdout();
    try {
      await owner.run(['list', '--json']);
      const roster = z.object({ data: z.object({ agents: z.array(z.looseObject({ id: z.string(), installed: z.boolean() })) }) })
        .parse(JSON.parse(String(output.logs.at(-1)))).data.agents;
      expect(roster.find(row => row.id === existing)?.installed).toBe(true);
      await owner.run(['setup', '--yes', '--json']);
      const starts = owner.requests.filter((value): value is { agentId: string } => !!value && typeof value === 'object' && 'agentId' in value);
      expect(starts.map(row => row.agentId)).toEqual(getAgentCliSetupRecommendedIds().filter(id => {
        const spec = getAgentCliRuntimeSpec(id);
        if (!spec) throw new Error('Recommended Agent has no CLI runtime');
        return roster.some(row => row.id === id && !row.installed) && spec.manualInstallKind !== 'none';
      }));
    } finally { output.restore(); }
  });
});
