import { createRelayHostEngine } from '@happier-dev/cli-common/relayHost';
import { resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import { getReleaseRingPublicLabel } from '@happier-dev/release-runtime/releaseRings';

const LOCAL_RELAY_CHANNELS: readonly ('stable' | 'preview' | 'dev')[] = ['stable', 'preview', 'dev'];

export type LocalRelayMatch = Readonly<{
  url: string;
  channel: 'stable' | 'preview' | 'dev';
  matchesCurrentChannel: boolean;
}>;

function createLocalRelayLookupEngine() {
  return createRelayHostEngine({
    installRemoteComponent: async () => {
      throw new Error('Remote component installation is not available for local relay lookup.');
    },
    resolveRemoteReleaseTarget: async () => {
      throw new Error('Remote target resolution is not available for local relay lookup.');
    },
    runRemoteText: async () => {
      throw new Error('Remote execution is not available for local relay lookup.');
    },
    copyLocalDirectoryToRemote: async () => {
      throw new Error('Remote copy is not available for local relay lookup.');
    },
  });
}

function inferCurrentLocalRelayChannel(): 'stable' | 'preview' | 'dev' {
  return getReleaseRingPublicLabel(resolveManagedCliReleaseChannelSync({
    processEnv: process.env,
    argv: process.argv,
    argv0: process.argv0,
    execPath: process.execPath,
  }).ringId);
}

export async function readLocalRelayUrlForChannel(channel: 'stable' | 'preview' | 'dev'): Promise<string | null> {
  const engine = createLocalRelayLookupEngine();
  try {
    const status = await engine.readStatus({
      target: { kind: 'local' },
      channel,
      mode: 'user',
    });
    return status.installed ? status.baseUrl : null;
  } catch {
    return null;
  }
}

async function listInstalledLocalRelays(): Promise<ReadonlyArray<Readonly<{ channel: 'stable' | 'preview' | 'dev'; url: string }>>> {
  const result: Array<Readonly<{ channel: 'stable' | 'preview' | 'dev'; url: string }>> = [];
  for (const channel of LOCAL_RELAY_CHANNELS) {
    const url = await readLocalRelayUrlForChannel(channel);
    if (url) result.push({ channel, url });
  }
  return result;
}

export async function resolveLocalRelay(params: Readonly<{
  channel?: 'stable' | 'preview' | 'dev' | null;
}> = {}): Promise<LocalRelayMatch | null> {
  const currentChannel = inferCurrentLocalRelayChannel();
  const targetChannel = params.channel ?? currentChannel;
  const url = await readLocalRelayUrlForChannel(targetChannel);
  if (!url) return null;
  return {
    url,
    channel: targetChannel,
    matchesCurrentChannel: targetChannel === currentChannel,
  };
}

export async function buildMissingLocalRelayError(channel: 'stable' | 'preview' | 'dev'): Promise<string> {
  const others = (await listInstalledLocalRelays()).filter((entry) => entry.channel !== channel);
  const base = `No local relay installed on the ${channel} channel. Run \`happier relay host install --channel ${channel}\` first.`;
  if (others.length === 0) return base;
  const installed = others.map((entry) => `${entry.channel} (${entry.url})`).join(', ');
  return `${base}\nOther installed local relays: ${installed}. Pass --local-channel <stable|preview|dev> to target one explicitly.`;
}
