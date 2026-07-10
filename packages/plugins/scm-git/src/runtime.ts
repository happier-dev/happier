import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import path from 'node:path';

import {
  resolveScmBackendCommandMaxOutputBytes,
  runScmBackendCommand,
  ScmSelectedMutationPathSchema,
} from '@happier-dev/plugin-sdk/scm';

const SAFE_GIT_ALLOW_PROTOCOL = 'https:ssh:git:file';

export type ScmExecResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  outputLimitExceeded?: boolean;
};

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
  maxOutputBytes?: number;
  env?: Record<string, string | undefined>;
}): Promise<ScmExecResult> {
  return runScmBackendCommand({
    installableKey: 'dep.git',
    command: input.bin,
  }, {
    cwd: input.cwd,
    args: input.args,
    timeoutMs: input.timeoutMs,
    stdin: input.stdin,
    maxOutputBytes: resolveScmMaxOutputBytes(input.maxOutputBytes),
    env: {
      ...(input.env ?? {}),
      GIT_ALLOW_PROTOCOL: SAFE_GIT_ALLOW_PROTOCOL,
    },
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
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
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
  const trimmed = String(rawPath ?? '').trim();
  if (!trimmed) return { ok: false, error: 'Path cannot be empty' };
  if (trimmed.includes('\0')) return { ok: false, error: 'Path contains null bytes' };
  if (trimmed.startsWith('-')) return { ok: false, error: 'Path cannot start with "-"' };
  if (trimmed.startsWith(':')) return { ok: false, error: 'Path contains unsupported syntax' };
  if (isAbsolute(trimmed)) return { ok: false, error: 'Absolute paths are not supported' };

  const normalized = trimmed.split(sep).join('/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..')) {
    return { ok: false, error: `Path contains unsupported ".." segment: ${rawPath}` };
  }
  if (!normalized || normalized === '.') return { ok: true, relativePath: '.', pathspec: ':(top).' };
  return { ok: true, relativePath: normalized, pathspec: `:(top)${normalized}` };
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
