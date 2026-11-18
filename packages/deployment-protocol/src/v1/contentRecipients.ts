import type {
  ActionExecutorContext,
  ActionExecutorDeps,
} from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import {
  DeploymentDomainListResultV1Schema,
  DeploymentEnvironmentGetResultV1Schema,
  DeploymentEnvironmentListResultV1Schema,
  DeploymentEnvironmentUpdateInputV1Schema,
  DeploymentEnvironmentUpdateResultV1Schema,
  type DeploymentEnvironmentUpdateInputV1,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { ProjectDeploymentDefaultsOutputV1 } from '@happier-dev/protocol/projects/projectDeploymentDefaultsV1';

/** Host readers plus the canonical keyholder Artifact preparation (census + key-envelope commit). */
export type DeploymentContentRecipientPortsV1 = Required<
  Pick<ActionExecutorDeps, 'deploymentAction'>
> &
  Readonly<{
    readDefaults(
      sourceId: string,
      context: ActionExecutorContext,
    ): Promise<ProjectDeploymentDefaultsOutputV1 | ActionExecuteFailure>;
    /** Resolves once every head is current; rejects when any head could not be prepared. */
    prepareArtifactRecipients(
      artifactIds: readonly string[],
      context: ActionExecutorContext,
    ): Promise<void>;
  }>;
/** Delivery after a committed change is best effort: `pending` leaves affected readers on `deployment_content_unavailable`. */
export type DeploymentContentRecipientPreparationV1 = Readonly<{
  status: 'prepared' | 'pending';
}>;

type Heads = { ids: string[]; complete: boolean };
/** A refused or unrecognised read leaves its heads undelivered without hiding the readable ones. */
function readResult<T>(schema: Readonly<{ safeParse(value: unknown): { success: true; data: T } | { success: false } }>,
  response: unknown): T | null {
  if (readActionFailureEnvelope(response) !== null) return null;
  const parsed = schema.safeParse(response);
  return parsed.success ? parsed.data : null;
}

/** Every private content head an Environment's readers open: its content, every target link, its Domains. */
async function collectEnvironmentHeads(
  ports: DeploymentContentRecipientPortsV1,
  serverId: string,
  environmentId: string,
  context: ActionExecutorContext,
  heads: Heads,
): Promise<void> {
  const response = await ports.deploymentAction(
    'deployments.environments.get',
    { serverId, environmentId },
    context,
  );
  const detail = readResult(DeploymentEnvironmentGetResultV1Schema, response);
  if (!detail?.ok) {
    heads.complete = false;
    return;
  }
  heads.ids.push(
    detail.environment.contentArtifactId,
    ...detail.targetLinks.map((link) => link.contentArtifactId),
  );
  let cursor: string | undefined;
  do {
    const listed = await ports.deploymentAction(
      'deployments.domains.list',
      {
        serverId,
        environmentId,
        ...(cursor ? { cursor } : {}),
      },
      context,
    );
    const page = readResult(DeploymentDomainListResultV1Schema, listed);
    if (!page?.ok) {
      heads.complete = false;
      return;
    }
    heads.ids.push(...page.domains.map((domain) => domain.contentArtifactId));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}

async function deliver(
  ports: DeploymentContentRecipientPortsV1,
  context: ActionExecutorContext,
  collect: (heads: Heads) => Promise<void>,
): Promise<DeploymentContentRecipientPreparationV1> {
  const heads: Heads = { ids: [], complete: true };
  try {
    await collect(heads);
    context.signal?.throwIfAborted();
    // A partial read still delivers what it found; the next trigger completes the rest.
    if (heads.ids.length)
      await ports.prepareArtifactRecipients([...new Set(heads.ids)], context);
    return { status: heads.complete ? 'prepared' : 'pending' };
  } catch (error) {
    if (context.signal?.aborted) throw error;
    return { status: 'pending' };
  }
}

/** Permissions changes are the Environment updates that choose who may deploy or edit its data. */
export function changesDeploymentEnvironmentAccessV1(
  input: Pick<DeploymentEnvironmentUpdateInputV1, 'patch'>,
): boolean {
  const patch = input.patch;
  return (
    patch !== undefined &&
    (patch.deployerMode !== undefined ||
      patch.deployerPrincipals !== undefined ||
      patch.dataEditorMode !== undefined ||
      patch.dataEditors !== undefined)
  );
}

/** Environment Permissions Save: deliver that Environment's heads to the Source audience already present. */
export function prepareDeploymentEnvironmentRecipientsV1(
  ports: DeploymentContentRecipientPortsV1,
  input: Readonly<{ serverId: string; environmentId: string }>,
  context: ActionExecutorContext,
) {
  return deliver(ports, context, (heads) =>
    collectEnvironmentHeads(
      ports,
      input.serverId,
      input.environmentId,
      context,
      heads,
    ),
  );
}

/** Committed Source audience/owner change: deliver every current private deployment head the Source holds.
 * Receipts are excluded: new ones carry their audience at creation; older ones need their key holder to share them. */
export function prepareProjectSourceDeploymentRecipientsV1(
  ports: DeploymentContentRecipientPortsV1,
  input: Readonly<{ serverId: string; projectSourceId: string }>,
  context: ActionExecutorContext,
) {
  return deliver(ports, context, async (heads) => {
    const environmentIds: string[] = [];
    let cursor: string | undefined;
    do {
      const response = await ports.deploymentAction(
        'deployments.environments.list',
        {
          serverId: input.serverId,
          projectSourceId: input.projectSourceId,
          ...(cursor ? { cursor } : {}),
        },
        context,
      );
      const page = readResult(DeploymentEnvironmentListResultV1Schema, response);
      if (!page?.ok) {
        heads.complete = false;
        break;
      }
      environmentIds.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    await Promise.all(
      environmentIds.map((id) =>
        collectEnvironmentHeads(ports, input.serverId, id, context, heads),
      ),
    );
    const defaults = await ports.readDefaults(input.projectSourceId, context);
    if ('errorCode' in defaults || !defaults.ok) heads.complete = false;
    else if (defaults.content)
      heads.ids.push(defaults.content.contentArtifactId);
  });
}

type DeploymentActionRoute = NonNullable<ActionExecutorDeps['deploymentAction']>;

/** A Source owner or audience edit is what changes who reads the Source's deployment content. */
export function changesProjectSourceAudienceV1(input: Readonly<{ patch: Readonly<{ owner?: unknown; audience?: unknown }> }>): boolean {
  return input.patch.owner !== undefined || input.patch.audience !== undefined;
}

/** Trigger 2 for every host: a committed Permissions Save that changed the Environment revision delivers
 * its heads, after the route returns. `portsFor` returns null where this host holds no keys of its own. */
export function withDeploymentEnvironmentRecipientDeliveryV1(route: DeploymentActionRoute,
  portsFor: (context: ActionExecutorContext) => DeploymentContentRecipientPortsV1 | null): DeploymentActionRoute {
  return async (actionId, input, context, review) => {
    const result = await route(actionId, input, context, review);
    if (actionId !== DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1) return result;
    const update = DeploymentEnvironmentUpdateInputV1Schema.safeParse(input);
    const saved = DeploymentEnvironmentUpdateResultV1Schema.safeParse(result);
    if (!update.success || update.data.mode === 'preview' || !changesDeploymentEnvironmentAccessV1(update.data)
      || !saved.success || !saved.data.ok || saved.data.revision === update.data.expectedRevision) return result;
    const ports = portsFor(context);
    if (ports) await prepareDeploymentEnvironmentRecipientsV1(ports,
      { serverId: update.data.serverId, environmentId: update.data.environmentId }, context);
    return result;
  };
}
