export type SupportInstallationEntry = Readonly<{
  id: string;
  label: string;
  kind: 'installation';
  path?: string | null;
  realPath?: string | null;
  version?: string | null;
  ring?: string | null;
  status?: string | null;
  shimName?: string | null;
  source?: string | null;
}>;

export type SupportServiceEntry = Readonly<{
  id: string;
  label: string;
  kind: string;
  targetMode?: string | null;
  path?: string | null;
  executablePath?: string | null;
  linkedInstallationId?: string | null;
  linkedInstallationPath?: string | null;
  linkedRuntimeTargetId?: string | null;
  linkedRuntimeTargetLabel?: string | null;
  linkedRuntimeTargetPath?: string | null;
  linkedRuntimeTargetCategory?: string | null;
  version?: string | null;
  ring?: string | null;
  status?: string | null;
  scope?: string | null;
  serverUrl?: string | null;
  publicServerUrl?: string | null;
}>;

export type SupportRuntimeTargetEntry = Readonly<{
  id: string;
  label: string;
  kind: 'runtime-target';
  category: string;
  path?: string | null;
  executablePath?: string | null;
  linkedServiceIds: readonly string[];
  linkedServiceLabels: readonly string[];
}>;

export type SupportWarning = Readonly<{
  code: string;
  title: string;
  severity: 'info' | 'warning' | 'error';
  details?: readonly string[];
}>;

export type SupportRuntimeInventory = Readonly<{
  invokedBinaryPath: string;
  invokedVersion: string | null;
  nodeVersion: string;
  platform: string;
  installations: readonly SupportInstallationEntry[];
  services: readonly SupportServiceEntry[];
  runtimeTargets: readonly SupportRuntimeTargetEntry[];
  warnings: readonly SupportWarning[];
  note?: string;
}>;

export type SupportReport = Readonly<{
  capturedAt: string;
  inventory: SupportRuntimeInventory;
}>;

export type SupportReportContext = Readonly<{
  now?: () => Date;
}>;
