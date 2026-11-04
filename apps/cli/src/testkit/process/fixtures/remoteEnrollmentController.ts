import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSystemTasksRunner, createHappierJsonExecutorFromTextRunner, createRemoteNativeBootstrapMachineTaskKind, SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks';
import type { SystemTaskResult } from '@happier-dev/protocol';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { ManagedEnrollmentCorrelationV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { approveTerminalAuthRequest } from '@/auth/terminalAuthApproval';
import { createProtocolSystemTasksRunnerAdapter, createSystemTasksCapability, systemTasksCapability } from '@/capabilities/registry/toolSystemTasks';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import { SystemTaskResultSchema } from '@happier-dev/protocol/system/tasks/spec';
import { writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { projectSafeAuthError } from '@/cli/commands/auth/errorDiagnostic';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';

// Real controller auth and SystemTask wiring; the native transport/installation
// boundary is a local source CLI process, never a VM or a daemon service.
const inputChunks: Buffer[] = [];
for await (const chunk of process.stdin) inputChunks.push(Buffer.from(chunk));
const input = JSON.parse(Buffer.concat(inputChunks).toString('utf8'));
const descriptor = HomeConnectionDescriptorV1Schema.parse(input.descriptor);
const correlation = ManagedEnrollmentCorrelationV1Schema.parse(input.correlation);
const controller = correlation.controller;
if (!controller) throw new Error('The native controller enrollment fixture requires its installed controller.');
const target = resolveHomeTargetFromDescriptor({ descriptor, authority: 'trusted_enrollment' });
const root = resolve(process.cwd(), '../..');
const guestEnv = { ...process.env, HAPPIER_HOME_DIR: String(input.guestHome), HAPPIER_SERVER_URL: undefined,
  HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_LOCAL_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined,
  HAPPIER_ACTIVE_SERVER_ID: undefined };
let pendingRequest: { publicKey: string; remoteProfileId: string } | undefined;
let waitDiagnostic: { v?: 1; ok?: false; kind?: 'auth_wait'; code?: string | number; status?: number } | undefined;
const executor = createHappierJsonExecutorFromTextRunner(async (args, options) => await new Promise((resolveResult, reject) => {
  const startedAt = Date.now();
  console.error(`qb73 subprocess start: ${args[0]} ${args[1]}`);
  const entrypoint = typeof input.guestEntrypoint === 'string' ? input.guestEntrypoint : resolve(root, 'apps/cli/src/index.ts');
  const guestExecutable = typeof input.guestExecutable === 'string' ? input.guestExecutable : undefined;
  const runtimeArgs = guestExecutable ? [] : [
    ...(input.guestEntrypoint ? [] : ['--conditions=happier-source', ...('bun' in process.versions ? [] : ['--import', 'tsx'])]),
    entrypoint,
  ];
  const child = spawn(guestExecutable ?? process.execPath, [...runtimeArgs, ...args], {
    cwd: resolve(root, 'apps/cli'), env: guestEnv, stdio: ['pipe', 'pipe', 'pipe'], signal: options?.signal,
  });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  if (args[1] === 'wait' && input.killWaitProcess === true) {
    child.once('spawn', () => child.kill('SIGKILL'));
  }
  child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
  child.on('error', reject);
  child.on('close', status => {
    console.error(`qb73 subprocess close: ${args[0]} ${args[1]} ${status} ${Date.now() - startedAt}ms`);
    const output = Buffer.concat(stdout).toString('utf8');
    if (args[1] === 'request' && status === 0) pendingRequest = JSON.parse(output);
    if (args[1] === 'wait' && input.observeWaitDiagnostic === true) {
      // Inspect the actual guest's single JSON document, never forward its raw
      // output or diagnostic message (which could carry credential material).
      try {
        const envelope = JSON.parse(output);
        const diagnostic = projectSafeAuthError(envelope.error);
        waitDiagnostic = { v: envelope.v === 1 ? 1 : undefined, ok: envelope.ok === false ? false : undefined,
          kind: envelope.kind === 'auth_wait' ? 'auth_wait' : undefined,
          code: diagnostic.code, status: diagnostic.status };
      } catch { /* Missing or contaminated JSON stays unobserved. */ }
    }
    resolveResult({ status: status ?? 1, stdout: output, stderr: Buffer.concat(stderr).toString('utf8') });
  });
  child.stdin.on('error', () => {});
  child.stdin.end(options?.input);
}));
const runner = getLiveSystemTasksRunnerAdapter();
const task = createRemoteNativeBootstrapMachineTaskKind({
  configuration: { relay: { relayUrl: target.canonicalAuthUrl }, homeTarget: target,
    managedEnrollment: correlation, requireLocalApproval: true, serviceMode: 'none' },
  executor, installRemoteCli: async () => {}, assertCurrent: async () => {},
  approveLocalAuthRequest: async ({ publicKey, pairing, supportsTokenOnly, signal }) => {
    console.error('qb73 approval start');
    await approveTerminalAuthRequest({ publicKey, pairing, supportsTokenOnly, target, signal });
    console.error('qb73 approval complete');
  },
});
const { taskId } = await runner.startAdmitted(task);
const scope = { accountId: 'disposable-account', machineId: controller.machineId };
const operations = createActionOperationRunner({ store: createActionOperationStore(), generateOperationId: () => 'qb73-operation',
  resolveAction: actionId => ({ actionId, title: 'Enroll managed Machine', operation: {
    version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
  } }),
});
await operations.observe({ actionId: 'machines.managed.acquire', scope, execute: async context => {
  context.operationAcceptance?.accept({ operationId: 'qb73-operation' });
  const result = await runner.wait({ taskId });
  if (!result.ok) throw new SystemTaskExecutionError(result.error?.code ?? 'system_task_failed', result.error?.message ?? 'Managed guest setup failed.');
  return { ok: true, result: result.data ?? null };
} });
async function publishOutcome(result: SystemTaskResult, lateConsent?: { rejected: boolean; waitStatus: number; waitCode?: string }): Promise<void> {
  await writeJsonStdout({ task: result, operation: await operations.waitForTerminal(scope, 'qb73-operation'),
    ...(waitDiagnostic ? { waitDiagnostic } : {}), ...(lateConsent ? { lateConsent } : {}) });
  process.exitCode = result.ok ? 0 : 1;
}
process.once('SIGTERM', () => { void runner.cancel({ taskId }); });
try {
  while (true) {
    const state = await runner.poll({ taskId, cursor: 0 });
    if (!state || typeof state !== 'object') throw new Error('invalid_task_poll');
    if ('result' in state && state.result) { await publishOutcome(SystemTaskResultSchema.parse(state.result)); break; }
    if ('pendingPrompt' in state && state.pendingPrompt) {
      if (typeof state.pendingPrompt !== 'object' || !('kind' in state.pendingPrompt)
        || state.pendingPrompt.kind !== 'auth.approveRemoteProvisioning') throw new Error('unexpected_prompt');
      // Sensitivity case: bind the real capability to a different runner while
      // retaining the exact task id. It must never approve the waiting request.
      const capability = input.misbind
        ? createSystemTasksCapability(createProtocolSystemTasksRunnerAdapter(createSystemTasksRunner({ kinds: {} })))
        : systemTasksCapability;
      if (typeof input.approvalDelayMs === 'number') {
        await delay(input.approvalDelayMs);
        const expired = await runner.poll({ taskId, cursor: 0 });
        if (!expired || typeof expired !== 'object') throw new Error('invalid_task_poll');
        if ('result' in expired && expired.result && pendingRequest) {
          let rejected = false;
          try { await capability.invoke!({ method: 'respond', params: { taskId, answer: { approved: true } } }); }
          catch { rejected = true; }
          // Exercise the original late guest invocation too, against the same
          // real request and Home. Only its safe typed code leaves the fixture.
          const waited = await executor.runHappierText(['auth', 'wait', '--json', '--remote-enrollment', '--server',
            pendingRequest.remoteProfileId, '--no-persist', '--public-key', pendingRequest.publicKey]);
          const failure = JSON.parse(waited.stdout);
          await publishOutcome(SystemTaskResultSchema.parse(expired.result), { rejected, waitStatus: waited.status, waitCode: failure.error?.code });
          break;
        }
      }
      await capability.invoke!({ method: 'respond', params: {
        taskId, answer: { approved: true },
      } });
      const result = await runner.wait({ taskId });
      await publishOutcome(result);
      break;
    }
    await delay(10);
  }
} catch {
  await runner.cancel({ taskId });
  await runner.wait({ taskId });
  await writeJsonStdout({ ok: false, error: { code: 'approval_wiring_failed' } });
  process.exitCode = 1;
}
// This finite fixture has awaited its subprocesses and drained its result.
process.exit(process.exitCode ?? 0);
