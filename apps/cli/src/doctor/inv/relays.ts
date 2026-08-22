import { createRelayHostEngine } from '@happier-dev/cli-common/relayHost';
import type { DoctorSnapshot } from '@happier-dev/protocol';

type HappierRelays = NonNullable<DoctorSnapshot['localRelays']>;
type HappierRelay = HappierRelays['relays'][number];
type RelayRing = HappierRelay['releaseChannel'];
type RelayScope = 'user' | 'system';

const RELAY_RINGS: readonly RelayRing[] = ['stable', 'preview', 'dev'];
const RELAY_SCOPES: readonly RelayScope[] = ['user', 'system'];

const relayHostEngine = createRelayHostEngine({
  installRemoteComponent: async () => {
    throw new Error('Remote component installation is not required for doctor relay inventory');
  },
  resolveRemoteReleaseTarget: async () => {
    throw new Error('Remote relay inventory is not supported in doctor');
  },
  runRemoteText: async () => {
    throw new Error('Remote relay inventory is not supported in doctor');
  },
  copyLocalDirectoryToRemote: async () => {
    throw new Error('Remote relay inventory is not supported in doctor');
  },
});

function shouldIncludeRelay(entry: Readonly<{
  installed: boolean;
  running: HappierRelay['running'];
  serviceEnabled?: HappierRelay['serviceEnabled'];
}>): boolean {
  return entry.installed
    || entry.running !== null
    || entry.serviceEnabled !== null;
}

export async function readDoctorRelays(): Promise<HappierRelays> {
  const entries = await Promise.all(
    RELAY_RINGS.flatMap((ring) => RELAY_SCOPES.map(async (scope): Promise<HappierRelay | null> => {
      const status = await relayHostEngine.readStatus({
        target: { kind: 'local' },
        channel: ring,
        mode: scope,
      });

      const entry: HappierRelay = {
        id: `${ring}:${scope}`,
        releaseChannel: ring,
        installed: status.installed,
        version: status.version,
        relayUrl: status.baseUrl,
        healthy: typeof status.healthy === 'boolean' ? status.healthy : null,
        running: status.service.active,
        serviceEnabled: status.service.enabled,
      };

      return shouldIncludeRelay(entry) ? entry : null;
    })),
  );

  return { relays: entries.filter((entry): entry is HappierRelay => entry !== null) };
}
