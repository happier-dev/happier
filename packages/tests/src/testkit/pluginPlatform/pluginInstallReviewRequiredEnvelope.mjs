function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBoundedNonEmptyString(value, maximum) {
  const result = readNonEmptyString(value);
  return result && result.length <= maximum ? result : null;
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

function parsePluginContributionLocalId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/u.test(value)
    ? value
    : null;
}

function parsePluginContributionIdentity(value) {
  if (!isRecord(value) || !hasOnlyKeys(value, ['pluginId', 'localId'])) return null;
  const pluginId = typeof value.pluginId === 'string'
    && value.pluginId.length >= 3
    && value.pluginId.length <= 256
    && /^(?!.*(?:^|\.)(?:__proto__|constructor|prototype)(?:\.|$))[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u.test(value.pluginId)
    ? value.pluginId
    : null;
  const localId = parsePluginContributionLocalId(value.localId);
  return pluginId && localId ? { pluginId, localId } : null;
}

function parseCanonicalRecordKey(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && value !== '__proto__'
    && value !== 'prototype'
    && value !== 'constructor'
    ? value
    : null;
}

function parseCanonicalRecordKeyList(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return null;
  const entries = value.map(parseCanonicalRecordKey);
  return entries.some((entry) => entry === null) || new Set(entries).size !== entries.length ? null : entries;
}

function parseHttpHeaderNames(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return null;
  const entries = value.map((entry) => {
    const headerName = readBoundedNonEmptyString(entry, 128);
    return headerName && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(headerName)
      ? headerName.toLowerCase()
      : null;
  });
  return entries.some((entry) => entry === null) || new Set(entries).size !== entries.length ? null : entries;
}

function parseRawCredentialRequest(value) {
  if (!isRecord(value)) return null;
  if (value.kind === 'httpHeaders') {
    const origin = readBoundedNonEmptyString(value.origin, 2_048);
    const headerNames = parseHttpHeaderNames(value.headerNames);
    if (!hasOnlyKeys(value, ['kind', 'origin', 'headerNames']) || !origin || !headerNames) return null;
    try {
      const url = new URL(origin);
      return url.protocol === 'https:'
        && !url.username
        && !url.password
        && url.pathname === '/'
        && !url.search
        && !url.hash
        && url.origin === origin
        ? { kind: 'httpHeaders', origin, headerNames }
        : null;
    } catch {
      return null;
    }
  }
  if (value.kind === 'environment') {
    const keys = parseCanonicalRecordKeyList(value.keys);
    return hasOnlyKeys(value, ['kind', 'keys']) && keys
      ? { kind: 'environment', keys }
      : null;
  }
  if (value.kind === 'files') {
    const fileIds = parseCanonicalRecordKeyList(value.fileIds);
    return hasOnlyKeys(value, ['kind', 'fileIds']) && fileIds
      ? { kind: 'files', fileIds }
      : null;
  }
  return null;
}

function parseRawCredentialSourceClass(value) {
  if (!isRecord(value)) return null;
  if (value.kind === 'savedSecret') {
    if (!hasOnlyKeys(value, ['kind', 'secretKinds']) || !Array.isArray(value.secretKinds)) return null;
    const secretKinds = value.secretKinds.filter((kind) => (
      kind === 'apiKey' || kind === 'token' || kind === 'password' || kind === 'other'
    ));
    return secretKinds.length === value.secretKinds.length
      && secretKinds.length > 0
      && secretKinds.length <= 4
      && new Set(secretKinds).size === secretKinds.length
      ? { kind: 'savedSecret', secretKinds }
      : null;
  }
  if (value.kind !== 'connectedAccount' || !hasOnlyKeys(value, ['kind', 'service'])) return null;
  const service = parsePluginContributionIdentity(value.service);
  return service ? { kind: 'connectedAccount', service } : null;
}

function parseRawCredentialAccess(value) {
  if (!Array.isArray(value)) return null;
  const access = [];
  for (const entry of value) {
    if (
      !isRecord(entry)
      || !hasOnlyKeys(entry, [
        'accessMode', 'contribution', 'credentialSlot', 'sourceClass', 'realm', 'phase', 'request',
      ])
      || entry.accessMode !== 'raw'
    ) return null;
    const contribution = parsePluginContributionIdentity(entry.contribution);
    const credentialSlot = entry.credentialSlot;
    if (!contribution || !isRecord(credentialSlot) || !hasOnlyKeys(credentialSlot, ['id', 'title', 'purpose'])) return null;
    const id = parseCanonicalRecordKey(credentialSlot.id);
    const title = readBoundedNonEmptyString(credentialSlot.title, 32_768);
    const purpose = readBoundedNonEmptyString(credentialSlot.purpose, 128);
    const sourceClass = parseRawCredentialSourceClass(entry.sourceClass);
    const request = parseRawCredentialRequest(entry.request);
    if (
      !id
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)
      || !title
      || !purpose
      || !sourceClass
      || !request
      || (entry.realm !== 'web' && entry.realm !== 'ios' && entry.realm !== 'android' && entry.realm !== 'daemon')
      || (entry.phase !== 'settings' && entry.phase !== 'prepare' && entry.phase !== 'connection' && entry.phase !== 'speech')
    ) return null;
    access.push({
      accessMode: 'raw',
      contribution,
      credentialSlot: { id, title, purpose },
      sourceClass,
      realm: entry.realm,
      phase: entry.phase,
      request,
    });
  }
  return access;
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

function parseReviewSource(value) {
  if (!isRecord(value)) return null;
  const locator = readNonEmptyString(value.locator);
  if (!locator) return null;
  if (value.kind === 'path') {
    return hasOnlyKeys(value, ['kind', 'locator'])
      ? { kind: 'path', locator }
      : null;
  }
  if (value.kind !== 'archive' && value.kind !== 'npm') return null;
  const integrity = value.integrity === undefined ? undefined : readNonEmptyString(value.integrity);
  return hasOnlyKeys(value, ['kind', 'locator', 'integrity'])
    && (value.integrity === undefined || integrity)
    ? { kind: value.kind, locator, ...(integrity ? { integrity } : {}) }
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

function readBoundedReviewString(value) {
  return readBoundedNonEmptyString(value, 32_768);
}

function parseReviewCompatibility(value) {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, ['happier', 'runtimeApiVersion', 'blockedNewerVersions'])
    || value.runtimeApiVersion !== 1
  ) return null;
  const happier = value.happier === undefined ? undefined : readBoundedReviewString(value.happier);
  if (value.happier !== undefined && !happier) return null;
  if (value.blockedNewerVersions === undefined) {
    return { ...(happier ? { happier } : {}), runtimeApiVersion: 1 };
  }
  if (!Array.isArray(value.blockedNewerVersions) || value.blockedNewerVersions.length > 32) return null;
  const blockedNewerVersions = value.blockedNewerVersions.flatMap((blocked) => {
    if (
      !isRecord(blocked)
      || !hasOnlyKeys(blocked, ['version', 'diagnostics'])
      || !Array.isArray(blocked.diagnostics)
      || blocked.diagnostics.length === 0
      || blocked.diagnostics.length > 4
    ) return [];
    const version = readBoundedReviewString(blocked.version);
    const diagnostics = blocked.diagnostics.flatMap((diagnostic) => {
      if (!isRecord(diagnostic) || !hasOnlyKeys(diagnostic, ['code', 'message'])) return [];
      const code = readBoundedReviewString(diagnostic.code);
      const message = readBoundedReviewString(diagnostic.message);
      return code && message ? [{ code, message }] : [];
    });
    return version && diagnostics.length === blocked.diagnostics.length
      ? [{ version, diagnostics }]
      : [];
  });
  if (blockedNewerVersions.length !== value.blockedNewerVersions.length) return null;
  return {
    ...(happier ? { happier } : {}),
    runtimeApiVersion: 1,
    blockedNewerVersions,
  };
}

function parseRequestInterceptorOrigin(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username
      && !url.password
      && url.origin === value
      ? value
      : null;
  } catch {
    return null;
  }
}

function parseRequestInterceptor(value) {
  if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'origins', 'methods', 'priority'])) return null;
  const id = parsePluginContributionLocalId(value.id);
  const origins = Array.isArray(value.origins)
    ? value.origins.map(parseRequestInterceptorOrigin)
    : null;
  const methods = value.methods === undefined
    ? undefined
    : Array.isArray(value.methods)
      ? value.methods.map((method) => (
        method === 'GET'
        || method === 'POST'
        || method === 'PUT'
        || method === 'PATCH'
        || method === 'DELETE'
        || method === 'HEAD'
        || method === 'OPTIONS'
          ? method
          : null
      ))
      : null;
  return id
    && origins
    && origins.length > 0
    && !origins.some((origin) => origin === null)
    && methods !== null
    && !methods?.some((method) => method === null)
    && Number.isInteger(value.priority)
    ? {
        id,
        origins,
        ...(methods === undefined ? {} : { methods }),
        priority: value.priority,
      }
    : null;
}

function parseRequestInterceptors(value) {
  if (!Array.isArray(value)) return null;
  const entries = value.map(parseRequestInterceptor);
  return entries.some((entry) => entry === null) ? null : entries;
}

function parseReviewFacts(value) {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, [
      'pluginId', 'displayName', 'version', 'packageIdentity', 'publisherIdentity', 'source',
      'updateChannel', 'signature', 'provenance', 'curation', 'executableRealms',
      'contributions', 'requestInterceptors', 'uiArtifacts', 'requiredHostAccess', 'optionalHostAccess',
      'rawCredentialAccess', 'compatibility', 'updatePolicy',
    ])
  ) return null;
  const pluginId = readNonEmptyString(value.pluginId);
  const displayName = readNonEmptyString(value.displayName);
  const version = readNonEmptyString(value.version);
  const source = parseReviewSource(value.source);
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
  const signature = parseSignature(value.signature);
  const provenance = parseProvenance(value.provenance);
  const curation = parseCuration(value.curation);
  const contributions = Array.isArray(value.contributions) && value.contributions.length <= 64
    ? value.contributions.flatMap((entry) => {
      const family = isRecord(entry) && hasOnlyKeys(entry, ['family', 'count']) ? readNonEmptyString(entry.family) : null;
      return family && Number.isSafeInteger(entry.count) && entry.count > 0 ? [{ family, count: entry.count }] : [];
    })
    : null;
  const requestInterceptors = parseRequestInterceptors(value.requestInterceptors);
  const uiArtifacts = isRecord(value.uiArtifacts) && hasOnlyKeys(value.uiArtifacts, ['status', 'contributionIds'])
    ? value.uiArtifacts
    : null;
  const uiArtifactIds = parseStringList(uiArtifacts?.contributionIds);
  const uiArtifactStatus = uiArtifacts?.status;
  const requiredHostAccess = parseHostAccessList(value.requiredHostAccess, false);
  const optionalHostAccess = parseHostAccessList(value.optionalHostAccess, true);
  const rawCredentialAccess = parseRawCredentialAccess(value.rawCredentialAccess);
  const compatibility = parseReviewCompatibility(value.compatibility);
  if (
    !pluginId
    || !displayName
    || !version
    || !source
    || !packageIdentity
    || (packageIdentity.name !== null && !packageName)
    || !packageVersion
    || packageVersion !== version
    || !publisherIdentity
    || !updateChannel
    || !signature
    || !provenance
    || !curation
    || !executableRealms
    || !contributions
    || contributions.length !== value.contributions.length
    || new Set(contributions.map((entry) => entry.family)).size !== contributions.length
    || !requestInterceptors
    || !uiArtifactIds
    || (uiArtifactStatus !== 'verified' && uiArtifactStatus !== 'none' && uiArtifactStatus !== 'unavailable')
    || (uiArtifactStatus === 'none' && uiArtifactIds.length !== 0)
    || (uiArtifactStatus !== 'none' && uiArtifactIds.length === 0)
    || !requiredHostAccess
    || !optionalHostAccess
    || !rawCredentialAccess
    || !compatibility
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
    source,
    updateChannel,
    signature,
    provenance,
    curation,
    executableRealms,
    contributions,
    requestInterceptors,
    uiArtifacts: { status: uiArtifactStatus, contributionIds: uiArtifactIds },
    requiredHostAccess,
    optionalHostAccess,
    rawCredentialAccess,
    compatibility,
    updatePolicy: value.updatePolicy,
  };
}

function diagnoseReviewFacts(value) {
  if (!isRecord(value)) return 'review: not_object';
  if (!hasOnlyKeys(value, [
    'pluginId', 'displayName', 'version', 'packageIdentity', 'publisherIdentity', 'source',
    'updateChannel', 'signature', 'provenance', 'curation', 'executableRealms',
    'contributions', 'requestInterceptors', 'uiArtifacts', 'requiredHostAccess', 'optionalHostAccess',
    'rawCredentialAccess', 'compatibility', 'updatePolicy',
  ])) return 'review: unexpected_field';
  if (!readNonEmptyString(value.pluginId)) return 'review.pluginId: invalid';
  if (!readNonEmptyString(value.displayName)) return 'review.displayName: invalid';
  const version = readNonEmptyString(value.version);
  if (!version) return 'review.version: invalid';
  if (!parseReviewSource(value.source)) return 'review.source: invalid';
  if (
    !isRecord(value.packageIdentity)
    || !hasOnlyKeys(value.packageIdentity, ['name', 'version'])
    || (value.packageIdentity.name !== null && !readNonEmptyString(value.packageIdentity.name))
    || readNonEmptyString(value.packageIdentity.version) !== version
  ) return 'review.packageIdentity: invalid';
  if (!parsePublisher(value.publisherIdentity)) return 'review.publisherIdentity: invalid';
  if (!parseUpdateChannel(value.updateChannel)) return 'review.updateChannel: invalid';
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
  if (!parseRequestInterceptors(value.requestInterceptors)) return 'review.requestInterceptors: invalid';
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
  if (!parseRawCredentialAccess(value.rawCredentialAccess)) return 'review.rawCredentialAccess: invalid';
  if (!parseReviewCompatibility(value.compatibility)) return 'review.compatibility: invalid';
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
