import type { DoctorSnapshot } from './doctorSnapshot.js';

export type BugReportMachineDiagnosticsSnapshot = Readonly<{
  daemonState: Readonly<{
    pid: number;
    httpPort: number;
    startedAt: number;
    startedWithCliVersion: string;
    hasControlToken: boolean;
    daemonLogPath: string | null;
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
