import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { joinPathForPathShape } from '../path/pathShape.js';
import type { FirstPartyComponentId } from './componentCatalog.js';
import { resolveFirstPartyInstallHomeDir, resolveFirstPartyInstallLayout } from './installLayout.js';
import { readInstalledVersionMarkersSync } from './versionMarkers.js';

const DEFAULT_MANAGED_RELEASE_CHANNEL: PublicReleaseRingId = 'stable';
const DEFAULT_RELEASE_CHANNEL_COMPONENT_IDS = new Set<FirstPartyComponentId>(['happier-cli', 'happier-daemon']);

export function shouldPersistDefaultManagedReleaseChannel(componentId: FirstPartyComponentId): boolean {
    return DEFAULT_RELEASE_CHANNEL_COMPONENT_IDS.has(componentId);
}

export function resolveDefaultManagedReleaseChannelStatePath(params: Readonly<{
    processEnv?: Readonly<Record<string, string | undefined>>;
}> = {}): string {
    const happyHomeDir = resolveFirstPartyInstallHomeDir(params.processEnv ?? process.env);
    return joinPathForPathShape(happyHomeDir, 'default-cli-release-channel.json');
}

function normalizeDefaultManagedReleaseChannelPayload(raw: string): PublicReleaseRingId {
    const parsed = JSON.parse(String(raw)) as { releaseChannel?: unknown };
    const normalized = normalizePublicReleaseRingId(parsed.releaseChannel);
    return normalized || DEFAULT_MANAGED_RELEASE_CHANNEL;
}

export function readDefaultManagedReleaseChannelSync(params: Readonly<{
    processEnv?: Readonly<Record<string, string | undefined>>;
}> = {}): PublicReleaseRingId {
    const statePath = resolveDefaultManagedReleaseChannelStatePath(params);
    try {
        return normalizeDefaultManagedReleaseChannelPayload(readFileSync(statePath, 'utf8'));
    } catch {
        return DEFAULT_MANAGED_RELEASE_CHANNEL;
    }
}

export async function readDefaultManagedReleaseChannel(params: Readonly<{
    processEnv?: Readonly<Record<string, string | undefined>>;
}> = {}): Promise<PublicReleaseRingId> {
    const statePath = resolveDefaultManagedReleaseChannelStatePath(params);
    try {
        return normalizeDefaultManagedReleaseChannelPayload(await readFile(statePath, 'utf8'));
    } catch {
        return DEFAULT_MANAGED_RELEASE_CHANNEL;
    }
}

export async function writeDefaultManagedReleaseChannel(params: Readonly<{
    releaseChannel: PublicReleaseRingId;
    processEnv?: Readonly<Record<string, string | undefined>>;
}>): Promise<Readonly<{ releaseChannel: PublicReleaseRingId; statePath: string }>> {
    const releaseChannel = normalizePublicReleaseRingId(params.releaseChannel) || DEFAULT_MANAGED_RELEASE_CHANNEL;
    const statePath = resolveDefaultManagedReleaseChannelStatePath(params);
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify({ releaseChannel })}\n`, 'utf8');
    return { releaseChannel, statePath };
}

/**
 * One default `happier` command per `~/.happier` (plan R10 D2). Installing a channel makes it the
 * default when the user chose it explicitly, when nothing else is installed, or when it already is
 * the default; otherwise the recorded default channel keeps the `happier` shim and the marker, so a
 * desktop app, a self-update or any other acquisition of a second channel never changes which CLI
 * the user's terminal and the default-following background service run.
 */
export async function resolveDefaultReleaseChannelAfterInstall(params: Readonly<{
  componentId: FirstPartyComponentId;
  installedChannel: PublicReleaseRingId;
  selectAsDefault: boolean;
  processEnv?: Readonly<Record<string, string | undefined>>;
}>): Promise<PublicReleaseRingId> {
  if (params.selectAsDefault || !shouldPersistDefaultManagedReleaseChannel(params.componentId)) {
    return params.installedChannel;
  }
  const currentDefault = await readDefaultManagedReleaseChannel({ processEnv: params.processEnv });
  if (currentDefault === params.installedChannel) return currentDefault;
  const defaultLayout = resolveFirstPartyInstallLayout({
    componentId: params.componentId,
    releaseRing: currentDefault,
    processEnv: params.processEnv,
  });
  return readInstalledVersionMarkersSync(defaultLayout).currentVersionId ? currentDefault : params.installedChannel;
}
