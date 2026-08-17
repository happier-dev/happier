import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseDevTargetsConfig, resolveDevTargetExecutionPolicy } from './config.mjs';
import { REMOTE_DEPENDENCY_ADMISSION } from './remote_commands.mjs';

function shellQuote(value) {
  return `'${String(value ?? '').replaceAll("'", `'"'"'`)}'`;
}

function assignment(name, value) {
  return `${name}=${shellQuote(value)}`;
}

export function renderNativeExecutionProjection(config, { repoRoot = '' } = {}) {
  const normalized = parseDevTargetsConfig(config);
  const policy = resolveDevTargetExecutionPolicy(normalized).commands;
  const selectedNames = policy.mode === 'auto'
    ? new Set(policy.targets)
    : policy.mode === 'prefer-target'
      ? new Set([policy.target])
      : new Set();
  const targets = normalized.targets.filter((target) => (
    target.platform === 'posix' && selectedNames.has(target.name)
  ));
  const lines = [
    assignment('HSTACK_EXEC_PROJECTION_VERSION', '2'),
    assignment('projection_repo_root', repoRoot),
    assignment('command_mode', policy.mode),
    assignment('include_local', policy.includeLocal === true ? '1' : '0'),
    assignment('fallback_mode', policy.fallback ?? 'local'),
    assignment('load_ttl_seconds', Math.max(1, Math.ceil((policy.loadProbeTtlMs ?? 15000) / 1000))),
    assignment('unavailable_ttl_seconds', Math.max(1, Math.ceil((policy.unavailableProbeTtlMs ?? 120000) / 1000))),
    assignment('dependency_direct_commands', REMOTE_DEPENDENCY_ADMISSION.directCommands.join(' ')),
    assignment('dependency_corepack_subcommands', REMOTE_DEPENDENCY_ADMISSION.corepackSubcommands.join(' ')),
    assignment('target_count', targets.length),
  ];
  targets.forEach((target, index) => {
    const prefix = `target_${index + 1}`;
    lines.push(
      assignment(`${prefix}_name`, target.name),
      assignment(`${prefix}_ssh`, target.ssh),
      assignment(`${prefix}_ssh_config`, target.sshConfigFile ?? ''),
      assignment(`${prefix}_repo_dir`, target.repoDir),
      assignment(`${prefix}_cli_home`, target.cliHomeDir),
      assignment(`${prefix}_remote_path`, target.remotePath?.join(':') ?? ''),
    );
  });
  return `${lines.join('\n')}\n`;
}

export async function writeNativeExecutionProjection({ configPath, outputPath, repoRoot = '' }) {
  const raw = JSON.parse(await readFile(configPath, 'utf8'));
  const rendered = renderNativeExecutionProjection(raw, { repoRoot });
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporary, rendered, { mode: 0o600 });
  await rename(temporary, outputPath);
}

async function main() {
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
