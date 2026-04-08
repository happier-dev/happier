import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { joinPathForPathShape } from '../path/pathShape.js';
import { resolveHappyHomeDirFromEnvironment } from '../providers/resolveHappyHomeDir.js';

const DEFAULT_MANAGED_RELEASE_CHANNEL: PublicReleaseRingId = 'stable';

export function resolveDefaultManagedReleaseChannelStatePath(params: Readonly<{
    processEnv?: NodeJS.ProcessEnv;
}> = {}): string {
    const happyHomeDir = resolveHappyHomeDirFromEnvironment(params.processEnv ?? process.env);
    return joinPathForPathShape(happyHomeDir, 'default-cli-release-channel.json');
}

export async function readDefaultManagedReleaseChannel(params: Readonly<{
    processEnv?: NodeJS.ProcessEnv;
}> = {}): Promise<PublicReleaseRingId> {
    const statePath = resolveDefaultManagedReleaseChannelStatePath(params);
    try {
        const raw = await readFile(statePath, 'utf8');
        const parsed = JSON.parse(String(raw)) as { releaseChannel?: unknown };
        const normalized = normalizePublicReleaseRingId(parsed.releaseChannel);
        return normalized || DEFAULT_MANAGED_RELEASE_CHANNEL;
    } catch {
        return DEFAULT_MANAGED_RELEASE_CHANNEL;
    }
}

export async function writeDefaultManagedReleaseChannel(params: Readonly<{
    releaseChannel: PublicReleaseRingId;
    processEnv?: NodeJS.ProcessEnv;
}>): Promise<Readonly<{ releaseChannel: PublicReleaseRingId; statePath: string }>> {
    const releaseChannel = normalizePublicReleaseRingId(params.releaseChannel) || DEFAULT_MANAGED_RELEASE_CHANNEL;
    const statePath = resolveDefaultManagedReleaseChannelStatePath(params);
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify({ releaseChannel })}\n`, 'utf8');
    return { releaseChannel, statePath };
}
