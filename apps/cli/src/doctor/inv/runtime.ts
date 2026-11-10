import { readDaemonStatusSnapshot } from '@/daemon/statusSnapshot';
import { readAccountChangesCursors, readServerProfileObservations, readSettings, readStoredCredentials, type AccountChangesCursors, type ServerProfileObservations } from '@/persistence';
import { daemonPost } from '@/daemon/controlHttp';
import { DoctorSnapshotResourceVitalsSchema, type DoctorSnapshotResourceVitals } from '@happier-dev/protocol/diagnostics/doctorSnapshot';

import { readDoctorInstallations } from './installs';
import { readDoctorRelays } from './relays';
import { readDoctorServices } from './services';
import { readDoctorWarnings } from './warnings';

export type DoctorRuntimeInventory = Readonly<{
  settings: Awaited<ReturnType<typeof readSettings>>;
  accountChangesCursors?: AccountChangesCursors;
  serverProfileObservations?: ServerProfileObservations;
  credentials: Awaited<ReturnType<typeof readStoredCredentials>>;
  daemonStatus: Awaited<ReturnType<typeof readDaemonStatusSnapshot>> | undefined;
  installations: Awaited<ReturnType<typeof readDoctorInstallations>>;
  services: Awaited<ReturnType<typeof readDoctorServices>>;
  warnings: Awaited<ReturnType<typeof readDoctorWarnings>>;
  localRelays: Awaited<ReturnType<typeof readDoctorRelays>>;
  resourceVitals?: DoctorSnapshotResourceVitals;
}>;

export async function readDoctorRuntimeInventory(): Promise<DoctorRuntimeInventory> {
  const [settings, credentials, daemonStatus, installations, services, localRelays, accountChangesCursors, serverProfileObservations] = await Promise.all([
    readSettings(),
    readStoredCredentials(),
    readDaemonStatusSnapshot().catch(() => undefined),
    readDoctorInstallations(),
    readDoctorServices(),
    readDoctorRelays().catch(() => ({ relays: [] })),
    readAccountChangesCursors(),
    readServerProfileObservations(),
  ]);

  const warnings = await readDoctorWarnings({
    ...(daemonStatus ? { daemonStatus } : {}),
  });
  const resourceVitals = daemonStatus?.daemon.running
    ? DoctorSnapshotResourceVitalsSchema.safeParse(await daemonPost('/doctor/vitals', {})) : null;

  return {
    settings,
    accountChangesCursors,
    serverProfileObservations,
    credentials,
    daemonStatus,
    installations,
    services,
    warnings,
    localRelays,
    ...(resourceVitals?.success ? { resourceVitals: resourceVitals.data } : {}),
  };
}
