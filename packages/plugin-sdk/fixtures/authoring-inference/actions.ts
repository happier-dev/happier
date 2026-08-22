import {
  PluginError,
  type JsonValue,
} from '@happier-dev/plugin-sdk';
import { definePlugin } from '../../src/definePlugin.js';
import {
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
} from '../../src/protocol/index.js';
import type {
  AdmittedTargetedOperationExecutionHandle,
  ActionsService,
  ContributedActionExecutionWithOriginOptions,
  PluginActionInputById,
  PluginActionResultById,
  PluginInvocableActionId,
} from '@happier-dev/plugin-sdk/actions';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

type FixtureContributionRef = Readonly<{
  pluginId: string;
  localId: string;
}>;

type FixtureCancellationOptions = Readonly<{
  signal?: AbortSignal;
}>;

type BoundaryCall = Readonly<{
  action: PluginInvocableActionId | FixtureContributionRef;
  input: unknown;
  signal: AbortSignal | undefined;
}>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function remotePermissionResponseInput(
  requestId: string,
): PluginActionInputById['session.permission.remote.respond'] {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    requestId,
    sourceRef: 'binding:fixture',
    sourceRevisionOrEpoch: '1',
    idempotencyKey: requestId,
    actor: { namespace: 'fixture', principalId: 'operator-1' },
    decision: 'allow',
    scope: 'request',
  };
}

class ActionsBoundaryFixture implements ActionsService {
  readonly calls: BoundaryCall[] = [];

  execute<K extends PluginInvocableActionId>(
    actionId: K,
    input: PluginActionInputById[K],
    options?: FixtureCancellationOptions,
  ): Promise<PluginActionResultById[K]>;

  execute(
    action: FixtureContributionRef,
    input: JsonValue,
    options?: FixtureCancellationOptions,
  ): Promise<JsonValue | void>;

  async execute(
    action: PluginInvocableActionId | FixtureContributionRef,
    input: unknown,
    options: FixtureCancellationOptions = {},
  ): Promise<JsonValue | void> {
    this.calls.push(Object.freeze({ action, input, signal: options.signal }));

    if (typeof action !== 'string') {
      assert(action.pluginId === 'example.target', 'unexpected contributed Action plugin id');
      assert(action.localId === 'publish', 'unexpected contributed Action local id');
      assert(isRecord(input) && typeof input.title === 'string', 'unexpected contributed Action input');
      return Object.freeze({ accepted: true, title: input.title });
    }

    assert(action === 'session.permission.remote.respond', 'unexpected host Action id');
    assert(isRecord(input), 'unexpected host Action input');
    assert(input.sessionId === 'session-1', 'unexpected remotely mediated Session identity');
    assert(input.sourceRef === 'binding:fixture', 'unexpected permission source reference');
    assert(input.sourceRevisionOrEpoch === '1', 'unexpected permission source revision');
    assert(input.decision === 'allow', 'unexpected remote permission decision');
    assert(input.scope === 'request', 'unexpected remote permission scope');
    assert(isRecord(input.actor), 'missing remote permission actor attribution');
    assert(input.actor.namespace === 'fixture', 'unexpected remote permission actor namespace');
    assert(input.actor.principalId === 'operator-1', 'unexpected remote permission actor principal');
    assert(typeof input.requestId === 'string', 'missing remote permission request id');

    if (input.requestId === 'boundary-error') {
      throw new PluginError({
        code: 'fixture_action_rejected',
        message: 'The narrow Actions boundary fixture rejected this request',
      });
    }
    if (input.requestId === 'wait') {
      const signal = options.signal;
      assert(signal !== undefined, 'the author did not forward caller cancellation');
      if (signal.aborted) throw signal.reason;
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }

    return Object.freeze({
      status: 'applied' as const,
      settlementId: 'settlement-1',
      requestId: input.requestId,
      decision: 'allow' as const,
      effect: Object.freeze({ kind: 'allowOnce' as const }),
    });
  }

  async executeWithExecutionOrigin(
    action: FixtureContributionRef,
    input: JsonValue,
    options?: FixtureCancellationOptions,
  ) {
    const result = await this.execute(action, input, options);
    return Object.freeze({
      result: result ?? null,
      executionOrigin: Object.freeze({
        serverIdentityId: 'srv_authoring_fixture',
        materializationRef: Object.freeze({
          pluginId: action.pluginId,
          machineId: 'machine-authoring-fixture',
          materializationId: `materialization-${action.pluginId}`,
        }),
      }),
    });
  }

  async executeAdmittedTargetedOperation<TInput extends JsonValue, TResult extends JsonValue | void>(
    _operation: AdmittedTargetedOperationExecutionHandle<TInput, TResult>,
    _input: NoInfer<TInput>,
    _options?: FixtureCancellationOptions,
  ): Promise<TResult> {
    throw new PluginError({
      code: 'plugin_admitted_targeted_operation_handle_invalid',
      message: 'The external fixture does not fabricate host-created admitted operation handles',
    });
  }

  async executeAdmittedTargetedOperationWithExecutionOrigin<
    TInput extends JsonValue,
    TResult extends JsonValue | void,
  >(
    _operation: AdmittedTargetedOperationExecutionHandle<TInput, TResult>,
    _input: NoInfer<TInput>,
    _options?: ContributedActionExecutionWithOriginOptions,
  ): Promise<Readonly<{
    result: TResult;
    executionOrigin: Awaited<ReturnType<ActionsBoundaryFixture['executeWithExecutionOrigin']>>['executionOrigin'];
  }>> {
    throw new PluginError({
      code: 'plugin_admitted_targeted_operation_handle_invalid',
      message: 'The external fixture does not fabricate host-created admitted operation handles',
    });
  }
}

const inputSchema = defineProtocolObject({
  requestId: defineProtocolString(),
  title: defineProtocolString(),
}, { policy: 'closed' });
const resultSchema = defineProtocolObject({
  echoed: defineProtocolString(),
}, { policy: 'closed' });

const targetInputSchema = defineProtocolObject({
  title: defineProtocolString(),
}, { policy: 'closed' });
const targetResultSchema = defineProtocolObject({
  accepted: defineProtocolUnion([
    defineProtocolLiteral(true),
    defineProtocolLiteral(false),
  ]),
  title: defineProtocolString(),
}, { policy: 'closed' });

/**
 * Maintained authoring consumer: the target Action identity and its static
 * input/result contract come from one definePlugin declaration. The fixture's
 * testkit service remains the host boundary and supplies no second registry or
 * target resolver.
 */
const targetPlugin = definePlugin({
  id: 'example.target',
  version: '0.1.0',
  actions: {
    publish: {
      title: 'Publish',
      execution: { target: 'daemon' },
      surfaces: ['plugin'],
      inputSchema: targetInputSchema,
      resultSchema: targetResultSchema,
      run: async (input) => ({ accepted: input.title.length > 0, title: input.title }),
    },
  },
});
const targetPublish = targetPlugin.actionContracts.publish;

const { manifest, activate } = definePlugin({
  id: 'example.actions-author',
  version: '0.1.0',
  actions: {
    exercise: {
      title: 'Exercise ActionsService',
      execution: { target: 'daemon' },
      inputSchema,
      resultSchema,
      async run(input, context) {
        const hostResult = await context.services.actions.execute(
          'session.permission.remote.respond',
          remotePermissionResponseInput(input.requestId),
          { signal: context.signal },
        );
        const contributedAction = targetPublish;
        const contributedWithOrigin = await context.services.actions.executeWithExecutionOrigin(
          contributedAction,
          { title: input.title },
          { signal: context.signal },
        );
        const contributedResult = contributedWithOrigin.result;
        assert(
          isRecord(contributedResult) && contributedResult.accepted === true,
          'contributed Action result was not returned through ActionsService',
        );
        assert(
          contributedWithOrigin.executionOrigin.materializationRef.pluginId === contributedAction.pluginId,
          'contributed Action execution origin was not host-stamped for its exact target',
        );
        assert(
          hostResult.status === 'applied'
            && hostResult.decision === 'allow'
            && hostResult.effect.kind === 'allowOnce',
          'remote permission response result was not preserved through ActionsService',
        );
        return { echoed: `${hostResult.status}:${contributedResult.title}` };
      },
    },
  },
});

function compileActionsContract(actions: ActionsService): void {
  const hostResult = actions.execute(
    'session.permission.remote.respond',
    remotePermissionResponseInput('permission-1'),
  );
  const contributedResult: Promise<JsonValue | void> = actions.execute(
    targetPublish,
    { title: 'Ready' },
  );
  const contributedWithOrigin = actions.executeWithExecutionOrigin(
    targetPublish,
    { title: 'Ready' },
  );
  void hostResult;
  void contributedResult;
  void contributedWithOrigin;

  // @ts-expect-error Remote permission response requires an explicit attributed Session identity.
  void actions.execute('session.permission.remote.respond', {
    requestId: 'permission-1',
    sourceRef: 'binding:fixture',
    sourceRevisionOrEpoch: '1',
    idempotencyKey: 'permission-1',
    actor: { namespace: 'fixture', principalId: 'operator-1' },
    decision: 'allow',
    scope: 'request',
  });
  // @ts-expect-error The invoking plugin identity is stamped by the host from the active generation.
  void actions.execute('plugins.sessionHooks.enable', {
    agent: { pluginId: 'forged.plugin', localId: 'codex' },
    installationId: 'installation-1',
  });
  // @ts-expect-error Host Action input is inferred from the selected literal Action id.
  void actions.execute('session.permission.remote.respond', {
    ...remotePermissionResponseInput('permission-1'),
    decision: 'later',
  });
  // @ts-expect-error Contributed Actions require a qualified reference, never a hand-built string id.
  void actions.execute('example.target/publish', { title: 'Ready' });
  // @ts-expect-error Host Actions never return a target plugin execution origin.
  void actions.executeWithExecutionOrigin('session.permission.remote.respond', remotePermissionResponseInput('permission-1'));
}

if (false) compileActionsContract({} as ActionsService);

async function expectErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert(
      typeof error === 'object' && error !== null && 'code' in error && error.code === code,
      `expected error code ${code}`,
    );
    return;
  }
  throw new Error(`expected error code ${code}`);
}

export async function exerciseActionsService(): Promise<void> {
  const actions = new ActionsBoundaryFixture();
  const testkit = await createPluginTestkit({
    manifest,
    module: { activate },
    services: { actions },
  });
  try {
    const result = await testkit.invokeAction('exercise', {
      requestId: 'permission-1',
      title: 'Ready',
    });
    assert(isRecord(result) && result.echoed === 'applied:Ready', 'typed Action results were not preserved');
    assert(actions.calls.length === 2, 'expected one host and one contributed Action call');

    await expectErrorCode(testkit.invokeAction('exercise', {
      requestId: 'boundary-error',
      title: 'Rejected',
    }), 'fixture_action_rejected');

    const caller = new AbortController();
    const pending = testkit.invokeAction('exercise', {
      requestId: 'wait',
      title: 'Cancelled',
    }, { signal: caller.signal });
    await Promise.resolve();
    caller.abort(new Error('external fixture caller cancelled'));
    await expectErrorCode(pending, 'plugin_action_aborted');
  } finally {
    await testkit.dispose();
  }

  const unavailable = await createPluginTestkit({ manifest, module: { activate } });
  try {
    await expectErrorCode(unavailable.invokeAction('exercise', {
      requestId: 'permission-2',
      title: 'Unavailable',
    }), 'plugin_test_service_unavailable');
  } finally {
    await unavailable.dispose();
  }
}
