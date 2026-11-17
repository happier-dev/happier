import { describe, expect, it } from 'vitest';

import {
    PluginSystemToolContributionV1Schema,
    PluginSystemToolReadinessV1Schema,
} from './systemTools.js';

const READINESS = {
    acpProbeArgs: ['acp'],
    currentFingerprint: {
        loadSession: true,
        sessionCapabilities: ['list', 'resume', 'close', 'delete', 'fork'],
        absentSessionCapabilities: [],
        mcpHttp: true,
        mcpSse: true,
    },
    legacyFingerprint: {
        loadSession: true,
        sessionCapabilities: ['list', 'resume'],
        absentSessionCapabilities: ['close', 'delete', 'fork'],
        mcpHttp: true,
        mcpSse: false,
    },
    commandSurfaceArgs: ['migrate', '--help'],
    legacyExecutableNames: ['kimi-cli'],
    legacyGuidance: 'Install the current Kimi Code CLI, then run `kimi migrate` manually.',
    unidentifiedGuidance: 'Install the current Kimi Code CLI and retry.',
};

describe('PluginSystemToolReadinessV1Schema', () => {
    it('enforces the native Connected Account purpose identity at a process credential destination', () => {
        const tool = { id: 'gh', title: 'GitHub CLI', executableNames: ['gh'] };
        const launch = { service: 'github-account', environmentKey: 'GH_TOKEN' };
        expect(PluginSystemToolContributionV1Schema.safeParse({ ...tool,
            connectedAccountLaunch: { ...launch, purpose: 'a'.repeat(128) } }).success).toBe(true);
        for (const purpose of ['', 'a'.repeat(129)]) {
            expect(PluginSystemToolContributionV1Schema.safeParse({ ...tool,
                connectedAccountLaunch: { ...launch, purpose } }).success).toBe(false);
        }
    });
    it('admits a declared process credential destination and host-scoped native Git helper', () => {
        expect(PluginSystemToolContributionV1Schema.parse({
            id: 'gh', title: 'GitHub CLI', executableNames: ['gh'],
            connectedAccountLaunch: { purpose: 'github.cli', service: 'github-account', environmentKey: 'GH_TOKEN',
                unsetEnvironmentKeys: ['GITHUB_TOKEN'], brokeredUnavailableCode: 'github_cli_team_brokered_unavailable',
                gitCredentialHelper: { host: 'github.com', args: ['auth', 'git-credential'] } },
        }).connectedAccountLaunch).toMatchObject({ purpose: 'github.cli', environmentKey: 'GH_TOKEN' });
    });
    it('admits declared machine CLI authentication without an Agent contribution', () => {
        const authentication = {
            status: { args: ['auth', 'status'], signedOutExitCodes: [1] },
            loginLaunches: [{ kind: 'primary', args: ['auth', 'login', '--web'] },
                { kind: 'device_code', args: ['auth', 'login', '--web'] }],
            connectedServices: [{ pluginId: 'happier.scm.forge.github', localId: 'github-account' }],
            unsetEnvironmentKeys: ['GH_TOKEN'],
        };
        expect(PluginSystemToolContributionV1Schema.parse({ id: 'gh', title: 'GitHub CLI',
            executableNames: ['gh'], authentication }).authentication).toEqual(authentication);
    });

    it('admits native desktop authentication without retaining manual session credentials', () => {
        const authentication = {
            status: { args: ['whoami'], signedOutExitCodes: [] },
            loginLaunches: [{ kind: 'primary', args: ['signin'] }],
            connectedServices: [],
            environment: { OP_BIOMETRIC_UNLOCK_ENABLED: 'true' },
            unsetEnvironmentKeys: ['OP_SERVICE_ACCOUNT_TOKEN', 'OP_SESSION', 'OP_CONNECT_TOKEN', 'OP_CONNECT_HOST'],
            unsetEnvironmentKeyPrefixes: ['OP_SESSION_'],
        };
        expect(PluginSystemToolContributionV1Schema.parse({ id: 'op', title: '1Password CLI',
            executableNames: ['op'], authentication }).authentication).toEqual(authentication);
    });

    it('accepts a capability-fingerprint readiness declaration', () => {
        expect(PluginSystemToolReadinessV1Schema.parse(READINESS)).toMatchObject({
            commandSurfaceArgs: ['migrate', '--help'],
            legacyExecutableNames: ['kimi-cli'],
        });
    });

    it('rejects version-ordering declarations instead of ranking by semver', () => {
        expect(() => PluginSystemToolReadinessV1Schema.parse({
            ...READINESS,
            orderByVersion: true,
        })).toThrow();
        expect(() => PluginSystemToolReadinessV1Schema.parse({
            ...READINESS,
            minimumVersion: '1.0.0',
        })).toThrow();
    });

    it('requires nonempty guidance and capability expectations', () => {
        expect(() => PluginSystemToolReadinessV1Schema.parse({
            ...READINESS,
            legacyGuidance: '   ',
        })).toThrow();
        expect(() => PluginSystemToolReadinessV1Schema.parse({
            ...READINESS,
            currentFingerprint: { ...READINESS.currentFingerprint, sessionCapabilities: [] },
        })).toThrow();
    });

    it('flows through the system tool contribution shape', () => {
        const parsed = PluginSystemToolContributionV1Schema.parse({
            id: 'kimi-cli',
            title: 'Kimi Code CLI',
            executableNames: ['kimi'],
            readiness: READINESS,
        });
        expect(parsed.readiness?.legacyExecutableNames).toEqual(['kimi-cli']);
    });

    it('stays optional so unrelated tools keep plain executable resolution', () => {
        const parsed = PluginSystemToolContributionV1Schema.parse({
            id: 'plain',
            title: 'Plain',
            executableNames: ['plain'],
        });
        expect(parsed.readiness).toBeUndefined();
    });
});
