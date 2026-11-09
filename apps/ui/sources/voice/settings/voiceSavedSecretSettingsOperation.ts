import { SettingsDeclarationValueV1Schema } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';

import type { SettingOperationContext, SettingOperationResult } from '@/components/settings/catalog/settingDeclarations';
import { Modal } from '@/modal';
import { settingsParse } from '@/sync/domains/settings/settings';
import { refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import {
    createAccountVoiceCredentialBindingMutation,
    mutateScopedAccountVoiceCredentialSource,
    removeAccountVoiceCredential,
    resolveExactAccountVoiceCredentialSecretId,
} from '@/voice/credentials/accountVoiceCredential';
import type { VoiceProviderRegistry, VoiceProviderRegistryEntry } from '@/voice/registry/providerRegistry';

/** Reference gestures share the picker owner; no credential value enters or leaves an Action. */
export async function invokeVoiceSavedSecretSettingsOperation(
    entry: VoiceProviderRegistryEntry,
    registry: VoiceProviderRegistry,
    context: SettingOperationContext,
): Promise<SettingOperationResult> {
    const input = context.input;
    if (input?.kind !== 'voice_saved_secret') return { status: 'unavailable', reason: 'operation_input_required' };
    const declaration = 'declaration' in entry ? entry.declaration : null;
    const scope = context.accountScope;
    if (!scope || !declaration?.credentials?.sources.some(source => source.kind === 'savedSecret')
        || declaration.credentials.slot.id !== input.credentialSlotId) {
        return { status: 'unavailable', reason: 'credential_source_unavailable' };
    }
    if (input.operation === 'review') return { status: 'unavailable', reason: 'operation_unavailable' };
    if (!context.isCurrent() || context.signal?.aborted) return { status: 'cancelled' };
    const contribution = { pluginId: entry.pluginId, localId: declaration.id };
    const sourceMutation = { contribution, credentialSlotId: input.credentialSlotId,
        expectedSettingsVersion: input.expectedSettingsVersion, selection: { kind: 'savedSecret' as const } };
    let settings = await context.readSettings();
    const resolve = (id: string) => resolveSavedSecretReference(scope, settings.secrets, id);
    const resolveExactId = () => resolveExactAccountVoiceCredentialSecretId({ settings, contribution,
        credentialSlotId: input.credentialSlotId, machineId: input.machineId });
    const retainedId = resolveExactId();
    const neededIds = input.operation === 'bind' ? [retainedId, input.secretId] : [retainedId];
    if (neededIds.some(id => id && resolve(id).status !== 'ready')) {
        await refreshSavedSecretCatalog(scope);
        settings = await context.readSettings();
    }
    const exactId = resolveExactId();
    const previous = exactId ? resolve(exactId) : null;
    if (input.operation === 'inspect') return { status: 'completed', value: {
        secretId: exactId, revision: previous?.revision ?? null,
    } };
    if (exactId !== input.expectedSecretId || (previous?.revision ?? null) !== input.expectedSecretUpdatedAt) {
        return { status: 'completed', value: { status: 'conflict' } };
    }
    const selectedId = input.operation === 'bind' ? input.secretId : exactId;
    const selected = selectedId ? resolve(selectedId) : null;
    if (!selectedId || !selected || selected.status !== 'ready' || selected.revision === null) return { status: 'unavailable', reason: 'saved_secret_record_unavailable' };
    const binding = { contribution, credentialSlotId: input.credentialSlotId, machineId: input.machineId,
        secretId: selectedId, expectedSecretId: input.expectedSecretId, expectedSecretUpdatedAt: input.expectedSecretUpdatedAt };
    if (input.operation === 'bind') {
        const result = await mutateScopedAccountVoiceCredentialSource({ scope,
            mutation: { ...sourceMutation, savedSecretMutation: createAccountVoiceCredentialBindingMutation(binding) },
            resolveCurrentDeclaration: () => {
                const current = registry.get(entry.providerId);
                return current && 'declaration' in current ? current.declaration ?? null : null;
            },
        });
        return { status: 'completed', value: SettingsDeclarationValueV1Schema.parse(result) };
    }
    const confirmed = await Modal.confirm(t('settingsVoice.local.voiceCredential.deleteTitle'), t('settingsVoice.local.voiceCredential.deleteAccountBody'),
        { destructive: true, confirmText: t('common.remove') });
    if (!confirmed) return { status: 'cancelled' };
    const result = await sync.mutateAccountSettingsOnce({ expectedSettingsScope: scope, expectedSettingsVersion: input.expectedSettingsVersion,
        mutate: raw => {
            const updated = removeAccountVoiceCredential({ ...binding, settings: settingsParse(raw), expectedSecretId: selectedId,
                expectedSecretUpdatedAt: selected.revision! });
            return { settings: { ...updated.accountSettings }, value: undefined };
        },
    });
    const { value: _value, ...receipt } = result.status === 'applied' ? result : { ...result, value: undefined };
    return { status: 'completed', value: SettingsDeclarationValueV1Schema.parse(receipt) };
}
