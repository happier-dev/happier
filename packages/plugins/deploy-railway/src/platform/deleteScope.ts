import { DeploymentTargetPreparationBaseV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext, PluginActionDeclaration, PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import { isPluginError, PluginError, projectActionFailureCauseV1 } from '@happier-dev/plugin-sdk/errors';
import { isMachineProvisionerCreateRefusal } from '@happier-dev/plugin-sdk/machine-provisioners';
import { createRailwayProjectOperations, RailwayNativeError } from '@happier-dev/railway-api';
import { projectRailwayFailure, railwayAccountAction, railwayIdentity, railwayRequest } from './account.js';

type AccountAction = PluginActionDefinition<Extract<PluginActionDeclaration, { execution: { target: 'account' } }>>;
type Selection = Parameters<ReturnType<typeof createRailwayProjectOperations>['readScopeInventory']>[0];
type Inventory = NonNullable<Awaited<ReturnType<ReturnType<typeof createRailwayProjectOperations>['readScopeInventory']>>>;
/** Link coordinates live only in Link content, which no Account Action may open; the review says so instead of listing none. */
type Preview = Inventory & { happierLinks: 'not-checked' };
type DeleteResult = { status: 'removed' | 'kept-unchecked' };

const text = { type: 'string', minLength: 1 } as const;
const namedItem = { type: 'object', additionalProperties: false, properties: { id: text, name: text }, required: ['id', 'name'] as string[] } as const;
const namedList = { type: 'array', items: namedItem } as const;
const vendorLists = {
  environments: 'Railway environments', services: 'Services (including database services)',
  databases: 'Recognized Railway databases', volumes: 'Volumes',
} as const satisfies Record<Exclude<keyof Inventory, 'scope'>, string>;
const vendorKeys = Object.keys(vendorLists) as (keyof typeof vendorLists)[];
const reviewFields = {
  scope: namedItem, environments: namedList, services: namedList, databases: namedList, volumes: namedList,
  happierLinks: { type: 'string', enum: ['not-checked'] as string[] },
} as const satisfies Record<keyof Preview, unknown>;
const base = DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema.properties!;
const accountFields = { credentialRef: base.credentialRef!, credentialPrincipal: base.credentialPrincipal! };
const common = { ...railwayAccountAction, surfaces: ['agent', 'mcp', 'cli', 'plugin'] } as const;

function actionObject<T extends Readonly<Record<string, unknown>>>(properties: T) {
  return { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) } as const;
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
      description: `List the Railway resources affected by deleting this ${kind}. Happier Links using it are not checked. Then invoke ${railwayIdentity.id}/actions/${deleteId} with the returned scope and lists.`,
      inputSchema: actionObject(inputFields),
      resultSchema: actionObject(reviewFields),
      async run(value, context) {
        const selection = value as unknown as Selection;
        const operations = createRailwayProjectOperations(railwayRequest(context), context.signal);
        const inventory = await operations.readScopeInventory(selection)
          .catch(error => projectRailwayFailure(error, context, 'scope.preview'));
        if (!inventory) throw new PluginError({ code: 'railway_scope_not_found' });
        return { ...inventory, happierLinks: 'not-checked' } satisfies Preview;
      },
    },
    [deleteId]: {
      ...common, readOnly: false, dangerLevel: 'destructive',
      title: `Delete Railway ${kind}`,
      description: `Run ${railwayIdentity.id}/actions/${previewId} first. Submit its scope and lists unchanged to review and delete the selected Railway ${kind}.`,
      confirmation: {
        title: `Delete this Railway ${kind} and its data?`,
        body: 'Railway will remove the listed resources. Happier could not check which of its Environments and Links use this scope. Any that do will stop working and remain in Happier.',
        inputFields: [{ path: 'scope.name', title: `Railway ${kind}` },
          ...Object.entries(vendorLists).map(([key, title]) => ({ path: `${key}.[].name`, title })),
          { path: 'happierLinks', title: 'Happier Environments and Links using this scope' }],
      },
      inputSchema: actionObject({ ...inputFields, ...reviewFields }),
      resultSchema: actionObject({ status: { type: 'string' as const, enum: ['removed', 'kept-unchecked'] } }),
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

export const railwayScopeDeleteActions: Readonly<Record<string, AccountAction>> = {
  ...scopeActions('project'),
  ...scopeActions('environment'),
};
