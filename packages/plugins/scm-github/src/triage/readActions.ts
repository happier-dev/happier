import { TriageSourceCredentialInputsV1 } from '@happier-dev/triage-protocol/v1';
import { GITHUB_FILE_VIEWED_ACTION_IDS_V1, GithubFileViewedReadInputV1Schema, ScmFileViewedReadResultV1Schema } from './fileViewedContracts.js';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_ACTION_IDS_V1, GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 } from './contribution.js';
import { GithubCapabilitiesInputV1Schema, GithubCapabilitiesResultV1Schema, GithubChangedFilesInputV1Schema, GithubChangedFilesResultV1Schema, GithubChecksInputV1Schema, GithubChecksResultV1Schema, GithubFeedbackInputV1Schema, GithubFeedbackResultV1Schema, GithubOverviewInputV1Schema, GithubOverviewResultV1Schema, GithubTimelineInputV1Schema, GithubTimelineResultV1Schema } from './detail/contracts.js';
import { GITHUB_SECURITY_ALERT_ACTION_IDS_V1, GithubSecurityAlertReadInputV1Schema, GithubSecurityAlertReadResultV1Schema, GithubCodeScanningLocationsInputV1Schema, GithubCodeScanningLocationsResultV1Schema, GithubCodeScanningLocationInputV1Schema, GithubCodeScanningLocationResultV1Schema, GithubDependabotFixPullRequestInputV1Schema, GithubDependabotFixPullRequestResultV1Schema } from './securityAlerts/actionContracts.js';
import { TriageSourcesContributionProtocolV1 } from '@happier-dev/triage-protocol/v1';
import { GITHUB_PLUGIN_ID } from '../observations/githubProviderContracts.js';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { ActionHandler, PluginAccountActionContext, PluginAccountActionHandler, PluginActionDeclaration, PluginActionReadObserver } from '@happier-dev/plugin-sdk/actions';
import { readInputPath } from '@happier-dev/plugin-sdk/actions';
import type { GithubTriageInvocationContext, GithubTriageObservationContext } from './invocation.js';

export const GITHUB_ACCOUNT_EXECUTION = { target: 'account', account: { artifactId: 'github-account-runtime', exportName: 'activate' } } as const;
export const TRIAGE_READ_HOST_ACCESS = ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE];
export const TRIAGE_INSTANCE_ACCOUNT_BINDINGS = [{ path: 'instance.binding.account', nativeServicePath: 'instance.binding.service', purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE }];
const sources = TriageSourcesContributionProtocolV1;

type AccountReadDeclaration = Extract<PluginActionDeclaration, Readonly<{
  execution: Readonly<{ target: 'account' }>;
}>>;
type ReadDefinition = Omit<AccountReadDeclaration, 'execution'> & Readonly<{
  run: (input: JsonValue, context: GithubTriageInvocationContext) => Promise<JsonValue | void>;
  observeRead?: PluginActionReadObserver<JsonValue, GithubTriageObservationContext>;
  nativeRun?: ActionHandler;
  nativeObserveRead?: PluginActionReadObserver;
}>;
const definitions = {
[GITHUB_TRIAGE_ACTION_IDS_V1.listScopeUnits]: {
      title: 'List GitHub repositories',
      description: 'Lists selectable repositories or the retained configured selection.',
      surfaces: sources.operations.listScopeUnits.declaration.surfaces,
      dangerLevel: sources.operations.listScopeUnits.declaration.dangerLevel,
      inputSchema: TriageSourceCredentialInputsV1.listScopeUnits.jsonSchema,
      resultSchema: sources.operations.listScopeUnits.declaration.resultSchema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: [{ path: 'draft.binding.account', nativeServicePath: 'draft.binding.service', purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE }],
      run: async (input, context) => (await import('./operations.js')).listGithubTriageScopeUnits(input, context),
    },
[GITHUB_TRIAGE_ACTION_IDS_V1.listInstances]: {
      title: 'Discover GitHub accounts',
      description: 'Lists the GitHub accounts each authorized connection can reach.',
      surfaces: sources.operations.listInstances.declaration.surfaces,
      // Mounted-only placement. `plugin` stays because the Triage daemon
      // consumes it and `ui` because this source's own mounted surfaces hold
      // present-user authority; the explicit empty list only withdraws the
      // Action from global placement discovery — it disables no invocation.
      placementBindings: [],
      dangerLevel: sources.operations.listInstances.declaration.dangerLevel,
      inputSchema: sources.operations.listInstances.declaration.input.schema.jsonSchema,
      resultSchema: sources.operations.listInstances.declaration.resultSchema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      run: async (input, context) => (await import('./operations.js')).listGithubTriageInstancesOperation(input, context),
    },
[GITHUB_TRIAGE_ACTION_IDS_V1.scan]: {
      title: 'Scan GitHub pull requests and issues',
      description: 'Reads one bounded page of GitHub pull requests and issues for a configured account.',
      surfaces: sources.operations.scan.declaration.surfaces,
      dangerLevel: sources.operations.scan.declaration.dangerLevel,
      inputSchema: TriageSourceCredentialInputsV1.scan.jsonSchema,
      resultSchema: sources.operations.scan.declaration.resultSchema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./operations.js')).scanGithubTriageSource(input, context),
    },
[GITHUB_TRIAGE_ACTION_IDS_V1.readAttention]: {
      title: 'Read GitHub review attention',
      description: 'Reads one conditional notification page using GitHub’s next-poll instruction.',
      surfaces: sources.operations.readAttention.declaration.surfaces,
      dangerLevel: sources.operations.readAttention.declaration.dangerLevel,
      inputSchema: TriageSourceCredentialInputsV1.readAttention.jsonSchema,
      resultSchema: sources.operations.readAttention.declaration.resultSchema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./attention.js')).readGithubAttention(input, context),
    },
[GITHUB_TRIAGE_ACTION_IDS_V1.get]: {
      title: 'Read one GitHub pull request or issue',
      description: 'Authoritatively reads one GitHub pull request or issue for a configured account.',
      surfaces: sources.operations.get.declaration.surfaces,
      // Mounted-only placement. `plugin` stays because the Triage daemon
      // consumes it and `ui` because this source's own mounted surfaces hold
      // present-user authority; the explicit empty list only withdraws the
      // Action from global placement discovery — it disables no invocation.
      placementBindings: [],
      dangerLevel: sources.operations.get.declaration.dangerLevel,
      inputSchema: TriageSourceCredentialInputsV1.get.jsonSchema,
      resultSchema: sources.operations.get.declaration.resultSchema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./operations.js')).getGithubTriageEntry(input, context),
    },
[GITHUB_TRIAGE_ACTION_IDS_V1.resolveResource]: {
      title: 'Resolve a GitHub resource link',
      description: 'Resolves a GitHub URL to its exact source identity through the configured connection.',
      surfaces: sources.operations.resolveResource.declaration.surfaces,
      placementBindings: [],
      dangerLevel: sources.operations.resolveResource.declaration.dangerLevel,
      inputSchema: TriageSourceCredentialInputsV1.resolveResource.jsonSchema,
      resultSchema: sources.operations.resolveResource.declaration.resultSchema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./resourceLinks.js')).resolveGithubTriageResource(input, context),
    },
[GITHUB_TRIAGE_ACTION_IDS_V1.readFixPullRequests]: {
      title: 'Read GitHub fix pull requests',
      description: 'Reads the selected finding’s current native fix pull-request association.',
      surfaces: sources.operations.readFixPullRequests.declaration.surfaces,
      placementBindings: [],
      dangerLevel: sources.operations.readFixPullRequests.declaration.dangerLevel,
      inputSchema: TriageSourceCredentialInputsV1.readFixPullRequests.jsonSchema,
      resultSchema: sources.operations.readFixPullRequests.declaration.resultSchema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./securityAlerts/fixPullRequests.js')).readGithubTriageFixPullRequests(input, context),
    },
[GITHUB_TRIAGE_ACTION_IDS_V1.readSessionLinks]: {
      title: 'Read GitHub pull request Session links',
      description: 'Reads native PR relationships for the exact configured Account or machine-native service.',
      surfaces: sources.operations.readSessionLinks.declaration.surfaces,
      placementBindings: [],
      dangerLevel: sources.operations.readSessionLinks.declaration.dangerLevel,
      readOnly: true,
      sessionTarget: { field: 'sessionId', cardinality: 'one' },
      inputSchema: TriageSourceCredentialInputsV1.readSessionLinks.jsonSchema,
      resultSchema: sources.operations.readSessionLinks.declaration.resultSchema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./sessionRelations.js')).readAccountGithubTriageSessionLinks(input, context),
      observeRead: async (input, invalidate, context) => (await import('./sessionRelations.js')).observeAccountGithubTriageSessionLinks(input, invalidate, context),
      nativeRun: async (input, context) => (await import('./sessionRelations.js')).readGithubTriageSessionLinks(input, context),
      nativeObserveRead: async (input, invalidate, context) => (await import('./sessionRelations.js')).observeGithubTriageSessionLinks(input, invalidate, context),
    },
[GITHUB_TRIAGE_ACTION_IDS_V1.readPullRequestStatus]: {
      title: 'Read GitHub pull-request status',
      description: 'Reads checks, reviews, mergeability and branches when a pull request is opened.',
      surfaces: sources.operations.readPullRequestStatus.declaration.surfaces,
      placementBindings: [],
      dangerLevel: sources.operations.readPullRequestStatus.declaration.dangerLevel,
      readOnly: true,
      inputSchema: TriageSourceCredentialInputsV1.readPullRequestStatus.jsonSchema,
      resultSchema: sources.operations.readPullRequestStatus.declaration.resultSchema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      observeRead: async (input, invalidate, context) => (await import('./detailOperations.js')).observeGithubPullRequestStatus(input, invalidate, context),
      run: async (input, context) => (await import('./detailOperations.js')).readGithubPullRequestStatus(input, context),
    },
[GITHUB_SECURITY_ALERT_ACTION_IDS_V1.read]: {
      title: 'Read a GitHub security alert', description: 'Reads the selected native alert and its advisory or rule evidence.',
      surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], placementBindings: [],
      inputSchema: GithubSecurityAlertReadInputV1Schema.jsonSchema, resultSchema: GithubSecurityAlertReadResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./securityAlerts/reads.js')).readGithubSecurityAlert(input, context),
    },
[GITHUB_SECURITY_ALERT_ACTION_IDS_V1.listLocations]: {
      title: 'Read code scanning alert locations', description: 'Reads one native page of locations for the selected code scanning finding.',
      surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], placementBindings: [],
      inputSchema: GithubCodeScanningLocationsInputV1Schema.jsonSchema, resultSchema: GithubCodeScanningLocationsResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./securityAlerts/reads.js')).listGithubCodeScanningLocations(input, context),
    },
[GITHUB_SECURITY_ALERT_ACTION_IDS_V1.readLocation]: {
      title: 'Read code scanning location evidence', description: 'Revalidates a selected provider instance and reads its code at the exact immutable commit.',
      surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], placementBindings: [],
      inputSchema: GithubCodeScanningLocationInputV1Schema.jsonSchema, resultSchema: GithubCodeScanningLocationResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./securityAlerts/reads.js')).readGithubCodeScanningLocation(input, context),
    },
[GITHUB_SECURITY_ALERT_ACTION_IDS_V1.readFixPullRequest]: {
      title: 'Read the Dependabot fix pull request', description: 'Reads the exact current Dependabot update association without listing pull requests.',
      surfaces: ['plugin', 'ui', 'agent', 'mcp', 'cli'], placementBindings: [],
      inputSchema: GithubDependabotFixPullRequestInputV1Schema.jsonSchema, resultSchema: GithubDependabotFixPullRequestResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./securityAlerts/reads.js')).readGithubDependabotFixPullRequest(input, context),
    },
[GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readCapabilities]: {
      title: 'Read GitHub repository capabilities',
      description: 'Reads authoritative repository write, issue, and merge-method availability.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
      placementBindings: [],
      inputSchema: GithubCapabilitiesInputV1Schema.jsonSchema,
      resultSchema: GithubCapabilitiesResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./detailOperations.js')).readGithubCapabilities(input, context),
    },
[GITHUB_FILE_VIEWED_ACTION_IDS_V1.read]: {
      title: 'Read GitHub viewed files', description: 'Reads the complete viewed state of the opened pull request.',
      surfaces: ['ui', 'plugin', 'agent', 'mcp', 'cli'], placementBindings: [], readOnly: true,
      inputSchema: GithubFileViewedReadInputV1Schema, resultSchema: ScmFileViewedReadResultV1Schema,
      hostAccess: TRIAGE_READ_HOST_ACCESS, connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./fileViewed.js')).readGithubFileViewed(input, context),
    },
[GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readOverview]: {
      title: 'Refresh the GitHub overview',
      description: 'Reads the current body, people, milestone, and branch facts for one pull request or issue.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
      placementBindings: [],
      inputSchema: GithubOverviewInputV1Schema.jsonSchema,
      resultSchema: GithubOverviewResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./detailOperations.js')).readGithubOverview(input, context),
    },
[GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listTimeline]: {
      title: 'Read a GitHub timeline page',
      description: 'Reads one bounded page of the event timeline of one pull request or issue.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
      placementBindings: [],
      inputSchema: GithubTimelineInputV1Schema.jsonSchema,
      resultSchema: GithubTimelineResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./detailOperations.js')).listGithubTimeline(input, context),
    },
[GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles]: {
      title: 'Read a GitHub changed-file page',
      description: 'Reads one bounded page of the files one pull request changes, with their'
        + ' counts and whether GitHub supplied a patch for each.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
      placementBindings: [],
      inputSchema: GithubChangedFilesInputV1Schema.jsonSchema,
      resultSchema: GithubChangedFilesResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./detailOperations.js')).listGithubChangedFiles(input, context),
    },
[GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readFeedback]: {
      title: 'Read one GitHub feedback connection',
      description: 'Reads one independently paged pull-request feedback connection: issue comments,'
        + ' review threads, review bodies, outstanding requests, or one thread\'s earlier replies.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
      placementBindings: [],
      inputSchema: GithubFeedbackInputV1Schema.jsonSchema,
      resultSchema: GithubFeedbackResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./detailOperations.js')).readGithubFeedback(input, context),
    },
[GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readChecks]: {
      title: 'Read the GitHub checks of a pull request',
      description: 'Reads the check runs and commit statuses of one pull request at its current'
        + ' head revision.',
      surfaces: ['ui', 'agent', 'mcp', 'cli'],
      placementBindings: [],
      inputSchema: GithubChecksInputV1Schema.jsonSchema,
      resultSchema: GithubChecksResultV1Schema.jsonSchema,
      hostAccess: TRIAGE_READ_HOST_ACCESS,
      connectedAccountPurposeBindings: TRIAGE_INSTANCE_ACCOUNT_BINDINGS,
      run: async (input, context) => (await import('./detailOperations.js')).readGithubChecks(input, context),
    },
} satisfies Readonly<Record<string, ReadDefinition>>;

export function githubNativeReadActionId(id: string): string { return id + '-native'; }

/** Select once from the same declared credential leaves the host already admitted. */
async function nativeReadRole(id: string, definition: ReadDefinition, input: JsonValue, context: PluginAccountActionContext) {
  const native = id === GITHUB_TRIAGE_ACTION_IDS_V1.listInstances
    ? await context.services.connectedAccounts.getBinding(GITHUB_CONNECTED_ACCOUNT_PURPOSE, { signal: context.signal }) === null
    : definition.connectedAccountPurposeBindings?.some(binding => binding.nativeServicePath !== undefined
      && readInputPath(input, binding.nativeServicePath) !== undefined) === true;
  return native ? { pluginId: GITHUB_PLUGIN_ID, localId: githubNativeReadActionId(id) } : null;
}

type AccountReadDefinition = AccountReadDeclaration & Readonly<{
  execution: typeof GITHUB_ACCOUNT_EXECUTION;
  run: PluginAccountActionHandler;
  observeRead?: PluginActionReadObserver<JsonValue, PluginAccountActionContext>;
}>;
type NativeReadDefinition = PluginActionDeclaration & Readonly<{
  execution: Readonly<{ target: 'daemon' }>;
  run: ActionHandler;
  observeRead?: PluginActionReadObserver;
}>;

export const GITHUB_ACCOUNT_READ_ACTIONS = Object.fromEntries(
  Object.entries<ReadDefinition>(definitions).map(([id, definition]) => {
    const { run, observeRead, nativeRun: _nativeRun, nativeObserveRead: _nativeObserveRead, ...declaration } = definition;
    const accountRun: PluginAccountActionHandler = async (input, context) => {
      const native = await nativeReadRole(id, definition, input, context);
      return native
        ? context.services.actions.execute(native, input, { signal: context.signal })
        : run(input, context);
    };
    const accountObserver: PluginActionReadObserver<JsonValue, PluginAccountActionContext> | undefined = observeRead === undefined ? undefined : async (input, invalidate, context) => {
      const native = await nativeReadRole(id, definition, input, context);
      return native
        ? context.services.actions.observe(native, input, () => invalidate(), { signal: context.signal })
        : observeRead(input, invalidate, context);
    };
    return [id, { ...declaration, execution: GITHUB_ACCOUNT_EXECUTION, run: accountRun,
      // Account admission already captures and retires the exact purpose lifetime.
      // The native observer additionally registers with its daemon credential owner.
      ...(observeRead === undefined ? {} : { observeRead: accountObserver }),
    } satisfies AccountReadDefinition];
  }),
// Every definition contributes its unchanged key; Object.fromEntries erases that finite key set.
) as Readonly<Record<keyof typeof definitions, AccountReadDefinition>>;

export const GITHUB_NATIVE_READ_ACTIONS: Readonly<Record<string, NativeReadDefinition>> = Object.fromEntries(
  Object.entries<ReadDefinition>(definitions).map(([id, definition]) => {
    const { nativeRun, nativeObserveRead, ...declaration } = definition;
    return [githubNativeReadActionId(id), {
      ...declaration, ...(nativeRun === undefined ? {} : { run: nativeRun }),
      ...(nativeObserveRead === undefined ? {} : { observeRead: nativeObserveRead }),
      execution: { target: 'daemon' }, surfaces: ['plugin'], placementBindings: [],
    } satisfies NativeReadDefinition];
  }),
);
