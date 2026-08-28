import { actionContracts } from '@happier-dev/action-contract-producer-fixture/actions';
import {
  definePlugin,
  type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import { PUBLIC_TOOLCHAIN_COMPATIBILITY_V1 } from '@happier-dev/plugin-sdk/browser';
import type { ActionHandler, ActionsService } from '@happier-dev/plugin-sdk/actions';
import {
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

export type InvokeInput = Readonly<{ title: string }>;
export type InvokeResult = Readonly<{
  accepted: boolean;
  executeTitle: string;
  originTitle: string;
  targetPluginId: string;
}>;

const invokeInputSchema = defineProtocolObject({
  title: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
const invokeResultSchema = defineProtocolObject({
  accepted: defineProtocolUnion([
    defineProtocolLiteral(true),
    defineProtocolLiteral(false),
  ]),
  executeTitle: defineProtocolString(),
  originTitle: defineProtocolString(),
  targetPluginId: defineProtocolString(),
}, { policy: 'closed' });

/**
 * This is a real plugin Action handler. The host supplies the canonical
 * ActionsService through PluginInvocationContext; the consumer never owns a
 * target registry or dispatch implementation.
 */
const invokePublishedActionHandler: ActionHandler<InvokeInput, InvokeResult> = async (
  input,
  context: PluginInvocationContext,
) => {
  const executeResult = await context.services.actions.execute(
    actionContracts.publish,
    { title: `${input.title}:execute` },
  );
  const originResult = await context.services.actions.executeWithExecutionOrigin(
    actionContracts.publish,
    { title: `${input.title}:origin` },
  );
  return {
    accepted: executeResult.accepted && originResult.result.accepted,
    executeTitle: executeResult.title,
    originTitle: originResult.result.title,
    targetPluginId: originResult.executionOrigin.materializationRef.pluginId,
  };
};

const plugin = definePlugin({
  id: 'fixture.action-contract-consumer',
  version: '1.0.0',
  displayName: 'Action contract consumer fixture',
  runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.runtime) as 1 },
  entrypoints: { daemon: './dist/index.js' },
  actions: {
    invoke: {
      title: 'Invoke published Action',
      surfaces: ['plugin'],
      execution: { target: 'daemon' },
      inputSchema: invokeInputSchema,
      resultSchema: invokeResultSchema,
      run: invokePublishedActionHandler,
    },
  },
});

export const { manifest, activate } = plugin;

if (false) {
  const actions = {} as ActionsService;
  const contract: typeof actionContracts.publish = actionContracts.publish;
  const result: Promise<Readonly<{ accepted: boolean; title: string }>> = actions.execute(
    contract,
    { title: 'structural invocation' },
  );
  const exactOriginResult = actions.executeWithExecutionOrigin(
    actionContracts.publish,
    { title: 'static inference' },
  );
  const archiveResult: Promise<Readonly<{ archived: boolean; id: string }>> = actions.execute(
    actionContracts.archive,
    { id: 'static-inference' },
  );
  // @ts-expect-error Cross-package declarations retain the producer's input schema type.
  void actions.execute(actionContracts.publish, { id: 'wrong-input' });
  void result;
  void exactOriginResult;
  void archiveResult;
}
