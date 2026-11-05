import {
  createSavedSecretMaterializerV1,
  type SavedSecretCatalogResourceInputV1,
  type SavedSecretCatalogState,
  type SavedSecretMaterializerV1,
} from './savedSecretCatalog';

/** Complete in-memory catalog fixture; production callers supply admitted material. */
export function withSavedSecretMaterializer<const T extends Readonly<{
  accountSettings?: unknown;
  savedSecretResources?: readonly SavedSecretCatalogResourceInputV1[];
  savedSecretCatalogState?: SavedSecretCatalogState;
  settingsSecretsReadKeys?: readonly (Uint8Array | null | undefined)[];
  savedSecretMaterializer?: SavedSecretMaterializerV1;
  isCurrent?: () => boolean;
}>>(input: T): Omit<T, 'savedSecretMaterializer'> & Readonly<{ savedSecretMaterializer: SavedSecretMaterializerV1 }> {
  return { ...input, savedSecretMaterializer: input.savedSecretMaterializer ?? createSavedSecretMaterializerV1({
    accountSettings: input.accountSettings ?? {},
    settingsSecretsReadKeys: input.settingsSecretsReadKeys?.filter((key): key is Uint8Array => key instanceof Uint8Array) ?? [],
    resources: input.savedSecretResources ?? [],
    resourceCatalogState: input.savedSecretCatalogState ?? 'ready',
    ...(input.isCurrent ? { isCurrent: input.isCurrent } : {}),
  }) };
}
