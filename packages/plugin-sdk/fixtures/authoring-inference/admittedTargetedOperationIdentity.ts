import type {
  AdmittedTargetedOperationExecutionHandle,
  ActionsService,
} from '../../src/actions/index.js';
import { definePlugin } from '../../src/definePlugin.js';
import type { JsonValue } from '../../src/identity.js';
import {
  defineContributionProtocol,
} from '../../src/targetedContributionAuthoring.js';
import {
  defineProtocolObject,
  defineProtocolLiteral,
  defineProtocolString,
} from '../../src/protocol/protocolFacade.js';
import type { TargetedContributionPointRef } from '../../src/services/targetedContributions.js';

type Equal<TLeft, TRight> = (<T>() => T extends TLeft ? 1 : 2) extends
  (<T>() => T extends TRight ? 1 : 2)
  ? true
  : false;
type Expect<T extends true> = T;

const inspectionResultSchema = defineProtocolObject({
  inspected: defineProtocolLiteral(true),
  entryId: defineProtocolString(),
}, { policy: 'closed' });

const protocol = defineContributionProtocol({
  id: 'fixture.admitted-operation',
  version: 1,
  operations: {
    inspect: {
      required: true,
      input: { kind: 'contributorDefined' },
      resultSchema: inspectionResultSchema,
      action: { surface: 'plugin', dangerLevel: 'safe' },
    },
  },
});

const target = definePlugin({
  id: 'fixture.admitted-operation-target',
  version: '0.1.0',
  contributionPoints: {
    sources: protocol.point(),
  },
});

type AdmittedSource = typeof target.contributionPoints.sources extends TargetedContributionPointRef<
  infer TContribution
> ? TContribution : never;

type _InspectOperationUsesTheCanonicalHandle = Expect<Equal<
  AdmittedSource['operations']['inspect'],
  AdmittedTargetedOperationExecutionHandle<
    JsonValue,
    Readonly<{ inspected: true; entryId: string }>,
    'inspect'
  >
>>;

export function executeAdmittedInspection(
  actions: ActionsService,
  source: AdmittedSource,
  input: JsonValue,
): Promise<Readonly<{ inspected: true; entryId: string }>> {
  const operation: AdmittedTargetedOperationExecutionHandle<
    JsonValue,
    Readonly<{ inspected: true; entryId: string }>,
    'inspect'
  > = source.operations.inspect;
  return actions.executeAdmittedTargetedOperation(operation, input);
}
