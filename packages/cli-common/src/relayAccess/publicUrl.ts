import { normalizeRelayAccessCanonicalPublicServerUrl } from './normalizePublicServerUrl.js';
export { normalizeRelayAccessCanonicalPublicServerUrl } from './normalizePublicServerUrl.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveHappyHomeDirFromEnvironment } from '../agents/resolveHappyHomeDir.js';

import { getRelayAccessProvider, getRelayAccessProviderDescriptor } from './registry.js';
import { parseRelayAccessConfig, relayAccessProviderDescriptors } from './catalog.js';
import type { RelayAccessConfig, RelayAccessProviderExposure, RelayAccessStatus } from './types.js';

type RelayAccessConfigEnv = Readonly<Record<string, string | undefined>>;
type ResolveRelayAccessConfiguredCanonicalPublicServerUrlOptions = Readonly<{
    upstreamUrl?: string | null;
    allowTailscaleProviders?: boolean;
}>;

const defaultRelayAccessConfigEnv: RelayAccessConfigEnv = {};
const defaultResolveRelayAccessConfiguredCanonicalPublicServerUrlOptions: ResolveRelayAccessConfiguredCanonicalPublicServerUrlOptions = {};

async function resolveRelayAccessStatusShareUrlWithEnv(
    config: RelayAccessConfig,
    env: NodeJS.ProcessEnv,
    upstreamUrl: string | null,
): Promise<string | null> {
    try {
        const provider = getRelayAccessProvider(config.provider);
        const status = await provider.status({ config, ctx: { env, upstreamUrl } });
        return resolveRelayAccessStatusShareUrlFromStatus(status);
    } catch {
        return null;
    }
}

function resolveRelayAccessStatusShareUrlFromStatus(status: RelayAccessStatus): string | null {
    return normalizeRelayAccessCanonicalPublicServerUrl(status.shareUrl);
}

async function readPersistedRelayAccessConfigFromEnv(
    env: RelayAccessConfigEnv,
): Promise<RelayAccessConfig | null> {
    const happyHomeDir = resolveHappyHomeDirFromEnvironment(env as NodeJS.ProcessEnv);
    const path = join(happyHomeDir, 'relay', 'access', 'local.json');
    const raw = await readFile(path, 'utf8').catch(() => '');
    if (!raw.trim()) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }

    return parseRelayAccessConfig(parsed, relayAccessProviderDescriptors.filter(descriptor =>
        descriptor.definition.targets.includes('homeRelay')));
}

/**
 * What the relay-access configuration persisted on this computer says about how it exposes the
 * local server: the configured method, whether that method reaches the public internet, and the
 * address it shares (when the provider can report one). `null` when no usable configuration exists.
 */
export type RelayAccessConfiguredPublicAccess = Readonly<{
    providerId: string;
    exposure: RelayAccessProviderExposure;
    shareUrl: string | null;
}>;

export async function resolveRelayAccessConfiguredPublicAccess(
    env: RelayAccessConfigEnv = defaultRelayAccessConfigEnv,
    options: ResolveRelayAccessConfiguredCanonicalPublicServerUrlOptions = defaultResolveRelayAccessConfiguredCanonicalPublicServerUrlOptions,
): Promise<RelayAccessConfiguredPublicAccess | null> {
    const config = await readPersistedRelayAccessConfigFromEnv(env);
    if (!config) return null;
    const descriptor = getRelayAccessProviderDescriptor(config.provider);
    const { exposure } = descriptor;

    const upstreamUrl = String(options.upstreamUrl ?? '').trim() || null;
    const allowTailscaleProviders = options.allowTailscaleProviders ?? true;
    if (descriptor.homeSetupTaskKind && !allowTailscaleProviders || descriptor.requiresUpstreamUrl && !upstreamUrl) {
        return { providerId: descriptor.id, exposure, shareUrl: null };
    }
    const shareUrl = await resolveRelayAccessStatusShareUrlWithEnv(config, env as NodeJS.ProcessEnv, upstreamUrl);
    return { providerId: descriptor.id, exposure, shareUrl };
}

export async function resolveRelayAccessConfiguredCanonicalPublicServerUrl(
    env: RelayAccessConfigEnv = defaultRelayAccessConfigEnv,
    options: ResolveRelayAccessConfiguredCanonicalPublicServerUrlOptions = defaultResolveRelayAccessConfiguredCanonicalPublicServerUrlOptions,
): Promise<string | null> {
    return (await resolveRelayAccessConfiguredPublicAccess(env, options))?.shareUrl ?? null;
}
