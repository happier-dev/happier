import chalk from 'chalk';

import type { CommandContext } from '@/cli/commandRegistry';
import { mapUnknownErrorToControlError } from '@/cli/control/controlErrorMapping';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import { getLiveSystemTasksRunnerAdapter } from '@/capabilities/systemTasks/liveSystemTasksRunner';
import { configuration } from '@/configuration';
import { describeBackgroundServiceTargetMode } from '@/daemon/service/describeBackgroundServiceTargetMode';
import { applyServerSelectionFromArgs } from '@/server/serverSelection';
import { isInteractiveTerminal, promptInput } from '@/terminal/prompts/promptInput';
import type {
  SystemTaskEvent,
  SystemTaskJsonObject,
  SystemTaskResult,
  SystemTaskSpec,
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

function normalizeTaskChannel(args: readonly string[]): 'stable' | 'preview' | 'dev' {
  const resolution = resolveManagedCliReleaseChannelSync({
    args,
    argv: process.argv,
    invokedPath: process.argv[1] ?? '',
  });
  return resolution.label;
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
  if (!ssh.value) {
    throw new Error('Missing required flag: --ssh <user@host>');
  }

  const identityFile = takeFlagValue(args, '--identity-file');
  args = identityFile.rest;
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
  if (args.length > 0) {
    throw new Error(`Unknown machine setup arguments: ${args.join(' ')}`);
  }

  const usesKeyfileAuth = Boolean(identityFile.value && identityFile.value.trim());

  return {
    protocolVersion: 1,
    kind: 'remote.ssh.bootstrapMachine.v1',
    params: {
      ssh: {
        target: ssh.value.trim(),
        auth: usesKeyfileAuth ? 'keyfile' : 'agent',
        ...(usesKeyfileAuth ? { identityFile: identityFile.value!.trim() } : {}),
        ...(sshConfigFile.value?.trim() ? { sshConfigFile: sshConfigFile.value.trim() } : {}),
        ...(knownHostsPath.value?.trim() ? { knownHostsPath: knownHostsPath.value.trim() } : {}),
        ...(trustedHostKey.value?.trim() ? { trustedHostKey: trustedHostKey.value.trim() } : {}),
      },
      relay: {
        relayUrl: params.relaySelection.relayUrl,
        webappUrl: params.relaySelection.webappUrl,
        ...(params.relaySelection.publicRelayUrl ? { publicRelayUrl: params.relaySelection.publicRelayUrl } : {}),
      },
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
            },
          }
        : {}),
    },
  };
}

function formatPromptMessage(prompt: Readonly<{ kind: string; data: SystemTaskJsonObject }>, fallbackMessage = ''): string {
  if (prompt.kind === 'ssh.trustHost' || prompt.kind === 'ssh.replaceHostKey') {
    const host = typeof prompt.data.host === 'string' ? prompt.data.host : '';
    const keyType = typeof prompt.data.keyType === 'string' ? prompt.data.keyType : '';
    const fingerprint = typeof prompt.data.fingerprint === 'string' ? prompt.data.fingerprint : '';
    const existingFingerprint = typeof prompt.data.existingFingerprint === 'string' ? prompt.data.existingFingerprint : '';
    return [
      fallbackMessage || 'Trust remote SSH host key?',
      host ? `Host: ${host}` : '',
      keyType ? `Key type: ${keyType}` : '',
      fingerprint ? `Fingerprint: ${fingerprint}` : '',
      existingFingerprint ? `Existing fingerprint: ${existingFingerprint}` : '',
    ].filter(Boolean).join('\n');
  }

  if (prompt.kind === 'auth.approveRemoteProvisioning') {
    const publicKey = typeof prompt.data.publicKey === 'string' ? prompt.data.publicKey : '';
    return [
      fallbackMessage || 'Approve remote machine pairing?',
      publicKey ? `Public key: ${publicKey}` : '',
    ].filter(Boolean).join('\n');
  }

  return fallbackMessage || `Task requires input: ${prompt.kind}`;
}

function formatRemoteBackgroundServicePrompt(prompt: Readonly<{ kind: string; data: SystemTaskJsonObject }>, fallbackMessage = ''): string | null {
  if (prompt.kind !== 'daemon.replaceRemoteBackgroundServices') {
    return null;
  }

  const targetReleaseChannel = typeof prompt.data.targetReleaseChannel === 'string'
    ? prompt.data.targetReleaseChannel.trim()
    : '';
  const targetServerUrl = typeof prompt.data.targetServerUrl === 'string'
    ? prompt.data.targetServerUrl.trim()
    : '';
  const services = Array.isArray(prompt.data.services) ? prompt.data.services : [];
  const serviceLines = services
    .map((service) => {
      if (!service || typeof service !== 'object') return '';
      const label = typeof service.label === 'string' ? service.label.trim() : '';
      const releaseChannel = typeof service.releaseChannel === 'string' ? service.releaseChannel.trim() : '';
      const targetMode = typeof service.targetMode === 'string' ? service.targetMode : null;
      const running = typeof service.running === 'boolean' ? service.running : null;
      if (!label) return '';

      const details = [
        releaseChannel || null,
        targetMode ? describeBackgroundServiceTargetMode(targetMode) : null,
        running === true ? 'running' : null,
      ].filter(Boolean).join(', ');
      return details ? `- ${label} (${details})` : `- ${label}`;
    })
    .filter(Boolean);

  return [
    fallbackMessage || 'Remote machine already has Happier background services. Replace them with the selected release channel?',
    targetReleaseChannel ? `Target release channel: ${targetReleaseChannel}` : '',
    targetServerUrl ? `Target server: ${targetServerUrl}` : '',
    serviceLines.length ? 'Existing services:' : '',
    ...serviceLines,
  ].filter(Boolean).join('\n');
}

async function resolvePromptAnswer(params: Readonly<{
  prompt: Readonly<{ kind: string; data: SystemTaskJsonObject }>;
  interactive: boolean;
  assumeYes: boolean;
  promptInput: (prompt: string) => Promise<string>;
  message: string;
}>): Promise<unknown> {
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
  let queuedPrompt: Readonly<{ kind: string; data: SystemTaskJsonObject }> | null = null;

  while (true) {
    const snapshot = await runner.poll({
      taskId,
      cursor,
    });
    cursor = snapshot.nextCursor;

    for (const event of snapshot.events) {
      if (json) {
        console.log(JSON.stringify(event));
        if (event.type !== 'prompt') {
          continue;
        }
      }
      if (event.type === 'prompt') {
        lastPromptMessage = event.message ?? '';
        const eventData = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
          ? event.data as SystemTaskJsonObject
          : null;
        const eventPromptKind = eventData && typeof eventData.kind === 'string' ? eventData.kind : '';
        if (eventData && eventPromptKind) {
          queuedPrompt = {
            kind: eventPromptKind,
            data: eventData,
          };
        }
        continue;
      }
      queuedPrompt = null;
      printHumanEvent(event);
    }

    const effectivePrompt = snapshot.pendingPrompt ?? queuedPrompt;
    if (effectivePrompt) {
      const promptMessage =
        formatRemoteBackgroundServicePrompt(effectivePrompt, lastPromptMessage) ??
        formatPromptMessage(effectivePrompt, lastPromptMessage);
      const answer = await resolvePromptAnswer({
        prompt: effectivePrompt,
        interactive: deps.isInteractiveTerminal() && !json,
        assumeYes: yes.present,
        promptInput: deps.promptInput,
        message: promptMessage,
      });
      await runner.respond({
        taskId,
        answer,
      });
      lastPromptMessage = '';
      queuedPrompt = null;
      continue;
    }

    if (snapshot.result) {
      if (json) {
        console.log(JSON.stringify(snapshot.result));
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
      console.log(chalk.green('Remote machine ready.'));
      if (typeof data.machineId === 'string' && data.machineId.trim()) {
        console.log(`Machine ID: ${data.machineId.trim()}`);
      }
      const relayRuntimeUrl = typeof data.relayRuntime?.relayUrl === 'string'
        ? data.relayRuntime.relayUrl.trim()
        : '';
      if (relayRuntimeUrl) {
        console.log(`Remote relay URL: ${relayRuntimeUrl}`);
      }
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
      printJsonEnvelope(
        {
          ok: false,
          kind: 'machine_setup',
          error: { code: mapped.code, ...(mapped.message ? { message: mapped.message } : {}) },
        },
        { exitCode: mapped.unexpected ? 2 : 1 },
      );
      return;
    }

    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
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
