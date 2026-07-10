import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveHappyHomeDirFromEnvironment } from '../agents/resolveHappyHomeDir.js';

import { getRelayAccessProvider } from './registry.js';
import type { RelayAccessConfig, RelayAccessStatus } from './types.js';

type RelayAccessConfigEnv = Readonly<Record<string, string | undefined>>;
type ResolveRelayAccessConfiguredCanonicalPublicServerUrlOptions = Readonly<{
    upstreamUrl?: string | null;
    allowTailscaleProviders?: boolean;
}>;

const defaultRelayAccessConfigEnv: RelayAccessConfigEnv = {};
const defaultResolveRelayAccessConfiguredCanonicalPublicServerUrlOptions: ResolveRelayAccessConfiguredCanonicalPublicServerUrlOptions = {};

function normalizeHttpUrl(raw: unknown): string | null {
    const value = String(raw ?? '').trim();
    if (!value) return null;

    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return null;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) {
        parsed.username = '';
        parsed.password = '';
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
}

async function resolveRelayAccessStatusShareUrlWithEnv(
    config: RelayAccessConfig,
    env: NodeJS.ProcessEnv,
    upstreamUrl: string | null,
): Promise<string | null> {
    try {
        const provider = getRelayAccessProvider(config.providerId);
        const status = await provider.status({ config, ctx: { env, upstreamUrl } });
        return resolveRelayAccessStatusShareUrlFromStatus(status);
    } catch {
        return null;
    }
}

function resolveRelayAccessStatusShareUrlFromStatus(status: RelayAccessStatus): string | null {
    return normalizeHttpUrl(status.shareUrl);
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

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const providerId = typeof record.providerId === 'string' ? record.providerId.trim() : '';
    if (!providerId) return null;

    switch (providerId) {
        case 'localOnly':
        case 'tailscaleServe':
        case 'tailscaleFunnel':
            return { providerId };
        case 'lan': {
            const url = typeof record.url === 'string' ? record.url.trim() : '';
            return url ? { providerId: 'lan', url } : null;
        }
        case 'cloudflareNamed': {
            const hostname = typeof record.hostname === 'string' ? record.hostname.trim() : '';
            const token = typeof record.token === 'string' ? record.token.trim() : '';
            return hostname && token ? { providerId: 'cloudflareNamed', hostname, token } : null;
        }
        default:
            return null;
    }
}

export async function resolveRelayAccessConfiguredCanonicalPublicServerUrl(
    env: RelayAccessConfigEnv = defaultRelayAccessConfigEnv,
    options: ResolveRelayAccessConfiguredCanonicalPublicServerUrlOptions = defaultResolveRelayAccessConfiguredCanonicalPublicServerUrlOptions,
): Promise<string | null> {
    const config = await readPersistedRelayAccessConfigFromEnv(env);
    if (!config) return null;

    const upstreamUrl = String(options.upstreamUrl ?? '').trim() || null;
    const allowTailscaleProviders = options.allowTailscaleProviders ?? true;
    if (config.providerId === 'tailscaleServe' || config.providerId === 'tailscaleFunnel') {
        if (!allowTailscaleProviders) return null;
        if (!upstreamUrl) return null;
    }
    return await resolveRelayAccessStatusShareUrlWithEnv(config, env as NodeJS.ProcessEnv, upstreamUrl);
}

export function normalizeRelayAccessCanonicalPublicServerUrl(raw: unknown): string | null {
    return normalizeHttpUrl(raw);
}
