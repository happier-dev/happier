import { basename, dirname, join, resolve } from 'node:path';

import {
  canonicalizeOhMyPiExternalSessionsPath,
  resolveConfiguredOhMyPiAgentDir,
} from '../surfaces/sessions/external/source.js';

export const OH_MY_PI_TERMINAL_BREADCRUMB_SUBDIR = 'terminal-sessions';
export const OH_MY_PI_TERMINAL_SESSIONS_SUBDIR = 'sessions';

export type ResolveOhMyPiTerminalRuntimeBreadcrumbParams = Readonly<{
  cwd: string;
  env?: NodeJS.ProcessEnv;
  terminalId?: string | null;
}>;

export type OhMyPiTerminalRuntimeBreadcrumb = Readonly<{
  agentDir: string;
  breadcrumbCwd: string;
  sessionFilePath: string;
  remoteSessionId: string;
  env: NodeJS.ProcessEnv;
}>;

export type ProjectOhMyPiTerminalRuntimeBreadcrumbParams = Readonly<{
  input: ResolveOhMyPiTerminalRuntimeBreadcrumbParams;
  agentDir: string;
  breadcrumbCwd: string;
  sessionFilePath: string;
  remoteSessionId: string;
}>;

export function parseOhMyPiTerminalRuntimeSessionId(sessionFilePath: string): string | null {
  const fileName = basename(sessionFilePath);
  if (!fileName.endsWith('.jsonl')) {
    return null;
  }

  const stem = fileName.slice(0, -'.jsonl'.length);
  const separatorIndex = stem.indexOf('_');
  if (separatorIndex === -1 || separatorIndex === stem.length - 1) {
    return null;
  }

  const remoteSessionId = stem.slice(separatorIndex + 1).trim();
  return remoteSessionId.length > 0 ? remoteSessionId : null;
}

export function canonicalizeOhMyPiTerminalRuntimePath(rawPath: string): string {
  const resolvedPath = resolve(rawPath);
  const canonicalPath = canonicalizeOhMyPiExternalSessionsPath(resolvedPath);
  if (canonicalPath !== resolvedPath) return canonicalPath;

  const canonicalDirectory = canonicalizeOhMyPiExternalSessionsPath(dirname(resolvedPath));
  return join(canonicalDirectory, basename(resolvedPath));
}

export function resolveOhMyPiTerminalRuntimeAgentDir(
  input: ResolveOhMyPiTerminalRuntimeBreadcrumbParams,
): string {
  return resolveConfiguredOhMyPiAgentDir(input.env ?? process.env);
}

export function isOhMyPiTerminalRuntimeCwdMatch(
  candidateCwd: string,
  input: ResolveOhMyPiTerminalRuntimeBreadcrumbParams,
): boolean {
  return resolve(candidateCwd) === canonicalizeOhMyPiTerminalRuntimePath(input.cwd);
}

export function projectOhMyPiTerminalRuntimeBreadcrumb(
  params: ProjectOhMyPiTerminalRuntimeBreadcrumbParams,
): OhMyPiTerminalRuntimeBreadcrumb {
  return {
    agentDir: params.agentDir,
    breadcrumbCwd: params.breadcrumbCwd,
    sessionFilePath: params.sessionFilePath,
    remoteSessionId: params.remoteSessionId,
    env: params.input.env ?? process.env,
  };
}
