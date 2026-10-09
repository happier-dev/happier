import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { MachineEnvironmentV1 } from '@happier-dev/protocol/machines/managed/machineEnvironmentV1';
import type { ProjectSetupOperationContext } from '@/workspaces/projectSetup/projectSetupExecution';
import type { ProjectNativeEnvironmentIo } from './produceProjectNativeEnvironment';
import type { SecretReferenceOverlayEnvironmentInput } from '@/settings/secrets/secretReferenceOverlay';
import type { TerminalPtySessionManager } from '@/terminal/pty/sessions';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { executeHostFiniteTerminalProcess } from '@/terminal/pty/finiteProcess';
import { resolveFiniteTerminalShell } from '@/terminal/pty/shells';
import { produceProjectNativeEnvironment } from './produceProjectNativeEnvironment';
import { resolveSecretReferenceOverlayEnvironment } from '@/settings/secrets/secretReferenceOverlay';
import type { TerminalPtyCustody } from '@/terminal/pty/sessions';
import { listMachineEnvironmentAdaptersV1 } from '@happier-dev/protocol/plugins/contributions/projectNativeAdapters';

export type ApplyMachineEnvironmentInput = Readonly<{
  homeId: string;
  machineId: string;
  preset: Readonly<{ id: string; revision: number }>;
  requesterAccountId: string;
  userHomeDirectory: string;
  environment: MachineEnvironmentV1;
  operation: ProjectSetupOperationContext;
  terminalSessions: Pick<TerminalPtySessionManager, 'ensure' | 'waitForExit' | 'requestStop'>;
  environmentIo: ProjectNativeEnvironmentIo;
  secretEnvironment?: Omit<SecretReferenceOverlayEnvironmentInput, 'secretReferenceOverlay'>;
  hostEnvironment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  managedId?: string;
  terminalCustody?: TerminalPtyCustody;
  signal?: AbortSignal;
  isCurrent(): Promise<boolean>;
}>;

export async function applyMachineEnvironment(input: ApplyMachineEnvironmentInput): Promise<ActionExecuteResult> {
  const fail = (code: string): ActionExecuteResult => ({ ok: false, errorCode: code, error: code });
  const platform = input.platform ?? process.platform;
  const signal = input.signal ?? input.operation.signal;
  const isCurrent = async () => !signal.aborted && await input.isCurrent() && !signal.aborted;
  const retired = () => fail(signal.aborted ? 'cancelled' : 'machine_admission_changed');
  const operationId = input.operation.operationAcceptance?.operationId ?? input.operation.actionRequestId;
  if (signal.aborted) return fail('cancelled');
  if (!operationId || !input.requesterAccountId) return fail('machine_environment_operation_unavailable');
  if (!await isCurrent()) return retired();
  const hostEnv = Object.fromEntries(Object.entries(input.hostEnvironment ?? process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const attachment = { kind: 'machineEnvironment' as const, serverId: input.homeId, machineId: input.machineId,
    preset: input.preset, ...(input.managedId ? { managedId: input.managedId } : {}) };
  input.operation.operationOwnerUpdate.update({ domainRef: attachment });
  let terminalId: string | undefined;
  const terminals: { install?: string; setup?: string } = {};
  let env: Readonly<Record<string, string>> = hostEnv;
  const run = async (phase: string, command: string, args: readonly string[], launchEnv: Readonly<Record<string, string>>, failureCode: string) => {
    if (!await isCurrent()) return retired();
    const outcome = await executeHostFiniteTerminalProcess({ operation: input.operation, terminalSessions: input.terminalSessions,
      requesterAccountId: input.requesterAccountId, terminalCustody: input.terminalCustody,
      signal,
      terminalKey: `${operationId}:machineEnvironment:${phase}`, launch: { command, args, cwd: input.userHomeDirectory, env: launchEnv },
      progress: { phase, label: phase === 'install' ? 'Installing machine tools' : 'Setting up machine' }, failureCode,
      attachment: observation => {
        if (phase === 'install' || phase === 'setup') terminals[phase] = observation.terminalId;
        return { ...attachment, ...observation, terminals: { ...terminals } };
      } });
    terminalId = outcome.terminalId;
    return outcome.result;
  };
  const toolchain = input.environment.toolchain;
  if (toolchain) {
    // Consumes the exact builtin B3 contract, not a guessed adapter command.
    const adapter = listMachineEnvironmentAdaptersV1(platform).find(candidate => candidate.id === toolchain.adapterId);
    if (!adapter) return fail('native_adapter_not_characterized');
    const tool = await input.environmentIo.resolveTool(adapter.id, signal);
    if (!await isCurrent()) return retired();
    if (!tool) return fail('native_tool_unavailable');
    if (tool.version !== adapter.nativeVersion) return fail('native_version_not_characterized');
    // Mise v2026.10.4 crates/mise-util/src/env.rs (reexported by src/env.rs):
    // GLOBAL_CONFIG_FILE > CONFIG_FILE > CONFIG_DIR > XDG_CONFIG_HOME.
    const configured = hostEnv.MISE_GLOBAL_CONFIG_FILE || hostEnv.MISE_CONFIG_FILE;
    const configDirectory = hostEnv.MISE_CONFIG_DIR || join(hostEnv.XDG_CONFIG_HOME || join(input.userHomeDirectory, '.config'), 'mise');
    const configPath = resolve(input.userHomeDirectory, expandHomeDirPath(configured || join(configDirectory, adapter.globalEnvironment.configFile), hostEnv, platform));
    try {
      await mkdir(dirname(configPath), { recursive: true });
      if (!await isCurrent()) return retired();
      await writeFile(configPath, toolchain.config, 'utf8');
    }
    catch { return fail('machine_environment_configuration_failed'); }
    if (signal.aborted) return fail('cancelled');
    const installed = await run('install', tool.executablePath, [...(tool.args ?? []), ...adapter.globalEnvironment.installArgs],
      { ...hostEnv, MISE_OVERRIDE_CONFIG_FILENAMES: configPath }, 'machine_environment_install_failed');
    if (!installed.ok) return installed;
    if (!await isCurrent()) return retired();
    const produced = await produceProjectNativeEnvironment({ selection: { kind: 'toolchain', tool: adapter.id, configPath: basename(configPath) },
      root: dirname(configPath), cwd: input.userHomeDirectory, env: hostEnv, platform, signal,
      io: { ...input.environmentIo, run: async request => {
        if (!await isCurrent()) throw Object.assign(new Error('machine_admission_changed'), { code: 'machine_admission_changed' });
        return input.environmentIo.run(request);
      } } });
    if (!await isCurrent()) return retired();
    if (produced.status !== 'ready') return fail(produced.kind === 'cancelled' ? 'cancelled' : produced.code);
    env = produced.env;
  }
  if (!await isCurrent()) return retired();
  if (input.environment.setupScript) {
    let secretEnv: Readonly<Record<string, string>> = {};
    if (input.environment.secretRefs) {
      if (!input.secretEnvironment) return fail('saved_secret_unavailable');
      try { secretEnv = resolveSecretReferenceOverlayEnvironment({ ...input.secretEnvironment, secretReferenceOverlay: input.environment.secretRefs }); }
      catch { return fail('saved_secret_unavailable'); }
    }
    const shell = resolveFiniteTerminalShell(input.environment.setupScript, hostEnv, platform);
    const setup = await run('setup', shell.file, shell.args, { ...env, ...secretEnv }, 'machine_environment_setup_failed');
    if (!setup.ok) return setup;
  }
  return { ok: true, result: { operationId, ...(terminalId ? { terminalId } : {}) } };
}
