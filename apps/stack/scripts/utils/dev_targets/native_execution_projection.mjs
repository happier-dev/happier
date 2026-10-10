import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadDevTargetsConfig, parseDevTargetsConfig, resolveDevTargetExecutionPolicy } from './config.mjs';
import { resolveRepoStackIdentity, resolveStacksStorageRoot } from '../stack/repo_stack_identity.mjs';
import { resolveDevTargetServicePlans } from './service_placement.mjs';
import { resolveMutagenSessionName } from './mutagen_project.mjs';
import { renderNativeCommandPolicy } from './remote_commands.mjs';
import { renderNativeSyncReadinessPolicy, resolveDevTargetMutagenRuntime } from './mutagen_runtime.mjs';
import {
  EXECUTION_PROVENANCE_FILENAME,
  EXECUTION_PROVENANCE_SCHEMA_VERSION,
} from './execution_provenance.mjs';

function shellQuote(value) {
  return `'${String(value ?? '').replaceAll("'", `'"'"'`)}'`;
}

function assignment(name, value) {
  return `${name}=${shellQuote(value)}`;
}

export function resolveCommandRepositoryConfig(config, { repoRoot, executorRepoRoot, commandExecution, runtimeConfig } = {}) {
  const normalized = parseDevTargetsConfig(config);
  if (resolve(repoRoot) === resolve(executorRepoRoot)) return normalized;
  if (!isAbsolute(repoRoot) || dirname(resolve(repoRoot)) !== dirname(resolve(executorRepoRoot))) {
    throw new Error('[dev-targets] --repo must identify an absolute sibling checkout');
  }
  const name = basename(repoRoot);
  const defaults = ['mac2-linux', 'windows2-linux'].filter(name => normalized.targets.some(target => target.name === name && target.platform === 'posix'));
  // Automatic commands use workers; explicit sibling service placements
  // retain their own endpoints in the same canonical synchronization project.
  const requested = commandExecution ?? (defaults.length ? { mode: 'auto', targets: defaults, fallback: 'local' } : { mode: 'local' });
  const commands = requested.mode === 'auto'
    ? { ...requested, targets: requested.targets.filter(target => target !== 'mac-host') }
    : requested.mode === 'prefer-target' && requested.target === 'mac-host'
      ? { mode: 'local' }
      : requested;
  if (commands.mode === 'auto' && commands.targets.length === 0) {
    throw new Error('[dev-targets] sibling command routing requires a worker target; mac-host command mirrors were withdrawn');
  }
  const runtime = parseDevTargetsConfig(runtimeConfig ?? { version: 3, targets: [] });
  const runtimePolicy = resolveDevTargetExecutionPolicy(runtime);
  const services = resolveDevTargetServicePlans({
    targets: runtime.targets, policy: { ...runtimePolicy, commands: { mode: 'local' } },
    requested: { server: true, expo: true, daemon: true },
  }).targets;
  const targets = new Map(normalized.targets.filter(target => target.platform === 'posix' && target.name !== 'mac-host')
    .map(target => [target.name, { ...target, executorRepoDir: target.repoDir,
      repoDir: posix.join(posix.dirname(target.repoDir), name) }]));
  for (const { target } of services) {
    targets.set(target.name, { ...target,
      executorRepoDir: normalized.targets.find(parent => parent.name === target.name)?.repoDir ?? target.repoDir });
  }
  return parseDevTargetsConfig({
    version: 3, targets: [...targets.values()],
    runtimePlacement: { server: runtimePolicy.server, expo: runtimePolicy.expo, daemon: runtimePolicy.daemons },
    commandExecution: commands,
  });
}

export function renderNativeExecutionProjection(config, { repoRoot = '', executorRepoRoot = null, stackBaseDir = '.', env = process.env } = {}) {
  const normalized = executorRepoRoot
    ? resolveCommandRepositoryConfig(config, { repoRoot, executorRepoRoot })
    : parseDevTargetsConfig(config);
  const policy = resolveDevTargetExecutionPolicy(normalized).commands;
  const selectedNames = policy.mode === 'auto'
    ? new Set(policy.targets)
    : policy.mode === 'prefer-target'
      ? new Set([policy.target])
      : new Set();
  const targets = normalized.targets.filter((target) => target.platform === 'posix');
  const syncRuntime = resolveDevTargetMutagenRuntime({ stackBaseDir, sourceDir: repoRoot || undefined, env });
  const lines = [
    assignment('HSTACK_EXEC_PROJECTION_VERSION', '2'),
    assignment('projection_repo_root', repoRoot),
    assignment('projection_mutagen_data_dir', syncRuntime.dataDir),
    assignment('projection_mutagen_ssh_path', syncRuntime.opensshDir),
    assignment('command_mode', policy.mode),
    assignment('include_local', policy.includeLocal === true ? '1' : '0'),
    assignment('fallback_mode', policy.fallback ?? 'local'),
    assignment('load_ttl_seconds', Math.max(1, Math.ceil((policy.loadProbeTtlMs ?? 15000) / 1000))),
    assignment('unavailable_ttl_seconds', Math.max(1, Math.ceil((policy.unavailableProbeTtlMs ?? 120000) / 1000))),
    assignment('execution_provenance_schema_version', EXECUTION_PROVENANCE_SCHEMA_VERSION),
    assignment('execution_provenance_filename', EXECUTION_PROVENANCE_FILENAME),
    assignment('target_count', targets.length),
  ];
  targets.forEach((target, index) => {
    const prefix = `target_${index + 1}`;
    lines.push(
      assignment(`${prefix}_name`, target.name),
      assignment(`${prefix}_sync_name`, resolveMutagenSessionName(target.name, repoRoot || undefined)),
      assignment(`${prefix}_ssh`, target.ssh),
      assignment(`${prefix}_ssh_config`, target.sshConfigFile ?? ''),
      assignment(`${prefix}_repo_dir`, target.repoDir),
      assignment(`${prefix}_executor_repo_dir`, target.executorRepoDir ?? target.repoDir),
      assignment(`${prefix}_cli_home`, target.cliHomeDir),
      assignment(`${prefix}_remote_path`, target.remotePath?.join(':') ?? ''),
      assignment(`${prefix}_automatic`, selectedNames.has(target.name) ? '1' : '0'),
    );
  });
  return `${lines.join('\n')}\n`;
}

export async function prepareCommandRepository({ configPath, repoRoot, executorRepoRoot, synchronize = true, env = process.env }) {
  const repository = resolve(repoRoot);
  // Source identity must be checked before creating a replica or state directory.
  await readFile(join(repository, 'package.json'), 'utf8');
  await readFile(join(repository, 'yarn.lock'), 'utf8');
  const parentConfig = JSON.parse(await readFile(configPath, 'utf8'));
  // Keep Mutagen's Unix socket below the platform path limit just as the
  // producer stack does; an extra directory ladder can exceed it here.
  const directory = join(dirname(configPath), `commands-${basename(repository)}`);
  const path = join(directory, 'dev-targets.json');
  const previous = await readFile(path, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const identity = resolveRepoStackIdentity({ repoRoot: repository,
    stacksStorageRoot: resolveStacksStorageRoot(env), createIfMissing: false });
  const runtime = await loadDevTargetsConfig({ path: join(identity.stackBaseDir, 'dev-targets.json'), env, allowMissing: true });
  const config = resolveCommandRepositoryConfig(parentConfig, {
    repoRoot: repository, executorRepoRoot, runtimeConfig: runtime.config,
    commandExecution: previous ? JSON.parse(previous).commandExecution : undefined,
  });
  const contents = `${JSON.stringify(config, null, 2)}\n`;
  if (previous !== contents) {
    await mkdir(directory, { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, path);
  }
  const outputPath = join(directory, 'dev-target-exec-v1.sh');
  await writeNativeExecutionProjection({ configPath: path, outputPath, repoRoot: repository, skipUnchanged: true, env });
  const syncTargets = resolveDevTargetServicePlans({ targets: config.targets,
    policy: resolveDevTargetExecutionPolicy(config), requested: { server: true, expo: true, daemon: true },
  }).targets.map(plan => plan.target);
  if (synchronize && syncTargets.length > 0) {
    const targets = syncTargets;
    const { prepareDevTargetCommandSync } = await import('./sync_service.mjs');
    await prepareDevTargetCommandSync({ stackBaseDir: directory, sourceDir: repository, targets, env });
  }
  return { path, outputPath, config };
}

export async function writeNativeExecutionProjection({ configPath, outputPath, repoRoot = '', skipUnchanged = false, env = process.env }) {
  const raw = JSON.parse(await readFile(configPath, 'utf8'));
  const rendered = renderNativeExecutionProjection(raw, { repoRoot, stackBaseDir: dirname(configPath), env });
  // Sibling dispatch can run with read-only stack storage. Regular projection
  // refreshes still advance mtime, which the native launcher uses for freshness.
  if (skipUnchanged) {
    const previous = await readFile(outputPath, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (previous === rendered) return;
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporary, rendered, { mode: 0o600 });
  await rename(temporary, outputPath);
}

async function main() {
  if (process.argv[2] === '--write-sync-policy') {
    await writeFile(new URL('./native_sync_readiness.sh', import.meta.url), renderNativeSyncReadinessPolicy());
    return;
  }
  if (process.argv[2] === '--prepare-command-repository') {
    const [configPath, executorRepoRoot, repoRoot] = process.argv.slice(3);
    await prepareCommandRepository({ configPath, executorRepoRoot, repoRoot });
    return;
  }
  if (process.argv[2] === '--write-command-policy') {
    await writeFile(new URL('./native_command_policy.sh', import.meta.url), renderNativeCommandPolicy());
    return;
  }
  const [configPath, outputPath, repoRoot = ''] = process.argv.slice(2);
  if (!configPath || !outputPath) {
    throw new Error('usage: native_execution_projection.mjs CONFIG_PATH OUTPUT_PATH');
  }
  await writeNativeExecutionProjection({ configPath, outputPath, repoRoot });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
