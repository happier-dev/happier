import { createConnectedAccountCredentialSettlement, parseConnectedAccountConfigurationRecordContent } from '@happier-dev/cli-common/connectedAccounts';
import { QualifiedConnectedAccountCredentialMutationSuccessV4Schema,
    QualifiedConnectedAccountConfigurationPatchV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { sameQualifiedConnectedAccountRef, type QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { withActionAccountRequestSignal } from '@/sync/ops/actions/actionAccountContext';
import { ConnectedServiceApiError, throwConnectedServiceApiError } from '@/sync/api/account/connectedServiceApiError';
import { getQualifiedConnectedAccountCredentialV4, getQualifiedConnectedAccountConfigurationV4 } from '@/sync/api/account/apiQualifiedConnectedAccountsV4';
import { createUiConnectedAccountContent } from './connectedAccountContent';
import type { SharedSavedSecretReferenceSelectionV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';

/** Physical app IO for the existing qualified credential CAS and settlement owner. */
export function createUiConnectedAccountCredentialPersistence(account: LazyActionAccountContext, signal?: AbortSignal) {
    const content = createUiConnectedAccountContent(account);
    const request = (path: string, method: 'GET' | 'POST' | 'PATCH', body?: unknown) =>
        withActionAccountRequestSignal(account, signal, ownedSignal => account.request(path, {
            method, signal: ownedSignal,
            headers: { Authorization: `Bearer ${account.credentials.token}`, 'Content-Type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }, { includeAuth: false, retry: 'none' }));
    const readCredential = async (ref: QualifiedConnectedAccountRef) => {
        const credential = await getQualifiedConnectedAccountCredentialV4(account.credentials, ref, {
            request: account.request, signal, requestPurpose: 'connected-accounts:persistence', retry: 'none',
        }).catch(error => {
            if (error instanceof ConnectedServiceApiError && error.status === 404 && error.code === 'connect_credential_not_found') return null;
            throw error;
        });
        if (credential === null) return null;
        if (!sameQualifiedConnectedAccountRef(credential.ref, ref)) {
            throw new ConnectedServiceApiError({ code: 'qualified_connected_accounts_inconsistent_peer' });
        }
        return credential;
    };
    const readConfiguration = async (ref: QualifiedConnectedAccountRef) => {
        return getQualifiedConnectedAccountConfigurationV4(account.credentials, ref, {
            request: account.request, signal, requestPurpose: 'connected-accounts:persistence', retry: 'none',
        }).catch(error => {
            if (error instanceof ConnectedServiceApiError && error.status === 404 && error.code === 'connect_configuration_not_found') return null;
            throw error;
        });
    };
    const parseConfigurationContent = (input: unknown, revision: string) => {
        const { revision: _revision, ...parsed } = parseConnectedAccountConfigurationRecordContent(input, revision);
        if (Object.keys(parsed.secretRefs).length) throw new Error('connected_account_configuration_invalid');
        return parsed;
    };
    return {
        content, readCredential, readConfiguration,
        async readSelectedSecrets(selections: Readonly<Record<string, SharedSavedSecretReferenceSelectionV1>>, selectedSignal?: AbortSignal) {
            const { readSavedSecretReferencesInContext } = await import('@/sync/api/account/apiSavedSecretCatalog');
            const read = await readSavedSecretReferencesInContext(account, Object.values(selections).map(selection => selection.ref), selectedSignal);
            if (!read.ok) throw new Error('connected_account_credential_secret_unavailable');
            return Object.fromEntries(Object.entries(selections).map(([fieldId, selection]) => [fieldId, read.values.get(selection.ref)!.value]));
        },
        accounts: { async readExact(ref: QualifiedConnectedAccountRef) {
            const record = await readCredential(ref);
            if (!record || record.authenticationModeId === null || record.revisionSemantics !== 'revisioned') return null;
            return { account: record.ref, authenticationModeId: record.authenticationModeId,
                credentialRevision: record.credentialRevision, configurationRevision: record.configurationRevision };
        } },
        async replaceConfiguration(patch: ReturnType<typeof QualifiedConnectedAccountConfigurationPatchV4Schema.parse>) {
            const response = await request('/v4/connect/qualified/configuration', 'PATCH', patch);
            if (!response.ok) await throwConnectedServiceApiError(response);
            return QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse(await response.json());
        },
        settlement: createConnectedAccountCredentialSettlement({
            now: Date.now,
            resolveAccountMode: usage => content.resolveAccountMode(usage),
            seal: content.seal,
            open: content.open,
            parseConfigurationContent,
            readCredential, readConfiguration,
            promoteCredentialSecrets: async ({ secrets, credential }) => {
                const { createSavedSecretResourcesWithConnectedAccountCredentialInContext } = await import('@/sync/ops/settings/savedSecretResourceOperations');
                return createSavedSecretResourcesWithConnectedAccountCredentialInContext(account, {
                    scope: { serverId: account.serverId, accountId: account.accountId }, secrets, credential,
                });
            },
            rotateCredentialSecrets: async ({ secrets }) => {
                const { updateSavedSecretResourceInContext } = await import('@/sync/ops/settings/savedSecretResourceOperations');
                for (const secret of secrets) {
                    const result = await updateSavedSecretResourceInContext(account, { resourceId: secret.resourceId, nextValue: secret.value });
                    if (!result.ok) return result.reason === 'changed' ? 'conflict'
                        : result.reason === 'outcome_unknown' ? 'outcome_unknown' : 'unavailable';
                }
                return 'applied';
            },
            mutateCredential: async mutation => {
                const response = await request('/v4/connect/qualified/credential', 'POST', mutation);
                if (!response.ok) await throwConnectedServiceApiError(response);
                return QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse(await response.json());
            },
            mutateCredentialHealth: async patch => {
                const response = await request('/v4/connect/qualified/credential/health', 'PATCH', patch);
                if (!response.ok) await throwConnectedServiceApiError(response);
                QualifiedConnectedAccountCredentialMutationSuccessV4Schema.parse(await response.json());
            },
            readHttpStatus: error => error instanceof ConnectedServiceApiError ? error.status : null,
            readFailureCode: error => error instanceof ConnectedServiceApiError ? error.code ?? null : null,
        }),
    };
}
