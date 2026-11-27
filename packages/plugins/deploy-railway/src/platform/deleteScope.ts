import { DeploymentTargetPreparationBaseV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated, type PluginAccountActionContext,
  type PluginActionDeclaration, type PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import { isPluginError, PluginError, projectActionFailureCauseV1 } from '@happier-dev/plugin-sdk/errors';
import { isMachineProvisionerCreateRefusal } from '@happier-dev/plugin-sdk/machine-provisioners';
import { readDeploymentTargetLinkArtifactV1 } from '@happier-dev/plugin-sdk/protocol';
import { createRailwayProjectOperations, RailwayNativeError } from '@happier-dev/railway-api';
import { projectRailwayFailure, railwayAccountAction, railwayIdentity, railwayRequest } from './account.js';

type AccountAction = PluginActionDefinition<Extract<PluginActionDeclaration, { execution: { target: 'account' } }>>;
type Selection = Parameters<ReturnType<typeof createRailwayProjectOperations>['readScopeInventory']>[0];
type Inventory = NonNullable<Awaited<ReturnType<ReturnType<typeof createRailwayProjectOperations>['readScopeInventory']>>>;
type NamedItem = Inventory['scope'];
type Preview = Inventory & { happierEnvironments: NamedItem[]; links: NamedItem[] };
type DeleteResult = { status: 'removed' | 'kept-unchecked' };

const text = { type: 'string', minLength: 1 } as const;
const namedItem = { type: 'object', additionalProperties: false, properties: { id: text, name: text }, required: ['id', 'name'] } as const;
const namedList = { type: 'array', items: namedItem } as const;
const vendorLists = {
  environments: 'Railway environments', services: 'Services (including database services)',
  databases: 'Recognized Railway databases', volumes: 'Volumes',
} as const satisfies Record<Exclude<keyof Inventory, 'scope'>, string>;
const reviewLists = { ...vendorLists, happierEnvironments: 'Happier Environments affected', links: 'Happier Links affected' } as const;
const vendorKeys = Object.keys(vendorLists) as (keyof typeof vendorLists)[];
const reviewFields = {
  scope: namedItem, environments: namedList, services: namedList, databases: namedList, volumes: namedList,
  happierEnvironments: namedList, links: namedList,
} as const satisfies Record<keyof Preview, unknown>;
const base = DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema.properties!;
const accountFields = { credentialRef: base.credentialRef!, credentialPrincipal: base.credentialPrincipal! };
const common = { ...railwayAccountAction, surfaces: ['agent', 'mcp', 'cli'] } as const;

function actionObject<T extends Readonly<Record<string, unknown>>>(properties: T) {
  return { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) } as const;
}

async function readVisibleHappierLinks({ projectId, environmentId }: Selection, context: PluginAccountActionContext) {
  if (!context.accountScope) throw new PluginError({ code: 'client_required' });
  const { serverId } = context.accountScope;
  const environments = new Map<string, NamedItem>();
  const links = new Map<string, NamedItem>();
  const options = { signal: context.signal };
  const actions = context.services.actions;
  let cursor: string | null = null;
  do {
    const page = await actions.execute('deployments.environments.list',
      { serverId, ...(cursor === null ? {} : { cursor }) }, options);
    if (isPluginActionApprovalRequestCreated(page)) throw new PluginError({ code: 'deployment_content_unavailable' });
    if (!page.ok) throw new PluginError({ code: page.error });
    if (page.coverage === 'partial') throw new PluginError({ code: 'deployment_content_unavailable' });

    for (const item of page.items) {
      const detail = await actions.execute('deployments.environments.get', { serverId, environmentId: item.id }, options);
      if (isPluginActionApprovalRequestCreated(detail)) throw new PluginError({ code: 'deployment_content_unavailable' });
      if (!detail.ok) {
        if (detail.error === 'deployment_access_denied') continue;
        throw new PluginError({ code: detail.error });
      }
      for (const link of detail.targetLinks) {
        if (link.deletedAtMs !== undefined || link.detachedAtMs !== undefined || link.state === 'detached'
          || link.source.kind !== 'plugin') continue;
        const { pluginId } = link.source.contribution;
        if (pluginId !== railwayIdentity.id && pluginId !== 'happier.deploy.railway-data') continue;
        const result = await actions.execute('artifact.get',
          { artifactId: link.contentArtifactId, projectSourceId: item.projectSourceId }, options);
        if (isPluginActionApprovalRequestCreated(result)) throw new PluginError({ code: 'deployment_content_unavailable' });
        if (!result.artifact || result.artifact.availability?.kind === 'locked') continue;
        const opened = readDeploymentTargetLinkArtifactV1(link, result.artifact);
        if (!opened.ok) throw new PluginError({ code: opened.error, failureCause: opened.failureCause });
        const identity = opened.content.providerIdentity;
        if (!identity || identity.providerAccountId !== projectId
          || environmentId !== undefined && identity.providerEnvironment !== environmentId) continue;
        if (!item.name || !opened.title) throw new PluginError({ code: 'deployment_content_unavailable' });
        environments.set(item.id, { id: item.id, name: item.name });
        links.set(link.id, { id: link.id, name: opened.title });
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { happierEnvironments: [...environments.values()], links: [...links.values()] };
}

function reviewAgain(): never {
  throw new PluginError({ code: 'railway_scope_review_again', retryable: false,
    message: 'The Railway scope changed. Preview it and review the deletion again.' });
}

function inventoryStillReviewed(current: Inventory, reviewed: Preview): boolean {
  return current.scope.id === reviewed.scope.id && current.scope.name === reviewed.scope.name
    && vendorKeys.every(key => {
      const names = new Map(reviewed[key].map(({ id, name }) => [id, name]));
      return current[key].every(({ id, name }) => names.get(id) === name);
    });
}

function throwIfMutationRefused(error: unknown, context: PluginAccountActionContext): void {
  context.signal.throwIfAborted();
  if (isPluginError(error) && error.code !== 'plugin_fetch_response_too_large') throw error;
  if (!(error instanceof RailwayNativeError)) return;
  const { code, status, nativeErrorCode } = error;
  if (!isMachineProvisionerCreateRefusal(status) && (!nativeErrorCode || nativeErrorCode === 'INTERNAL_SERVER_ERROR')) return;
  const denied = code === 'credential_unavailable' || nativeErrorCode === 'FORBIDDEN' || nativeErrorCode === 'UNAUTHENTICATED';
  throw new PluginError({ code: denied ? 'deployment_access_denied' : nativeErrorCode ?? code, retryable: false,
    failureCause: { ...projectActionFailureCauseV1(error, 'deployment.railway.scope.delete', { allowUnknownErrorCode: true }),
      ...(nativeErrorCode === undefined ? {} : { nativeErrorCode }) } });
}

function scopeActions(kind: 'project' | 'environment'): Record<string, AccountAction> {
  const inputFields = { ...accountFields, projectId: text, ...(kind === 'environment' ? { environmentId: text } : {}) };
  const previewId = `${kind}-delete-preview`;
  const deleteId = `${kind}-delete`;
  return {
    [previewId]: {
      ...common, readOnly: true, dangerLevel: 'safe',
      title: `Preview Railway ${kind} deletion`,
      description: `List the Railway resources and visible Happier records affected by deleting this ${kind}. Then invoke ${railwayIdentity.id}/actions/${deleteId} with the returned scope and lists.`,
      inputSchema: actionObject(inputFields),
      resultSchema: actionObject(reviewFields),
      async run(value, context) {
        const selection = value as unknown as Selection;
        const operations = createRailwayProjectOperations(railwayRequest(context), context.signal);
        const inventory = await operations.readScopeInventory(selection)
          .catch(error => projectRailwayFailure(error, context, 'scope.preview'));
        if (!inventory) throw new PluginError({ code: 'railway_scope_not_found' });
        return { ...inventory, ...await readVisibleHappierLinks(selection, context) };
      },
    },
    [deleteId]: {
      ...common, readOnly: false, dangerLevel: 'destructive',
      title: `Delete Railway ${kind}`,
      description: `Run ${railwayIdentity.id}/actions/${previewId} first. Submit its scope and lists unchanged to review and delete the selected Railway ${kind}.`,
      confirmation: {
        title: `Delete this Railway ${kind} and its data?`,
        body: 'Railway will remove the listed resources. The listed Happier Environments and Links will stop working and remain in Happier.',
        inputFields: [{ path: 'scope.name', title: `Railway ${kind}` },
          ...Object.entries(reviewLists).map(([key, title]) => ({ path: `${key}.[].name`, title }))],
      },
      inputSchema: actionObject({ ...inputFields, ...reviewFields }),
      resultSchema: actionObject({ status: { type: 'string', enum: ['removed', 'kept-unchecked'] } }),
      async run(value, context): Promise<DeleteResult> {
        const input = value as unknown as Selection & Preview;
        const operations = createRailwayProjectOperations(railwayRequest(context), context.signal);
        const current = await operations.readScopeInventory(input)
          .catch(error => projectRailwayFailure(error, context, 'scope.preflight'));
        if (!current || !inventoryStillReviewed(current, input)) reviewAgain();
        try {
          if (await operations.deleteScope(input)) return { status: 'removed' };
        } catch (error) {
          throwIfMutationRefused(error, context);
        }
        const absent = await operations.observeScopeAbsent(input).catch(() => {
          context.signal.throwIfAborted();
          return false;
        });
        return { status: absent ? 'removed' : 'kept-unchecked' };
      },
    },
  };
}

export const railwayScopeDeleteActions = { ...scopeActions('project'), ...scopeActions('environment') };
