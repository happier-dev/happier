import { createRelayHostEngine } from '@happier-dev/cli-common/relayHost';
import { resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import { getReleaseRingPublicLabel, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

const LOCAL_RELAY_CHANNELS: readonly ('stable' | 'preview' | 'dev')[] = ['stable', 'preview', 'dev'];

export type LocalRelayMatch = Readonly<{
  url: string;
  channel: 'stable' | 'preview' | 'dev';
  /**
   * `true` when the resolved relay matches the current CLI's channel. `false`
   * when we fell back to a differently-channeled relay because the current
   * channel isn't installed locally — callers can emit a warning so the user
   * sees the mismatch.
   */
  matchesCurrentChannel: boolean;
}>;

function buildLocalRelayHostEngine() {
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

/**
 * Read the install status of the local relay on one explicit channel.
 * Returns the URL when installed, else null. Never throws.
 */
export async function readLocalRelayUrlForChannel(channel: 'stable' | 'preview' | 'dev'): Promise<string | null> {
  const engine = buildLocalRelayHostEngine();
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

function publicLabelToRing(label: 'stable' | 'preview' | 'dev'): PublicReleaseRingId {
  return label === 'dev' ? 'publicdev' : label;
}

/**
 * List installed local relays across every channel. Used when the current
 * channel has no installed relay so we can mention the nearby installs in
 * the error message (rather than silently falling back).
 */
async function listAllInstalledLocalRelays(): Promise<ReadonlyArray<{ channel: 'stable' | 'preview' | 'dev'; url: string }>> {
  const results: Array<{ channel: 'stable' | 'preview' | 'dev'; url: string }> = [];
  for (const candidate of LOCAL_RELAY_CHANNELS) {
    const url = await readLocalRelayUrlForChannel(candidate);
    if (url) results.push({ channel: candidate, url });
  }
  return results;
}

/**
 * Resolve a local relay the user can act on.
 *
 * Strict channel policy — deliberately no silent fall-back:
 *   1. If `--local-channel <c>` was passed, resolve for that channel or return null.
 *   2. Otherwise resolve for the current CLI's inferred channel; return null if
 *      nothing is installed there. We surface the installs on other channels
 *      via `otherInstalls` so the caller can format a helpful error (pointing
 *      the user at `--local-channel` or telling them to invoke the intended
 *      CLI shim).
 *
 * Rationale: falling back to an off-channel relay silently is confusing —
 * running the stable CLI should never reach the dev relay, even if that's the
 * only one installed. The channel is the user's declared identity; we respect
 * it.
 *
 * Shared between `happier relay use/add/set --local`, `relay start-daemon`,
 * and `service install --local-relay`.
 */
export async function resolveLocalRelay(params: Readonly<{
  channel?: 'stable' | 'preview' | 'dev' | null;
}> = {}): Promise<LocalRelayMatch | null> {
  const currentRing = resolveManagedCliReleaseChannelSync({ processEnv: process.env, argv: process.argv }).ringId;
  const currentChannel = getReleaseRingPublicLabel(currentRing);

  if (params.channel) {
    const url = await readLocalRelayUrlForChannel(params.channel);
    if (!url) return null;
    return { url, channel: params.channel, matchesCurrentChannel: params.channel === currentChannel };
  }

  const matchingUrl = await readLocalRelayUrlForChannel(currentChannel);
  if (matchingUrl) {
    return { url: matchingUrl, channel: currentChannel, matchesCurrentChannel: true };
  }

  return null;
}

/**
 * Build a user-facing error message when no local relay is installed on the
 * current (or requested) channel, mentioning any installs we found on other
 * channels so the user knows the options without us silently using them.
 */
export async function buildMissingLocalRelayError(channel: 'stable' | 'preview' | 'dev'): Promise<string> {
  const others = (await listAllInstalledLocalRelays()).filter((e) => e.channel !== channel);
  const base = `No local relay installed on the ${channel} channel. Run \`happier relay host install --channel ${channel}\` first.`;
  if (others.length === 0) return base;
  const list = others.map((e) => `${e.channel} (${e.url})`).join(', ');
  return `${base}\n  Other installed relays: ${list}. Pass --local-channel <stable|preview|dev> to target one explicitly.`;
}

// Keep this export in case unrelated modules need the ring-id form.
export { publicLabelToRing };
