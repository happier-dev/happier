import { normalizeCustomProviderTemplateV1 } from '@happier-dev/protocol/providers/connections/normalizeCustomTemplateV1';
import { ProviderConnectionV1Schema } from '@happier-dev/protocol/providers/connections/v1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ProviderConnectionsCatalogImportResultV1 } from '@happier-dev/protocol/providers/connections/providerConnectionsCatalogV1';
import { listProviderConnectionsCatalogSavedSecretRefsV1 } from '@happier-dev/protocol/providers/connections/providerConnectionsCatalogV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ProviderCatalogCryptoAdmission } from '@/sync/store/settings/providerCatalogSnapshot';
import type { SavedSecretVerifiedImportReference } from '@/sync/domains/settings/savedSecretTypes';
import type { SavedSecretPrivateCreationApprovalOptions } from '@/components/secrets/useSavedSecretCatalog';
import { readSavedSecretTransferSourceV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';

import { VoiceLocalConversationProviderChatSchema } from './settings';

export { LEGACY_VOICE_OPENAI_CHAT_COMPATIBLE_AGENT_ID, completeLegacyVoiceOpenAiChatAgentSelection, migrateLegacyVoiceOpenAiChatProvider, resolveLegacyVoiceOpenAiChatImportState } from '@happier-dev/protocol/voice/settings/legacyOpenAiChatProviderMigration';
import { resolveLegacyVoiceOpenAiChatImportState, readLegacyVoiceOpenAiChatConfig as readLegacyConfig, readLegacyVoiceOpenAiChatPath as readPath, readLegacyVoiceOpenAiChatModelId as readModelId } from '@happier-dev/protocol/voice/settings/legacyOpenAiChatProviderMigration';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Import the retained source through the Provider owner, then retire it with exact Settings CAS. */
export async function importLegacyVoiceOpenAiChatProvider(
  scope: ServerAccountScope,
  approval?: SavedSecretPrivateCreationApprovalOptions,
): Promise<ProviderConnectionsCatalogImportResultV1 | Readonly<{ status: 'applied'; settingsVersion: number }>> {
  const [{ captureLazyActionAccountContext }, providerApi, snapshots, { settingsParse }, voiceSettings,
    { normalizeVoiceSettingsLocalDelta }] = await Promise.all([
    import('@/sync/ops/actions/actionAccountContext'), import('@/sync/api/account/apiProviderCatalog'),
    import('@/sync/store/settings/providerCatalogSnapshot'), import('@/sync/domains/settings/settings'),
    import('@/sync/domains/settings/voiceSettings'), import('@/sync/domains/settings/voiceSettingsPersistence'),
  ]);
  const context = await captureLazyActionAccountContext(scope.serverId, approval?.signal);
  try {
    if (context.accountId !== scope.accountId) return { status: 'cancelled' };
    // Bootstrap maintenance can advance Settings. Capture the retained Voice source afterwards.
    const base = await providerApi.readProviderCatalogInContext(context);
    if (base.status !== 'ready') return { status: 'unavailable',
      reason: base.status === 'unavailable' ? base.reason : 'catalog-not-ready' };
    let source = await context.readRawSettingsSnapshot();
    const config = readLegacyConfig(source.raw);
    const legacy = asRecord(asRecord(config?.agent)?.openaiCompat);
    const selectedProviderId = readPath(source.raw.voice, ['providerId']);
    if (resolveLegacyVoiceOpenAiChatImportState(source.raw, settingsParse(source.raw))?.reason
      !== 'provider_catalog_import_required') return { status: 'invalid' };
    let credential: SavedSecretVerifiedImportReference | undefined;
    if (legacy?.chatApiKey != null) {
      const { importLegacySavedSecretsInContext, verifyRetainedLegacySavedSecretReferenceInContext } = await import('@/sync/ops/settings/savedSecretResourceOperations');
      const originalCredential = readSavedSecretTransferSourceV1(source.raw).legacyChatCredential;
      let verifiedReferences: readonly SavedSecretVerifiedImportReference[] | undefined;
      if (originalCredential?.source.kind === 'existing-resource-reference') {
        const verified = await verifyRetainedLegacySavedSecretReferenceInContext(context, scope, originalCredential);
        if (!verified.ok) return verified.reason === 'changed' ? { status: 'conflict' }
          : { status: 'unavailable', reason: 'saved-secret-import-pending' };
        verifiedReferences = [verified.reference];
      } else {
        const importedSecrets = await importLegacySavedSecretsInContext(context, await context.resolveAccountMode(), scope, approval);
        if (importedSecrets.status !== 'complete') return importedSecrets.reason === 'outcome_unknown'
          ? { status: 'outcome_unknown' } : { status: 'unavailable', reason: 'saved-secret-import-pending' };
        verifiedReferences = importedSecrets.verifiedReferences;
      }
      context.assertCurrent();
      // S2 may legitimately replace a personal binding. Consume only its fresh, proven source identity.
      source = await context.readRawSettingsSnapshot();
      if (!sameStrictJsonValue(readLegacyConfig(source.raw), config)
        || !sameStrictJsonValue(readPath(source.raw.voice, ['providerId']), selectedProviderId)) return { status: 'conflict' };
      const origin = readSavedSecretTransferSourceV1(source.raw).legacyChatCredential;
      credential = origin && verifiedReferences?.find(reference => sameStrictJsonValue(reference.source, origin.source));
      if (!credential) return { status: 'unavailable', reason: 'saved-secret-import-pending' };
    }
    const admittedCredential = credential;
    const chatModelId = readModelId(legacy?.chatModel)!;
    const commitModelId = readModelId(legacy?.commitModel)!;
    const connection = ProviderConnectionV1Schema.parse({ v: 1, id: 'voice-openai-compatible-chat',
      source: { kind: 'custom', template: normalizeCustomProviderTemplateV1({
        name: 'Voice OpenAI-compatible Chat', protocol: 'openai-chat', baseUrl: String(legacy?.chatBaseUrl), catalog: 'manual',
        ...(admittedCredential ? { credentialStyle: 'bearer' as const } : {}),
      }) }, role: 'named', displayName: 'Voice OpenAI-compatible Chat', displayNameMode: 'custom',
      revision: 1, createdAt: 0, updatedAt: 0,
      modelSettings: {
        [commitModelId]: { temperature: 0.2, maxTokens: legacy?.maxTokens ?? null },
        [chatModelId]: { temperature: legacy?.temperature ?? 0.4, maxTokens: legacy?.maxTokens ?? null },
      },
    });
    const pending = VoiceLocalConversationProviderChatSchema.parse({ status: 'needs_selection',
      providerConnectionId: connection.id, chatModelId, commitModelId,
    });
    let cryptoAdmission: ProviderCatalogCryptoAdmission | null = null;
    const imported = await providerApi.readProviderCatalogInContext(context, undefined, {
      onCryptoAdmission: admission => { cryptoAdmission = admission; },
      onReady: (catalog, current) => snapshots.applyProviderCatalogSnapshot(scope, catalog, current(), cryptoAdmission),
      importConnection: { candidate: { connection,
        ...(admittedCredential ? { secretBindings: { account: { apiKey: admittedCredential.resourceRef } } } : {}),
        manualModels: [...new Set([chatModelId, commitModelId])].map(id => ({ id, addedAt: 0 })),
      }, isCurrent: context.accountLifetime.isCurrent, commitCatalog: async input => {
        const { captureSavedSecretReferenceRevisionsInContext } = await import('@/sync/api/account/apiSavedSecretCatalog');
        const captures = admittedCredential ? await captureSavedSecretReferenceRevisionsInContext(context, {
          references: listProviderConnectionsCatalogSavedSecretRefsV1(input.catalog).map(reference => reference.secretId),
        }) : undefined;
        if (admittedCredential) {
          const reference = parseSavedSecretRefV1(admittedCredential.resourceRef);
          if (reference.kind !== 'shared_resource' || !captures?.savedSecretRevisions.some(proof =>
            proof.resourceId === reference.resourceId && proof.expectedRevision === admittedCredential.revision)) return { status: 'conflict' };
        }
        try {
          const result = await providerApi.writeProviderCatalogInContext(context, { ...input,
            ...(captures ? { savedSecretRevisions: captures.savedSecretRevisions } : {}),
          });
          if (result.status === 'updated') return { status: 'applied' };
          if (result.status === 'conflict' || result.status === 'settings-conflict') return { status: 'conflict' };
          return { status: 'refused', reason: result.status };
        } catch (error) {
          if (error instanceof providerApi.ProviderCatalogOperationError && error.code === 'outcome_unknown') return { status: 'outcome_unknown' };
          throw error;
        }
      } },
    });
    if (imported.status !== 'applied' && imported.status !== 'unchanged') return imported;
    context.assertCurrent();
    if (admittedCredential) {
      const { readSavedSecretReferenceInContext } = await import('@/sync/api/account/apiSavedSecretCatalog');
      const current = await readSavedSecretReferenceInContext(context, admittedCredential.resourceRef);
      if (!current.ok || current.revision !== admittedCredential.revision) return { status: 'conflict' };
    }
    const saved = await context.mutateRawSettings(raw => {
      if (!sameStrictJsonValue(readLegacyConfig(raw), config)) throw new Error('voice_settings_provider_changed');
      const currentVoice = settingsParse(raw).voice;
      const currentLocal = voiceSettings.readLocalConversationVoiceSettings(currentVoice);
      const nextVoice = voiceSettings.writeLocalConversationVoiceSettings(currentVoice, { ...currentLocal,
        agent: { ...currentLocal.agent, providerChat: pending },
      });
      return { ...raw, ...normalizeVoiceSettingsLocalDelta({ voice: nextVoice }, raw) };
    }, { expectedSettingsVersion: source.version, rebaseOnConflict: false, observeOutcome: true });
    if (saved.status === 'applied') return { status: 'applied', settingsVersion: saved.settingsVersion };
    return saved.status === 'outcomeUnknown' ? { status: 'outcome_unknown' } : { status: 'conflict' };
  } finally { context.dispose(); }
}
