import { readDaemonStatusSnapshot } from '@/daemon/statusSnapshot';
import { readSettings, readStoredCredentials } from '@/persistence';

import { readDoctorInstallations } from './installs';
import { readDoctorRelays } from './relays';
import { readDoctorServices } from './services';
import { readDoctorWarnings } from './warnings';

export type DoctorRuntimeInventory = Readonly<{
  settings: Awaited<ReturnType<typeof readSettings>>;
  credentials: Awaited<ReturnType<typeof readStoredCredentials>>;
  daemonStatus: Awaited<ReturnType<typeof readDaemonStatusSnapshot>> | undefined;
  installations: Awaited<ReturnType<typeof readDoctorInstallations>>;
  services: Awaited<ReturnType<typeof readDoctorServices>>;
  warnings: Awaited<ReturnType<typeof readDoctorWarnings>>;
  localRelays: Awaited<ReturnType<typeof readDoctorRelays>>;
}>;

export async function readDoctorRuntimeInventory(): Promise<DoctorRuntimeInventory> {
  const [settings, credentials, daemonStatus, installations, services, localRelays] = await Promise.all([
    readSettings(),
    readStoredCredentials(),
    readDaemonStatusSnapshot().catch(() => undefined),
    readDoctorInstallations(),
    readDoctorServices(),
    readDoctorRelays().catch(() => ({ relays: [] })),
  ]);

  const warnings = await readDoctorWarnings({
    ...(daemonStatus ? { daemonStatus } : {}),
  });

  return {
    settings,
    credentials,
    daemonStatus,
    installations,
    services,
    warnings,
    localRelays,
  };
}
