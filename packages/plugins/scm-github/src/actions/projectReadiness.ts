import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { defineProtocolObject, projectNativeJsonValueForTransport, ScmHostingRepositoryIdentityV1ProtocolSchema,
  ScmHostingProjectReadinessSourceFactV1ProtocolSchema as outcome } from '@happier-dev/plugin-sdk/protocol';
import { createTriageConfigureSourceOfferV1, TriageReadConfiguredSourceInstancesResultV1Schema,
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1 } from '@happier-dev/triage-protocol/v1';
import { ForgeCiActionResultSchemasV1 } from '@happier-dev/triage-protocol/ci/v1';
import { GITHUB_PLUGIN_ID, GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../observations/githubProviderContracts.js';
import { GITHUB_ACTIONS_PAGE_ID_V1 } from '../ui/forge/surfaceIds.js';
import { GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1 } from '../triage/contribution.js';
import { classifyGithubTransportFailure } from '../observations/githubResponseFailure.js';
import { GITHUB_TRIAGE_DEPLOYMENT_BASE_URL_V1,
  readGithubTriageAlertFamilies } from '../triage/configuration.js';
import type { GithubTriageInvocationContext } from '../triage/invocation.js';
import { openGithubTriageClient, resolveGithubTriageInstance } from '../triage/operations.js';
import { createGithubRepositoryReader } from '../triage/repositories.js';
import { parseGithubRoutingToken } from '../triage/locator.js';
import { GITHUB_ACCOUNT_EXECUTION } from '../triage/readActions.js';
import { GITHUB_PROJECT_READINESS_ACTION_ID_V1 } from './actionIds.js';
import { executeGithubCiAction } from './operations.js';

const inputSchema = defineProtocolObject({ repository: ScmHostingRepositoryIdentityV1ProtocolSchema }, { policy: 'closed' });
const resultSchema = defineProtocolObject({ repository: ScmHostingRepositoryIdentityV1ProtocolSchema,
  ci: outcome, security: outcome }, { policy: 'closed' });
type Outcome = ReturnType<typeof outcome.parse>;
const unavailable = (reason: string): Outcome => ({ status: 'unavailable', reason });

/** Each finite owner read degrades only its own fact, preserving the producer's failure code. */
async function readFact(read: () => Promise<Outcome>, context: GithubTriageInvocationContext): Promise<Outcome> {
  try { context.signal?.throwIfAborted(); return await read(); }
  catch (error) {
    context.signal?.throwIfAborted();
    return unavailable(isPluginError(error) ? error.code : classifyGithubTransportFailure(error).code);
  }
}

export const GITHUB_PROJECT_READINESS_ACTIONS_V1 = {
  [GITHUB_PROJECT_READINESS_ACTION_ID_V1]: {
    title: 'Read GitHub Project readiness sources',
    description: 'Reads CI workflow presence and configured security-alert coverage for this exact Project repository.',
    surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'plugin'] as const,
    placementBindings: [], dangerLevel: 'safe' as const, readOnly: true as const,
    execution: GITHUB_ACCOUNT_EXECUTION,
    inputSchema: inputSchema.jsonSchema, resultSchema: resultSchema.jsonSchema,
    hostAccess: ['github-api', GITHUB_CONNECTED_ACCOUNT_PURPOSE],
    async run(raw: unknown, context: GithubTriageInvocationContext) {
      const { repository } = inputSchema.parse(raw);
      const [ci, security] = await Promise.all([
        readFact(async () => {
          const workflows = ForgeCiActionResultSchemasV1.listWorkflows.parse(
            await executeGithubCiAction('listWorkflows', { repository }, context));
          if (workflows.kind === 'unavailable') return unavailable(workflows.failure.code);
          if (workflows.kind === 'notModified') return unavailable('ci_source_read_incomplete');
          return workflows.value.rows.length > 0
            ? { status: 'ready', reason: 'ci_source_present' }
            : workflows.value.continuation !== null || workflows.value.incomplete !== null
              || workflows.value.omittedRowCount > 0 || workflows.value.projectionTruncated ? unavailable('ci_source_read_incomplete')
              : { status: 'actionNeeded', reason: 'ci_source_required' };
        }, context),
        readFact(async () => {
          if (repository.kind !== 'github' || repository.deployment !== GITHUB_TRIAGE_DEPLOYMENT_BASE_URL_V1)
            return unavailable('security_source_deployment_unsupported');
          const sources = TriageReadConfiguredSourceInstancesResultV1Schema.parse(await context.services.actions.execute(
            TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1, { v: 1 }, { signal: context.signal }));
          if (sources.kind !== 'read') return unavailable(sources.kind);
          const route = parseGithubRoutingToken(repository.repository);
          if (route === null) return unavailable('github_repository_route_invalid');
          let failedSource: string | undefined;
          for (const source of sources.instances) {
            if (source.lifecycle !== 'active') continue;
            const decoded = resolveGithubTriageInstance(source.configured);
            if (!decoded.ok) { failedSource ??= decoded.failure.code; continue; }
            const selection = decoded.configuration.selection;
            if (selection.kind === 'selected' && !selection.unitIds.includes(repository.repository.toLowerCase())) continue;
            const alerts = readGithubTriageAlertFamilies(decoded.configuration);
            if (!alerts.dependabot && !alerts.codeScanning) continue;
            const opened = await openGithubTriageClient(source.configured, context);
            if (!opened.ok) { failedSource ??= opened.failure.code; continue; }
            const current = await createGithubRepositoryReader({ client: opened.client, now: () => context.invokedAtMs }).read(route);
            if (current.kind === 'unreadable') { failedSource ??= current.failure.code; continue; }
            if (current.repositoryKey !== repository.repository.toLowerCase()) {
              failedSource ??= 'github_repository_mismatch'; continue;
            }
            return { status: 'ready', reason: 'security_source_present' };
          }
          return sources.status === 'truncated' ? unavailable('security_source_read_incomplete')
            : failedSource ? unavailable(failedSource)
              : { status: 'actionNeeded', reason: 'security_source_required' };
        }, context),
      ]);
      context.signal?.throwIfAborted();
      const securitySetup = createTriageConfigureSourceOfferV1(GITHUB_PLUGIN_ID, GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1);
      return projectNativeJsonValueForTransport(resultSchema.parse({ repository,
        ci: { ...ci, setupSurface: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_ACTIONS_PAGE_ID_V1 } },
        security: { ...security, ...(securitySetup ? { setupSurface: securitySetup.destination } : {}) },
      }));
    },
  },
};
