import {
  compilePluginJsonSchema as canonicalCompilePluginJsonSchema,
  createPluginContributionIdentity as canonicalCreatePluginContributionIdentity,
  ingestPluginManifestV2,
  isValidPluginJsonSchemaValue as canonicalIsValidPluginJsonSchemaValue,
  PluginContributionIdentityV1JsonSchema as canonicalPluginContributionIdentityV1JsonSchema,
  PluginContributionIdentityV1Schema as canonicalPluginContributionIdentityV1Schema,
  PluginIdJsonSchema as canonicalPluginIdJsonSchema,
  PluginIdSchema as canonicalPluginIdSchema,
} from '@happier-dev/protocol/plugins/manifest';
import type { JsonValue, PluginJsonSchema } from './identity.js';
import type { ProtocolComposableSchema } from './protocol/protocolFacade.js';
import type { ComposerOperationV1 } from './ui/hostApi.js';

/** A qualified Plugin-local contribution identity. */
export type PluginContributionIdentity = Readonly<{
  pluginId: string;
  localId: string;
}>;

/** The callable JSON-schema validator contract, without the AJV owner graph. */
export type PluginJsonSchemaValidator = (value: unknown) => boolean;

/** Public prompt-asset capability facts retained by manifest declarations. */
export type PromptAssetCapabilities = Readonly<{
  supportsCatalogInstall?: boolean;
  supportsNestedNamespaces?: boolean;
  supportsSymlinkInstall?: boolean;
  [key: string]: unknown;
}>;

/** Public prompt-asset descriptor facts retained by manifest declarations. */
export type PromptAssetTypeDescriptor = Readonly<{
  id: string;
  providerId: string;
  title: string;
  description: string;
  libraryKind: 'doc' | 'bundle';
  supportsScope: Readonly<{
    user: boolean;
    project: boolean;
    [key: string]: unknown;
  }>;
  supportsFiles: boolean;
  formatId: string;
  defaultRoots: readonly Readonly<{
    label: string;
    scope: 'user' | 'project';
    pathTemplate: string;
    [key: string]: unknown;
  }>[];
  capabilities: PromptAssetCapabilities;
  [key: string]: unknown;
}>;

// Preserve canonical runtime identity while making every declaration-facing
// type local to this public SDK boundary.
export const compilePluginJsonSchema: (schema: PluginJsonSchema) => PluginJsonSchemaValidator =
  canonicalCompilePluginJsonSchema;
export const isValidPluginJsonSchemaValue: (
  validate: PluginJsonSchemaValidator,
  value: unknown,
) => boolean = canonicalIsValidPluginJsonSchemaValue;
export const createPluginContributionIdentity: (
  input: PluginContributionIdentity,
) => PluginContributionIdentity = canonicalCreatePluginContributionIdentity;
export const PluginContributionIdentityV1JsonSchema: PluginJsonSchema =
  canonicalPluginContributionIdentityV1JsonSchema;
export const PluginContributionIdentityV1Schema: ProtocolComposableSchema<PluginContributionIdentity> =
  canonicalPluginContributionIdentityV1Schema;
export const PluginIdJsonSchema: PluginJsonSchema = canonicalPluginIdJsonSchema;
export const PluginIdSchema: ProtocolComposableSchema<string> = canonicalPluginIdSchema;

type DeferredPublicHostAccessCapability =
  | 'browser'
  | 'clipboard'
  | 'externalLinks';
const DEFERRED_PUBLIC_HOST_ACCESS_CAPABILITIES = new Set<string>([
  'browser',
  'clipboard',
  'externalLinks',
]);
type ParsedRequiredHostAccessRequest = Readonly<{ capability: string }>;

function isPublicRequiredHostAccessRequest<TRequest extends ParsedRequiredHostAccessRequest>(
  request: TRequest,
): request is Exclude<TRequest, { capability: DeferredPublicHostAccessCapability }> {
  return !DEFERRED_PUBLIC_HOST_ACCESS_CAPABILITIES.has(request.capability);
}

export type PluginLocalizedStringV2 =
  | string
  | Readonly<{ key: string; fallback: string }>;

export type PluginAvailabilityDescriptor = unknown;
export type PluginContributionReference =
  | string
  | Readonly<{ pluginId: string; localId: string }>;
export type PluginHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export type PluginBrowserContributionDisplay = Readonly<{
  id: string;
  title: PluginLocalizedStringV2;
  description?: PluginLocalizedStringV2;
  availability?: PluginAvailabilityDescriptor;
  metadata?: Readonly<Record<string, JsonValue>>;
}>;
export type PluginBrowserTargetContributionInput = PluginBrowserContributionDisplay & Readonly<{
  url: string;
  launch?: 'newView' | 'currentView';
  profile?: 'ephemeral' | 'session' | 'user' | 'plugin';
}>;
export type PluginBrowserTargetContribution = Omit<PluginBrowserTargetContributionInput, 'launch' | 'profile'> & Readonly<{
  launch: 'newView' | 'currentView';
  profile: 'ephemeral' | 'session' | 'user' | 'plugin';
}>;
export type PluginBrowserActionContributionInput = PluginBrowserContributionDisplay & Readonly<{
  action: PluginContributionReference;
  target: PluginContributionReference;
  placement?: 'toolbar' | 'detailsPanel' | 'contextMenu';
  icon?: string;
  order?: number;
}>;
export type PluginBrowserActionContribution = Omit<PluginBrowserActionContributionInput, 'placement'> & Readonly<{
  placement: 'toolbar' | 'detailsPanel' | 'contextMenu';
}>;
export type PluginRequestInterceptorContribution = Readonly<{
  id: string;
  origins: readonly string[];
  methods?: readonly PluginHttpMethod[];
  priority?: number;
  availability?: PluginAvailabilityDescriptor;
  metadata?: Readonly<Record<string, JsonValue>>;
}>;

export type PublicHostAccessCapability =
  | 'network'
  | 'network.client'
  | 'filesystem'
  | 'process'
  | 'environment'
  | 'connectedAccounts'
  | 'sessions'
  | 'terminal'
  | 'storage.account'
  | 'mcp';
/** Public author input accepted by the canonical manifest schema. */
export type PluginManifestAuthorInput = {
  schemaVersion: 2;
  id: string;
  version: string;
  displayName: PluginLocalizedStringV2;
  description?: PluginLocalizedStringV2;
  engines?: { happier?: string };
  runtime: { apiVersion: 1 };
  entrypoints?: { daemon?: string; development?: string };
  brand?: { iconResourceId: string };
  activation?: { events?: readonly Readonly<{ kind: 'startup' }>[] };
  hostAccess?: Readonly<{
    required?: readonly Readonly<{
      id: string;
      reason: PluginLocalizedStringV2;
      capability: PublicHostAccessCapability;
      scope: Readonly<Record<string, unknown>>;
    }>[];
    optional?: readonly Readonly<{
      id: string;
      reason: PluginLocalizedStringV2;
      capability: 'connectedAccounts' | 'sessions' | 'storage.account' | 'mcp';
      scope: Readonly<Record<string, unknown>>;
    }>[];
  }>;
  secrets?: readonly Readonly<{
    id: string;
    readonly [key: string]: unknown;
  }>[];
  contributes?: Readonly<{
    [TKey in
      | 'agents'
      | 'commands'
      | 'tools'
      | 'resources'
      | 'transcriptActivities'
      | 'sessionHeaderActions'
      | 'settings'
      | 'events'
      | 'executionRunProfiles'
      | 'notifications'
      | 'notificationChannels'
      | 'scmHostingProviders'
      | 'scmBackends'
      | 'connectedAccountDescriptors'
      | 'managedDependencies'
      | 'systemTools'
      | 'hooks'
      | 'voiceModelPacks'
      | 'voiceProviders'
      | 'backgroundServices'
      | 'composerReferences'
      | 'composerControls'
      | 'composerRegions'
      | 'openableContentViewers'
      | 'accountCollections'
      | 'webhooks'
      | 'pluginContributionPoints'
      | 'targetedPluginContributions']?: readonly Readonly<{
      id: string;
      readonly [key: string]: unknown;
    }>[];
  } & {
    providers?: readonly (Readonly<{
      id: string;
      readonly [key: string]: unknown;
    }> & Readonly<{
      managedRuntime?: Readonly<Record<string, unknown>>;
    }>)[];
    actions?: readonly (Readonly<{
      id: string;
      readonly [key: string]: unknown;
    }> & Readonly<{
      inputSchema?: PluginJsonSchema | null;
      resultSchema?: PluginJsonSchema | null;
      surfaces: readonly string[];
    }>)[];
    promptAssets?: readonly (Readonly<{
      id: string;
      readonly [key: string]: unknown;
    }> & Readonly<{
      kind: 'systemPrompt' | 'context' | 'guidelines';
      resource: string | Readonly<{ pluginId: string; localId: string }>;
      target: Readonly<{
        kind: 'agent';
        agent: string | Readonly<{ pluginId: string; localId: string }>;
      }>;
      priority?: number;
      adapterDescriptor?: Readonly<{
        id: string;
        providerId: string;
        title: string;
        description: string;
        libraryKind: 'doc' | 'bundle';
        supportsScope: Readonly<{
          user: boolean;
          project: boolean;
          [key: string]: unknown;
        }>;
        supportsFiles: boolean;
        formatId: string;
        defaultRoots: readonly Readonly<{
          label: string;
          scope: 'user' | 'project';
          pathTemplate: string;
          [key: string]: unknown;
        }>[];
        capabilities: Readonly<{
          supportsCatalogInstall?: boolean;
          supportsNestedNamespaces?: boolean;
          supportsSymlinkInstall?: boolean;
          [key: string]: unknown;
        }>;
        [key: string]: unknown;
      }>;
      availability?: unknown;
      metadata?: Readonly<Record<string, JsonValue>>;
    }>)[];
    daemonDatabases?: readonly (Readonly<{
      id: string;
      readonly [key: string]: unknown;
    }> & Readonly<{
      migrations: readonly Readonly<{ version: number; id: string }>[];
      incumbentQueryFixtureId: string;
    }>)[];
    composerAttachments?: readonly (Readonly<{
      id: string;
      readonly [key: string]: unknown;
    }> & Readonly<{
      valueSchema?: object;
      preparedValueSchema?: object;
      runtime?: Readonly<Record<string, boolean | undefined>>;
    }>)[];
    mcp?: Readonly<{
      servers?: readonly Readonly<{
        id: string;
        readonly [key: string]: unknown;
      }>[];
      discoverySources?: readonly Readonly<{
        id: string;
        readonly [key: string]: unknown;
      }>[];
    }>;
    ui?: Readonly<{
      views?: readonly (Readonly<{
        id: string;
        renderer: string;
        fallbackRenderers?: readonly string[];
        readonly [key: string]: unknown;
      }> & (
        | Readonly<{ container: 'appPage'; target: Readonly<{ kind: 'app' }> }>
        | Readonly<{
          container: 'rightSidebarTab';
          target:
            | Readonly<{ kind: 'app' }>
            | Readonly<{ kind: 'session'; sessionIdPath?: string }>
            | Readonly<{
              kind: 'project';
              workspaceRefIdPath?: string;
              serverIdPath?: string;
              machineIdPath?: string;
              rootPathPath?: string;
              projectIdPath?: string;
            }>;
        }>
        | Readonly<{
          container: 'rightPane' | 'detailsTab' | 'detailsPane' | 'bottomPane';
          target:
            | Readonly<{ kind: 'session'; sessionIdPath?: string }>
            | Readonly<{
              kind: 'project';
              workspaceRefIdPath?: string;
              serverIdPath?: string;
              machineIdPath?: string;
              rootPathPath?: string;
              projectIdPath?: string;
            }>;
        }>
        | Readonly<{
          container: 'browserPanel';
          target: Readonly<{
            kind: 'browser';
            browserViewIdPath: string;
            sessionIdPath?: string;
            profileIdPath?: string;
          }>;
        }>
        | Readonly<{
          container: 'servicesPanel';
          target: Readonly<{
            kind: 'services';
            sessionIdPath?: string;
            serverIdPath?: string;
            machineIdPath?: string;
          }>;
        }>
      ))[];
      renderers?: readonly (Readonly<{
        id: string;
        readonly [key: string]: unknown;
      }> & Readonly<{
        kind: string;
        artifact?: string;
        source?: unknown;
      }>)[];
      settingsGroups?: readonly Readonly<{
        id: string;
        readonly [key: string]: unknown;
      }>[];
      settingsPages?: readonly (Readonly<{
        id: string;
        readonly [key: string]: unknown;
      }> & Readonly<{ renderer: string }>)[];
      translations?: readonly Readonly<{
        locale: string;
        messages: Readonly<Record<string, string>>;
      }>[];
    }>;
    requestInterceptors?: readonly PluginRequestInterceptorContribution[];
    browserTargets?: readonly PluginBrowserTargetContributionInput[];
    browserActions?: readonly PluginBrowserActionContributionInput[];
  }>;
  metadata?: Readonly<Record<string, JsonValue>>;
};

/**
 * A portable author-manifest value accepts immutable literal declarations and
 * readonly normalized projections without exposing Protocol's output graph.
 */
export interface PluginManifest {
  readonly schemaVersion: 2;
  readonly id: string;
  readonly version: string;
  readonly displayName: PluginLocalizedStringV2;
  readonly description?: PluginLocalizedStringV2;
  readonly engines?: Readonly<NonNullable<PluginManifestAuthorInput['engines']>>;
  readonly runtime: Readonly<PluginManifestAuthorInput['runtime']>;
  readonly entrypoints?: Readonly<NonNullable<PluginManifestAuthorInput['entrypoints']>>;
  readonly brand?: Readonly<NonNullable<PluginManifestAuthorInput['brand']>>;
  readonly activation?: Readonly<NonNullable<PluginManifestAuthorInput['activation']>>;
  readonly hostAccess?: PluginManifestAuthorInput['hostAccess'];
  readonly secrets?: PluginManifestAuthorInput['secrets'];
  readonly contributes?: PluginManifestAuthorInput['contributes'];
  readonly metadata?: PluginManifestAuthorInput['metadata'];
}

/** Canonical readonly contribution collection returned by public structural parsing. */
export type PluginContributes = Readonly<{
  agents: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['agents']>;
  providers: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['providers']>;
  actions: readonly (Readonly<{
    id: string;
    readonly [key: string]: unknown;
  }> & Readonly<{
    inputSchema?: PluginJsonSchema;
    resultSchema?: PluginJsonSchema;
    surfaces: readonly string[];
    dangerLevel: string;
  }>)[];
  commands: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['commands']>;
  tools: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['tools']>;
  resources: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['resources']>;
  transcriptActivities: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['transcriptActivities']>;
  sessionHeaderActions: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['sessionHeaderActions']>;
  settings: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['settings']>;
  events: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['events']>;
  executionRunProfiles: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['executionRunProfiles']>;
  notifications: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['notifications']>;
  notificationChannels: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['notificationChannels']>;
  scmHostingProviders: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['scmHostingProviders']>;
  scmBackends: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['scmBackends']>;
  connectedAccountDescriptors: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['connectedAccountDescriptors']>;
  managedDependencies: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['managedDependencies']>;
  systemTools: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['systemTools']>;
  promptAssets: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['promptAssets']>;
  hooks: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['hooks']>;
  voiceModelPacks: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['voiceModelPacks']>;
  voiceProviders: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['voiceProviders']>;
  backgroundServices: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['backgroundServices']>;
  daemonDatabases: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['daemonDatabases']>;
  composerReferences: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['composerReferences']>;
  composerAttachments: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['composerAttachments']>;
  composerControls: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['composerControls']>;
  composerRegions: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['composerRegions']>;
  openableContentViewers: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['openableContentViewers']>;
  accountCollections: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['accountCollections']>;
  webhooks: NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['webhooks']>;
  requestInterceptors: readonly PluginRequestInterceptorContribution[];
  browserTargets: readonly PluginBrowserTargetContribution[];
  browserActions: readonly PluginBrowserActionContribution[];
  pluginContributionPoints: readonly (Readonly<{
    id: string;
    readonly [key: string]: unknown;
  }> & Readonly<{
    maxContributionsPerContributor?: number;
    protocols: readonly Readonly<{
      id: string;
      version: number;
      operations: Readonly<Record<string, Readonly<{ required: boolean }>>>;
    }>[];
  }>)[];
  targetedPluginContributions: readonly (Readonly<{
    id: string;
    readonly [key: string]: unknown;
  }> & Readonly<{
    target: Readonly<{
      pluginId: string;
      pointId: string;
    }>;
    protocol: Readonly<{
      id: string;
      version: number;
    }>;
    descriptor?: unknown;
    operations: Readonly<Record<string, string>>;
    surfaces?: unknown;
  }>)[];
  mcp: Required<NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['mcp']>>;
  ui: Required<NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['ui']>>;
}>;

/** Canonical portable manifest projected through declaration-safe SDK types. */
export interface ParsedPluginManifest extends Omit<
  PluginManifest,
  'activation' | 'hostAccess' | 'secrets' | 'contributes'
> {
  readonly activation?: Readonly<{
    events: NonNullable<NonNullable<PluginManifest['activation']>['events']>;
  }>;
  readonly hostAccess: Readonly<{
    required: NonNullable<NonNullable<PluginManifest['hostAccess']>['required']>;
    optional: NonNullable<NonNullable<PluginManifest['hostAccess']>['optional']>;
  }>;
  readonly secrets: NonNullable<PluginManifest['secrets']>;
  readonly contributes: PluginContributes;
}

/**
 * The daemon-independent testkit accepts a cold author declaration, a parsed
 * manifest, or a parsed fixture narrowed to just the contribution families a
 * test exercises. It always reparses through the canonical manifest owner.
 */
export type PluginTestkitManifest =
  | PluginManifest
  | ParsedPluginManifest
  | (Omit<ParsedPluginManifest, 'contributes'> & Readonly<{
    contributes: Partial<PluginContributes>;
  }>);

/** Structured portable-validation diagnostic suitable for author tooling. */
export type PluginManifestDiagnostic = Readonly<{
  code:
    | 'plugin_manifest_invalid_json'
    | 'plugin_manifest_invalid'
    | 'plugin_manifest_duplicate_contribution_id'
    | 'plugin_manifest_invalid_contribution_id'
    | 'plugin_manifest_dangling_reference'
    | 'plugin_manifest_wrong_family_reference';
  path?: readonly (string | number)[];
  message: string;
}>;
/** Portable structural parse result; host compatibility and installation checks are separate. */
export type PluginManifestParseResult =
  | Readonly<{ ok: true; manifest: ParsedPluginManifest }>
  | Readonly<{ ok: false; diagnostics: readonly PluginManifestDiagnostic[] }>;

function readPublicManifestDiagnostics(
  manifest: Readonly<{
    hostAccess: Readonly<{ required: readonly ParsedRequiredHostAccessRequest[] }>;
  }>,
  input: unknown,
): PluginManifestDiagnostic[] {
  const diagnostics: PluginManifestDiagnostic[] = [];
  manifest.hostAccess.required.forEach((request, index) => {
    if (!DEFERRED_PUBLIC_HOST_ACCESS_CAPABILITIES.has(request.capability)) return;
    diagnostics.push({
      code: 'plugin_manifest_invalid',
      path: ['hostAccess', 'required', index, 'capability'],
      message: `HostAccess capability '${request.capability}' is deferred from public plugin authoring until a maintained plugin consumer exists.`,
    });
  });
  return diagnostics;
}

/**
 * Parses the canonical cold manifest without consulting host version,
 * installation, trust, or currentness state.
 */
export function parsePluginManifest(input: unknown): PluginManifestParseResult {
  const parsed = ingestPluginManifestV2(input);
  if (!parsed.ok) return parsed;
  const diagnostics = readPublicManifestDiagnostics(parsed.manifest, input);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  type CanonicalRequiredHostAccessRequest =
    (typeof parsed.manifest.hostAccess.required)[number];
  const publicRequiredHostAccess = parsed.manifest.hostAccess.required.filter(
    (request): request is Exclude<
      CanonicalRequiredHostAccessRequest,
      { capability: DeferredPublicHostAccessCapability }
    > => isPublicRequiredHostAccessRequest(request),
  );
  return {
    ok: true,
    manifest: {
      ...parsed.manifest,
      hostAccess: {
        ...parsed.manifest.hostAccess,
        required: publicRequiredHostAccess,
      },
      contributes: parsed.manifest.contributes,
    },
  };
}

/**
 * The declarative renderer vocabulary named by the public manifest signature.
 * An author authoring a declarative tree cannot type the tree without
 * the node union and every node it is composed of, so the whole family stays
 * declaration-local at this public SDK seam rather than leaking Protocol's
 * package graph through an otherwise portable author manifest.
 */
export type PluginDeclarativeToneV2 =
  | 'default'
  | 'muted'
  | 'success'
  | 'warning'
  | 'danger';

export type PluginDeclarativeControlV2 =
  | Readonly<{ kind: 'text'; settingId: string }>
  | Readonly<{ kind: 'number'; settingId: string }>
  | Readonly<{ kind: 'toggle'; settingId: string }>
  | Readonly<{
    kind: 'select';
    settingId: string;
    options: readonly Readonly<{ value: JsonValue; label: PluginLocalizedStringV2 }>[];
  }>
  | Readonly<{ kind: 'secret'; settingId: string }>;

export type PluginDeclarativeComposerApplyEffectV1 = Readonly<{
  kind: 'composerApply';
  expectedRevision: number;
  operations: readonly ComposerOperationV1[];
}>;
export type PluginDeclarativeActionNodeV2 =
  | Readonly<{
    kind: 'action';
    action: string | Readonly<{ pluginId: string; localId: string }>;
    label: PluginLocalizedStringV2;
    variant?: 'primary' | 'secondary' | 'destructive';
    input?: JsonValue;
  }>
  | Readonly<{
    kind: 'action';
    effect: PluginDeclarativeComposerApplyEffectV1;
    label: PluginLocalizedStringV2;
    variant?: 'primary' | 'secondary' | 'destructive';
  }>;
export type PluginDeclarativeItemNodeV2 = Readonly<{
  kind: 'item';
  title: PluginLocalizedStringV2;
  subtitle?: PluginLocalizedStringV2;
  detail?: PluginLocalizedStringV2;
  icon?: string;
  tone?: PluginDeclarativeToneV2;
  action?: string | Readonly<{ pluginId: string; localId: string }>;
  input?: JsonValue;
}>;
export type PluginDeclarativeStateNodeV2 = Readonly<{
  kind: 'state';
  state: 'empty' | 'loading' | 'error';
  title: PluginLocalizedStringV2;
  description?: PluginLocalizedStringV2;
  icon?: string;
}>;
export type PluginDeclarativeTargetedSurfaceReferenceV1 = Readonly<{
  point: Readonly<Record<string, unknown>>;
  contributor: Readonly<{ pluginId: string; contributionId: string }>;
  role: string;
}>;
export type PluginDeclarativeTargetedSurfaceNodeV2 = Readonly<{
  kind: 'targetedSurface';
  surface: PluginDeclarativeTargetedSurfaceReferenceV1;
  input: JsonValue;
  instanceKey: string;
  fallback?: PluginDeclarativeStateNodeV2;
}>;
export type PluginDeclarativeSectionNodeV2 = Readonly<{
  kind: 'section';
  title?: PluginLocalizedStringV2;
  footer?: PluginLocalizedStringV2;
  children: readonly (
    | PluginDeclarativeItemNodeV2
    | PluginDeclarativeStateNodeV2
  )[];
}>;
export type PluginDeclarativeListNodeV2 = Readonly<{
  kind: 'list';
  label?: PluginLocalizedStringV2;
  children: readonly (
    | PluginDeclarativeSectionNodeV2
    | PluginDeclarativeItemNodeV2
    | PluginDeclarativeStateNodeV2
  )[];
}>;
export type PluginDeclarativeActionPanelNodeV2 = Readonly<{
  kind: 'actionPanel';
  title?: PluginLocalizedStringV2;
  children: readonly PluginDeclarativeActionNodeV2[];
}>;
export type PluginDeclarativeMetadataNodeV2 = Readonly<{
  kind: 'metadata';
  title?: PluginLocalizedStringV2;
  entries: readonly Readonly<{
    label: PluginLocalizedStringV2;
    value: PluginLocalizedStringV2;
    tone?: PluginDeclarativeToneV2;
  }>[];
}>;
export type PluginDeclarativeCollectionListNodeV2 = Readonly<{
  kind: 'collectionList';
  source: Readonly<{
    collectionId: string;
    uiQueryId: string;
    parameters?: Readonly<Record<string, string | number | boolean>>;
  }>;
  projection: Readonly<{
    titleField: string;
    subtitleField?: string;
    detailField?: string;
    badgeField?: string;
    statusField?: string;
  }>;
  primaryCommand?: Readonly<Record<string, unknown>>;
  secondaryCommands?: readonly Readonly<Record<string, unknown>>[];
}>;
export type PluginDeclarativeNodeV2 =
  | Readonly<{ kind: 'text'; text: PluginLocalizedStringV2; tone?: PluginDeclarativeToneV2 }>
  | Readonly<{ kind: 'markdown'; text: PluginLocalizedStringV2 }>
  | Readonly<{
    kind: 'stack';
    direction?: 'vertical' | 'horizontal';
    gap?: 'small' | 'medium' | 'large';
    children: readonly PluginDeclarativeNodeV2[];
  }>
  | Readonly<{
    kind: 'group';
    title?: PluginLocalizedStringV2;
    description?: PluginLocalizedStringV2;
    children: readonly PluginDeclarativeNodeV2[];
  }>
  | Readonly<{
    kind: 'field';
    label: PluginLocalizedStringV2;
    description?: PluginLocalizedStringV2;
    control: PluginDeclarativeControlV2;
  }>
  | Readonly<{
    kind: 'status';
    label: PluginLocalizedStringV2;
    value: PluginLocalizedStringV2;
    tone?: PluginDeclarativeToneV2;
  }>
  | PluginDeclarativeActionNodeV2
  | PluginDeclarativeListNodeV2
  | PluginDeclarativeSectionNodeV2
  | PluginDeclarativeItemNodeV2
  | PluginDeclarativeStateNodeV2
  | PluginDeclarativeTargetedSurfaceNodeV2
  | PluginDeclarativeMetadataNodeV2
  | PluginDeclarativeActionPanelNodeV2
  | PluginDeclarativeCollectionListNodeV2;
