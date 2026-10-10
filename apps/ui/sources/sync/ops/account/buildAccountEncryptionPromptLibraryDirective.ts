import { AccountEncryptionMigratePromptLibraryDirectiveV1Schema, sealPromptLibraryContentV1,
  type AccountEncryptionMigratePromptLibraryDirectiveV1, type PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { PROMPT_LIBRARY_RETAINED_ROOTS_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { LEGACY_ROLE_GUIDANCE_HISTORY_ROOTS_V1 } from '@happier-dev/protocol/account/settings/accountSettingsHistoryRestoreV1';
import { RETIRED_ACCOUNT_SETTINGS_ROOT_KEYS } from '@happier-dev/protocol/account/settings/accountSettings';
import { CONNECTED_PRESENTATION_SOURCE_ROOTS_V1, CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1,
  CONNECTED_DISCLOSURE_SOURCE_ROOT_V1 } from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';

/** Conversion preserves raw source retirement, not the default-filled runtime facade. */
export function restoreAccountEncryptionPromptLibrarySettingsSources(params: Readonly<{
  settings: Readonly<object>;
  rawSettings: Readonly<Record<string, unknown>>;
}>): Record<string, unknown> {
  const settings: Record<string, unknown> = { ...params.settings };
  const roots = new Set<string>([...Object.values(PROMPT_LIBRARY_RETAINED_ROOTS_V1), ...LEGACY_ROLE_GUIDANCE_HISTORY_ROOTS_V1,
    ...RETIRED_ACCOUNT_SETTINGS_ROOT_KEYS, ...CONNECTED_PRESENTATION_SOURCE_ROOTS_V1,
    ...CONNECTED_ACKNOWLEDGEMENTS_SOURCE_ROOTS_V1, CONNECTED_DISCLOSURE_SOURCE_ROOT_V1]);
  // Preserve source absence even before ordinary writers retire these roots.
  roots.add('remoteHostsV1');
  roots.add('notificationChannelsV1');
  roots.add('providerSettingsV1');
  for (const root of roots) {
    if (Object.hasOwn(params.rawSettings, root)) settings[root] = params.rawSettings[root];
    else delete settings[root];
  }
  return settings;
}

export type AccountEncryptionPromptLibraryMigrationCandidate = Readonly<{
  revision: number;
  record: PromptLibraryRecordV1;
}>;

export function buildAccountEncryptionPromptLibraryDirective(params: Readonly<{
  candidates: readonly AccountEncryptionPromptLibraryMigrationCandidate[];
  target: Readonly<{ mode: 'plain' }> | Readonly<{
    mode: 'e2ee'; material: AccountScopedCryptoMaterial; randomBytes(length: number): Uint8Array;
  }>;
}>): AccountEncryptionMigratePromptLibraryDirectiveV1 | undefined {
  if (params.candidates.length === 0) return undefined;
  return AccountEncryptionMigratePromptLibraryDirectiveV1Schema.parse({
    items: params.candidates.map(({ record, revision }) => ({
      key: record.key, expectedRevision: revision,
      content: sealPromptLibraryContentV1({ record, mode: params.target.mode,
        material: params.target.mode === 'plain' ? null : params.target.material,
        ...(params.target.mode === 'e2ee' ? { randomBytes: params.target.randomBytes } : {}),
      }),
    })),
  });
}
