import type { HappyCliSubprocessLaunchSpec } from '../../utils/spawnHappyCLI';
import { buildHappyCliSubprocessLaunchSpec } from '../../utils/spawnHappyCLI';
import { normalizeProcessCommandPathValue } from '../../subprocess/processCommandPathMatch';

import type {
  SessionRunnerEntrypointIdentity,
  SessionRunnerEntrypointIdentitySource,
  UnknownSessionRunnerEntrypointIdentity,
} from './types';

function unknownIdentity(reason: UnknownSessionRunnerEntrypointIdentity['reason']): SessionRunnerEntrypointIdentity {
  return { status: 'unknown', source: 'unknown', reason };
}

function normalizePathLike(value: string): string {
  const separatorNormalized = value.trim().replaceAll('\\', '/');
  const isUncPath = separatorNormalized.startsWith('//');
  const collapsed = separatorNormalized.replace(/\/+/g, '/');
  return isUncPath ? `/${collapsed}` : collapsed;
}

function normalizeComparablePath(value: string): string {
  return normalizeProcessCommandPathValue(normalizePathLike(value));
}

function tokenizeCommandLine(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const char of command) {
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function isMutableEntrypointPointer(pathLike: string): boolean {
  const normalized = normalizePathLike(pathLike).toLowerCase();
  return /(?:^|\/)(current|previous)(?:\/|$)/.test(normalized);
}

function isCliEntrypointPath(pathLike: string): boolean {
  const normalized = normalizePathLike(pathLike).toLowerCase();
  return (
    normalized.endsWith('/package-dist/index.mjs') ||
    normalized.endsWith('/dist/index.mjs') ||
    normalized.endsWith('/src/index.ts')
    || /\/\.runner-snapshots\/[^/]+\/(?:(?:dist|package-dist)\/)?index\.mjs$/i.test(normalized)
  );
}

function isCliBinaryPath(pathLike: string): boolean {
  const base = normalizePathLike(pathLike).split('/').at(-1)?.toLowerCase() ?? '';
  return base === 'happier' || base === 'happier.exe';
}

function resolveVersion(pathLike: string): string | null {
  const normalized = normalizePathLike(pathLike);
  const match = /(?:^|\/)versions\/([^/]+)(?:\/|$)/i.exec(normalized);
  const version = match?.[1]?.trim() ?? '';
  return version || null;
}

function resolveSnapshotFingerprint(pathLike: string): string | null {
  const normalized = normalizePathLike(pathLike);
  const match = /(?:^|\/)\.runner-snapshots\/([^/]+)\/(?:(?:dist|package-dist)\/)?index\.mjs$/i.exec(normalized);
  const fingerprint = match?.[1]?.trim() ?? '';
  return fingerprint || null;
}

export function isGenerationAttestedComparableId(comparableId: string): boolean {
  return comparableId.startsWith('version:') || comparableId.startsWith('snapshot:');
}

function resolveRuntimeRoot(pathLike: string): string | null {
  const normalized = normalizeComparablePath(pathLike);
  for (const marker of ['/package-dist/', '/dist/', '/src/']) {
    const index = normalized.indexOf(marker);
    if (index > 0) return normalized.slice(0, index);
  }
  if (isCliBinaryPath(normalized)) {
    const parts = normalized.split('/');
    parts.pop();
    return parts.join('/') || null;
  }
  return null;
}

function resolveEntrypointPathIdentity(
  pathLike: string,
  source: Exclude<SessionRunnerEntrypointIdentitySource, 'structured_state' | 'unknown'>,
): SessionRunnerEntrypointIdentity {
  const normalized = normalizePathLike(pathLike);
  if (!normalized) return unknownIdentity('entrypoint_not_found');
  if (isMutableEntrypointPointer(normalized)) return unknownIdentity('mutable_entrypoint_pointer');

  const snapshotFingerprint = resolveSnapshotFingerprint(normalized);
  if (snapshotFingerprint) {
    return {
      status: 'known',
      source,
      comparableId: `snapshot:${snapshotFingerprint}`,
      entrypointVersion: null,
    };
  }

  const version = resolveVersion(normalized);
  if (version) {
    return {
      status: 'known',
      source,
      comparableId: `version:${version}`,
      entrypointVersion: version,
    };
  }

  const root = resolveRuntimeRoot(normalized);
  if (!root) return unknownIdentity('entrypoint_not_found');
  return {
    status: 'known',
    source,
    comparableId: `path:${root}`,
    entrypointVersion: null,
  };
}

function findEntrypointToken(tokens: readonly string[]): string | null {
  const candidates = tokens.filter((token) => isCliEntrypointPath(token) || isCliBinaryPath(token));
  return candidates.at(-1) ?? null;
}

export function resolveSessionRunnerEntrypointIdentityFromProcessCommand(
  processCommand: string | null | undefined,
): SessionRunnerEntrypointIdentity {
  const command = typeof processCommand === 'string' ? processCommand.trim() : '';
  if (!command) return unknownIdentity('empty_command');

  const entrypoint = findEntrypointToken(tokenizeCommandLine(command));
  if (!entrypoint) return unknownIdentity('entrypoint_not_found');
  return resolveEntrypointPathIdentity(entrypoint, 'process_command');
}

export function resolveEntrypointIdentityFromLaunchSpec(
  launchSpec: HappyCliSubprocessLaunchSpec | null | undefined,
): SessionRunnerEntrypointIdentity {
  if (!launchSpec) return unknownIdentity('empty_launch_spec');
  const entrypoint = findEntrypointToken([launchSpec.filePath, ...launchSpec.args]);
  if (!entrypoint) return unknownIdentity('entrypoint_not_found');
  return resolveEntrypointPathIdentity(entrypoint, 'launch_spec');
}

export function resolveCurrentSessionRunnerLaunchIdentity(): SessionRunnerEntrypointIdentity {
  try {
    return resolveEntrypointIdentityFromLaunchSpec(buildHappyCliSubprocessLaunchSpec(['daemon', 'start-sync']));
  } catch {
    return unknownIdentity('unsupported_launch_spec');
  }
}
