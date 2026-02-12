import { sanitizeBugReportArtifactPath } from './sanitize.js';

export type BugReportMachineDaemonStateLike = {
  daemonLogPath?: string | null;
  [key: string]: unknown;
};

export type BugReportMachineDaemonLogLike = {
  path?: string | null;
  [key: string]: unknown;
};

export type BugReportMachineRuntimeLike = {
  cwd?: string | null;
  [key: string]: unknown;
};

export type BugReportMachineStackContextLike = {
  stackName?: string | null;
  stackEnvPath?: string | null;
  runtimeStatePath?: string | null;
  logCandidates?: string[];
};

export type BugReportMachineDiagnosticsLike = {
  daemonState: BugReportMachineDaemonStateLike | null;
  daemonLogs: BugReportMachineDaemonLogLike[];
  runtime: BugReportMachineRuntimeLike;
  stackContext?: BugReportMachineStackContextLike | null;
};

export function sanitizeBugReportDaemonDiagnosticsPayload(input: BugReportMachineDiagnosticsLike): {
  daemonState: Record<string, unknown> | null;
  daemonLogs: Array<Record<string, unknown>>;
  runtime: Record<string, unknown>;
} {
  return {
    daemonState: input.daemonState
      ? {
          ...input.daemonState,
          daemonLogPath: sanitizeBugReportArtifactPath(input.daemonState.daemonLogPath as string | null | undefined),
        }
      : null,
    daemonLogs: input.daemonLogs.map((entry) => ({
      ...entry,
      path: sanitizeBugReportArtifactPath(entry.path as string | null | undefined),
    })),
    runtime: {
      ...input.runtime,
      cwd: sanitizeBugReportArtifactPath(input.runtime.cwd as string | null | undefined),
    },
  };
}

export function sanitizeBugReportStackContextPayload(input: BugReportMachineStackContextLike): {
  stackName: string | null;
  stackEnvPath: string | null;
  runtimeStatePath: string | null;
  logCandidates: string[];
} {
  return {
    stackName: input.stackName ?? null,
    stackEnvPath: sanitizeBugReportArtifactPath(input.stackEnvPath),
    runtimeStatePath: sanitizeBugReportArtifactPath(input.runtimeStatePath),
    logCandidates: (input.logCandidates ?? [])
      .map((entry) => sanitizeBugReportArtifactPath(entry))
      .filter((entry): entry is string => Boolean(entry)),
  };
}
