export type ServiceDiscoveryScope = 'user' | 'system';

export type ServiceDefinitionKind = 'launchd-plist' | 'systemd-unit' | 'windows-wrapper-ps1';

export type ServiceDiscoveryRoot = Readonly<{
  path: string;
  scope: ServiceDiscoveryScope;
}>;

export type ServiceDefinitionFile = Readonly<{
  path: string;
  scope: ServiceDiscoveryScope;
  kind: ServiceDefinitionKind;
  label: string;
}>;

export type ParsedLaunchdPlist = Readonly<{
  kind: 'launchd-plist';
  label: string;
  programArgs: readonly string[];
  env: Readonly<Record<string, string>>;
  workingDirectory: string | null;
  stdoutPath: string | null;
  stderrPath: string | null;
  runAtLoad: boolean;
  keepAliveOnFailure: boolean;
  startIntervalSec: number | null;
  startCalendarInterval: Readonly<{ hour: number; minute: number } | null>;
}>;

export type ParsedSystemdUnit = Readonly<{
  kind: 'systemd-unit';
  label: string;
  description: string;
  programArgs: readonly string[];
  env: Readonly<Record<string, string>>;
  workingDirectory: string | null;
  runAsUser: string | null;
  stdoutPath: string | null;
  stderrPath: string | null;
  restart: string | null;
  wantedBy: string | null;
}>;

export type ParsedWindowsScheduledTaskWrapperPs1 = Readonly<{
  kind: 'windows-wrapper-ps1';
  label: string;
  workingDirectory: string | null;
  programArgs: readonly string[];
  env: Readonly<Record<string, string>>;
  stdoutPath: string | null;
  stderrPath: string | null;
}>;

export type LaunchdLoadedStatus = Readonly<{
  state: 'loaded' | 'unloaded' | 'unknown';
  pid: number | null;
  lastExitStatus: number | null;
  label: string | null;
}>;

export type SystemdUnitStatus = Readonly<{
  loadState: string | null;
  activeState: string | null;
  subState: string | null;
  result: string | null;
  execMainStatus: number | null;
  nRestarts: number | null;
  unitFileState: string | null;
  fragmentPath: string | null;
  mainPid: number | null;
}>;

export type ScheduledTaskStatus = Readonly<{
  taskName: string | null;
  scheduledTaskState: string | null;
  status: string | null;
  enabled: boolean | null;
  running: boolean | null;
  lastRunTime: string | null;
  nextRunTime: string | null;
  lastResult: number | null;
  taskToRun: string | null;
}>;
