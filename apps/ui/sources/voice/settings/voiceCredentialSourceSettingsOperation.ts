import { SettingsDeclarationValueV1Schema } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import type { SettingOperationContext, SettingOperationResult } from '@/components/settings/catalog/settingDeclarations';
import { mutateScopedAccountVoiceCredentialSource } from '@/voice/credentials/accountVoiceCredential';
import type { VoiceProviderRegistry, VoiceProviderRegistryEntry } from '@/voice/registry/providerRegistry';
import { qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { storage } from '@/sync/domains/state/storage';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { getConnectedAccountAuthentication } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { resolveVoiceConnectedAccountTargetEligibility } from '@/voice/credentials/sourceEligibility';

/** Public source choice adapts the existing atomic Settings + qualified-purpose owner. */
export async function invokeVoiceCredentialSourceSettingsOperation(
    entry: VoiceProviderRegistryEntry,
    registry: VoiceProviderRegistry,
    context: SettingOperationContext,
): Promise<SettingOperationResult> {
    const input = context.input;
    if (input?.kind !== 'voice_credential_source') return { status: 'unavailable', reason: 'operation_input_required' };
    const declaration = 'declaration' in entry ? entry.declaration : null;
    if (!declaration || !context.accountScope) return { status: 'unavailable', reason: 'credential_source_unavailable' };
    const mutation = {
        contribution: { pluginId: entry.pluginId, localId: declaration.id },
        credentialSlotId: input.credentialSlotId,
        expectedSettingsVersion: input.expectedSettingsVersion,
        selection: input.selection,
    };
    const declaredServices = declaration.credentials?.sources.flatMap(source => source.kind === 'connectedAccount'
        ? [qualifyPluginContributionReferenceV1(source.service, entry.pluginId)] : []) ?? [];
    const sourceUsable = () => {
        if (input.selection.kind !== 'connectedAccount') return true;
        const state = storage.getState();
        return areAccountSettingsScopesEqual(state.settingsScope, context.accountScope)
            && resolveVoiceConnectedAccountTargetEligibility({
                target: input.selection.target, declaredServices,
                accounts: state.profile.connectedAccountsV4 ?? [],
                groups: state.profile.connectedAccountGroupsV4 ?? [],
                resolveAuthentication: getConnectedAccountAuthentication,
            }) === 'usable';
    };
    if (!sourceUsable()) return { status: 'unavailable', reason: 'credential_source_unavailable' };
    const result = await mutateScopedAccountVoiceCredentialSource({
        scope: context.accountScope,
        mutation,
        resolveCurrentDeclaration: () => {
            if (!context.isCurrent() || !sourceUsable()) return null;
            const current = registry.get(entry.providerId);
            return current && 'declaration' in current ? current.declaration ?? null : null;
        },
    });
    // Selection-only receipts contain references and versions, never credential material or recovery callbacks.
    return { status: 'completed', value: SettingsDeclarationValueV1Schema.parse(result) };
}
