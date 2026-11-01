/** Semantic bundled UI projection. The app inventory supplies compiler facts,
 * while the build-owned declaration projector owns their interpretation. */
export async function projectBundledPluginUiDeclaration({ packageName, packageVersion, manifest, artifactGraphs }) {
  const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
  const { projectPluginPortableUiDeclarationsV1 } = await import('@happier-dev/protocol/plugins/contributions/ui');
  const { normalizePluginAccountCollectionContractsV1 } = await import('@happier-dev/protocol/plugins/data/collectionsV1');
  const { normalizeStrictJsonValue } = await import('@happier-dev/protocol/json/strictJsonValue');
  const declaration = PluginPortableReleaseManifestV1Schema.safeParse(manifest);
  if (!declaration.success) return undefined;
  const normalizedManifest = { ...declaration.data, version: packageVersion };
  // JSON publication must not silently omit opaque schema members (for
  // example enum: undefined) and thereby change their authored meaning.
  normalizeStrictJsonValue(normalizedManifest);
  const pluginId = normalizedManifest.id;
  return {
    pluginId, pluginVersion: packageVersion, packageName,
    ...((normalizedManifest.contributes.machineProvisioners?.length ?? 0) > 0 ? { hasMachineProvisioners: true } : {}),
    displayName: typeof normalizedManifest.displayName === 'string' ? normalizedManifest.displayName : normalizedManifest.displayName.fallback,
    normalizedManifest,
    artifactGraphs,
    declaredExecution: {
      daemonActions: normalizedManifest.contributes.actions?.some(action => !action.execution || action.execution.target === 'daemon') === true,
      contributionPoints: (normalizedManifest.contributes.pluginContributionPoints?.length ?? 0) > 0,
    },
    entriesById: projectPluginPortableUiDeclarationsV1(normalizedManifest, artifactGraphs),
    collectionContracts: normalizePluginAccountCollectionContractsV1({ pluginId,
      contributions: normalizedManifest.contributes.accountCollections }).map(({ pluginId, collectionId, schemaVersion, contractDigest }) =>
      ({ pluginId, collectionId, schemaVersion, contractDigest })),
  };
}

/** Discovery is a projection of the admitted declaration, never an executable manifest. */
export async function projectBundledPluginUiFirstPaintDeclaration(declaration) {
  const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
  const { normalizedManifest, entriesById, ...identity } = declaration;
  const contributes = normalizedManifest.contributes;
  const emptyUi = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: normalizedManifest.id,
    version: normalizedManifest.version, displayName: normalizedManifest.displayName,
    runtime: { apiVersion: 1 }, contributes: {} }).contributes.ui;
  const actions = (contributes.actions ?? []).filter(action => action.execution.target === 'account')
    .map(({ inputSchema, resultSchema, ...descriptor }) => descriptor);
  const presentationManifest = { ...normalizedManifest, contributes: {
    ...Object.fromEntries(Object.entries(contributes).filter(([key]) => key !== 'ui')
      .map(([key, value]) => [key, Array.isArray(value) ? [] : value])),
    actions,
    resources: contributes.resources,
    connectedAccountDescriptors: contributes.connectedAccountDescriptors,
    secretSources: contributes.secretSources,
    ui: emptyUi,
  } };
  const discoveryEntry = value => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(discoveryEntry);
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !(value.kind === 'declarative' && key === 'model'))
      .map(([key, child]) => [key, discoveryEntry(child)]));
  };
  const entries = Object.fromEntries(Object.entries(entriesById).filter(([, entry]) => entry.contributionKind !== 'translations')
    .map(([id, entry]) => [id, discoveryEntry(entry)]));
  // Navigation and Action labels must stay localized before a body is opened.
  // Keep only keys actually referenced by these descriptors, in every locale.
  const keys = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.key === 'string' && typeof value.fallback === 'string') keys.add(value.key);
    // Canonical view/badge projection flattens localized text into these fields.
    if (typeof value.titleKey === 'string') keys.add(value.titleKey);
    if (typeof value.labelKey === 'string') keys.add(value.labelKey);
    for (const child of Object.values(value)) visit(child);
  };
  visit(entries);
  visit(presentationManifest);
  for (const [id, entry] of Object.entries(entriesById)) {
    if (entry.contributionKind !== 'translations') continue;
    entries[id] = { ...entry, ...(entry.bundles ? { bundles: Object.fromEntries(Object.entries(entry.bundles)
      .map(([locale, bundle]) => [locale, Object.fromEntries(Object.entries(bundle).filter(([key]) => keys.has(key)))])) } : {}) };
  }
  return { ...identity, entriesById: entries, presentationManifest,
    targetedPluginIds: [...new Set((contributes.targetedPluginContributions ?? []).map(row => row.target.pluginId))].sort() };
}
