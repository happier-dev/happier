import type { ProviderRedactionLease } from '@/providers/spawn/redaction';
import type { ProjectToolchainSelectionV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import { basename, dirname, resolve } from 'node:path';
import { findBuiltinNativeToolchainAdapterV1 } from '@happier-dev/protocol/plugins/contributions/projectNativeAdapters';
import type { ProjectNativeAdapterProductionV1 } from '@/plugins/runtime/lifecycle/contributions/targetProjectNativeAdapters';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';

export type ProjectNativeToolchainIo = Readonly<{
  /** Incumbent managedDependencies/systemTools resolution; never installs. */
  resolveTool: (tool: string, signal?: AbortSignal) => Promise<Readonly<{ executablePath: string; args?: readonly string[]; version: string }> | null>;
  /** Incumbent supervised process IO, including process-tree cancellation. Output is private. */
  run: (request: Readonly<{ command: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>>; signal?: AbortSignal;
    /** Host-owned native config input; existing supervisor owns byte custody. */
    stdin?: Uint8Array;
    /** Host-only stage capture; the supervisor sanitizes before this sink or its result buffers. */
    output?: Readonly<{ redaction: ProviderRedactionLease; onChunk(stream: 'stdout' | 'stderr', chunk: Uint8Array): void }>;
  }>) => Promise<Readonly<{ exitCode: number; stdout: string; stderr?: string }>>;
}>;

type PluginToolchainReady = Extract<Awaited<ReturnType<ProjectNativeAdapterProductionV1['prepareToolchain']>>, { kind: 'ready' }>;

export type ProjectNativePluginAdapterInput = Readonly<{
  lease: Pick<ProjectNativeAdapterProductionV1, 'prepareToolchain' | 'isCurrent'>;
  files: Parameters<ProjectNativeAdapterProductionV1['prepareToolchain']>[0]['files'];
  launch?: Readonly<{ command: string; args: readonly string[] }>;
}>;

export type ProjectNativeToolchainResult =
  | Readonly<{ status: 'ready'; env: Readonly<Record<string, string>>; nativeLaunch?: NonNullable<PluginToolchainReady['launch']>; reviewInputs?: PluginToolchainReady['reviewInputs'] }>
  | Readonly<{ status: 'refused'; kind: 'unavailable' | 'unsupported' | 'native_failed' | 'cancelled'; code: string }>;

export class ProjectNativeToolchainUncertainError extends Error {
  readonly kind = 'outcome_uncertain';
  readonly code = 'native_toolchain_termination_incomplete';

  constructor() {
    super('Native environment process termination could not be verified');
  }
}

function preserveUnconfirmedProcessCustody(error: unknown): void {
  if (error && typeof error === 'object' && 'code' in error
    && error.code === 'plugin_exec_termination_incomplete') {
    // Keep the process owner's fact, not potentially private native diagnostics.
    throw new ProjectNativeToolchainUncertainError();
  }
}

function readIsolationRefusal(error: unknown): ProjectNativeToolchainResult | undefined {
  if (isPluginError(error) && (error.code === 'workspace_exec_isolation_unavailable' || error.code === 'agent_isolation_unavailable')) {
    return { status: 'refused', kind: 'unavailable', code: error.code };
  }
  return undefined;
}

export type ProjectNativeToolchainInput = Readonly<{
  selection: ProjectToolchainSelectionV1;
  /** Reviewed Project root; cwd may be a nested command working directory. */
  root?: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
  platform: NodeJS.Platform;
  signal?: AbortSignal;
  io: ProjectNativeToolchainIo;
  /** Only 20's canonical native resolution can establish this fact. */
  nativeCommandToolchain?: ProjectToolchainSelectionV1;
  /** Admitted lifecycle lease; the caller never supplies plugin invocation services. */
  pluginAdapter?: ProjectNativePluginAdapterInput;
}>;

export async function prepareProjectNativeToolchain(input: ProjectNativeToolchainInput): Promise<ProjectNativeToolchainResult> {
  const cancelled = (): ProjectNativeToolchainResult => ({ status: 'refused', kind: 'cancelled', code: 'native_toolchain_cancelled' });
  if (input.signal?.aborted) return cancelled();
  if (input.selection.kind === 'host') return { status: 'ready', env: input.env };
  if (input.selection.kind === 'pluginToolchain') {
    const adapter = input.pluginAdapter;
    if (!adapter) return { status: 'refused', kind: 'unavailable', code: 'native_adapter_unavailable' };
    if (!adapter.lease.isCurrent()) return { status: 'refused', kind: 'unavailable', code: 'native_adapter_retired' };
    const native = input.nativeCommandToolchain;
    if (native?.kind === 'pluginToolchain'
      && native.adapter.pluginId === input.selection.adapter.pluginId
      && native.adapter.localId === input.selection.adapter.localId
      && native.configPath === input.selection.configPath) {
      return { status: 'ready', env: input.env };
    }
    try {
      const output = await adapter.lease.prepareToolchain({
        root: input.root ?? input.cwd, adapter: input.selection.adapter, files: adapter.files,
        selection: input.selection,
        ...(adapter.launch ? { launch: { ...adapter.launch, cwd: input.cwd, env: input.env } } : {}),
      }, input.signal ? { signal: input.signal } : undefined);
      if (input.signal?.aborted) return cancelled();
      if (!adapter.lease.isCurrent()) return { status: 'refused', kind: 'unavailable', code: 'native_adapter_retired' };
      if (output.kind !== 'ready') return {
        status: 'refused', kind: output.kind === 'failed' ? 'native_failed' : output.kind, code: output.code,
      };
      // The lifecycle owner validates the SDK result. The final tuple owner
      // resolves an optional managed wrapper before authorization/capture.
      return { status: 'ready', env: output.env, reviewInputs: output.reviewInputs,
        ...(output.launch ? { nativeLaunch: output.launch } : {}) };
    } catch (error) {
      preserveUnconfirmedProcessCustody(error);
      const isolationRefusal = readIsolationRefusal(error);
      if (isolationRefusal && !input.signal?.aborted && adapter.lease.isCurrent()) return isolationRefusal;
      return input.signal?.aborted ? cancelled()
        : !adapter.lease.isCurrent() ? { status: 'refused', kind: 'unavailable', code: 'native_adapter_retired' }
        : { status: 'refused', kind: 'native_failed', code: 'native_toolchain_failed' };
    }
  }
  if (input.selection.kind !== 'toolchain') return { status: 'refused', kind: 'unsupported', code: 'native_adapter_not_characterized' };
  const selected = input.selection;
  const native = input.nativeCommandToolchain;
  if (native?.kind === 'toolchain' && native.tool === selected.tool && native.configPath === selected.configPath) {
    return { status: 'ready', env: input.env };
  }
  // Installed Linux x64 contracts only. Selection is retained for repair on
  // unqualified targets; it never silently becomes the host environment.
  const characterization = findBuiltinNativeToolchainAdapterV1(selected.tool, input.platform);
  if (!characterization) {
    return { status: 'refused', kind: 'unsupported', code: 'native_adapter_not_characterized' };
  }
  try {
    const tool = await input.io.resolveTool(selected.tool, input.signal);
    if (input.signal?.aborted) return cancelled();
    if (!tool) return { status: 'refused', kind: 'unavailable', code: 'native_tool_unavailable' };
    if (tool.version !== characterization.nativeVersion) return { status: 'refused', kind: 'unsupported', code: 'native_version_not_characterized' };
    // Passive resolution selects the actual reviewed file; an unresolved or
    // missing selection must not silently use the host environment.
    if (selected.configPath === undefined) return { status: 'refused', kind: 'unavailable', code: 'native_configuration_unavailable' };
    const { readProjectDefinitionFile } = await import('../projectSetup/nativeDefinitionFiles.ts');
    const root = input.root ?? input.cwd;
    const config = await readProjectDefinitionFile(root, selected.configPath);
    if (input.signal?.aborted) return cancelled();
    if (config.kind !== 'read') return {
      status: 'refused', kind: 'unavailable',
      code: config.kind === 'refused' ? config.code : 'native_configuration_unavailable',
    };
    const configPath = resolve(root, selected.configPath.replaceAll('\\', '/'));
    const envInput = { ...input.env };
    // Native activation may move to its config root and print hook diagnostics.
    // Restore the actual launch cwd with literal argv, then frame the complete
    // export so diagnostics cannot become environment keys. This is a fixed
    // probe, not the consumer's launch command or a second native producer.
    const marker = '\0HAPPIER_NATIVE_ENV_V1\0';
    const probe = ['/bin/sh', '-c', 'cd "$1" && printf "\\000HAPPIER_NATIVE_ENV_V1\\000" && exec /usr/bin/env -0', 'happier-native-environment', input.cwd];
    const probeCommand = probe.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');
    let args: readonly string[];
    switch (selected.tool) {
      case 'mise':
        envInput.MISE_OVERRIDE_CONFIG_FILENAMES = configPath;
        args = ['exec', '--', '/usr/bin/env', '-0'];
        break;
      case 'devbox':
        if (basename(configPath) !== 'devbox.json') return { status: 'refused', kind: 'unsupported', code: 'native_configuration_not_characterized' };
        // Devbox 0.18.4 RunScript evals its command and double-quotes each
        // additional arg, expanding $/backticks inside them. Supply the fully
        // shell-quoted fixed probe as the command itself, with no extra args.
        args = ['run', '--config', dirname(configPath), '--', probeCommand];
        break;
      case 'devenv':
        if (basename(configPath) !== 'devenv.nix') return { status: 'refused', kind: 'unsupported', code: 'native_configuration_not_characterized' };
        args = ['--from', `path:${dirname(configPath)}`, 'shell', '--', ...probe];
        break;
      case 'flox':
        if (!configPath.endsWith('/.flox/env/manifest.toml')) return { status: 'refused', kind: 'unsupported', code: 'native_configuration_not_characterized' };
        // Direct exec skips Flox profiles. Shell-command activation includes
        // common/bash profiles; select the installed, characterized Linux shell.
        envInput.FLOX_SHELL = '/bin/bash';
        args = ['activate', '--dir', dirname(dirname(dirname(configPath))), '--no-start-services', '-c', probeCommand];
        break;
      case 'nix_flake':
        if (basename(configPath) !== 'flake.nix') return { status: 'refused', kind: 'unsupported', code: 'native_configuration_not_characterized' };
        args = ['--extra-experimental-features', 'nix-command flakes', 'develop', `path:${dirname(configPath)}`, '--command', ...probe];
        break;
    }
    const output = await input.io.run({
      command: tool.executablePath,
      args: [...(tool.args ?? []), ...args],
      cwd: input.cwd,
      env: envInput,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (input.signal?.aborted) return cancelled();
    if (output.exitCode !== 0) return { status: 'refused', kind: 'native_failed', code: 'native_toolchain_failed' };
    // env -0 exports the full environment, including native unset semantics.
    // Shell/JSON export plans alone omit hooks and/or native removals.
    const markerOffset = output.stdout.indexOf(marker);
    if (selected.tool !== 'mise' && markerOffset < 0) return { status: 'refused', kind: 'native_failed', code: 'native_toolchain_invalid' };
    const stdout = selected.tool === 'mise' ? output.stdout : output.stdout.slice(markerOffset + marker.length);
    const env: Record<string, string> = Object.create(null);
    if (stdout !== '' && !stdout.endsWith('\0')) {
      return { status: 'refused', kind: 'native_failed', code: 'native_toolchain_invalid' };
    }
    for (const entry of stdout === '' ? [] : stdout.slice(0, -1).split('\0')) {
      const separator = entry.indexOf('=');
      if (separator <= 0) return { status: 'refused', kind: 'native_failed', code: 'native_toolchain_invalid' };
      env[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
    return { status: 'ready', env: Object.freeze(env) };
  } catch (error) {
    preserveUnconfirmedProcessCustody(error);
    const isolationRefusal = readIsolationRefusal(error);
    if (isolationRefusal && !input.signal?.aborted) return isolationRefusal;
    // Native diagnostics may contain secret values; the owning operation may
    // retain safe output separately, never in launch refusal/Action results.
    return input.signal?.aborted ? cancelled() : { status: 'refused', kind: 'native_failed', code: 'native_toolchain_failed' };
  }
}
