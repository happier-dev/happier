import type { CommandContext } from '@/cli/commandRegistry';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import { wantsJson, printJsonEnvelope, writeJsonStdout } from '@/cli/output/jsonEnvelope';
import { cmd, createOutputBuilder, errorFrame, ok, warn } from '@happier-dev/cli-common/output';
import { buildSshTarget, parseSshTarget } from '@happier-dev/cli-common/systemTasks';
import { describeBackgroundServiceTargetMode } from '@happier-dev/cli-common/happierRuntime';
import { resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import { configuration } from '@/configuration';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import { isLoopbackServerHost } from '@/server/serverUrlClassification';
import { isInteractiveTerminal, promptInput } from '@/terminal/prompts/promptInput';
import { promptSecret } from '@/terminal/prompts/promptSecret';
import {
  parseApproveRemoteProvisioningPromptData,
  parseReplaceRemoteBackgroundServicesPromptData,
  parseSshTrustPromptData,
  type SystemTaskEvent,
  type SystemTaskJsonObject,
  type SystemTaskResult,
  type SystemTaskSpec,
} from '@happier-dev/protocol';

import { showMachineHelp } from './machine/help';

type SystemTasksRunnerAdapter = Readonly<{
  start: (params: Readonly<{ spec: SystemTaskSpec }>) => Promise<Readonly<{ taskId: string }>>;
  poll: (params: Readonly<{ taskId: string; cursor: number }>) => Promise<Readonly<{
    events: SystemTaskEvent[];
    nextCursor: number;
    result: SystemTaskResult | null;
    pendingPrompt: Readonly<{ kind: string; data: SystemTaskJsonObject }> | null;
  }>>;
  respond: (params: Readonly<{ taskId: string; answer: unknown }>) => Promise<void>;
}>;

export type MachineCommandDeps = Readonly<{
  applyServerSelectionFromArgs: typeof applyServerSelectionFromArgs;
  createRunner: () => SystemTasksRunnerAdapter;
  readRelaySelection: () => Readonly<{
    relayUrl: string;
    webappUrl: string;
    publicRelayUrl?: string;
  }>;
  promptInput: (prompt: string) => Promise<string>;
  promptSecret: (prompt: string) => Promise<string>;
  isInteractiveTerminal: () => boolean;
  sleep: (ms: number) => Promise<void>;
}>;

const DEFAULT_DEPS: MachineCommandDeps = {
  applyServerSelectionFromArgs,
  createRunner: () => {
    const runner = getLiveSystemTasksRunnerAdapter();
    return {
      start: async (params) => await runner.start(params as never) as Readonly<{ taskId: string }>,
      poll: async (params) => await runner.poll(params as never) as Readonly<{
        events: SystemTaskEvent[];
        nextCursor: number;
        result: SystemTaskResult | null;
        pendingPrompt: Readonly<{ kind: string; data: SystemTaskJsonObject }> | null;
      }>,
      respond: async (params) => {
        await runner.respond(params as never);
      },
    };
  },
  readRelaySelection: () => ({
    relayUrl: configuration.serverUrl,
    webappUrl: configuration.webappUrl,
    ...(configuration.publicServerUrl && configuration.publicServerUrl !== configuration.serverUrl
      ? { publicRelayUrl: configuration.publicServerUrl }
      : {}),
  }),
  promptInput,
  promptSecret,
  isInteractiveTerminal,
  sleep: async (ms) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  },
};

function takeFlagValue(args: string[], name: string): { value: string | null; rest: string[] } {
  const rest: string[] = [];
  let value: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const current = String(args[index] ?? '');
    if (current === name) {
      const next = String(args[index + 1] ?? '');
      if (!next || next.startsWith('--')) {
        throw new Error(`Missing value for ${name}`);
      }
      value = next;
      index += 1;
      continue;
    }
    if (current.startsWith(`${name}=`)) {
      const next = current.slice(`${name}=`.length);
      if (!next) {
        throw new Error(`Missing value for ${name}`);
      }
      value = next;
      continue;
    }
    rest.push(current);
  }

  return { value, rest };
}

function takeFlag(args: string[], name: string): { present: boolean; rest: string[] } {
  const rest = args.filter((entry) => entry !== name);
  return {
    present: rest.length !== args.length,
    rest,
  };
}

function normalizeServiceMode(raw: string | null): 'user' | 'none' {
  return String(raw ?? '').trim().toLowerCase() === 'none' ? 'none' : 'user';
}

function normalizeRelayRuntimeMode(raw: string | null): 'user' | 'system' {
  return String(raw ?? '').trim().toLowerCase() === 'system' ? 'system' : 'user';
}

function normalizeSshAuth(raw: string | null): 'agent' | 'keyfile' | 'password' | null {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return null;
  if (text === 'agent' || text === 'keyfile' || text === 'password') {
    return text;
  }
  throw new Error(`Unsupported SSH auth mode: ${raw}`);
}

function normalizeTaskChannel(args: readonly string[]): 'stable' | 'preview' | 'dev' {
  return resolveManagedCliReleaseChannelSync({
    args,
    argv: process.argv,
    invokedPath: process.argv[1] ?? '',
    processEnv: process.env,
  }).label;
}

function buildMachineSetupSpec(params: Readonly<{
  args: string[];
  relaySelection: Readonly<{
    relayUrl: string;
    webappUrl: string;
    publicRelayUrl?: string;
  }>;
}>): SystemTaskSpec {
  let args = [...params.args];
  const json = takeFlag(args, '--json');
  args = json.rest;
  const preview = takeFlag(args, '--preview');
  args = preview.rest;
  const dev = takeFlag(args, '--dev');
  args = dev.rest;
  const channel = takeFlagValue(args, '--channel');
  args = channel.rest;
  const ssh = takeFlagValue(args, '--ssh');
  args = ssh.rest;
  const sshUser = takeFlagValue(args, '--ssh-user');
  args = sshUser.rest;
  const sshHost = takeFlagValue(args, '--ssh-host');
  args = sshHost.rest;
  const sshPort = takeFlagValue(args, '--ssh-port');
  args = sshPort.rest;
  if (!ssh.value && !sshHost.value) {
    throw new Error('Missing required flag: --ssh <user@host> or --ssh-host <host>.');
  }
  if (ssh.value && (sshUser.value || sshHost.value)) {
    throw new Error('Do not combine --ssh with --ssh-user/--ssh-host.');
  }
  const parsedLegacyTarget = parseSshTarget(ssh.value ?? '');
  const parsedHostTarget = parseSshTarget(sshHost.value ?? '');
  const sshTargetUsername = ssh.value
    ? parsedLegacyTarget.username
    : (sshUser.value?.trim() || parsedHostTarget.username);
  const sshTargetHost = ssh.value
    ? parsedLegacyTarget.host
    : (parsedHostTarget.host || sshHost.value?.trim() || '');
  const normalizedSshTarget = buildSshTarget({
    username: sshTargetUsername,
    host: sshTargetHost,
  });
  if (!normalizedSshTarget) {
    throw new Error('Missing required SSH host.');
  }
  if (ssh.value) {
    const sshTargetAfterUser = normalizedSshTarget.includes('@')
      ? normalizedSshTarget.slice(normalizedSshTarget.lastIndexOf('@') + 1)
      : normalizedSshTarget;
    if (/\]:\d+$/.test(sshTargetAfterUser)) {
      throw new Error('SSH target does not support specifying a port in --ssh. Use --ssh-config-file to set Port.');
    }
    const sshTargetHostParts = sshTargetAfterUser.split(':');
    if (sshTargetHostParts.length === 2 && /^\d+$/.test(sshTargetHostParts[1] ?? '')) {
      throw new Error('SSH target does not support specifying a port in --ssh. Use --ssh-config-file to set Port.');
    }
  }
  const sshPortText = sshPort.value?.trim() ?? '';
  let normalizedPort: number | undefined;
  if (sshPortText) {
    const parsedPort = Number.parseInt(sshPortText, 10);
    if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
      throw new Error('Missing or invalid value for --ssh-port');
    }
    normalizedPort = parsedPort;
  }

  const identityFile = takeFlagValue(args, '--identity-file');
  args = identityFile.rest;
  const sshAuth = takeFlagValue(args, '--ssh-auth');
  args = sshAuth.rest;
  const sshConfigFile = takeFlagValue(args, '--ssh-config-file');
  args = sshConfigFile.rest;
  const knownHostsPath = takeFlagValue(args, '--known-hosts-path');
  args = knownHostsPath.rest;
  const trustedHostKey = takeFlagValue(args, '--trusted-host-key');
  args = trustedHostKey.rest;
  const serviceMode = takeFlagValue(args, '--service-mode');
  args = serviceMode.rest;
  const relayRuntimeMode = takeFlagValue(args, '--relay-runtime-mode');
  args = relayRuntimeMode.rest;
  const installRelayRuntime = takeFlag(args, '--install-relay-runtime');
  args = installRelayRuntime.rest;
  const requireLocalApproval = takeFlag(args, '--require-local-approval');
  args = requireLocalApproval.rest;
  if (args.length > 0) {
    throw new Error(`Unknown machine setup arguments: ${args.join(' ')}`);
  }

  const explicitSshAuth = normalizeSshAuth(sshAuth.value);
  if (explicitSshAuth === 'password' && identityFile.value?.trim()) {
    throw new Error('--ssh-auth=password cannot be combined with --identity-file.');
  }
  if (explicitSshAuth === 'keyfile' && !identityFile.value?.trim()) {
    throw new Error('--ssh-auth=keyfile requires --identity-file <path>.');
  }
  const sshAuthMode = explicitSshAuth ?? (identityFile.value && identityFile.value.trim() ? 'keyfile' : 'agent');
  const normalizedTrustedHostKey = trustedHostKey.value?.trim() ?? '';
  if (normalizedTrustedHostKey && (normalizedTrustedHostKey.includes('\n') || normalizedTrustedHostKey.includes('\r'))) {
    throw new Error('Invalid --trusted-host-key: expected a single known_hosts line');
  }

  return {
    protocolVersion: 1,
    kind: 'remote.ssh.bootstrapMachine.v1',
    params: {
      ssh: {
        target: normalizedSshTarget,
        ...(typeof normalizedPort === 'number' ? { port: normalizedPort } : {}),
        auth: sshAuthMode,
        ...(sshAuthMode === 'keyfile' ? { identityFile: identityFile.value!.trim() } : {}),
        ...(sshConfigFile.value?.trim() ? { sshConfigFile: sshConfigFile.value.trim() } : {}),
        ...(knownHostsPath.value?.trim() ? { knownHostsPath: knownHostsPath.value.trim() } : {}),
        ...(normalizedTrustedHostKey ? { trustedHostKey: normalizedTrustedHostKey } : {}),
      },
      relay: {
        relayUrl: params.relaySelection.relayUrl,
        webappUrl: params.relaySelection.webappUrl,
        ...(params.relaySelection.publicRelayUrl ? { publicRelayUrl: params.relaySelection.publicRelayUrl } : {}),
      },
      ...(requireLocalApproval.present ? { requireLocalApproval: true } : {}),
      channel: normalizeTaskChannel([
        ...(preview.present ? ['--preview'] : []),
        ...(dev.present ? ['--dev'] : []),
        ...(channel.value ? [`--channel=${channel.value}`] : []),
      ]),
      serviceMode: normalizeServiceMode(serviceMode.value),
      knownHostsMode: 'app',
      ...(installRelayRuntime.present
        ? {
            relayRuntime: {
              enabled: true,
              mode: normalizeRelayRuntimeMode(relayRuntimeMode.value),
              switchRelayUrl: true,
            },
          }
        : {}),
    },
  };
}

function formatPromptMessage(prompt: Readonly<{ kind: string; data: SystemTaskJsonObject }>, fallbackMessage = ''): string {
  if (prompt.kind === 'ssh.trustHost' || prompt.kind === 'ssh.replaceHostKey') {
    const parsed = parseSshTrustPromptData(prompt.kind, prompt.data);
    return [
      fallbackMessage || 'Trust remote SSH host key?',
      parsed?.host ? `Host: ${parsed.host}` : '',
      parsed?.keyType ? `Key type: ${parsed.keyType}` : '',
      parsed?.fingerprint ? `Fingerprint: ${parsed.fingerprint}` : '',
      parsed?.existingFingerprint ? `Existing fingerprint: ${parsed.existingFingerprint}` : '',
    ].filter(Boolean).join('\n');
  }

  if (prompt.kind === 'auth.approveRemoteProvisioning') {
    const parsed = parseApproveRemoteProvisioningPromptData(prompt.data);
    return [
      fallbackMessage || 'Approve remote machine pairing?',
      parsed.publicKey ? `Public key: ${parsed.publicKey}` : '',
    ].filter(Boolean).join('\n');
  }

  if (prompt.kind === 'daemon.replaceRemoteBackgroundServices') {
    const parsed = parseReplaceRemoteBackgroundServicesPromptData(prompt.data);
    const formattedServices = parsed.services.map((service) => {
      const details = [
        service.releaseChannel,
        describeBackgroundServiceTargetMode(service.targetMode),
      ].filter(Boolean).join(', ');
      return `- ${service.label}${details ? ` (${details})` : ''} — ${service.running ? 'running' : 'stopped'}`;
    });
    return [
      fallbackMessage || 'Replace existing remote background services?',
      parsed.targetServerUrl ? `Target server: ${parsed.targetServerUrl}` : '',
      parsed.targetReleaseChannel ? `Target release channel: ${parsed.targetReleaseChannel}` : '',
      formattedServices.length > 0 ? 'Existing services:' : '',
      ...formattedServices,
    ].filter(Boolean).join('\n');
  }

  return fallbackMessage || `Task requires input: ${prompt.kind}`;
}

async function resolvePromptAnswer(params: Readonly<{
  prompt: Readonly<{ kind: string; data: SystemTaskJsonObject }>;
  interactive: boolean;
  assumeYes: boolean;
  promptInput: (prompt: string) => Promise<string>;
  promptSecret: (prompt: string) => Promise<string>;
  message: string;
}>): Promise<unknown> {
  if (params.prompt.kind === 'ssh.password') {
    if (!params.interactive) {
      throw new Error('Non-interactive mode requires an interactive terminal for SSH password auth.');
    }
    const password = await params.promptSecret(`${params.message}\nSSH password: `);
    return { password };
  }

  if (params.assumeYes) {
    if (params.prompt.kind === 'ssh.trustHost' || params.prompt.kind === 'ssh.replaceHostKey') {
      return { trusted: true };
    }
    if (params.prompt.kind === 'auth.approveRemoteProvisioning') {
      return { approved: true };
    }
    if (params.prompt.kind === 'daemon.replaceRemoteBackgroundServices') {
      return { replaceExistingServices: true };
    }
    return {};
  }

  if (!params.interactive) {
    throw new Error('Non-interactive mode requires --yes for setup prompts.');
  }

  if (params.prompt.kind === 'ssh.trustHost' || params.prompt.kind === 'ssh.replaceHostKey') {
    const answer = await params.promptInput(`${params.message}\nTrust this host key? [y/N]: `);
    return { trusted: /^y(?:es)?$/i.test(answer.trim()) };
  }
  if (params.prompt.kind === 'auth.approveRemoteProvisioning') {
    const answer = await params.promptInput(`${params.message}\nApprove pairing? [Y/n]: `);
    return { approved: !/^n(?:o)?$/i.test(answer.trim()) };
  }
  if (params.prompt.kind === 'daemon.replaceRemoteBackgroundServices') {
    const answer = await params.promptInput(`${params.message}\nReplace existing background services? [Y/n]: `);
    return { replaceExistingServices: !/^n(?:o)?$/i.test(answer.trim()) };
  }
  await params.promptInput(`${params.message}\nPress Enter to continue...`);
  return {};
}

function printHumanEvent(event: SystemTaskEvent): void {
  if (event.type === 'prompt') {
    return;
  }
  if (event.message) {
    console.log(event.message);
    return;
  }
  if (event.stepId) {
    console.log(event.stepId);
  }
}

async function runSetupSubcommand(argsRaw: string[], deps: MachineCommandDeps): Promise<void> {
  let args = await deps.applyServerSelectionFromArgs(argsRaw);
  const yes = takeFlag(args, '--yes');
  args = yes.rest;
  const json = wantsJson(args);
  const spec = buildMachineSetupSpec({
    args,
    relaySelection: deps.readRelaySelection(),
  });
  const runner = deps.createRunner();
  const { taskId } = await runner.start({ spec });
  let cursor = 0;
  let lastPromptMessage = '';
  let lastPromptEnvelopeFromEvents: Readonly<{ kind: string; data: SystemTaskJsonObject }> | null = null;

  while (true) {
    const snapshot = await runner.poll({
      taskId,
      cursor,
    });
    cursor = snapshot.nextCursor;
    lastPromptEnvelopeFromEvents = null;

    for (const event of snapshot.events) {
      if (event.type === 'prompt') {
        lastPromptMessage = event.message ?? '';
        if (event.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
          const kind = typeof (event.data as SystemTaskJsonObject).kind === 'string'
            ? String((event.data as SystemTaskJsonObject).kind).trim()
            : '';
          if (kind) {
            lastPromptEnvelopeFromEvents = {
              kind,
              data: event.data as SystemTaskJsonObject,
            };
          }
        }
        if (json) {
          await writeJsonStdout(event);
        }
        continue;
      }

      if (json) {
        await writeJsonStdout(event);
        continue;
      }
      printHumanEvent(event);
    }

    const pendingPrompt = snapshot.pendingPrompt ?? lastPromptEnvelopeFromEvents;
    if (pendingPrompt) {
      const promptMessage = formatPromptMessage(pendingPrompt, lastPromptMessage);
      const answer = await resolvePromptAnswer({
        prompt: pendingPrompt,
        interactive: deps.isInteractiveTerminal() && !json,
        assumeYes: yes.present,
        promptInput: deps.promptInput,
        promptSecret: deps.promptSecret,
        message: promptMessage,
      });
      await runner.respond({
        taskId,
        answer,
      });
      lastPromptMessage = '';
      continue;
    }

    if (snapshot.result) {
      if (json) {
        await writeJsonStdout(snapshot.result);
        if (!snapshot.result.ok) {
          process.exitCode = typeof process.exitCode === 'number' && process.exitCode > 1 ? process.exitCode : 1;
        }
        return;
      }

      if (!snapshot.result.ok) {
        throw Object.assign(new Error(snapshot.result.error.message), {
          code: snapshot.result.error.code,
        });
      }

      const data = (snapshot.result.data ?? {}) as {
        machineId?: unknown;
        relayRuntime?: { relayUrl?: unknown } | null;
      };
      const details: Array<{ label: string; value: string }> = [];
      if (typeof data.machineId === 'string' && data.machineId.trim()) {
        details.push({ label: 'Machine ID', value: data.machineId.trim() });
      }
      const relayRuntimeUrl = typeof data.relayRuntime?.relayUrl === 'string'
        ? data.relayRuntime.relayUrl.trim()
        : '';
      if (relayRuntimeUrl) {
        details.push({ label: 'Remote relay URL', value: relayRuntimeUrl });
      }
      const relayRuntimeIsLoopback = relayRuntimeUrl ? isLoopbackServerHost(relayRuntimeUrl) : false;
      const out = createOutputBuilder();
      out.line(ok('Remote machine ready.'));
      if (details.length > 0) {
        out.definitionList(details, { indent: '  ' });
      }
      if (relayRuntimeUrl) {
        if (relayRuntimeIsLoopback) {
          out.blank();
          out.line(warn('The remote relay URL is a loopback address and is only reachable from the remote machine.'));
          out.line('  Set up remote access (Tailscale/Cloudflare/reverse proxy) before switching other devices to it.');
        } else {
          out.line(`  Switch this computer to it with: ${cmd(`happier relay set ${relayRuntimeUrl} --use`)}`);
        }
      }
      console.log(out.render());
      return;
    }

    await deps.sleep(50);
  }
}

export async function handleMachineCommand(args: string[], deps: Partial<MachineCommandDeps> = {}): Promise<void> {
  const effectiveDeps: MachineCommandDeps = {
    ...DEFAULT_DEPS,
    ...deps,
  };
  const json = wantsJson(args);
  const subcommand = args[0];

  try {
    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      showMachineHelp();
      return;
    }

    if (subcommand !== 'setup') {
      throw new Error(`Unknown machine subcommand: ${subcommand}`);
    }

    await runSetupSubcommand(args.slice(1), effectiveDeps);
  } catch (error) {
    if (json) {
      const mapped = mapUnknownErrorToControlError(error);
      await printJsonEnvelope(
        {
          ok: false,
          kind: 'machine_setup',
          error: { code: mapped.code, ...(mapped.message ? { message: mapped.message } : {}) },
        },
        { exitCode: mapped.unexpected ? 2 : 1 },
      );
      return;
    }

    console.error(errorFrame('Error:', [error instanceof Error ? error.message : 'Unknown error']));
    showMachineHelp();
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exitCode = typeof process.exitCode === 'number' && process.exitCode > 1 ? process.exitCode : 1;
  }
}

export async function handleMachineCliCommand(context: CommandContext): Promise<void> {
  await handleMachineCommand(context.args.slice(1));
}
