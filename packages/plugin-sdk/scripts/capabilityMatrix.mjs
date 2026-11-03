import ts from 'typescript';

const AVAILABILITY_DISPOSITIONS = new Set(['available', 'preview', 'deferred', 'retired']);
const PLUGIN_SERVICES_DECLARATION_MODULE = 'packages/plugin-sdk/src/services/index.ts';

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

function unwrapReadonlyType(node) {
  return typeReferenceName(node) === 'Readonly'
    ? unwrapReadonlyType(node.typeArguments?.[0])
    : node;
}

function readAccountInvocationServices(source, publicTypeByProperty) {
  if (source === undefined) return new Map();
  const file = sourceFile(source, 'actions/contracts.ts');
  const declaration = file.statements.find(node => ts.isTypeAliasDeclaration(node)
    && node.name.text === 'PluginAccountActionContext');
  const context = unwrapReadonlyType(declaration?.type);
  if (!context || !ts.isTypeLiteralNode(context)) throw new Error('PluginAccountActionContext must declare its portable context');
  const servicesProperty = context.members.find(member => ts.isPropertySignature(member)
    && propertyNameText(member.name) === 'services');
  const services = unwrapReadonlyType(servicesProperty?.type);
  if (!services || !ts.isTypeLiteralNode(services)) throw new Error('PluginAccountActionContext must declare its service capabilities');
  return new Map(services.members.map(member => {
    const property = ts.isPropertySignature(member) ? propertyNameText(member.name) : null;
    if (!property || !publicTypeByProperty.has(property)) throw new Error('Account context declares an unknown service');
    const type = unwrapReadonlyType(member.type);
    let members;
    if (typeReferenceName(type) === 'Pick') {
      members = collectUnionStringLiterals(type.typeArguments?.[1]).sort(compareCodePoints);
      if (members.length === 0) throw new Error(`Account service ${property} must name its admitted members`);
    } else if (type && ts.isTypeLiteralNode(type)) {
      members = type.members.map(row => ts.isPropertySignature(row) ? propertyNameText(row.name) : null);
      if (members.some(name => !name)) throw new Error(`Account service ${property} must name its admitted properties`);
      members.sort(compareCodePoints);
    } else if (typeReferenceName(type) === publicTypeByProperty.get(property)) {
      members = 'all';
    } else {
      throw new Error(`Account service ${property} must use its canonical service type or explicit subset`);
    }
    return [property, Object.freeze({ members: Array.isArray(members) ? Object.freeze(members) : members })];
  }));
}

/**
 * Reads the `PluginServiceId` / `PluginServices` one-to-one declaration pair
 * so public service rows are derived from their canonical SDK owner.
 */
export function readPluginServicesCapabilityCatalog(source, accountContextSource) {
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
  const accountServices = readAccountInvocationServices(accountContextSource, publicTypeByProperty);
  return Object.freeze(ids
    .sort(compareCodePoints)
    .map((id) => Object.freeze({
      id,
      property: id,
      publicType: publicTypeByProperty.get(id),
      ...(accountServices.has(id) ? { accountInvocation: accountServices.get(id) } : {}),
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

function normalizeMetadataRow(label, value, diagnostics, { lifecycle = true } = {}) {
  if (!isRecord(value)) {
    diagnostics.push(`${label} metadata must be an object`);
    return null;
  }
  const producer = requiredString(value.producer, `${label}.producer`, diagnostics);
  const normalizedLifecycle = lifecycle
    ? requiredLifecycle(value.lifecycle, `${label}.lifecycle`, diagnostics)
    : undefined;
  const availabilityDisposition = value.availabilityDisposition;
  if (!AVAILABILITY_DISPOSITIONS.has(availabilityDisposition)) {
    diagnostics.push(`${label} availabilityDisposition must be available, preview, deferred, or retired`);
  }
  const unblockCondition = availabilityDisposition === 'deferred'
    ? requiredString(value.unblockCondition, `${label}.unblockCondition`, diagnostics)
    : undefined;
  if (availabilityDisposition !== 'deferred' && value.unblockCondition !== undefined) {
    diagnostics.push(`${label}.unblockCondition is only valid for deferred availability`);
  }
  if (!producer || (lifecycle && !normalizedLifecycle)) return null;
  return Object.freeze({
    producer,
    ...(lifecycle ? { lifecycle: normalizedLifecycle } : {}),
    availabilityDisposition,
    ...(unblockCondition ? { unblockCondition } : {}),
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
 * PluginServices declaration, and generated public API inventory. Metadata supplies
 * only author availability and exceptional lifecycle facts.
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
  } else if (definePluginEntrypoint && definePluginSymbols[0].realm !== definePluginEntrypoint.realm) {
    diagnostics.push('apiInventory root definePlugin symbol realm must match its entrypoint realm');
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
      { lifecycle: false },
    );
    if (!catalogEntry || !policy || !rowMetadata || !definePluginEntrypoint) continue;
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
      realm: definePluginSymbols[0]?.realm ?? definePluginEntrypoint.realm,
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
    );
    if (!service || !rowMetadata || !isRecord(apiInventory)) continue;
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
    const realms = [...new Set(publicSymbols.map((symbol) => symbol.realm))].sort(compareCodePoints);
    normalizedServices.push(Object.freeze({
      serviceId,
      property: service.property,
      publicType: service.publicType,
      authorEntrypoints: Object.freeze(entrypoints),
      realms: Object.freeze(realms),
      ...(service.accountInvocation ? { accountInvocation: service.accountInvocation } : {}),
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
    );
    if (!entry || !rowMetadata) continue;
    if (typeof entry.authorizationClass !== 'string' || entry.authorizationClass === '') {
      diagnostics.push(`hostAccess catalog ${capability}.authorizationClass must be a non-empty string`);
      continue;
    }
    normalizedHostAccess.push(Object.freeze({
      capability,
      authorizationClass: entry.authorizationClass,
      // The daemon plugin runtime is the one realm whose resolver
      // (`apps/cli/src/plugins/runtime/hostAccess/resolve.ts`) binds, serves,
      // and cleans up HostAccess grants; UI realms never receive them. This is
      // the row's supported realm, not evidence inferred from another binder.
      realm: 'daemon',
      ...rowMetadata,
    }));
  }

  const normalizedSubpaths = [];
  for (const entrypoint of authorEntrypointRows) {
    const rowMetadata = normalizeMetadataRow(
      `subpaths.${entrypoint.specifier}`,
      metadataSubpaths?.[entrypoint.specifier],
      diagnostics,
    );
    if (!rowMetadata) continue;
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

export function renderCapabilityMatrix(matrix) {
  return `${JSON.stringify(matrix, null, 2)}\n`;
}

/**
 * Fills only facts that already have one canonical source. Declarations own
 * availability and deferred-unblock facts for every
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
        ...declaration,
      });
    }
  }
  for (const [family, declaration] of Object.entries(declarations.manifestFamilies ?? {})) {
    if (!Object.hasOwn(manifestFamilies, family)) {
      manifestFamilies[family] = declaration;
    }
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
        // The declaration owner is the module publishing the service's public
        // type, falling back to the module that declares the service catalog. A
        // `PluginServices` member spelling names no module and is never used.
        producer: typeof source === 'string' ? source : PLUGIN_SERVICES_DECLARATION_MODULE,
        lifecycle: 'invocation-scoped',
        ...declaration,
      });
    }
  }
  for (const [serviceId, declaration] of Object.entries(declarations.services ?? {})) {
    if (!Object.hasOwn(serviceMetadata, serviceId)) {
      serviceMetadata[serviceId] = declaration;
    }
  }
  const hostAccessMetadata = {};
  for (const entry of hostAccess) {
    if (typeof entry?.capability !== 'string') continue;
    const declaration = declarations.hostAccess?.[entry.capability];
    if (declaration !== undefined) {
      hostAccessMetadata[entry.capability] = Object.freeze({
        producer: `packages/protocol/src/plugins/manifest/v2.ts#${entry.capability}`,
        lifecycle: 'invocation-scoped',
        ...declaration,
      });
    }
  }
  for (const [capability, declaration] of Object.entries(declarations.hostAccess ?? {})) {
    if (!Object.hasOwn(hostAccessMetadata, capability)) {
      hostAccessMetadata[capability] = declaration;
    }
  }
  const subpathMetadata = {};
  for (const entrypoint of entrypoints) {
    const declaration = declarations.subpaths?.[entrypoint.specifier];
    if (declaration !== undefined) {
      subpathMetadata[entrypoint.specifier] = Object.freeze({
          producer: entrypoint.sourceModule,
          lifecycle: 'published',
          ...declaration,
      });
    }
  }
  for (const [specifier, declaration] of Object.entries(declarations.subpaths ?? {})) {
    if (!Object.hasOwn(subpathMetadata, specifier)) {
      subpathMetadata[specifier] = declaration;
    }
  }
  return deepFreeze({
    manifestFamilies,
    services: serviceMetadata,
    hostAccess: hostAccessMetadata,
    subpaths: subpathMetadata,
  });
}
