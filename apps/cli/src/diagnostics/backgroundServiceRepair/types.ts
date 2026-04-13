import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import type { DaemonServiceListEntry } from '@/daemon/service/cli';
import type { DaemonServiceMode, DaemonServiceTargetMode } from '@/daemon/service/plan';

export type BackgroundServiceRepairPlan = Readonly<{
  currentReleaseChannel: PublicReleaseRingId;
  existingServices: readonly DaemonServiceListEntry[];
  actions: readonly BackgroundServiceRepairAction[];
  manualWarnings: readonly string[];
}>;

export type BackgroundServiceRepairAction =
  | Readonly<{
      kind: 'remove-service';
    service: Readonly<{
      id?: string;
      label: string;
      platform?: 'darwin' | 'linux' | 'win32';
      backend?: 'launchd' | 'systemd-user' | 'systemd-system' | 'schtasks-user' | 'schtasks-system';
      scope?: DaemonServiceMode;
      definitionPath?: string;
      installedPath?: string;
      mode: DaemonServiceMode;
      releaseChannel: PublicReleaseRingId;
      targetMode: DaemonServiceTargetMode;
      instanceId: string;
      }>;
    }>
  | Readonly<{
      kind: 'install-default-following-service';
      releaseChannel: PublicReleaseRingId;
      mode: DaemonServiceMode;
    }>;

export type BackgroundServiceRepairApplyRuntime = Readonly<{
  platform: 'darwin' | 'linux' | 'win32';
  systemUser: string;
  uid: number | null;
  userHomeDir: string;
  happierHomeDir: string;
  nodePath: string;
  entryPath: string;
}>;
