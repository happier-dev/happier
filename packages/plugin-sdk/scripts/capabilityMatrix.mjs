import ts from 'typescript';

const AVAILABILITY_DISPOSITIONS = new Set(['available', 'deferred', 'retired']);
const MAINTAINED_PUBLIC_CONSUMER_PREFIXES = Object.freeze([
  'packages/plugins/',
  'packages/plugin-sdk/examples/',
  'packages/tests/fixtures/plugin-platform/',
]);
const NO_CURRENT_POSITIVE_CONSUMER = 'no current positive consumer';
export class CapabilityMatrixValidationError extends Error {
  /** @param {readonly string[]} diagnostics */
  constructor(diagnostics) {
    super(`Invalid Plugin SDK capability matrix:\n- ${diagnostics.join('\n- ')}`);
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareCodePoints(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    current
    && (ts.isAsExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isParenthesizedExpression(current)
      || ts.isTypeAssertionExpression(current))
  ) current = current.expression;
  if (
    current
    && ts.isCallExpression(current)
    && ts.isPropertyAccessExpression(current.expression)
    && ts.isIdentifier(current.expression.expression)
    && current.expression.expression.text === 'Object'
    && current.expression.name.text === 'freeze'
    && current.arguments.length === 1
  ) return unwrapExpression(current.arguments[0]);
  return current;
}

function propertyNameText(name) {
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    ? name.text
    : null;
}

function objectProperty(object, key) {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || propertyNameText(property.name) !== key) continue;
    return property.initializer;
  }
  return null;
}

function requiredStringProperty(object, key, label) {
  const expression = objectProperty(object, key);
  const unwrapped = expression ? unwrapExpression(expression) : null;
  if (!unwrapped || !ts.isStringLiteral(unwrapped)) {
    throw new Error(`${label}.${key} must be a string literal`);
  }
  return unwrapped.text;
}

function sourceFile(source, label) {
  if (typeof source !== 'string') throw new Error(`${label} must be source text`);
  return ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function findVariableInitializer(file, name, label) {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name || !declaration.initializer) continue;
      return declaration.initializer;
    }
  }
  throw new Error(`${label} must declare ${name}`);
}

/**
 * Reads exactly the static fields the capability matrix needs from the one
 * `definePlugin` family policy. It never replicates that policy in tooling.
 */
export function readDefinePluginCapabilityPolicy(source) {
  const file = sourceFile(source, 'definePlugin.ts');
  const expression = unwrapExpression(
    findVariableInitializer(file, 'DEFINE_PLUGIN_FAMILY_POLICY_V2', 'definePlugin.ts'),
  );
  if (!ts.isObjectLiteralExpression(expression)) {
    throw new Error('DEFINE_PLUGIN_FAMILY_POLICY_V2 must be an object literal');
  }
  const policy = {};
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const family = propertyNameText(property.name);
    const value = unwrapExpression(property.initializer);
    if (!family || !ts.isObjectLiteralExpression(value)) {
      throw new Error('DEFINE_PLUGIN_FAMILY_POLICY_V2 entries must be named object literals');
    }
    if (Object.hasOwn(policy, family)) {
      throw new Error(`DEFINE_PLUGIN_FAMILY_POLICY_V2 has duplicate family ${family}`);
    }
    policy[family] = Object.freeze({
      authorKey: requiredStringProperty(value, 'authorKey', `DEFINE_PLUGIN_FAMILY_POLICY_V2.${family}`),
      classification: requiredStringProperty(value, 'classification', `DEFINE_PLUGIN_FAMILY_POLICY_V2.${family}`),
      inputShape: requiredStringProperty(value, 'inputShape', `DEFINE_PLUGIN_FAMILY_POLICY_V2.${family}`),
    });
  }
  if (Object.keys(policy).length === 0) {
    throw new Error('DEFINE_PLUGIN_FAMILY_POLICY_V2 must publish at least one family');
  }
  return deepFreeze(policy);
}

function collectUnionStringLiterals(node) {
  if (ts.isUnionTypeNode(node)) return node.types.flatMap(collectUnionStringLiterals);
  return ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal) ? [node.literal.text] : [];
}

function typeReferenceName(node) {
  if (!node || !ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName)) return null;
  return node.typeName.text;
}

/**
 * Reads the `PluginServiceId` / `PluginServices` one-to-one declaration pair
 * so public service rows are derived from their canonical SDK owner.
 */
export function readPluginServicesCapabilityCatalog(source) {
  const file = sourceFile(source, 'services/index.ts');
  const serviceIdDeclaration = file.statements.find((statement) => (
    ts.isTypeAliasDeclaration(statement) && statement.name.text === 'PluginServiceId'
  ));
  const servicesDeclaration = file.statements.find((statement) => (
    ts.isInterfaceDeclaration(statement) && statement.name.text === 'PluginServices'
  ));
  if (!serviceIdDeclaration || !servicesDeclaration) {
    throw new Error('services/index.ts must declare PluginServiceId and PluginServices');
  }
  const ids = collectUnionStringLiterals(serviceIdDeclaration.type);
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error('PluginServiceId must be a non-empty union of unique string literals');
  }
  const publicTypeByProperty = new Map();
  for (const member of servicesDeclaration.members) {
    if (!ts.isPropertySignature(member)) continue;
    const property = propertyNameText(member.name);
    const publicType = typeReferenceName(member.type);
    if (!property || !publicType) continue;
    if (publicTypeByProperty.has(property)) {
      throw new Error(`PluginServices has duplicate property ${property}`);
    }
    publicTypeByProperty.set(property, publicType);
  }
  const idSet = new Set(ids);
  const missingProperties = ids.filter((id) => !publicTypeByProperty.has(id));
  const extraProperties = [...publicTypeByProperty.keys()].filter((property) => !idSet.has(property));
  if (missingProperties.length > 0 || extraProperties.length > 0) {
    throw new Error([
      'PluginServiceId and PluginServices must be a one-to-one public service declaration',
      ...(missingProperties.length > 0 ? [`missing properties: ${missingProperties.join(', ')}`] : []),
      ...(extraProperties.length > 0 ? [`extra properties: ${extraProperties.join(', ')}`] : []),
    ].join('; '));
  }
  return Object.freeze(ids
    .sort(compareCodePoints)
    .map((id) => Object.freeze({
      id,
      property: id,
      publicType: publicTypeByProperty.get(id),
    })));
}

function requiredString(value, label, diagnostics) {
  if (typeof value !== 'string' || value.trim() === '') {
    diagnostics.push(`${label} must be a non-empty string`);
    return null;
  }
  return value;
}

function requiredLifecycle(value, label, diagnostics) {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry !== '')) {
    return Object.freeze([...value]);
  }
  diagnostics.push(`${label} must be a non-empty lifecycle string or string array`);
  return null;
}

function isMaintainedPublicConsumerPath(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\\') || value.includes('\0')) {
    return false;
  }
  if (!MAINTAINED_PUBLIC_CONSUMER_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return false;
  }
  return !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

function sourceOwnerPath(value) {
  return typeof value === 'string' ? value.split('#', 1)[0] : null;
}

function isSelfProvingConsumer(metadata) {
  const provingConsumerPath = sourceOwnerPath(metadata.provingConsumer);
  if (!provingConsumerPath) return false;
  return [metadata.producer, metadata.specialistOwner].some((owner) => (
    sourceOwnerPath(owner) === provingConsumerPath
  ));
}

/**
 * Availability is an author-facing claim, so neither a catalog owner nor a
 * `PluginServices` member can prove its own capability. Available rows name a
 * maintained public plugin/example; unavailable rows remain explicit deferred
 * dispositions with an unblock.
 */
function validateAvailabilityConsumer(label, metadata, diagnostics) {
  if (metadata.availabilityDisposition === 'available') {
    if (!isMaintainedPublicConsumerPath(metadata.provingConsumer)) {
      diagnostics.push(
        `${label} provingConsumer must name a maintained public plugin/example consumer, not a host binder`,
      );
    } else if (isSelfProvingConsumer(metadata)) {
      diagnostics.push(
        `${label} provingConsumer must name a distinct maintained public plugin/example leaf, not its producer or specialist owner`,
      );
    }
    return;
  }
  if (
    metadata.availabilityDisposition === 'deferred'
    && metadata.provingConsumer !== NO_CURRENT_POSITIVE_CONSUMER
  ) {
    diagnostics.push(
      `${label} deferred provingConsumer must be ${JSON.stringify(NO_CURRENT_POSITIVE_CONSUMER)}`,
    );
  }
}

function assertExactMetadataKeys(label, metadata, canonicalIds, diagnostics) {
  if (!isRecord(metadata)) {
    diagnostics.push(`${label} metadata must be an object`);
    return;
  }
  const canonical = new Set(canonicalIds);
  for (const id of canonicalIds) {
    if (!Object.hasOwn(metadata, id)) diagnostics.push(`missing ${label} metadata: ${id}`);
  }
  for (const id of Object.keys(metadata).sort(compareCodePoints)) {
    if (!canonical.has(id)) diagnostics.push(`unknown ${label} metadata: ${id}`);
  }
}

function normalizeMetadataRow(label, value, diagnostics, { disposition = false, lifecycle = true } = {}) {
  if (!isRecord(value)) {
    diagnostics.push(`${label} metadata must be an object`);
    return null;
  }
  const producer = requiredString(value.producer, `${label}.producer`, diagnostics);
  const normalizedLifecycle = lifecycle
    ? requiredLifecycle(value.lifecycle, `${label}.lifecycle`, diagnostics)
    : undefined;
  const provingConsumer = requiredString(value.provingConsumer, `${label}.provingConsumer`, diagnostics);
  const specialistOwner = requiredString(value.specialistOwner, `${label}.specialistOwner`, diagnostics);
  const predecessorRemoval = requiredString(value.predecessorRemoval, `${label}.predecessorRemoval`, diagnostics);
  let availabilityDisposition;
  let unblockCondition;
  if (disposition) {
    availabilityDisposition = value.availabilityDisposition;
    if (!AVAILABILITY_DISPOSITIONS.has(availabilityDisposition)) {
      diagnostics.push(`${label} availabilityDisposition must be available, deferred, or retired`);
    }
    if (availabilityDisposition === 'deferred') {
      unblockCondition = requiredString(value.unblockCondition, `${label}.unblockCondition`, diagnostics);
    } else if (value.unblockCondition !== undefined) {
      diagnostics.push(`${label}.unblockCondition is only valid for deferred availability`);
    }
  }
  if (!producer || (lifecycle && !normalizedLifecycle) || !provingConsumer || !specialistOwner || !predecessorRemoval) {
    return null;
  }
  return Object.freeze({
    producer,
    ...(lifecycle ? { lifecycle: normalizedLifecycle } : {}),
    provingConsumer,
    specialistOwner,
    predecessorRemoval,
    ...(disposition && AVAILABILITY_DISPOSITIONS.has(availabilityDisposition)
      ? {
          availabilityDisposition,
          ...(availabilityDisposition === 'deferred' && unblockCondition ? { unblockCondition } : {}),
        }
      : {}),
  });
}

function indexedBy(entries, key, label, diagnostics) {
  const result = new Map();
  for (const entry of entries) {
    const identity = entry?.[key];
    if (typeof identity !== 'string' || identity === '') {
      diagnostics.push(`${label} has an invalid ${key}`);
      continue;
    }
    if (result.has(identity)) {
      diagnostics.push(`${label} has duplicate ${key}: ${identity}`);
      continue;
    }
    result.set(identity, entry);
  }
  return result;
}

function authorEntrypoints(apiInventory) {
  return apiInventory.entrypoints
    .filter((entrypoint) => entrypoint.visibility === 'author')
    .sort((left, right) => compareCodePoints(left.specifier, right.specifier));
}

/**
 * Joins the Protocol contribution/HostAccess catalogs, definePlugin policy,
 * PluginServices declaration, and generated public API inventory. Metadata is
 * deliberately limited to lifecycle evidence that no canonical catalog owns.
 */
export function projectCapabilityMatrix({
  contributionCatalog,
  hostAccessCatalog,
  definePluginPolicy,
  apiInventory,
  services,
  metadata,
}) {
  const diagnostics = [];
  const catalog = Array.isArray(contributionCatalog) ? contributionCatalog : [];
  const hostAccess = Array.isArray(hostAccessCatalog) ? hostAccessCatalog : [];
  const serviceEntries = Array.isArray(services) ? services : [];
  if (!Array.isArray(contributionCatalog)) diagnostics.push('contributionCatalog must be an array');
  if (!Array.isArray(hostAccessCatalog)) diagnostics.push('hostAccessCatalog must be an array');
  if (!isRecord(definePluginPolicy)) diagnostics.push('definePluginPolicy must be an object');
  if (!isRecord(apiInventory) || !Array.isArray(apiInventory.entrypoints) || !Array.isArray(apiInventory.symbols)) {
    diagnostics.push('apiInventory must provide entrypoints and symbols arrays');
  }
  if (!Array.isArray(services)) diagnostics.push('services must be an array');
  if (!isRecord(metadata)) diagnostics.push('metadata must be an object');

  const catalogByFamily = indexedBy(catalog, 'manifestKey', 'contributionCatalog', diagnostics);
  // Family availability has exactly one owner: this matrix. The contribution
  // catalog previously carried a second per-family `stability` posture that
  // disagreed with the matrix on 12 of its 36 shared families and reached the
  // daemon introspection wire. This is the only point where both owners are in
  // scope, so a reintroduced catalog posture is rejected here.
  for (const [family, entry] of catalogByFamily) {
    if (Object.hasOwn(entry, 'stability')) {
      diagnostics.push(
        `contribution catalog family '${family}' uses retired family stability metadata`
        + '; capability-matrix.json owns family availability',
      );
    }
  }
  const accessByCapability = indexedBy(hostAccess, 'capability', 'hostAccessCatalog', diagnostics);
  const servicesById = indexedBy(serviceEntries, 'id', 'services', diagnostics);
  const authorEntrypointRows = isRecord(apiInventory) && Array.isArray(apiInventory.entrypoints)
    ? authorEntrypoints(apiInventory)
    : [];
  const authorEntrypointBySpecifier = indexedBy(authorEntrypointRows, 'specifier', 'apiInventory author entrypoints', diagnostics);
  const definePluginEntrypoint = authorEntrypointBySpecifier.get('.');
  if (!definePluginEntrypoint) diagnostics.push('apiInventory must publish definePlugin through the root author entrypoint');
  const definePluginSymbols = isRecord(apiInventory) && Array.isArray(apiInventory.symbols)
    ? apiInventory.symbols.filter((symbol) => (
      symbol.specifier === '.'
      && symbol.exportName === 'definePlugin'
      && symbol.kind === 'value'
    ))
    : [];
  if (definePluginSymbols.length !== 1) {
    diagnostics.push('apiInventory must publish exactly one root definePlugin value');
  }

  const metadataManifestFamilies = metadata?.manifestFamilies;
  const metadataServices = metadata?.services;
  const metadataHostAccess = metadata?.hostAccess;
  const metadataSubpaths = metadata?.subpaths;
  const familyIds = [...catalogByFamily.keys()].sort(compareCodePoints);
  const hostAccessIds = [...accessByCapability.keys()].sort(compareCodePoints);
  const serviceIds = [...servicesById.keys()].sort(compareCodePoints);
  const subpathIds = authorEntrypointRows.map((entrypoint) => entrypoint.specifier).sort(compareCodePoints);
  assertExactMetadataKeys('manifest-family', metadataManifestFamilies, familyIds, diagnostics);
  assertExactMetadataKeys('service', metadataServices, serviceIds, diagnostics);
  assertExactMetadataKeys('hostAccess', metadataHostAccess, hostAccessIds, diagnostics);
  assertExactMetadataKeys('published-subpath', metadataSubpaths, subpathIds, diagnostics);

  const policyKeys = isRecord(definePluginPolicy) ? Object.keys(definePluginPolicy).sort(compareCodePoints) : [];
  for (const family of familyIds) {
    if (!Object.hasOwn(definePluginPolicy ?? {}, family)) {
      diagnostics.push(`missing definePlugin policy for manifest family: ${family}`);
    }
  }
  for (const family of policyKeys) {
    if (!catalogByFamily.has(family)) diagnostics.push(`unknown definePlugin policy family: ${family}`);
  }

  const normalizedFamilies = [];
  for (const family of familyIds) {
    const catalogEntry = catalogByFamily.get(family);
    const policy = definePluginPolicy?.[family];
    const rowMetadata = normalizeMetadataRow(
      `manifestFamilies.${family}`,
      metadataManifestFamilies?.[family],
      diagnostics,
      { disposition: true, lifecycle: false },
    );
    if (!catalogEntry || !policy || !rowMetadata || !definePluginEntrypoint) continue;
    validateAvailabilityConsumer(`manifestFamilies.${family}`, rowMetadata, diagnostics);
    if (
      policy.classification === 'deferred'
      && rowMetadata.availabilityDisposition !== 'deferred'
    ) {
      diagnostics.push(
        `manifestFamilies.${family} deferred definePlugin policy requires deferred availabilityDisposition`,
      );
    }
    for (const key of ['authorKey', 'classification', 'inputShape']) {
      if (typeof policy[key] !== 'string' || policy[key] === '') {
        diagnostics.push(`definePlugin policy ${family}.${key} must be a non-empty string`);
      }
    }
    if (!Array.isArray(catalogEntry.lifecycleStages) || catalogEntry.lifecycleStages.length === 0) {
      diagnostics.push(`contribution catalog ${family}.lifecycleStages must be a non-empty array`);
      continue;
    }
    normalizedFamilies.push(Object.freeze({
      manifestFamily: family,
      pluginApiRegistrationFamily: catalogEntry.allowedRuntimeRegistration ?? null,
      registrationHost: catalogEntry.registrationHost ?? null,
      definePluginAuthorKey: policy.authorKey,
      definePluginInputShape: policy.inputShape,
      definePluginClassification: policy.classification,
      authorEntrypoint: definePluginEntrypoint.specifier,
      realm: definePluginEntrypoint.realm,
      lifecycle: Object.freeze([...catalogEntry.lifecycleStages]),
      catalogDisposition: catalogEntry.disposition,
      ...rowMetadata,
    }));
  }

  const normalizedServices = [];
  for (const serviceId of serviceIds) {
    const service = servicesById.get(serviceId);
    const rowMetadata = normalizeMetadataRow(
      `services.${serviceId}`,
      metadataServices?.[serviceId],
      diagnostics,
      { disposition: true },
    );
    if (!service || !rowMetadata || !isRecord(apiInventory)) continue;
    validateAvailabilityConsumer(`services.${serviceId}`, rowMetadata, diagnostics);
    if (typeof service.property !== 'string' || service.property === '') {
      diagnostics.push(`services ${serviceId}.property must be a non-empty string`);
      continue;
    }
    if (typeof service.publicType !== 'string' || service.publicType === '') {
      diagnostics.push(`services ${serviceId}.publicType must be a non-empty string`);
      continue;
    }
    const publicSymbols = apiInventory.symbols.filter((symbol) => (
      symbol.kind === 'type'
      && symbol.exportName === service.publicType
      && authorEntrypointBySpecifier.has(symbol.specifier)
    ));
    if (publicSymbols.length === 0) {
      diagnostics.push(`service ${serviceId} public type ${service.publicType} is not published through an author entrypoint`);
      continue;
    }
    const entrypoints = [...new Set(publicSymbols.map((symbol) => symbol.specifier))].sort(compareCodePoints);
    normalizedServices.push(Object.freeze({
      serviceId,
      property: service.property,
      publicType: service.publicType,
      authorEntrypoints: Object.freeze(entrypoints),
      realms: Object.freeze(entrypoints.map((specifier) => authorEntrypointBySpecifier.get(specifier).realm)),
      ...rowMetadata,
    }));
  }

  const normalizedHostAccess = [];
  for (const capability of hostAccessIds) {
    const entry = accessByCapability.get(capability);
    const rowMetadata = normalizeMetadataRow(
      `hostAccess.${capability}`,
      metadataHostAccess?.[capability],
      diagnostics,
      { disposition: true },
    );
    if (!entry || !rowMetadata) continue;
    validateAvailabilityConsumer(`hostAccess.${capability}`, rowMetadata, diagnostics);
    if (typeof entry.authorizationClass !== 'string' || entry.authorizationClass === '') {
      diagnostics.push(`hostAccess catalog ${capability}.authorizationClass must be a non-empty string`);
      continue;
    }
    normalizedHostAccess.push(Object.freeze({
      capability,
      authorizationClass: entry.authorizationClass,
      ...rowMetadata,
    }));
  }

  const normalizedSubpaths = [];
  for (const entrypoint of authorEntrypointRows) {
    const rowMetadata = normalizeMetadataRow(
      `subpaths.${entrypoint.specifier}`,
      metadataSubpaths?.[entrypoint.specifier],
      diagnostics,
      { disposition: true },
    );
    if (!rowMetadata) continue;
    validateAvailabilityConsumer(`subpaths.${entrypoint.specifier}`, rowMetadata, diagnostics);
    normalizedSubpaths.push(Object.freeze({
      specifier: entrypoint.specifier,
      sourceModule: entrypoint.sourceModule,
      realm: entrypoint.realm,
      ...rowMetadata,
    }));
  }

  if (diagnostics.length > 0) throw new CapabilityMatrixValidationError(diagnostics);
  return deepFreeze({
    schemaVersion: 1,
    manifestFamilies: normalizedFamilies.sort((left, right) => compareCodePoints(left.manifestFamily, right.manifestFamily)),
    services: normalizedServices.sort((left, right) => compareCodePoints(left.serviceId, right.serviceId)),
    hostAccess: normalizedHostAccess.sort((left, right) => compareCodePoints(left.capability, right.capability)),
    subpaths: normalizedSubpaths.sort((left, right) => compareCodePoints(left.specifier, right.specifier)),
  });
}

const PUBLIC_SDK_PACKAGE_NAME = '@happier-dev/plugin-sdk';

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsQuotedLiteral(source, value) {
  return source.includes(`'${value}'`) || source.includes(`"${value}"`);
}

function containsIdentifier(source, value) {
  return new RegExp(`(^|[^A-Za-z0-9_$])${escapeForRegExp(value)}([^A-Za-z0-9_$]|$)`).test(source);
}

function containsNamedImportedCall(source, moduleSpecifier, importedName) {
  const sourceFile = ts.createSourceFile(
    'capability-matrix-proving-consumer.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const importedLocalNames = new Set();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== moduleSpecifier
      || statement.importClause?.isTypeOnly === true
    ) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = element.propertyName?.text ?? element.name.text;
      if (imported === importedName) importedLocalNames.add(element.name.text);
    }
  }
  if (importedLocalNames.size === 0) return false;

  let found = false;
  const visit = (node) => {
    if (found) return;
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && importedLocalNames.has(node.expression.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * A row's proving consumer must EXERCISE the capability it proves, not merely
 * exist. Every token below is derived from the row itself — the published
 * subpath specifier, the `services.<id>` invocation, the hostAccess capability
 * literal, the definePlugin author key and dotted family leaf — so the bar
 * cannot drift from the capability it guards. Returns null when the source
 * carries the evidence, otherwise the diagnostic clause naming what is absent.
 */
export function capabilityMatrixProvingConsumerExerciseFailure(row, source) {
  if (typeof source !== 'string') return 'could not be read as source text';
  if (typeof row?.specifier === 'string') {
    const specifier = row.specifier === '.'
      ? PUBLIC_SDK_PACKAGE_NAME
      : `${PUBLIC_SDK_PACKAGE_NAME}/${row.specifier.replace(/^\.\//, '')}`;
    return containsQuotedLiteral(source, specifier)
      ? null
      : `does not import ${specifier}`;
  }
  if (typeof row?.serviceId === 'string') {
    if (
      row.serviceId === 'storage'
      && containsNamedImportedCall(
        source,
        `${PUBLIC_SDK_PACKAGE_NAME}/storage`,
        'requireAccountStorage',
      )
    ) {
      return null;
    }
    return source.includes(`services.${row.serviceId}`)
      ? null
      : `does not invoke services.${row.serviceId}`;
  }
  if (typeof row?.capability === 'string') {
    return containsQuotedLiteral(source, row.capability)
      ? null
      : `does not declare the '${row.capability}' hostAccess capability`;
  }
  if (typeof row?.manifestFamily === 'string') {
    const authorKey = row.definePluginAuthorKey;
    if (typeof authorKey !== 'string' || authorKey === '') {
      return 'has no definePlugin author key to prove';
    }
    if (!containsIdentifier(source, authorKey)) {
      return `does not declare the '${authorKey}' definePlugin contribution key`;
    }
    const leaf = row.manifestFamily.includes('.')
      ? row.manifestFamily.slice(row.manifestFamily.lastIndexOf('.') + 1)
      : null;
    if (leaf && !containsIdentifier(source, leaf)) {
      return `declares '${authorKey}' but not '${row.manifestFamily}'`;
    }
    return null;
  }
  return 'does not belong to a known capability matrix dimension';
}

export function renderCapabilityMatrix(matrix) {
  return `${JSON.stringify(matrix, null, 2)}\n`;
}

/**
 * Fills only facts that already have one canonical source. Declarations own
 * availability and positive-consumer (or deferred-unblock) facts for every
 * public capability family; catalogs and inventories retain identity, source,
 * lifecycle, and published-surface authority.
 */
export function deriveCapabilityMatrixMetadata({
  contributionCatalog,
  hostAccessCatalog,
  apiInventory,
  services,
  declarations,
}) {
  if (!isRecord(declarations)) throw new Error('capability matrix declarations must be an object');
  const catalog = Array.isArray(contributionCatalog) ? contributionCatalog : [];
  const hostAccess = Array.isArray(hostAccessCatalog) ? hostAccessCatalog : [];
  const serviceEntries = Array.isArray(services) ? services : [];
  const inventorySymbols = Array.isArray(apiInventory?.symbols) ? apiInventory.symbols : [];
  const entrypoints = authorEntrypoints(isRecord(apiInventory) && Array.isArray(apiInventory.entrypoints)
    ? apiInventory
    : { entrypoints: [] });
  const manifestFamilies = {};
  for (const entry of catalog) {
    if (typeof entry?.manifestKey !== 'string') continue;
    const declaration = declarations.manifestFamilies?.[entry.manifestKey];
    if (declaration !== undefined) {
      manifestFamilies[entry.manifestKey] = Object.freeze({
        producer: `packages/protocol/src/plugins/contributions/catalog.ts#${entry.manifestKey}`,
        specialistOwner: `packages/protocol/src/plugins/contributions/catalog.ts#${entry.manifestKey}`,
        predecessorRemoval: `catalog-disposition:${entry.disposition}`,
        ...declaration,
      });
    }
  }
  for (const [family, declaration] of Object.entries(declarations.manifestFamilies ?? {})) {
    if (!Object.hasOwn(manifestFamilies, family)) manifestFamilies[family] = declaration;
  }
  const serviceMetadata = {};
  for (const service of serviceEntries) {
    if (typeof service?.id !== 'string') continue;
    const source = inventorySymbols.find((symbol) => (
      symbol.kind === 'type' && symbol.exportName === service.publicType
    ))?.sourceModule;
    const declaration = declarations.services?.[service.id];
    if (declaration !== undefined) {
      serviceMetadata[service.id] = Object.freeze({
        producer: typeof source === 'string'
          ? source
          : `packages/plugin-sdk/src/services/index.ts#PluginServices.${service.property}`,
        lifecycle: 'invocation-scoped',
        specialistOwner: `packages/plugin-sdk/src/services/index.ts#PluginServices.${service.property}`,
        predecessorRemoval: 'none',
        ...declaration,
      });
    }
  }
  for (const [serviceId, declaration] of Object.entries(declarations.services ?? {})) {
    if (!Object.hasOwn(serviceMetadata, serviceId)) serviceMetadata[serviceId] = declaration;
  }
  const hostAccessMetadata = {};
  for (const entry of hostAccess) {
    if (typeof entry?.capability !== 'string') continue;
    const declaration = declarations.hostAccess?.[entry.capability];
    if (declaration !== undefined) {
      hostAccessMetadata[entry.capability] = Object.freeze({
        producer: 'apps/cli/src/plugins/runtime/hostAccess/resolve.ts',
        lifecycle: 'invocation-scoped',
        specialistOwner: 'apps/cli/src/plugins/runtime/hostAccess/resolve.ts',
        predecessorRemoval: 'none',
        ...declaration,
      });
    }
  }
  for (const [capability, declaration] of Object.entries(declarations.hostAccess ?? {})) {
    if (!Object.hasOwn(hostAccessMetadata, capability)) hostAccessMetadata[capability] = declaration;
  }
  const subpathMetadata = {};
  for (const entrypoint of entrypoints) {
    const declaration = declarations.subpaths?.[entrypoint.specifier];
    if (declaration !== undefined) {
      subpathMetadata[entrypoint.specifier] = Object.freeze({
          producer: entrypoint.sourceModule,
          lifecycle: 'published',
          specialistOwner: entrypoint.sourceModule,
          predecessorRemoval: 'none',
          ...declaration,
      });
    }
  }
  for (const [specifier, declaration] of Object.entries(declarations.subpaths ?? {})) {
    if (!Object.hasOwn(subpathMetadata, specifier)) subpathMetadata[specifier] = declaration;
  }
  return deepFreeze({
    manifestFamilies,
    services: serviceMetadata,
    hostAccess: hostAccessMetadata,
    subpaths: subpathMetadata,
  });
}
