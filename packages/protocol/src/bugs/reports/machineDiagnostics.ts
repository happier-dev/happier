import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { DoctorSnapshotSchema, type DoctorSnapshot } from '../../diagnostics/doctorSnapshot.js';

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
  logCandidates?: readonly string[];
};

export type BugReportMachineDiagnosticsLike = {
  daemonState: BugReportMachineDaemonStateLike | null;
  daemonLogs: readonly BugReportMachineDaemonLogLike[];
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

export const BugReportLogSelectionSchema = lazyZodSchema(() => z.object({ daemon: z.boolean(), session: z.boolean(), provider: z.boolean() }));
export type BugReportLogSelection = z.infer<typeof BugReportLogSelectionSchema>;
export const BUG_REPORT_LOG_SOURCE_KINDS = { daemon: 'daemon', session: 'session-log', provider: 'provider-transcript' } as const;
export function resolveBugReportLogSelection(input?: Partial<BugReportLogSelection>): BugReportLogSelection {
  return { daemon: input?.daemon !== false, session: input?.session !== false, provider: input?.provider === true };
}
export const BugReportDiagnosticsRequestSchema = lazyZodSchema(() => z.looseObject({
  sessionId: z.optional(z.string()), logSelection: z.optional(z.partial(BugReportLogSelectionSchema)),
}));
export type BugReportDiagnosticsRequest = z.infer<typeof BugReportDiagnosticsRequestSchema>;
export const BugReportSessionDiagnosticsSchema = lazyZodSchema(() => z.object({
  context: z.object({ sessionId: z.string(), machineId: z.optional(z.string()), provider: z.optional(z.string()), metadataStatus: z.enum(['available', 'unavailable', 'wrong-machine']) }),
  logs: z.array(z.object({
    kind: z.enum(['daemon', 'session', 'provider']), status: z.enum(['collected', 'unavailable', 'disabled']), detail: z.optional(z.string()),
    artifact: z.optional(z.object({ filename: z.string(), sourceKind: z.string(), contentType: z.string(), content: z.string() })),
  })),
}));
export type BugReportSessionDiagnostics = z.infer<typeof BugReportSessionDiagnosticsSchema>;
export const BugReportMachineDiagnosticsSnapshotSchema = lazyZodSchema(() => z.object({
  daemonState: z.nullable(z.object({ pid: z.number(), httpPort: z.number(), startedAt: z.number(), startedWithCliVersion: z.string(), hasControlToken: z.boolean(), daemonLogPath: z.nullable(z.string()), machineId: z.optional(z.string()) })),
  daemonLogs: z.array(z.object({ file: z.string(), path: z.string(), modifiedAt: z.string() })),
  doctorSnapshot: z.nullable(DoctorSnapshotSchema),
  runtime: z.object({ cwd: z.string(), platform: z.string(), nodeVersion: z.string() }),
  stackContext: z.nullable(z.object({ stackName: z.nullable(z.string()), stackEnvPath: z.nullable(z.string()), runtimeStatePath: z.nullable(z.string()), runtimeState: z.nullable(z.string()), logCandidates: z.array(z.string()) })),
  sessionDiagnostics: z.optional(BugReportSessionDiagnosticsSchema),
}));

export type BugReportMachineDiagnosticsSnapshot = Readonly<{
  sessionDiagnostics?: BugReportSessionDiagnostics;
  daemonState: Readonly<{
    pid: number;
    httpPort: number;
    startedAt: number;
    startedWithCliVersion: string;
    hasControlToken: boolean;
    daemonLogPath: string | null;
    machineId?: string;
  }> | null;
  daemonLogs: ReadonlyArray<Readonly<{ file: string; path: string; modifiedAt: string }>>;
  doctorSnapshot: DoctorSnapshot | null;
  runtime: Readonly<{ cwd: string; platform: string; nodeVersion: string }>;
  stackContext: Readonly<{
    stackName: string | null;
    stackEnvPath: string | null;
    runtimeStatePath: string | null;
    runtimeState: string | null;
    logCandidates: ReadonlyArray<string>;
  }> | null;
}>;
