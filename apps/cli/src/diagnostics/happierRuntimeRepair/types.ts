import type { DoctorSnapshot } from '@/ui/doctorSnapshot';
import type { PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

export type HappierRuntimeRepairAction =
  | Readonly<{
      kind: 'restart-daemon';
      command: string;
    }>
  | Readonly<{
      kind: 'uninstall-daemon-services';
      command: string;
      services: Array<{
        id: string;
        label: string;
        platform: 'darwin' | 'linux' | 'win32';
        backend: string;
        scope: 'user' | 'system';
        ring: PublicReleaseRingLabel | null;
        instanceId: string | null;
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
