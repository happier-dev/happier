import type { PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

export type HappierInstallationSource =
  | 'firstPartyManaged'
  | 'selfHostManaged'
  | 'stackManaged'
  | 'fromSource'
  | 'npmGlobal'
  | 'pathBinary'
  | 'unknown';

export type HappierServicePlatform = 'darwin' | 'linux' | 'win32';
export type HappierServiceBackend =
  | 'launchd'
  | 'systemd-user'
  | 'systemd-system'
  | 'schtasks-user'
  | 'schtasks-system';
export type HappierServiceVerification = 'verified' | 'candidate';
export type HappierServiceTargetMode = 'pinned' | 'default-following';
export type HappierServiceType = 'daemon' | 'stack-service' | 'self-host-service';
export type HappierWarningSeverity = 'info' | 'warning' | 'error';

export type HappierInstallation = Readonly<{
  id: string;
  source: HappierInstallationSource;
  components: string[];
  ring: PublicReleaseRingLabel | null;
  version: string | null;
  path: string;
  realPath: string | null;
  shimName: string | null;
  onPath: boolean;
  managedRoot: string | null;
}>;

export type HappierActiveInvocation = Readonly<{
  path: string;
  realPath: string | null;
  invokerName: string | null;
  ring: PublicReleaseRingLabel | null;
  version: string | null;
  installationId: string | null;
}>;

export type HappierInstallationInventory = Readonly<{
  activeInvocation: HappierActiveInvocation | null;
  installations: HappierInstallation[];
}>;

export type HappierService = Readonly<{
  id: string;
  serviceType: HappierServiceType;
  platform: HappierServicePlatform;
  backend: HappierServiceBackend;
  label: string;
  targetMode?: HappierServiceTargetMode;
  verification: HappierServiceVerification;
  ring: PublicReleaseRingLabel | null;
  instanceId: string | null;
  scope: 'user' | 'system';
  definitionPath: string;
  executablePath: string | null;
  serverUrl?: string | null;
  publicServerUrl?: string | null;
  installed: boolean;
  running: boolean;
}>;

export type HappierServiceInventory = Readonly<{
  services: HappierService[];
}>;

export type HappierRuntimeWarning = Readonly<{
  code: string;
  severity: HappierWarningSeverity;
  message: string;
  repairCommands: string[];
}>;

export type HappierServiceRuntimeTargetKind =
  | 'installation'
  | 'stack-runtime'
  | 'source-checkout'
  | 'managed-js-runtime'
  | 'unmatched-executable';

export type HappierServiceRuntimeTarget = Readonly<{
  id: string;
  kind: HappierServiceRuntimeTargetKind;
  label: string;
  path: string;
  executablePath: string;
  installationId: string | null;
  installationPath: string | null;
}>;
