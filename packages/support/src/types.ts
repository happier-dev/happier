export type SupportInventoryEntry = Readonly<{
  id: string;
  label: string;
  kind?: string;
  path?: string | null;
  version?: string | null;
  ring?: string | null;
  status?: string | null;
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
  installations: readonly SupportInventoryEntry[];
  services: readonly SupportInventoryEntry[];
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
