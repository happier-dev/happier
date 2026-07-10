import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { normalizePublicReleaseRingId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { joinPathForPathShape } from '../path/pathShape.js';
import { resolveHappyHomeDirFromEnvironment } from '../agents/resolveHappyHomeDir.js';
import type { FirstPartyComponentId } from './componentCatalog.js';

const DEFAULT_MANAGED_RELEASE_CHANNEL: PublicReleaseRingId = 'stable';
const DEFAULT_RELEASE_CHANNEL_COMPONENT_IDS = new Set<FirstPartyComponentId>(['happier-cli', 'happier-daemon']);

export function shouldPersistDefaultManagedReleaseChannel(componentId: FirstPartyComponentId): boolean {
    return DEFAULT_RELEASE_CHANNEL_COMPONENT_IDS.has(componentId);
}

export function resolveDefaultManagedReleaseChannelStatePath(params: Readonly<{
    processEnv?: NodeJS.ProcessEnv;
}> = {}): string {
    const happyHomeDir = resolveHappyHomeDirFromEnvironment(params.processEnv ?? process.env);
    return joinPathForPathShape(happyHomeDir, 'default-cli-release-channel.json');
}

function normalizeDefaultManagedReleaseChannelPayload(raw: string): PublicReleaseRingId {
    const parsed = JSON.parse(String(raw)) as { releaseChannel?: unknown };
    const normalized = normalizePublicReleaseRingId(parsed.releaseChannel);
    return normalized || DEFAULT_MANAGED_RELEASE_CHANNEL;
}

export function readDefaultManagedReleaseChannelSync(params: Readonly<{
    processEnv?: NodeJS.ProcessEnv;
}> = {}): PublicReleaseRingId {
    const statePath = resolveDefaultManagedReleaseChannelStatePath(params);
    try {
        return normalizeDefaultManagedReleaseChannelPayload(readFileSync(statePath, 'utf8'));
    } catch {
        return DEFAULT_MANAGED_RELEASE_CHANNEL;
    }
}

export async function readDefaultManagedReleaseChannel(params: Readonly<{
    processEnv?: NodeJS.ProcessEnv;
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
    processEnv?: NodeJS.ProcessEnv;
}>): Promise<Readonly<{ releaseChannel: PublicReleaseRingId; statePath: string }>> {
    const releaseChannel = normalizePublicReleaseRingId(params.releaseChannel) || DEFAULT_MANAGED_RELEASE_CHANNEL;
    const statePath = resolveDefaultManagedReleaseChannelStatePath(params);
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify({ releaseChannel })}\n`, 'utf8');
    return { releaseChannel, statePath };
}
