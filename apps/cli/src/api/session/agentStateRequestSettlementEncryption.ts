import { resolveMachineEncryptionContext } from '@/api/client/encryptionKey';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { readInstallationIdentityIfExists, readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { readAccountIdFromToken } from '@/daemon/machineIdentity/resolveMachineRegistrationIdentity';
import { readCredentials } from '@/persistence';
import { deriveKey } from '@/utils/deriveKey';

import type { AgentStateRequestSettlement } from './agentStateRequestSettlement';
import type { AgentStateRequestSettlementMutationV1 } from './mutations/sessionMutationTypes';

export type AgentStateRequestSettlementEncryptionScope = Readonly<{
    token: string;
    serverId: string;
    sessionId: string;
    installationIdentityPath: string;
}>;

async function readOwnedCredentials(scope: AgentStateRequestSettlementEncryptionScope) {
    const credentials = await readCredentials({ serverId: scope.serverId });
    if (!credentials) throw new Error('Request settlement requires account credentials');
    const accountId = readAccountIdFromToken(scope.token);
    if (credentials.token !== scope.token && (!accountId || readAccountIdFromToken(credentials.token) !== accountId)) {
        throw new Error('Request settlement requires credentials for the session account');
    }
    return credentials;
}

async function deriveInstallationKey(
    scope: AgentStateRequestSettlementEncryptionScope,
    identity: NonNullable<Awaited<ReturnType<typeof readInstallationIdentityIfExists>>>,
): Promise<Uint8Array> {
    const accountId = readAccountIdFromToken(scope.token);
    if (!accountId) throw new Error('Request settlement requires a session account identity');
    return await deriveKey(decodeBase64(identity.privateKey, 'base64url'), 'Happier Session Mutation', [
        'request-settlement-v1', scope.serverId, accountId, scope.sessionId,
    ]);
}

export async function sealAgentStateRequestSettlement(
    scope: AgentStateRequestSettlementEncryptionScope,
    settlement: AgentStateRequestSettlement,
): Promise<AgentStateRequestSettlementMutationV1['content']> {
    const credentials = await readOwnedCredentials(scope);
    if (credentials.encryption) {
        const context = resolveMachineEncryptionContext(credentials);
        return { t: 'encrypted', c: encodeBase64(encrypt(context.encryptionKey, context.encryptionVariant, settlement)) };
    }
    const identity = await readOrCreateInstallationIdentity(scope.installationIdentityPath);
    const key = await deriveInstallationKey(scope, identity);
    return { t: 'installation_encrypted_v1', c: encodeBase64(encrypt(key, 'dataKey', settlement)) };
}

export async function openAgentStateRequestSettlement(
    scope: AgentStateRequestSettlementEncryptionScope,
    content: AgentStateRequestSettlementMutationV1['content'],
): Promise<unknown> {
    const credentials = await readOwnedCredentials(scope);
    switch (content.t) {
        case 'encrypted': {
            const context = resolveMachineEncryptionContext(credentials);
            return decrypt(context.encryptionKey, context.encryptionVariant, decodeBase64(content.c));
        }
        case 'installation_encrypted_v1': {
            const identity = await readInstallationIdentityIfExists(scope.installationIdentityPath);
            if (!identity) throw new Error('Request settlement recovery requires the original installation identity');
            const key = await deriveInstallationKey(scope, identity);
            return decrypt(key, 'dataKey', decodeBase64(content.c));
        }
    }
}
