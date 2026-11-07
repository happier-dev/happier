import type { DeploymentHistoryQueryV1 } from '@happier-dev/deployments';
import {
  createEntityFilterConditionCodecV1,
  defineEntityFilterFieldV1,
  type EntityFilterRegistryV1,
} from '@happier-dev/protocol/collections/filter/fieldRegistryV1';
import {
  DeploymentReceiptMetadataV1Schema,
  type DeploymentReceiptHeaderV1,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentStateV1Schema } from '@happier-dev/protocol/deployments/deploymentStateV1';

/**
 * History's narrowing is exactly the read owner's query (state, who started it, operation), one value each;
 * the server applies it before paging, so the page never filters rows it holds.
 */
export type DeploymentHistoryFilter = Omit<DeploymentHistoryQueryV1, 'cursor'>;
type Facts = Pick<
  DeploymentReceiptHeaderV1,
  'state' | 'operation' | 'requestedByAccountId'
>;

export const EMPTY_DEPLOYMENT_HISTORY_FILTER: DeploymentHistoryFilter =
  Object.freeze({});

function scalarField<Key extends keyof DeploymentHistoryFilter>(
  id: Key,
  parse: (value: unknown) => NonNullable<DeploymentHistoryFilter[Key]>,
  options: () => readonly NonNullable<DeploymentHistoryFilter[Key]>[],
  fact: (facts: Facts) => string,
) {
  return defineEntityFilterFieldV1<
    DeploymentHistoryFilter,
    Facts,
    NonNullable<DeploymentHistoryFilter[Key]>
  >({
    id,
    kind: 'domain',
    evaluators: ['list'],
    readSelection: (filter) => filter[id] ?? undefined,
    replaceSelection: (filter, selection) => {
      const { [id]: _removed, ...rest } = filter;
      return selection === undefined ? rest : { ...rest, [id]: selection };
    },
    match: (selection, facts) => (fact(facts) === selection ? 'match' : 'miss'),
    conditions: createEntityFilterConditionCodecV1({
      encoding: 'value',
      parseValue: parse,
      valueOptions: options,
    }),
  });
}

/** The History registry; "Started by" offers the reader's own Account, the one name this page can say. */
export function createDeploymentHistoryFilterRegistry(
  accountId: string,
): EntityFilterRegistryV1<DeploymentHistoryFilter, Facts> {
  return [
    scalarField(
      'state',
      (value) => DeploymentStateV1Schema.parse(value),
      () => Object.values(DeploymentStateV1Schema._zod.def.entries),
      (facts) => facts.state,
    ),
    scalarField(
      'actorAccountId',
      (value) => {
        if (value !== accountId)
          throw new TypeError('Only your own Account can be chosen here');
        return accountId;
      },
      () => [accountId],
      (facts) => facts.requestedByAccountId,
    ),
    scalarField(
      'operation',
      (value) => DeploymentReceiptMetadataV1Schema.shape.operation.parse(value),
      () => DeploymentReceiptMetadataV1Schema.shape.operation.options,
      (facts) => facts.operation,
    ),
  ];
}
