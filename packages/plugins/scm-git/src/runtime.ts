import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import path from 'node:path';

import {
  type BackendCommandRunInput,
  type BackendCommandStreamInput,
  resolveBackendCommandMaxOutputBytes as resolveScmBackendCommandMaxOutputBytes,
  runBackendCommand as runScmBackendCommand } from '@happier-dev/plugin-sdk/scm/backend';
import {
  SCM_OPERATION_ERROR_CODES,
  ScmSelectedMutationPathSchema,
  type ScmOperationErrorCode,
} from '@happier-dev/plugin-sdk/scm';
import { isCanonicalAbsolutePathInsideRoot } from '@happier-dev/plugin-sdk/fs';

import { toRepoRootLiteralPathspec } from './literalPathspec.js';
import { GIT_INSTALLABLE_DEP_ID } from './installables/gitInstallable.js';

const SAFE_GIT_ALLOW_PROTOCOL = 'https:ssh:git:file';

export type ScmExecResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  outputLimitExceeded?: boolean;
  stoppedEarly?: boolean;
};

export function getScmCommandIndeterminateErrorCode(result: ScmExecResult): ScmOperationErrorCode | null {
  if (result.timedOut) return SCM_OPERATION_ERROR_CODES.COMMAND_TIMEOUT;
  if (result.outputLimitExceeded) return SCM_OPERATION_ERROR_CODES.COMMAND_OUTPUT_LIMIT_EXCEEDED;
  if (result.exitCode < 0) return SCM_OPERATION_ERROR_CODES.COMMAND_OUTCOME_UNKNOWN;
  return null;
}

function resolveScmMaxOutputBytes(inputMaxOutputBytes: number | undefined): number {
  return resolveScmBackendCommandMaxOutputBytes({
    inputMaxOutputBytes,
    envValue: process.env.HAPPIER_SCM_MAX_OUTPUT_BYTES,
  });
}

export function runScmCommand(input: {
  bin: 'git';
  cwd: string;
  args: string[];
  timeoutMs?: number;
  stdin?: string;
  stdinInteraction?: BackendCommandRunInput['stdinInteraction'];
  maxOutputBytes?: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  stdoutConsumer?: BackendCommandStreamInput['stdoutConsumer'];
}): Promise<ScmExecResult> {
  return runScmBackendCommand({
    installableKey: GIT_INSTALLABLE_DEP_ID,
    command: input.bin,
  }, {
    cwd: input.cwd,
    args: input.args,
    timeoutMs: input.timeoutMs,
    stdin: input.stdin,
    stdinInteraction: input.stdinInteraction,
    maxOutputBytes: resolveScmMaxOutputBytes(input.maxOutputBytes),
    env: {
      ...(input.env ?? {}),
      GIT_ALLOW_PROTOCOL: SAFE_GIT_ALLOW_PROTOCOL,
    },
    signal: input.signal,
    ...(input.stdoutConsumer ? { stdoutConsumer: input.stdoutConsumer } : {}),
  });
}

function validateContainedPath(rawPath: string, cwd: string): { ok: true; relativePath: string } | { ok: false; error: string } {
  const selectedPath = ScmSelectedMutationPathSchema.safeParse(rawPath);
  if (!selectedPath.success) {
    return { ok: false, error: 'Path must identify a file or subdirectory' };
  }
  const canonicalCwd = (() => {
    try {
      return realpathSync(path.resolve(cwd));
    } catch {
      return path.resolve(cwd);
    }
  })();
  const resolvedPath = path.resolve(canonicalCwd, rawPath);
  const rel = relative(canonicalCwd, resolvedPath);
  if (!isCanonicalAbsolutePathInsideRoot(canonicalCwd, resolvedPath)) {
    return { ok: false, error: `Path outside working directory: ${rawPath}` };
  }
  return { ok: true, relativePath: rel === '' ? '.' : rel.split(sep).join('/') };
}

export function normalizePathspec(rawPath: string, cwd: string): { ok: true; pathspec: string } | { ok: false; error: string } {
  const validation = validateContainedPath(rawPath, cwd);
  if (!validation.ok) return validation;
  if (validation.relativePath === '.') {
    return { ok: false, error: 'Path must identify a file or subdirectory' };
  }
  return { ok: true, pathspec: validation.relativePath };
}

export function normalizeRepoRootRelativePath(
  rawPath: string,
): { ok: true; relativePath: string; pathspec: string } | { ok: false; error: string } {
  const requestedPath = String(rawPath ?? '');
  if (!requestedPath.trim()) return { ok: false, error: 'Path cannot be empty' };
  if (requestedPath.includes('\0')) return { ok: false, error: 'Path contains null bytes' };
  if (requestedPath.startsWith('-')) return { ok: false, error: 'Path cannot start with "-"' };
  if (requestedPath.startsWith(':')) return { ok: false, error: 'Path contains unsupported syntax' };
  if (isAbsolute(requestedPath)) return { ok: false, error: 'Absolute paths are not supported' };

  const normalized = requestedPath.split(sep).join('/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..')) {
    return { ok: false, error: `Path contains unsupported ".." segment: ${rawPath}` };
  }
  if (!normalized || normalized === '.') return { ok: true, relativePath: '.', pathspec: toRepoRootLiteralPathspec('.') };
  return { ok: true, relativePath: normalized, pathspec: toRepoRootLiteralPathspec(normalized) };
}

export function normalizeRepoRootPathspec(rawPath: string): { ok: true; pathspec: string } | { ok: false; error: string } {
  const normalized = normalizeRepoRootRelativePath(rawPath);
  if (!normalized.ok) return normalized;
  return { ok: true, pathspec: normalized.pathspec };
}

const SAFE_COMMIT_REF_REGEX = /^(?:[0-9a-fA-F]{7,64}|[A-Za-z0-9._/-]+)$/;

export function normalizeCommitRef(rawCommit: string): { ok: true; commit: string } | { ok: false; error: string } {
  const commit = rawCommit.trim();
  if (!commit) return { ok: false, error: 'Commit reference cannot be empty' };
  if (/\s/.test(commit)) return { ok: false, error: 'Commit reference must not contain whitespace' };
  if (commit.startsWith('-')) return { ok: false, error: 'Commit reference cannot start with "-"' };
  if (commit.startsWith('.') || commit.startsWith('/')) return { ok: false, error: 'Commit reference contains unsupported syntax' };
  if (commit.includes('..') || commit.includes('@{') || commit.includes(':')) return { ok: false, error: 'Commit reference contains unsupported syntax' };
  if (!SAFE_COMMIT_REF_REGEX.test(commit)) return { ok: false, error: 'Commit reference contains invalid characters' };
  return { ok: true, commit };
}
