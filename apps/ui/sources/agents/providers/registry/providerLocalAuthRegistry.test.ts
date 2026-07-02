import { describe, expect, it } from 'vitest';
import { PROVIDER_SETTINGS_DESCRIPTORS } from '@/agents/catalog/providerSettingsCatalog';
import { getProviderCliInstallGuideUrl } from '@happier-dev/agents';

import { getProviderLocalAuthPlugin } from '@/agents/providers/catalog/providerLocalAuthCatalog';

describe('provider local auth registry', () => {
    it('covers every provider settings descriptor with an explicit local auth plugin', () => {
        const providerIds = PROVIDER_SETTINGS_DESCRIPTORS.map((descriptor) => descriptor.providerId);
        expect(new Set(providerIds.map((providerId) => getProviderLocalAuthPlugin(providerId as Parameters<typeof getProviderLocalAuthPlugin>[0])?.providerId ?? null))).toEqual(new Set(providerIds));
    });

    it('returns a Claude launch strategy that starts the CLI and submits /login as terminal input', () => {
        const plugin = getProviderLocalAuthPlugin('claude');
        const launch = plugin?.buildLoginLaunch?.({ resolvedPath: '/usr/local/bin/claude' }) ?? null;

        expect(launch).toEqual({
            initialCommand: '/usr/local/bin/claude',
            initialInput: '/login\r',
        });
    });

    it('returns a Codex launch strategy that runs the direct login command', () => {
        const plugin = getProviderLocalAuthPlugin('codex');
        const launch = plugin?.buildLoginLaunch?.({ resolvedPath: '/usr/local/bin/codex' }) ?? null;

        expect(launch).toEqual({
            initialCommand: '/usr/local/bin/codex login',
        });
    });

    it('returns a Copilot launch strategy that runs the direct login command', () => {
        const plugin = getProviderLocalAuthPlugin('copilot');
        const launch = plugin?.buildLoginLaunch?.({ resolvedPath: '/usr/local/bin/copilot' }) ?? null;

        expect(launch).toEqual({
            initialCommand: '/usr/local/bin/copilot login',
        });
    });

    it('returns a Kilo launch strategy that starts the CLI and submits /connect as terminal input', () => {
        const plugin = getProviderLocalAuthPlugin('kilo');
        const launch = plugin?.buildLoginLaunch?.({ resolvedPath: '/usr/local/bin/kilo' }) ?? null;

        expect(launch).toEqual({
            initialCommand: '/usr/local/bin/kilo',
            initialInput: '/connect\r',
        });
    });

    it('returns a Kiro launch strategy that runs the direct login command', () => {
        const plugin = getProviderLocalAuthPlugin('kiro');
        const launch = plugin?.buildLoginLaunch?.({ resolvedPath: '/usr/local/bin/kiro-cli' }) ?? null;

        expect(launch).toEqual({
            initialCommand: '/usr/local/bin/kiro-cli login',
        });
    });

    it('uses centralized provider setup guide URLs for local auth plugins', () => {
        for (const providerId of ['claude', 'codex', 'opencode', 'kiro', 'copilot'] as const) {
            expect(getProviderLocalAuthPlugin(providerId)?.docsUrl ?? null).toBe(getProviderCliInstallGuideUrl(providerId));
        }
    });

    it('prefers a resolved shell command when the CLI requires a runtime wrapper', () => {
        const plugin = getProviderLocalAuthPlugin('codex');
        const launch = plugin?.buildLoginLaunch?.({
            resolvedPath: '/opt/tools/fake-codex.js',
            resolvedCommand: `'bun' '/opt/tools/fake-codex.js'`,
            platform: 'darwin',
        }) ?? null;

        expect(launch).toEqual({
            initialCommand: `'bun' '/opt/tools/fake-codex.js' login`,
        });
    });

    it('quotes a fallback resolvedPath when the CLI path contains spaces', () => {
        const plugin = getProviderLocalAuthPlugin('codex');
        const launch = plugin?.buildLoginLaunch?.({
            resolvedPath: '/Applications/Codex App/bin/codex',
            resolvedCommand: null,
            platform: 'darwin',
        }) ?? null;

        expect(launch).toEqual({
            initialCommand: `'/Applications/Codex App/bin/codex' login`,
        });
    });
});
