import type { ConnectedAccountPurposeMutationIntentV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { areAccountSettingsJsonValuesEqual } from '@/sync/domains/settings/accountSettingsStructuralEquality';
import { resolveSettingsSecretsKeySet } from '@/sync/encryption/resolveSettingsSecretsKeySet';
import { readAccountSettingsBaseline } from '@/sync/engine/settings/accountSettingsBaseline';
import { requireOneShotAccountSettingsMutationApplied, syncSettings } from '@/sync/engine/settings/syncSettings';
import { ConnectedAccountCatalogOperationError, readConnectedAccountCatalogInContext,
    requireUpdatedConnectedAccountCatalogMutation, writeConnectedAccountCatalogRecordAndPublishInContext,
    type ConnectedAccountCatalogAccountContext } from '@/sync/api/account/apiConnectedAccountCatalog';

/** Purpose defaults and actual predecessor-carrier retirement share one acknowledged transaction. */
export async function mutateConnectedAccountPurposeDefaultsInContext(context: ConnectedAccountCatalogAccountContext,
    mutate: ConnectedAccountPurposeMutationIntentV1, signal?: AbortSignal): Promise<void> {
    const catalog = await readConnectedAccountCatalogInContext(context, 'purposes', signal);
    context.assertCurrent();
    signal?.throwIfAborted();
    if (catalog.status !== 'ready' || catalog.record.key !== 'purposes') {
        throw new ConnectedAccountCatalogOperationError(catalog.status === 'unavailable' ? catalog.reason : 'connected_account_purpose_catalog_unavailable');
    }
    const { accountMode, encryption } = await context.resolveAccountEncryption();
    const baseline = await readAccountSettingsBaseline({ request: context.request, credentials: context.credentials, encryption, accountMode });
    context.assertCurrent();
    const raw = baseline.raw;
    if (raw === null && baseline.content !== null) throw new ConnectedAccountCatalogOperationError('invalid-stored-content');
    const legacySettings = raw ?? {};
    const next = mutate(catalog.record.value, legacySettings);
    if (!next) return;
    const record = { key: 'purposes' as const, value: next.purposeBindings };
    const changedLegacy = Object.fromEntries(Object.entries(next.legacySettingsDelta).filter(([key, value]) =>
        !areAccountSettingsJsonValuesEqual(legacySettings[key], value)
        && (Object.prototype.hasOwnProperty.call(legacySettings, key) || Object.keys(value.bindingsByAgentId).length > 0)));
    if (Object.keys(changedLegacy).length === 0) {
        requireUpdatedConnectedAccountCatalogMutation(await writeConnectedAccountCatalogRecordAndPublishInContext(context,
            { record, expectedRevision: catalog.revision }, signal));
        return;
    }
    const scope = { serverId: context.serverId, accountId: context.accountId };
    const keys = await resolveSettingsSecretsKeySet({ credentials: context.credentials, scope });
    context.assertCurrent();
    requireOneShotAccountSettingsMutationApplied(await syncSettings({ credentials: context.credentials, encryption, signal,
        settingsScope: scope, settingsSecretsKey: keys?.writeKey ?? null, settingsSecretsReadKeys: keys?.readKeys ?? [],
        requestContext: { scope, endpointUrl: context.endpointUrl, request: context.request },
        pendingSettings: {}, clearPendingSettings: () => {}, oneShotServerSettingsMutation: {
            expectedSettingsVersion: baseline.version, rebaseOnConflict: false,
            mutate: current => { context.assertCurrent(); return { settings: { ...current, ...changedLegacy }, value: undefined }; },
            commitPrepared: async prepared => {
                context.assertCurrent();
                try {
                    const result = await writeConnectedAccountCatalogRecordAndPublishInContext(context, {
                        record, expectedRevision: catalog.revision, settingsMutation: {
                            expectedSettingsVersion: prepared.expectedSettingsVersion, content: prepared.content,
                        },
                    }, signal);
                    if (result.status === 'updated' && result.settingsVersion !== undefined) return { status: 'applied', settingsVersion: result.settingsVersion };
                    if (result.status === 'conflict' || result.status === 'settings-conflict') return { status: 'conflict' };
                    return { status: 'rejected', error: new ConnectedAccountCatalogOperationError(result.status) };
                } catch (error) {
                    if (error instanceof ConnectedAccountCatalogOperationError && error.code === 'outcome_unknown') return { status: 'outcomeUnknown' };
                    return { status: 'rejected', error: error instanceof Error ? error : new Error('connected_account_purpose_catalog_unavailable') };
                }
            },
        } }));
}
