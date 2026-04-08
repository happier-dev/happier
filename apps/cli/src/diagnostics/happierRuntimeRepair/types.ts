import type { DoctorSnapshot } from '@/ui/doctorSnapshot';
import type { PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';
import type { HappierServiceBackend, HappierServiceTargetMode } from '@happier-dev/cli-common/happierRuntime';

export type HappierRuntimeRepairAction =
  | Readonly<{
      kind: 'restart-daemon';
      command: string;
    }>
  | Readonly<{
      kind: 'install-default-following-service';
      command: string;
      mode: 'user' | 'system';
      targetServerUrl: string | null;
    }>
  | Readonly<{
      kind: 'uninstall-daemon-services';
      command: string;
      reason?: 'orphan' | 'duplicate-default-following' | 'legacy-pinned-migration';
      services: Array<{
        id: string;
        label: string;
        platform: 'darwin' | 'linux' | 'win32';
        backend: HappierServiceBackend;
        scope: 'user' | 'system';
        targetMode: HappierServiceTargetMode;
        ring: PublicReleaseRingLabel | null;
        instanceId: string | null;
        definitionPath: string;
        serverUrl?: string | null;
      }>;
    }>;

export type HappierRuntimeRepairPlan = Readonly<{
  actions: HappierRuntimeRepairAction[];
  manualWarnings: NonNullable<DoctorSnapshot['warnings']>;
}>;

export type HappierRuntimeRepairResult = Readonly<{
  executedActions: Array<{
    kind: HappierRuntimeRepairAction['kind'];
  }>;
}>;
