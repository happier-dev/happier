import { readDoctorRuntimeInventory } from '@/doctor/inv/runtime';
import {
  buildDoctorSnapshotFromInventory,
  type DoctorSnapshot,
} from '@/doctor/inv/snapshot';
import { resolveDoctorRepairReport } from '@/diagnostics/doctorRepair/resolveDoctorRepairReport';

export type { DoctorSnapshot } from '@/doctor/inv/snapshot';

export async function buildDoctorSnapshot(): Promise<DoctorSnapshot> {
  const inventory = await readDoctorRuntimeInventory();
  const doctorRepairReport = await resolveDoctorRepairReport({
    preferredMode: 'user',
    systemUser: '',
    inventory,
  }).then((resolution) => resolution.report).catch(() => null);

  return buildDoctorSnapshotFromInventory({
    inventory,
    doctorRepairReport,
  });
}
