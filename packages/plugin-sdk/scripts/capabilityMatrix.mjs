import ts from 'typescript';

const AVAILABILITY_DISPOSITIONS = new Set(['available', 'deferred', 'retired']);
const SOURCE_API_AVAILABILITY = new Set(['present', 'absent']);
const LOADED_PLATFORM_PROOF = new Set(['not-recorded', 'established']);
const RELEASE_AVAILABILITY = new Set(['not-published', 'published']);
const MAINTAINED_PUBLIC_CONSUMER_PREFIXES = Object.freeze([
  'packages/plugins/',
  'packages/plugin-sdk/examples/',
  'packages/plugin-sdk/fixtures/external-targeted-packages/',
  'packages/plugin-ui/fixtures/',
  'packages/tests/fixtures/plugin-platform/',
]);
/**
 * The canonical host owners that can bind, project, or run a public capability.
 * An available row cites one of these as its host binder and one as its
 * runtime lifecycle owner, chosen for its applicable realm; a Protocol
 * catalog entry, a `PluginServices` member spelling, or a published source
 * module declares a capability and binds nothing, so it can only be a row's
 * declaration owner. A row whose applicable realm has no owner here stays
 * deferred with both owner facts null.
 */
export const CAPABILITY_HOST_BINDING_OWNERS_V1 = Object.freeze({
  /** Binds manifest families that a plugin registers in the daemon realm. */
  contributionRuntimeRegistration: 'apps/cli/src/plugins/runtime/resolveExecutablePluginRuntimeRegistry.ts',
  /** Binds and retires client-realm executable registrations. */
  clientExecutableRegistration: 'apps/ui/sources/components/plugins/reactNative/clientExecutableContributions.ts',
  /** Projects the Plugin UI surface families into the client projection. */
  pluginUiFamilyProjection: 'apps/cli/src/plugins/projection/registry/ui/projection.ts',
  /** Projects the browser target/action families into the client projection. */
  browserFamilyProjection: 'apps/cli/src/plugins/projection/registry/browser.ts',
  /** Projects the Composer surface families into the client projection. */
  composerFamilyProjection: 'apps/cli/src/plugins/projection/registry/composer.ts',
  /** Projects declared managed dependencies into the client projection. */
  managedDependencyFamilyProjection: 'apps/cli/src/plugins/projection/registry/managedDependencies.ts',
  /** Projects cold machine-provisioner descriptors; executable roles remain ordinary Actions. */
  machineProvisionerFamilyProjection: 'apps/cli/src/plugins/projection/registry/machineProvisioners.ts',
  /** Projects declared Account collections into the client projection. */
  accountCollectionFamilyProjection: 'apps/cli/src/plugins/projection/registry/accountCollections.ts',
  /** Projects declared Voice model packs into the client projection. */
  voiceDeclarationFamilyProjection: 'apps/cli/src/plugins/projection/registry/voiceDeclarations.ts',
  /** Projects declared roles into the existing role source catalog. */
  roleFamilyProjection: 'apps/cli/src/plugins/projection/registry/roles.ts',
  /** Projects declared workflows into the existing workflow library. */
  workflowFamilyProjection: 'apps/cli/src/plugins/projection/registry/workflows.ts',
  inputTypeFamilyProjection: 'apps/cli/src/plugins/projection/registry/inputTypes.ts',
  /** Admits contribution points and the contributions targeting them. */
  targetedContributionAdmission: 'apps/cli/src/plugins/projection/registry/targetedContributions.ts',
  /** Binds declared plugin commands onto the CLI command surface. */
  cliPluginCommandHost: 'apps/cli/src/cli/pluginCommandContributions.ts',
  /** Projects declared plugin tools into the executable Agent tool catalog. */
  agentToolCatalogProjection: 'apps/cli/src/plugins/runtime/toolCatalog.ts',
  /** Binds declared execution-run profiles onto the execution-run capability. */
  executionRunProfileHost: 'apps/cli/src/capabilities/registry/toolExecutionRuns.ts',
  /** Projects declared system tools onto the host exec surface. */
  systemToolProjection: 'apps/cli/src/plugins/runtime/exec/system/tools/definitions.ts',
  /** Binds declared Settings scopes/fields onto the plugin Settings host. */
  pluginSettingsHost: 'apps/cli/src/plugins/runtime/invocation/services/settings.ts',
  /** Binds declared notification categories onto the notifications host. */
  pluginNotificationsHost: 'apps/cli/src/plugins/runtime/invocation/services/notifications.ts',
  /** Owns contribution activation, deactivation, and disposal. */
  contributionActivationLifecycle: 'apps/cli/src/plugins/runtime/lifecycle/manager.ts',
  /** Prepares manifest-declared daemon databases during daemon readiness. */
  daemonDatabaseRuntime: 'apps/cli/src/plugins/daemon/runtimeOwner.ts',
  /** Resolves a webhook declaration against the exact current manifest. */
  webhookContributionCurrentness: 'apps/server/sources/app/plugins/webhooks/currentContribution.ts',
  /** Owns webhook delivery claim, lease, settlement, and recovery. */
  webhookDeliveryLifecycle: 'apps/server/sources/app/plugins/webhooks/claimStore.ts',
  /** Binds the binding-owned `PluginServices` members onto one invocation. */
  invocationServiceBinding: 'apps/cli/src/plugins/runtime/invocation/services/factory.ts',
  /** Composes the host-owned `PluginServices` members for one invocation. */
  invocationHostServiceComposition: 'apps/cli/src/plugins/runtime/invocation/services/production.ts',
  /** Owns invocation lifetime: settle, abort, and completion. */
  invocationLifetime: 'apps/cli/src/plugins/runtime/invocation/lifetime.ts',
  /** Resolves every HostAccess request against the invocation binding. */
  hostAccessResolver: 'apps/cli/src/plugins/runtime/hostAccess/resolve.ts',
  /** Binds Agent-session terminal access into the plugin runtime context. */
  agentSessionTerminalHost: 'apps/cli/src/plugins/runtime/context/terminalHost.ts',
  /** Owns the Agent-session host services that outlive one invocation. */
  agentSessionHostServices: 'apps/cli/src/agent/runtime/registry/engineRegistry/nativeAgentSessionHostServiceOwners.ts',
  /** Resolves every published author subpath for consumers. */
  publishedPackageExports: 'packages/plugin-sdk/package.json',
  /** Loads author modules in the daemon realm. */
  daemonPluginModuleLoader: 'apps/cli/src/plugins/runtime/loadPluginModule.ts',
  /** Mounts author surfaces in the client realm. */
  clientPluginUiSurfaceHost: 'packages/plugin-ui/src/surfaceEntry.tsx',
  /** Builds the author UI artifacts the build realm publishes. */
  pluginUiBuildToolchain: 'packages/plugin-sdk/src/ui/build/buildUniversalUiArtifacts.ts',
});
const HOST_BINDING_OWNER_MODULES = new Set(Object.values(CAPABILITY_HOST_BINDING_OWNERS_V1));

/** A capability whose applicable realm names no binder and no lifecycle owner. */
const UNBOUND_REALM_OWNERS = Object.freeze({ specialistOwner: null, lifecycleOwner: null });

function realmOwners(specialistOwner, lifecycleOwner) {
  return Object.freeze({ specialistOwner, lifecycleOwner });
}

const DAEMON_REGISTRATION_OWNERS = realmOwners(
  CAPABILITY_HOST_BINDING_OWNERS_V1.contributionRuntimeRegistration,
  CAPABILITY_HOST_BINDING_OWNERS_V1.contributionActivationLifecycle,
);

function declarativeFamilyOwners(binder) {
  return realmOwners(binder, CAPABILITY_HOST_BINDING_OWNERS_V1.contributionActivationLifecycle);
}

/**
 * The exhaustive owner map for catalogued manifest families. Each row names the
 * host owner that really binds or projects that family in the realm it applies
 * to, plus the owner that runs its lifecycle there. Catalog registration and
 * projection fields are declaration labels, so they select nothing here: a
 * family absent from this map has no nameable binder and cannot be available.
 */
export const MANIFEST_FAMILY_REALM_OWNERS_V1 = Object.freeze({
  // Families a plugin registers into the daemon runtime registry, activated and
  // retired with their generation by the contribution lifecycle manager.
  agents: DAEMON_REGISTRATION_OWNERS,
  providers: DAEMON_REGISTRATION_OWNERS,
  actions: DAEMON_REGISTRATION_OWNERS,
  resources: DAEMON_REGISTRATION_OWNERS,
  events: DAEMON_REGISTRATION_OWNERS,
  notificationChannels: DAEMON_REGISTRATION_OWNERS,
  scmHostingProviders: DAEMON_REGISTRATION_OWNERS,
  scmBackends: DAEMON_REGISTRATION_OWNERS,
  connectedAccountDescriptors: DAEMON_REGISTRATION_OWNERS,
  promptAssets: DAEMON_REGISTRATION_OWNERS,
  hooks: DAEMON_REGISTRATION_OWNERS,
  requestInterceptors: DAEMON_REGISTRATION_OWNERS,
  backgroundServices: DAEMON_REGISTRATION_OWNERS,
  captureSources: DAEMON_REGISTRATION_OWNERS,
  projectNativeAdapters: DAEMON_REGISTRATION_OWNERS,
  composerReferences: DAEMON_REGISTRATION_OWNERS,
  composerAttachments: DAEMON_REGISTRATION_OWNERS,
  'mcp.servers': DAEMON_REGISTRATION_OWNERS,
  'mcp.discoverySources': DAEMON_REGISTRATION_OWNERS,
  // Voice providers run on web/iOS/Android only: the client executable
  // registration index binds them and withdraws them, not the daemon registry.
  voiceProviders: realmOwners(
    CAPABILITY_HOST_BINDING_OWNERS_V1.clientExecutableRegistration,
    CAPABILITY_HOST_BINDING_OWNERS_V1.clientExecutableRegistration,
  ),
  dragSources: realmOwners(
    CAPABILITY_HOST_BINDING_OWNERS_V1.clientExecutableRegistration,
    CAPABILITY_HOST_BINDING_OWNERS_V1.clientExecutableRegistration,
  ),
  dropTargets: realmOwners(
    CAPABILITY_HOST_BINDING_OWNERS_V1.clientExecutableRegistration,
    CAPABILITY_HOST_BINDING_OWNERS_V1.clientExecutableRegistration,
  ),
  // Declarative families whose reachability is the client projection their own
  // projection-family owner builds.
  transcriptActivities: declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.pluginUiFamilyProjection),
  sessionInfoSections: declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.pluginUiFamilyProjection),
  sessionHeaderActions: declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.pluginUiFamilyProjection),
  searchProviders: declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.pluginUiFamilyProjection),
  openableContentViewers: declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.pluginUiFamilyProjection),
  'ui.views': declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.pluginUiFamilyProjection),
  'ui.renderers': declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.pluginUiFamilyProjection),
  'ui.settingsGroups': declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.pluginUiFamilyProjection),
  'ui.settingsPages': declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.pluginUiFamilyProjection),
  'ui.translations': declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.pluginUiFamilyProjection),
  browserTargets: declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.browserFamilyProjection),
  browserActions: declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.browserFamilyProjection),
  composerControls: declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.composerFamilyProjection),
  composerRegions: declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.composerFamilyProjection),
  managedDependencies: declarativeFamilyOwners(
    CAPABILITY_HOST_BINDING_OWNERS_V1.managedDependencyFamilyProjection,
  ),
  machineProvisioners: declarativeFamilyOwners(
    CAPABILITY_HOST_BINDING_OWNERS_V1.machineProvisionerFamilyProjection,
  ),
  accountCollections: declarativeFamilyOwners(
    CAPABILITY_HOST_BINDING_OWNERS_V1.accountCollectionFamilyProjection,
  ),
  voiceModelPacks: declarativeFamilyOwners(
    CAPABILITY_HOST_BINDING_OWNERS_V1.voiceDeclarationFamilyProjection,
  ),
  // Declarative families a named host surface consumes directly.
  commands: declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.cliPluginCommandHost),
  tools: declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.agentToolCatalogProjection),
  settings: declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.pluginSettingsHost),
  'settings.fields': declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.pluginSettingsHost),
  executionRunProfiles: declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.executionRunProfileHost),
  roles: declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.roleFamilyProjection),
  workflows: declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.workflowFamilyProjection),
  inputTypes: declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.inputTypeFamilyProjection),
  notifications: declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.pluginNotificationsHost),
  systemTools: declarativeFamilyOwners(CAPABILITY_HOST_BINDING_OWNERS_V1.systemToolProjection),
  pluginContributionPoints: declarativeFamilyOwners(
    CAPABILITY_HOST_BINDING_OWNERS_V1.targetedContributionAdmission,
  ),
  targetedPluginContributions: declarativeFamilyOwners(
    CAPABILITY_HOST_BINDING_OWNERS_V1.targetedContributionAdmission,
  ),
  // Families whose binder and lifecycle owner are outside contribution
  // activation entirely.
  daemonDatabases: realmOwners(
    CAPABILITY_HOST_BINDING_OWNERS_V1.daemonDatabaseRuntime,
    CAPABILITY_HOST_BINDING_OWNERS_V1.daemonDatabaseRuntime,
  ),
  webhooks: realmOwners(
    CAPABILITY_HOST_BINDING_OWNERS_V1.webhookContributionCurrentness,
    CAPABILITY_HOST_BINDING_OWNERS_V1.webhookDeliveryLifecycle,
  ),
});

const BINDING_OWNED_SERVICE_OWNERS = realmOwners(
  CAPABILITY_HOST_BINDING_OWNERS_V1.invocationServiceBinding,
  CAPABILITY_HOST_BINDING_OWNERS_V1.invocationLifetime,
);
const HOST_OWNED_SERVICE_OWNERS = realmOwners(
  CAPABILITY_HOST_BINDING_OWNERS_V1.invocationHostServiceComposition,
  CAPABILITY_HOST_BINDING_OWNERS_V1.invocationLifetime,
);

/**
 * The exhaustive owner map for published `PluginServices` members, split the
 * way the host itself splits them: `availabilityOwner: 'binding'` members are
 * bound by the invocation service binding, and `availabilityOwner: 'host'`
 * members are composed by the host service owner. A `PluginServices` spelling
 * proves neither, so a member absent from this map cannot be available.
 */
export const PLUGIN_SERVICE_REALM_OWNERS_V1 = Object.freeze({
  logger: BINDING_OWNED_SERVICE_OWNERS,
  events: BINDING_OWNED_SERVICE_OWNERS,
  http: BINDING_OWNED_SERVICE_OWNERS,
  fs: BINDING_OWNED_SERVICE_OWNERS,
  exec: BINDING_OWNED_SERVICE_OWNERS,
  managedServices: BINDING_OWNED_SERVICE_OWNERS,
  sessions: BINDING_OWNED_SERVICE_OWNERS,
  mcp: BINDING_OWNED_SERVICE_OWNERS,
  connectedAccounts: BINDING_OWNED_SERVICE_OWNERS,
  storage: HOST_OWNED_SERVICE_OWNERS,
  settings: HOST_OWNED_SERVICE_OWNERS,
  secrets: HOST_OWNED_SERVICE_OWNERS,
  providers: HOST_OWNED_SERVICE_OWNERS,
  resources: HOST_OWNED_SERVICE_OWNERS,
  notifications: HOST_OWNED_SERVICE_OWNERS,
  actions: HOST_OWNED_SERVICE_OWNERS,
  targetedContributions: HOST_OWNED_SERVICE_OWNERS,
  composerContent: HOST_OWNED_SERVICE_OWNERS,
  machineProvisioners: HOST_OWNED_SERVICE_OWNERS,
  interactions: HOST_OWNED_SERVICE_OWNERS,
});

const INVOCATION_HOST_ACCESS_OWNERS = realmOwners(
  CAPABILITY_HOST_BINDING_OWNERS_V1.hostAccessResolver,
  CAPABILITY_HOST_BINDING_OWNERS_V1.invocationLifetime,
);

/**
 * The exhaustive owner map for catalogued HostAccess capabilities. The daemon
 * resolver binds each ordinary grant for one invocation lifetime; the
 * Agent-session terminal is bound and run outside an invocation; and the three
 * capabilities the resolver refuses to serve name no owner at all.
 */
export const HOST_ACCESS_REALM_OWNERS_V1 = Object.freeze({
  network: INVOCATION_HOST_ACCESS_OWNERS,
  'network.client': INVOCATION_HOST_ACCESS_OWNERS,
  filesystem: INVOCATION_HOST_ACCESS_OWNERS,
  process: INVOCATION_HOST_ACCESS_OWNERS,
  environment: INVOCATION_HOST_ACCESS_OWNERS,
  connectedAccounts: INVOCATION_HOST_ACCESS_OWNERS,
  sessions: INVOCATION_HOST_ACCESS_OWNERS,
  'storage.account': INVOCATION_HOST_ACCESS_OWNERS,
  mcp: INVOCATION_HOST_ACCESS_OWNERS,
  terminal: realmOwners(
    CAPABILITY_HOST_BINDING_OWNERS_V1.agentSessionTerminalHost,
    CAPABILITY_HOST_BINDING_OWNERS_V1.agentSessionHostServices,
  ),
  browser: UNBOUND_REALM_OWNERS,
  clipboard: UNBOUND_REALM_OWNERS,
  externalLinks: UNBOUND_REALM_OWNERS,
});

/**
 * The exhaustive owner map for published author subpaths, keyed by the realm
 * the API inventory records. The package `exports` map resolves every subpath;
 * the realm decides which host runs the module. An unrecorded realm names no
 * runtime owner rather than defaulting to the daemon loader.
 */
export const PUBLISHED_SUBPATH_REALM_OWNERS_V1 = Object.freeze({
  any: realmOwners(
    CAPABILITY_HOST_BINDING_OWNERS_V1.publishedPackageExports,
    CAPABILITY_HOST_BINDING_OWNERS_V1.daemonPluginModuleLoader,
  ),
  daemon: realmOwners(
    CAPABILITY_HOST_BINDING_OWNERS_V1.publishedPackageExports,
    CAPABILITY_HOST_BINDING_OWNERS_V1.daemonPluginModuleLoader,
  ),
  browser: realmOwners(
    CAPABILITY_HOST_BINDING_OWNERS_V1.publishedPackageExports,
    CAPABILITY_HOST_BINDING_OWNERS_V1.clientPluginUiSurfaceHost,
  ),
  client: realmOwners(
    CAPABILITY_HOST_BINDING_OWNERS_V1.publishedPackageExports,
    CAPABILITY_HOST_BINDING_OWNERS_V1.clientPluginUiSurfaceHost,
  ),
  build: realmOwners(
    CAPABILITY_HOST_BINDING_OWNERS_V1.publishedPackageExports,
    CAPABILITY_HOST_BINDING_OWNERS_V1.pluginUiBuildToolchain,
  ),
});

/** The module that declares the public service catalog, not a member spelling. */
const PLUGIN_SERVICES_DECLARATION_MODULE = 'packages/plugin-sdk/src/services/index.ts';
const PLUGIN_SERVICES_MEMBER_SPELLING = /#PluginServices\./u;

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

function optionalMaintainedPublicConsumer(value, label, diagnostics) {
  if (value === null || value === undefined) return null;
  if (!isMaintainedPublicConsumerPath(value)) {
    diagnostics.push(`${label} must be null or name a maintained public plugin/example consumer`);
    return null;
  }
  return value;
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
  const provingConsumer = optionalMaintainedPublicConsumer(
    value.provingConsumer,
    `${label}.provingConsumer`,
    diagnostics,
  );
  const specialistOwner = value.specialistOwner ?? null;
  const lifecycleOwner = value.lifecycleOwner ?? null;
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
    // Availability is a fact of the canonical declaration owner, the host
    // binder/projection that serves the row in its realm, and the owner that
    // runs its lifecycle there. A row may never prove any of those with itself.
    if (availabilityDisposition === 'available') {
      if (producer !== null && PLUGIN_SERVICES_MEMBER_SPELLING.test(producer)) {
        diagnostics.push(
          `${label}.producer must name the module that declares the capability`
          + '; a PluginServices member spelling declares no module',
        );
      }
      if (!HOST_BINDING_OWNER_MODULES.has(specialistOwner)) {
        diagnostics.push(
          `${label}.specialistOwner must name a canonical host binder/projection owner`
          + '; a declaration catalog, type member, or published source module binds nothing',
        );
      }
      if (!HOST_BINDING_OWNER_MODULES.has(lifecycleOwner)) {
        diagnostics.push(
          `${label}.lifecycleOwner must name a canonical runtime lifecycle owner`
          + '; a lifecycle stage label owns no lifecycle',
        );
      }
      if (specialistOwner !== null && specialistOwner === producer) {
        diagnostics.push(`${label}.specialistOwner must not repeat its own declaration owner`);
      }
      if (lifecycleOwner !== null && lifecycleOwner === producer) {
        diagnostics.push(`${label}.lifecycleOwner must not repeat its own declaration owner`);
      }
    } else if (specialistOwner !== null || lifecycleOwner !== null) {
      diagnostics.push(
        `${label} must leave specialistOwner and lifecycleOwner null while it is ${availabilityDisposition}`,
      );
    }
  }
  // Every row joins a canonical public catalog/entrypoint, so source API
  // availability is a matrix-owned fact. Loaded-platform and release evidence
  // remain independently unrecorded until their owners establish them.
  const sourceApiAvailability = value.sourceApiAvailability ?? 'present';
  if (!SOURCE_API_AVAILABILITY.has(sourceApiAvailability)) {
    diagnostics.push(`${label}.sourceApiAvailability must be present or absent`);
  }
  const sourceConsumer = optionalMaintainedPublicConsumer(
    value.sourceConsumer,
    `${label}.sourceConsumer`,
    diagnostics,
  );
  const loadedPlatformProof = value.loadedPlatformProof ?? 'not-recorded';
  if (!LOADED_PLATFORM_PROOF.has(loadedPlatformProof)) {
    diagnostics.push(`${label}.loadedPlatformProof must be not-recorded or established`);
  }
  const releaseAvailability = value.releaseAvailability ?? 'not-published';
  if (!RELEASE_AVAILABILITY.has(releaseAvailability)) {
    diagnostics.push(`${label}.releaseAvailability must be not-published or published`);
  }
  if (!producer || (lifecycle && !normalizedLifecycle) || !predecessorRemoval) {
    return null;
  }
  return Object.freeze({
    producer,
    ...(lifecycle ? { lifecycle: normalizedLifecycle } : {}),
    provingConsumer,
    specialistOwner,
    lifecycleOwner,
    predecessorRemoval,
    sourceApiAvailability,
    sourceConsumer,
    loadedPlatformProof,
    releaseAvailability,
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
      { disposition: true, lifecycle: false },
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
      { disposition: true },
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
      { disposition: true },
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
 * Source availability is established when a row joins the canonical catalog;
 * source consumers, loaded-runtime proof, and release availability remain
 * separate facts. This is the single metadata choke point before projection.
 */
function withEvidenceLifecycleFacts(declaration) {
  if (!isRecord(declaration)) return declaration;
  return Object.freeze({
    ...declaration,
    sourceApiAvailability: declaration.sourceApiAvailability ?? 'present',
    sourceConsumer: declaration.sourceConsumer ?? null,
    loadedPlatformProof: declaration.loadedPlatformProof ?? 'not-recorded',
    releaseAvailability: declaration.releaseAvailability ?? 'not-published',
  });
}

/**
 * Reads the owners of one capability from its canonical map. A capability the
 * map does not name has no host binder and no runtime lifecycle owner: it stays
 * unbound here instead of inheriting a generic registry, reader, or loader.
 */
function mappedRealmOwners(map, identity) {
  return typeof identity === 'string' && Object.hasOwn(map, identity)
    ? map[identity]
    : UNBOUND_REALM_OWNERS;
}

/**
 * Fills only facts that already have one canonical source. Declarations own
 * availability and optional positive-consumer (or deferred-unblock) facts for every
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
        ...mappedRealmOwners(MANIFEST_FAMILY_REALM_OWNERS_V1, entry.manifestKey),
        predecessorRemoval: `catalog-disposition:${entry.disposition}`,
        ...withEvidenceLifecycleFacts(declaration),
      });
    }
  }
  for (const [family, declaration] of Object.entries(declarations.manifestFamilies ?? {})) {
    if (!Object.hasOwn(manifestFamilies, family)) {
      manifestFamilies[family] = withEvidenceLifecycleFacts(declaration);
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
        ...mappedRealmOwners(PLUGIN_SERVICE_REALM_OWNERS_V1, service.id),
        predecessorRemoval: 'none',
        ...withEvidenceLifecycleFacts(declaration),
      });
    }
  }
  for (const [serviceId, declaration] of Object.entries(declarations.services ?? {})) {
    if (!Object.hasOwn(serviceMetadata, serviceId)) {
      serviceMetadata[serviceId] = withEvidenceLifecycleFacts(declaration);
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
        ...mappedRealmOwners(HOST_ACCESS_REALM_OWNERS_V1, entry.capability),
        predecessorRemoval: 'none',
        ...withEvidenceLifecycleFacts(declaration),
      });
    }
  }
  for (const [capability, declaration] of Object.entries(declarations.hostAccess ?? {})) {
    if (!Object.hasOwn(hostAccessMetadata, capability)) {
      hostAccessMetadata[capability] = withEvidenceLifecycleFacts(declaration);
    }
  }
  const subpathMetadata = {};
  for (const entrypoint of entrypoints) {
    const declaration = declarations.subpaths?.[entrypoint.specifier];
    if (declaration !== undefined) {
      subpathMetadata[entrypoint.specifier] = Object.freeze({
          producer: entrypoint.sourceModule,
          lifecycle: 'published',
          ...mappedRealmOwners(PUBLISHED_SUBPATH_REALM_OWNERS_V1, entrypoint.realm),
          predecessorRemoval: 'none',
          ...withEvidenceLifecycleFacts(declaration),
      });
    }
  }
  for (const [specifier, declaration] of Object.entries(declarations.subpaths ?? {})) {
    if (!Object.hasOwn(subpathMetadata, specifier)) {
      subpathMetadata[specifier] = withEvidenceLifecycleFacts(declaration);
    }
  }
  return deepFreeze({
    manifestFamilies,
    services: serviceMetadata,
    hostAccess: hostAccessMetadata,
    subpaths: subpathMetadata,
  });
}
