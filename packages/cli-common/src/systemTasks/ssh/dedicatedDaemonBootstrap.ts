import { computeSha256HexDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import type { ManagedEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { resolveManagedMachineEnrollmentAdminAccessV1, type ManagedMachineV1, type ManagedMachineEnrollmentIdentityV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { MachineSetupBootstrapBasisV1, MachineRecipeStepV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { ManagedBootstrapFailureDetailsV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { ManagedMachineControllerError } from '../../machines/managed/controllerErrors.js';
export { ManagedMachineControllerError } from '../../machines/managed/controllerErrors.js';
import { buildBootstrapRootCommand, buildDedicatedDaemonInvocationCommand, buildRemoteHappierInvocationCommand, DEDICATED_DAEMON_INSTALL_HOME } from './remoteBootstrapCommandBuilder.js';
import { SystemTaskExecutionError } from '../runSystemTask.js';
import type { InteractiveSystemTaskContext } from '../interactiveTaskKinds.js';
import { createDockerEngineSetupSteps } from '../../machineSetup/dockerEngine.js';
import { buildManagedSudoersSteps } from '../../machineSetup/managedSudoers.js';
import { buildAgentIsolationBootstrapSteps } from '../../machineSetup/agentIsolationBootstrap.js';
import { buildUserManagerGroupRefreshStep } from '../../machineSetup/userManagerGroups.js';
import { FIRST_PARTY_MANAGED_TOOLS_DIR_NAME } from '../../firstPartyRuntime/installLayoutContract.js';
import { MachineAdministratorEstablishFrameSchema, MachineEffectInternalRecordSchema, MachineEffectInternalRequestSchema, type MachineAdministratorEstablishFrame, type MachineEffectInternalRequest, type MachineEffectInternalResult } from '../../machineSetup/effectInternalProtocol.js';

/** OS/SSH transport only; requests carry transient stdin and optional live stdout. */
export type DedicatedDaemonBootstrapExec = (request: Readonly<{
  command: string; input?: string; signal?: AbortSignal; timeoutMs?: number | null;
  onStdoutChunk?: (chunk: string) => void; includeStdoutInError?: boolean;
}>) => Promise<Readonly<{ status: number; stdout: string; stderr: string }>>;

export type DedicatedDaemonBootstrapInput = Readonly<{
  binaryPath: string;
  channel: 'stable' | 'preview' | 'dev';
  exec: DedicatedDaemonBootstrapExec;
  createPromptId: () => string;
  emit: InteractiveSystemTaskContext['emit'];
  prompt: InteractiveSystemTaskContext['prompt'];
  signal?: AbortSignal;
} & (
  | { row: ManagedMachineV1; correlation: ManagedEnrollmentCorrelationV1 }
  | { task: Readonly<{ taskId: string;
      enrollmentIdentity: Extract<ManagedMachineEnrollmentIdentityV1, { kind: 'dedicatedDaemonUser' }>;
      sshTarget: string; sshPort?: number; homeServerIdentityId?: string; relayUrl: string }> }
)>;

/** Creation-time composition only. The setup interpreter owns every effect and plan digest. */
export async function prepareDedicatedDaemonBootstrap(input: DedicatedDaemonBootstrapInput): Promise<void> {
  const identity = 'row' in input ? input.row.enrollmentIdentity : input.task.enrollmentIdentity;
  // Binding the Machine follows this root window. A later retained installer
  // retry must not replay immutable creation intent over current admin policy.
  if (identity?.kind !== 'dedicatedDaemonUser' || ('row' in input && input.row.enrolledMachineId)) return;
  const operationId = 'row' in input ? input.correlation.requestId : input.task.taskId;
  const facts = await input.exec({ command: '. /etc/os-release; printf "%s\\n%s\\n%s\\n" "$ID" "$VERSION_CODENAME" "$(dpkg --print-architecture)"', signal: input.signal });
  const [distribution, codename, architecture] = facts.stdout.trim().split(/\r?\n/u);
  if (facts.status !== 0 || (distribution !== 'ubuntu' && distribution !== 'debian') || !codename || !architecture
    || !/^[a-z0-9][a-z0-9.-]*$/u.test(codename) || !/^[a-z0-9-]+$/u.test(architecture)) {
    throw new SystemTaskExecutionError('dedicated_identity_unsupported', 'Dedicated bootstrap requires the supported Linux package and service managers.');
  }
  const account = await input.exec({ command: 'id -u happier', signal: input.signal });
  const uid = account.stdout.trim();
  if (account.status !== 0 || !/^[1-9][0-9]*$/u.test(uid)) {
    throw new SystemTaskExecutionError('dedicated_identity_unconfirmed', 'The dedicated non-root account could not be confirmed.');
  }
  const administrator = identity.adminAccessAtCreation === 'ask' ? identity.administrator : undefined;
  const policy = resolveManagedMachineEnrollmentAdminAccessV1(identity)!;
  const steps: MachineRecipeStepV1[] = [
    { id: 'bootstrap-isolation-packages', kind: 'package', manager: 'apt', packages: ['sudo', 'acl', 'git'].map(name => ({ name })) },
    ...(administrator ? [{ id: 'bootstrap-administrator', kind: 'user' as const, username: administrator.username }] : []),
    ...buildManagedSudoersSteps({ daemonUsername: identity.username, previousPolicy: { version: 1, mode: 'none' }, policy }),
    ...buildAgentIsolationBootstrapSteps({ daemonUsername: 'happier', daemonPrimaryGroup: 'happier', binaryPath: input.binaryPath,
      toolsRoot: `${DEDICATED_DAEMON_INSTALL_HOME}/${FIRST_PARTY_MANAGED_TOOLS_DIR_NAME}` }),
    ...(identity.role === 'deployTarget' ? createDockerEngineSetupSteps({ distribution, codename, architecture, daemonUsername: 'happier' }) : []),
    { id: 'daemon-user-linger', kind: 'command', executable: 'loginctl', args: ['enable-linger', 'happier'],
      check: { executable: 'test', args: ['-f', '/var/lib/systemd/linger/happier'], unsatisfiedExitCodes: [1] } },
    buildUserManagerGroupRefreshStep({ uid: Number(uid), username: 'happier' }),
  ];
  // This identifies the immutable retained bootstrap inputs, not an online
  // desired record. The effect plan/digest itself is constructed only by P20.
  const basis: MachineSetupBootstrapBasisV1 = 'row' in input ? {
    kind: 'bootstrap', managedId: input.correlation.managedId, operationId,
    admittedInputDigest: computeSha256HexDigest(createCanonicalJsonSigningInput({ correlation: input.correlation,
      enrollmentIdentity: identity, launch: input.row.launch })),
  } : { kind: 'sshBootstrap', operationId,
    admittedInputDigest: computeSha256HexDigest(createCanonicalJsonSigningInput({ ...input.task, channel: input.channel })) };
  const invoke = async (request: MachineEffectInternalRequest, establishment?: MachineAdministratorEstablishFrame): Promise<MachineEffectInternalResult> => {
    input.signal?.throwIfAborted();
    let result: MachineEffectInternalResult | undefined;
    let lineBuffer = '';
    let streamed = false;
    let invalidResponse = false;
    const consumeLine = (line: string) => {
      if (!line.trim()) return;
      const record = MachineEffectInternalRecordSchema.parse(JSON.parse(line));
      if (result) throw new Error('Record after terminal result');
      if (record.type === 'progress') input.emit({ type: 'progress', stepId: record.stepId,
        message: { check: 'Checking machine setup', apply: 'Setting up the machine', verify: 'Verifying machine setup' }[record.phase] });
      if (record.type === 'result') result = record.result;
    };
    const consumeOutput = (chunk: string) => {
      if (invalidResponse) return;
      lineBuffer += chunk;
      try {
        let newline = lineBuffer.indexOf('\n');
        while (newline >= 0) {
          consumeLine(lineBuffer.slice(0, newline));
          lineBuffer = lineBuffer.slice(newline + 1);
          newline = lineBuffer.indexOf('\n');
        }
      } catch {
        // Output callbacks may run on process events. Retain only the closed
        // failure fact and settle it with the command's final process facts.
        invalidResponse = true;
        lineBuffer = '';
      }
    };
    const response = await input.exec({ command: buildBootstrapRootCommand(buildRemoteHappierInvocationCommand({
      binaryPath: input.binaryPath, channel: input.channel,
      args: ['machine', 'effect-internal', `--operation-id=${operationId}`],
    })), input: JSON.stringify(MachineEffectInternalRequestSchema.parse(request)) + '\n'
      + (establishment ? JSON.stringify(establishment) + '\n' : ''), signal: input.signal,
      onStdoutChunk: chunk => {
        if (chunk.length === 0) return;
        streamed = true;
        consumeOutput(chunk);
      } });
    const failure = (responseKind: 'missing_result' | 'invalid_response' | 'result', code = 'bootstrap_effect_unconfirmed') => {
      const details = { kind: 'managedBootstrap' as const, phase: request.mode, response: responseKind,
        exitStatus: response.status, stdoutPresent: Boolean(response.stdout.trim()), stderrPresent: Boolean(response.stderr.trim()),
        ...(responseKind === 'result' && result ? { resultStatus: result.status } : {}) };
      // A result reason is a code, never free-form child output. The shared
      // operation schema owns its identifier grammar and public bound.
      const withReason = ManagedBootstrapFailureDetailsV1Schema.safeParse({ ...details,
        ...(responseKind === 'result' && result && 'reason' in result ? { reason: result.reason } : {}) });
      return new ManagedMachineControllerError(code, undefined,
        withReason.success ? withReason.data : ManagedBootstrapFailureDetailsV1Schema.parse(details));
    };
    // Buffered-only adapters use the same parser. Streaming adapters return
    // those bytes again in stdout; do not publish their progress twice.
    if (!streamed) consumeOutput(response.stdout);
    if (!invalidResponse) {
      try { consumeLine(lineBuffer); } catch { invalidResponse = true; }
    }
    if (invalidResponse) throw failure('invalid_response');
    input.signal?.throwIfAborted();
    if (!result || response.status !== 0 && (result.status === 'applied' || result.status === 'checked')) {
      throw failure(result ? 'result' : 'missing_result');
    }
    if (result.status !== (request.mode === 'check' ? 'checked' : 'applied')) {
      throw failure('result', `bootstrap_effect_${result.status}`);
    }
    return result;
  };
  const checked = await invoke({ v: 1, mode: 'check', basis, steps });
  if (checked.status !== 'checked' || !('plan' in checked)) throw new SystemTaskExecutionError(`bootstrap_effect_${checked.status}`, 'Bootstrap prerequisites could not be checked.');
  if (!sameStrictJsonValue(checked.plan.basis, basis) || !sameStrictJsonValue(checked.plan.steps, steps)) {
    throw new SystemTaskExecutionError('bootstrap_plan_changed', 'The bootstrap plan no longer matches its retained inputs.');
  }
  let establishment: MachineAdministratorEstablishFrame | undefined;
  if (administrator && checked.plan.nativeFacts.find(fact => fact.stepId === 'bootstrap-administrator')?.facts.present === false) {
    const answer = await input.prompt({ kind: 'administrator.establish',
      message: `Setup will create administrator ${administrator.username}. Set a password for this new account. Your password passes through this computer's setup step to the server. Happier does not save it.`,
      data: { promptId: input.createPromptId(), administratorUsername: administrator.username } });
    const credential = MachineAdministratorEstablishFrameSchema.safeParse({ type: 'administrator.establish',
      operationId, planDigest: checked.plan.planDigest,
      stepId: 'bootstrap-administrator', username: administrator.username,
      password: answer && typeof answer === 'object' && 'password' in answer ? answer.password : undefined });
    if (!credential.success || /[\r\n\0]/u.test(credential.data.password)) {
      throw new SystemTaskExecutionError('administrator_establishment_invalid', 'The administrator password response is invalid.');
    }
    establishment = credential.data;
  }
  let applied: MachineEffectInternalResult;
  try {
    applied = await invoke({ v: 1, mode: 'apply', plans: [{ plan: checked.plan }],
      ...(establishment ? { administrator: { stepId: establishment.stepId, username: establishment.username } } : {}) }, establishment);
  } finally {
    // Strings cannot be zeroized; release the transient response after the one
    // stdin exchange. It never enters a plan, retained event or argv.
    if (establishment) establishment.password = '';
  }
  if (applied.status !== 'applied') throw new SystemTaskExecutionError(`bootstrap_effect_${applied.status}`, 'Bootstrap preparation did not complete.');
  if (identity.adminAccessAtCreation === 'preauthorized') {
    const grant = await input.exec({ command: buildDedicatedDaemonInvocationCommand('sudo -n -u root -- true'), signal: input.signal });
    if (grant.status !== 0) throw new SystemTaskExecutionError('administrator_grant_unconfirmed', 'The reviewed administrator grant could not be confirmed.');
  }
}
