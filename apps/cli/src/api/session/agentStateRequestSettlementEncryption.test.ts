import { readFile, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

import type { AgentStateRequestSettlementEncryptionScope } from './agentStateRequestSettlementEncryption';

const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID']);
const tokenForAccount = (account: string, revision = 1) => `header.${Buffer.from(JSON.stringify({ sub: account, revision })).toString('base64url')}.sig`;
const settlement = { v: 1 as const, entries: [] };

async function withScope(run: (scope: AgentStateRequestSettlementEncryptionScope) => Promise<void>) {
    await withTempDir('happier-settlement-encryption-', async (home) => {
        envScope.patch({ HAPPIER_HOME_DIR: home });
        vi.resetModules();
        const { configuration } = await import('@/configuration');
        const { writeCredentialsTokenOnly } = await import('@/persistence');
        const token = tokenForAccount('account');
        await writeCredentialsTokenOnly({ token });
        await run({
            token, serverId: configuration.activeServerId, sessionId: 'session',
            installationIdentityPath: configuration.installationIdentityFile,
        });
    });
}

afterEach(() => {
    envScope.restore();
    vi.resetModules();
});

describe('local request settlement encryption', () => {
    it('retains the same-account token refresh path without using another account credentials', async () => {
        await withScope(async (scope) => {
            const { sealAgentStateRequestSettlement, openAgentStateRequestSettlement } = await import('./agentStateRequestSettlementEncryption');
            const { readCredentials, writeCredentialsTokenOnly } = await import('@/persistence');
            const config = await import('@/configuration');
            const content = await sealAgentStateRequestSettlement(scope, settlement);
            expect(content.t).toBe('installation_encrypted_v1');
            envScope.patch({ HAPPIER_ACTIVE_SERVER_ID: 'other-profile' });
            config.reloadConfiguration();
            expect(config.configuration.activeServerId).toBe('other-profile');
            await expect(openAgentStateRequestSettlement(scope, content)).resolves.toEqual(settlement);
            envScope.patch({ HAPPIER_ACTIVE_SERVER_ID: scope.serverId });
            config.reloadConfiguration();
            await writeCredentialsTokenOnly({ token: tokenForAccount('account', 2) });
            await expect(openAgentStateRequestSettlement(scope, content)).resolves.toEqual(settlement);
            expect((await readCredentials())?.encryption).toBeNull();
            await writeCredentialsTokenOnly({ token: tokenForAccount('other-account') });
            await expect(openAgentStateRequestSettlement(scope, content)).rejects.toThrow('credentials for the session account');
            await expect(sealAgentStateRequestSettlement(scope, settlement)).rejects.toThrow('credentials for the session account');
        });
    });

    it('keeps missing and replacement installation identities distinct from the original scoped key', async () => {
        await withScope(async (scope) => {
            const { sealAgentStateRequestSettlement, openAgentStateRequestSettlement } = await import('./agentStateRequestSettlementEncryption');
            const { readOrCreateInstallationIdentity } = await import('@/daemon/identity/store');
            const content = await sealAgentStateRequestSettlement(scope, settlement);
            await expect(openAgentStateRequestSettlement({ ...scope, sessionId: 'other-session' }, content)).resolves.toBeNull();
            const original = await readFile(scope.installationIdentityPath, 'utf8');
            await rm(scope.installationIdentityPath);
            await expect(openAgentStateRequestSettlement(scope, content)).rejects.toThrow('original installation identity');
            await expect(readFile(scope.installationIdentityPath)).rejects.toMatchObject({ code: 'ENOENT' });
            await readOrCreateInstallationIdentity(scope.installationIdentityPath);
            expect(await readFile(scope.installationIdentityPath, 'utf8')).not.toBe(original);
            await expect(openAgentStateRequestSettlement(scope, content)).resolves.toBeNull();
        });
    });
});
