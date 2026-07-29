function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hasOnlyKeys(value, keys) {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedJson(value, depth = 0) {
  if (depth > 8) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 4096;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 256 && value.every((entry) => isBoundedJson(entry, depth + 1));
  return isRecord(value)
    && Object.keys(value).length <= 256
    && Object.entries(value).every(([key, entry]) => key.length <= 256 && isBoundedJson(entry, depth + 1));
}

function parseHostAccess(value, optional) {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'capability', 'reason', 'authorizationClass', 'normalizedScope'])) return null;
  const id = readNonEmptyString(value.id);
  const capability = readNonEmptyString(value.capability);
  const reason = readNonEmptyString(value.reason);
  const authorizationClass = value.authorizationClass;
  return id
    && capability
    && reason
    && (
      authorizationClass === 'cooperativeDisclosure'
      || authorizationClass === 'hostResourceSelection'
      || authorizationClass === 'presentIntentOrOs'
    )
    && (!optional || authorizationClass === 'hostResourceSelection')
    && isRecord(value.normalizedScope)
    && isBoundedJson(value.normalizedScope)
    ? { id, capability, reason, authorizationClass, normalizedScope: value.normalizedScope }
    : null;
}

function parseHostAccessList(value, optional) {
  if (!Array.isArray(value) || value.length > 128) return null;
  const entries = value.map((entry) => parseHostAccess(entry, optional));
  const ids = entries.map((entry) => entry?.id);
  return entries.some((entry) => entry === null) || new Set(ids).size !== ids.length ? null : entries;
}

function parseStringList(value, maximum = 64) {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const entries = value.map(readNonEmptyString);
  return entries.some((entry) => entry === null) || new Set(entries).size !== entries.length ? null : entries;
}

function parsePublisher(value) {
  if (!isRecord(value)) return null;
  if (value.status === 'unavailable' && hasOnlyKeys(value, ['status'])) return { status: 'unavailable' };
  const id = readNonEmptyString(value.id);
  const displayName = readNonEmptyString(value.displayName);
  return value.status === 'unverified' && hasOnlyKeys(value, ['status', 'id', 'displayName']) && id && displayName
    ? { status: 'unverified', id, displayName }
    : null;
}

function parseUpdateChannel(value) {
  if (!isRecord(value)) return null;
  if (value.kind === 'path') {
    const locator = readNonEmptyString(value.locator);
    return hasOnlyKeys(value, ['kind', 'locator', 'development']) && locator && typeof value.development === 'boolean'
      ? { kind: 'path', locator, development: value.development }
      : null;
  }
  if (value.kind === 'archive') {
    const locator = readNonEmptyString(value.locator);
    return hasOnlyKeys(value, ['kind', 'locator']) && locator ? { kind: 'archive', locator } : null;
  }
  if (
    value.kind !== 'npm'
    || !hasOnlyKeys(value, ['kind', 'packageName', 'registryOrigin', 'registryProfileId', 'marketplaceSource'])
  ) return null;
  const packageName = readNonEmptyString(value.packageName);
  const registryOrigin = readNonEmptyString(value.registryOrigin);
  const registryProfileId = value.registryProfileId === undefined
    ? undefined
    : readNonEmptyString(value.registryProfileId);
  if (!packageName || !registryOrigin) return null;
  if (value.registryProfileId !== undefined && !registryProfileId) return null;
  const base = {
    kind: 'npm',
    packageName,
    registryOrigin,
    ...(registryProfileId ? { registryProfileId } : {}),
  };
  if (value.marketplaceSource === undefined) return base;
  if (!isRecord(value.marketplaceSource) || !hasOnlyKeys(value.marketplaceSource, ['id', 'kind', 'sourceUrl'])) return null;
  const id = readNonEmptyString(value.marketplaceSource.id);
  const sourceUrl = readNonEmptyString(value.marketplaceSource.sourceUrl);
  const kind = value.marketplaceSource.kind;
  return id && sourceUrl && (kind === 'curated' || kind === 'community-npm')
    ? { ...base, marketplaceSource: { id, kind, sourceUrl } }
    : null;
}

function parseSignature(value) {
  if (!isRecord(value)) return null;
  if (value.status === 'notProvided' && hasOnlyKeys(value, ['status'])) return { status: 'notProvided' };
  const keyId = readNonEmptyString(value.keyId);
  return (value.status === 'verified' || value.status === 'unsupported')
    && hasOnlyKeys(value, ['status', 'keyId'])
    && keyId
    ? { status: value.status, keyId }
    : null;
}

function parseProvenance(value) {
  if (!isRecord(value)) return null;
  if (value.status === 'notProvided' && hasOnlyKeys(value, ['status'])) return { status: 'notProvided' };
  if (value.status === 'declaredUnverified' && hasOnlyKeys(value, ['status', 'predicateType'])) {
    const predicateType = readNonEmptyString(value.predicateType);
    return predicateType ? { status: 'declaredUnverified', predicateType } : null;
  }
  if (value.status === 'retrievedUnverified' && hasOnlyKeys(value, ['status', 'predicateTypes'])) {
    const predicateTypes = parseStringList(value.predicateTypes);
    return predicateTypes?.length ? { status: 'retrievedUnverified', predicateTypes } : null;
  }
  if (value.status === 'unavailable' && hasOnlyKeys(value, ['status', 'code'])) {
    const code = readNonEmptyString(value.code);
    return code ? { status: 'unavailable', code } : null;
  }
  return null;
}

function parseCuration(value) {
  if (!isRecord(value)) return null;
  if (value.status === 'notApplicable' && hasOnlyKeys(value, ['status'])) return { status: 'notApplicable' };
  const sourceId = readNonEmptyString(value.sourceId);
  if (!sourceId) return null;
  if (value.status === 'unreviewed' && hasOnlyKeys(value, ['status', 'sourceId'])) return { status: 'unreviewed', sourceId };
  if (value.status !== 'approved' || !hasOnlyKeys(value, ['status', 'sourceId', 'reviewedAt', 'reason'])) return null;
  const reviewedAt = readNonEmptyString(value.reviewedAt);
  const reason = value.reason === undefined || value.reason === null ? value.reason : readNonEmptyString(value.reason);
  return reviewedAt && (value.reason === undefined || value.reason === null || reason)
    ? { status: 'approved', sourceId, reviewedAt, ...(value.reason !== undefined ? { reason } : {}) }
    : null;
}

function parseReviewFacts(value) {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, [
      'pluginId', 'displayName', 'version', 'packageIdentity', 'publisherIdentity', 'source',
      'updateChannel', 'integrity', 'signature', 'provenance', 'curation', 'executableRealms',
      'contributions', 'uiArtifacts', 'requiredHostAccess', 'optionalHostAccess',
      'compatibility', 'updatePolicy',
    ])
  ) return null;
  const pluginId = readNonEmptyString(value.pluginId);
  const displayName = readNonEmptyString(value.displayName);
  const version = readNonEmptyString(value.version);
  const sourceKind = isRecord(value.source) ? value.source.kind : null;
  const sourceLocator = isRecord(value.source) ? readNonEmptyString(value.source.locator) : null;
  const sourceIntegrity = isRecord(value.source) && value.source.integrity !== undefined
    ? readNonEmptyString(value.source.integrity)
    : undefined;
  const executableRealms = Array.isArray(value.executableRealms)
    && value.executableRealms.every((realm) => realm === 'daemon' || realm === 'reactNative')
    && new Set(value.executableRealms).size === value.executableRealms.length
    ? value.executableRealms
    : null;
  const packageIdentity = isRecord(value.packageIdentity) && hasOnlyKeys(value.packageIdentity, ['name', 'version'])
    ? value.packageIdentity
    : null;
  const packageName = packageIdentity?.name === null ? null : readNonEmptyString(packageIdentity?.name);
  const packageVersion = readNonEmptyString(packageIdentity?.version);
  const publisherIdentity = parsePublisher(value.publisherIdentity);
  const updateChannel = parseUpdateChannel(value.updateChannel);
  const integrity = isRecord(value.integrity) && hasOnlyKeys(value.integrity, ['packageDigest', 'manifestDigest', 'uiArtifactDigest'])
    ? value.integrity
    : null;
  const digestPattern = /^sha256:[a-f0-9]{64}$/u;
  const packageDigest = readNonEmptyString(integrity?.packageDigest);
  const manifestDigest = readNonEmptyString(integrity?.manifestDigest);
  const uiArtifactDigest = readNonEmptyString(integrity?.uiArtifactDigest);
  const signature = parseSignature(value.signature);
  const provenance = parseProvenance(value.provenance);
  const curation = parseCuration(value.curation);
  const contributions = Array.isArray(value.contributions) && value.contributions.length <= 64
    ? value.contributions.flatMap((entry) => {
      const family = isRecord(entry) && hasOnlyKeys(entry, ['family', 'count']) ? readNonEmptyString(entry.family) : null;
      return family && Number.isSafeInteger(entry.count) && entry.count > 0 ? [{ family, count: entry.count }] : [];
    })
    : null;
  const uiArtifacts = isRecord(value.uiArtifacts) && hasOnlyKeys(value.uiArtifacts, ['status', 'contributionIds'])
    ? value.uiArtifacts
    : null;
  const uiArtifactIds = parseStringList(uiArtifacts?.contributionIds);
  const uiArtifactStatus = uiArtifacts?.status;
  const requiredHostAccess = parseHostAccessList(value.requiredHostAccess, false);
  const optionalHostAccess = parseHostAccessList(value.optionalHostAccess, true);
  const compatibility = isRecord(value.compatibility) && hasOnlyKeys(value.compatibility, ['happier', 'runtimeApiVersion'])
    ? value.compatibility
    : null;
  const happier = readNonEmptyString(compatibility?.happier);
  if (
    !pluginId
    || !displayName
    || !version
    || (sourceKind !== 'path' && sourceKind !== 'archive' && sourceKind !== 'npm')
    || !sourceLocator
    || (isRecord(value.source) && value.source.integrity !== undefined && !sourceIntegrity)
    || !isRecord(value.source)
    || !hasOnlyKeys(value.source, ['kind', 'locator', 'integrity'])
    || !packageIdentity
    || (packageIdentity.name !== null && !packageName)
    || !packageVersion
    || packageVersion !== version
    || !publisherIdentity
    || !updateChannel
    || !packageDigest
    || !manifestDigest
    || !uiArtifactDigest
    || !digestPattern.test(packageDigest)
    || !digestPattern.test(manifestDigest)
    || !digestPattern.test(uiArtifactDigest)
    || !signature
    || !provenance
    || !curation
    || !executableRealms
    || !contributions
    || contributions.length !== value.contributions.length
    || new Set(contributions.map((entry) => entry.family)).size !== contributions.length
    || !uiArtifactIds
    || (uiArtifactStatus !== 'verified' && uiArtifactStatus !== 'none' && uiArtifactStatus !== 'unavailable')
    || (uiArtifactStatus === 'none' && uiArtifactIds.length !== 0)
    || (uiArtifactStatus !== 'none' && uiArtifactIds.length === 0)
    || !requiredHostAccess
    || !optionalHostAccess
    || !happier
    || compatibility.runtimeApiVersion !== 1
    || (value.updatePolicy !== 'automatic' && value.updatePolicy !== 'manual' && value.updatePolicy !== 'pinned')
  ) {
    return null;
  }
  return {
    pluginId,
    displayName,
    version,
    packageIdentity: { name: packageName, version: packageVersion },
    publisherIdentity,
    source: {
      kind: sourceKind,
      locator: sourceLocator,
      ...(sourceIntegrity ? { integrity: sourceIntegrity } : {}),
    },
    updateChannel,
    integrity: { packageDigest, manifestDigest, uiArtifactDigest },
    signature,
    provenance,
    curation,
    executableRealms,
    contributions,
    uiArtifacts: { status: uiArtifactStatus, contributionIds: uiArtifactIds },
    requiredHostAccess,
    optionalHostAccess,
    compatibility: { happier, runtimeApiVersion: 1 },
    updatePolicy: value.updatePolicy,
  };
}

function diagnoseReviewFacts(value) {
  const digestPattern = /^sha256:[a-f0-9]{64}$/u;
  if (!isRecord(value)) return 'review: not_object';
  if (!hasOnlyKeys(value, [
    'pluginId', 'displayName', 'version', 'packageIdentity', 'publisherIdentity', 'source',
    'updateChannel', 'integrity', 'signature', 'provenance', 'curation', 'executableRealms',
    'contributions', 'uiArtifacts', 'requiredHostAccess', 'optionalHostAccess',
    'compatibility', 'updatePolicy',
  ])) return 'review: unexpected_field';
  if (!readNonEmptyString(value.pluginId)) return 'review.pluginId: invalid';
  if (!readNonEmptyString(value.displayName)) return 'review.displayName: invalid';
  const version = readNonEmptyString(value.version);
  if (!version) return 'review.version: invalid';
  if (
    !isRecord(value.source)
    || !hasOnlyKeys(value.source, ['kind', 'locator', 'integrity'])
    || (value.source.kind !== 'path' && value.source.kind !== 'archive' && value.source.kind !== 'npm')
    || !readNonEmptyString(value.source.locator)
    || (value.source.integrity !== undefined && !readNonEmptyString(value.source.integrity))
  ) return 'review.source: invalid';
  if (
    !isRecord(value.packageIdentity)
    || !hasOnlyKeys(value.packageIdentity, ['name', 'version'])
    || (value.packageIdentity.name !== null && !readNonEmptyString(value.packageIdentity.name))
    || readNonEmptyString(value.packageIdentity.version) !== version
  ) return 'review.packageIdentity: invalid';
  if (!parsePublisher(value.publisherIdentity)) return 'review.publisherIdentity: invalid';
  if (!parseUpdateChannel(value.updateChannel)) return 'review.updateChannel: invalid';
  if (
    !isRecord(value.integrity)
    || !hasOnlyKeys(value.integrity, ['packageDigest', 'manifestDigest', 'uiArtifactDigest'])
    || !digestPattern.test(readNonEmptyString(value.integrity.packageDigest) ?? '')
    || !digestPattern.test(readNonEmptyString(value.integrity.manifestDigest) ?? '')
    || !digestPattern.test(readNonEmptyString(value.integrity.uiArtifactDigest) ?? '')
  ) return 'review.integrity: invalid';
  if (!parseSignature(value.signature)) return 'review.signature: invalid';
  if (!parseProvenance(value.provenance)) return 'review.provenance: invalid';
  if (!parseCuration(value.curation)) return 'review.curation: invalid';
  if (
    !Array.isArray(value.executableRealms)
    || !value.executableRealms.every((realm) => realm === 'daemon' || realm === 'reactNative')
    || new Set(value.executableRealms).size !== value.executableRealms.length
  ) return 'review.executableRealms: invalid';
  if (!Array.isArray(value.contributions) || value.contributions.length > 64) {
    return 'review.contributions: invalid';
  }
  const contributionFamilies = value.contributions.map((entry) => (
    isRecord(entry)
    && hasOnlyKeys(entry, ['family', 'count'])
    && readNonEmptyString(entry.family)
    && Number.isSafeInteger(entry.count)
    && entry.count > 0
      ? entry.family.trim()
      : null
  ));
  if (
    contributionFamilies.some((family) => family === null)
    || new Set(contributionFamilies).size !== contributionFamilies.length
  ) return 'review.contributions: invalid';
  if (
    !isRecord(value.uiArtifacts)
    || !hasOnlyKeys(value.uiArtifacts, ['status', 'contributionIds'])
  ) return 'review.uiArtifacts: invalid';
  const uiArtifactIds = parseStringList(value.uiArtifacts.contributionIds);
  if (
    !uiArtifactIds
    || (
      value.uiArtifacts.status !== 'verified'
      && value.uiArtifacts.status !== 'none'
      && value.uiArtifacts.status !== 'unavailable'
    )
    || (value.uiArtifacts.status === 'none' && uiArtifactIds.length !== 0)
    || (value.uiArtifacts.status !== 'none' && uiArtifactIds.length === 0)
  ) return 'review.uiArtifacts: invalid';
  if (!parseHostAccessList(value.requiredHostAccess, false)) return 'review.requiredHostAccess: invalid';
  if (!parseHostAccessList(value.optionalHostAccess, true)) return 'review.optionalHostAccess: invalid';
  if (
    !isRecord(value.compatibility)
    || !hasOnlyKeys(value.compatibility, ['happier', 'runtimeApiVersion'])
    || !readNonEmptyString(value.compatibility.happier)
    || value.compatibility.runtimeApiVersion !== 1
  ) return 'review.compatibility: invalid';
  if (
    value.updatePolicy !== 'automatic'
    && value.updatePolicy !== 'manual'
    && value.updatePolicy !== 'pinned'
  ) return 'review.updatePolicy: invalid';
  return 'review: invalid';
}

export function readPluginInstallReviewRequiredEnvelope(envelope) {
  if (
    !isRecord(envelope)
    || envelope.ok !== false
    || envelope.kind !== 'plugins_install'
    || !isRecord(envelope.error)
  ) {
    throw new Error('Candidate plugin install did not return the required review_required envelope');
  }
  const details = isRecord(envelope.error.details) ? envelope.error.details : envelope.error;
  if (envelope.error.code !== 'review_required' || !isRecord(details)) {
    throw new Error('Candidate plugin install did not return the required review_required envelope');
  }
  const pendingChangeId = readNonEmptyString(details.pendingChangeId);
  const review = parseReviewFacts(details.review);
  if (!pendingChangeId) {
    throw new Error('Candidate plugin install returned malformed review_required facts (pendingChangeId: invalid)');
  }
  if (!review) {
    throw new Error(`Candidate plugin install returned malformed review_required facts (${diagnoseReviewFacts(details.review)})`);
  }
  return { pendingChangeId, review };
}
