import { z } from '../../zodRuntimePolicy.js';
import {
  FrameBridgeIdentityV1Schema,
  wireIdentitiesEqual,
  type FrameBridgeIdentityV1,
} from '../../frameBridge/frameBridgeEnvelopeV1.js';

import { PluginUiJsonValueV1Schema } from '../contributions/ui/json.js';
import {
  PluginUiHostMethodV1Schema,
  PluginUiHostSubscriptionMethodV1Schema,
} from './hostApiDefinition.js';
import {
  PluginUiHostApiDiagnosticRemediationV1Schema,
  PluginUiHostApiErrorPayloadV1Schema,
  PluginUiHostApiDiagnosticV1Schema,
} from './hostApiRequests.js';
import { PluginUiSelectActionInputTargetedSubmittedV1Schema } from './hostApiRequests.js';
import { pluginUiSelectedActionInputMatchesOperation } from './selectedActionInput.js';
import { PluginUiTargetedContributionOperationV1Schema } from './targetedContributions.js';

export const PLUGIN_UI_HOST_API_WIRE_VERSION_V1 = 1 as const;

export const PluginUiHostApiWireIdentityV1Schema = FrameBridgeIdentityV1Schema;
export type PluginUiHostApiWireIdentityV1 = FrameBridgeIdentityV1;

/**
 * The one wire-identity equality operation. Every realm that addresses a
 * mounted surface — the host bridge adapter, the client transport, and the
 * hosted-web guest — answers "is this envelope mine?" with exactly this
 * comparison, so adding an identity member cannot leave one realm accepting
 * an envelope the other two reject.
 *
 * Domain identity and authority belong to the outer mount adapter. Two mounts
 * of the same source and a replacement document are distinct addressees.
 */
export const pluginUiHostApiWireIdentitiesEqual = wireIdentitiesEqual;

const WireBase = z.object({ wireVersion: z.literal(PLUGIN_UI_HOST_API_WIRE_VERSION_V1), identity: PluginUiHostApiWireIdentityV1Schema });
const RequestBase = z.extend(WireBase, { requestId: z.string().check(z.trim(), z.minLength(1)) });

/**
 * A selected contributor operation and its complete settlement are a
 * host-private currentness carrier. They cross only the canonical operation
 * consumers: `executeAction`, or `openNewSession` when it materializes a
 * prepared review workspace. Public Action and New Session payloads remain
 * closed values.
 */
const PluginUiHostApiWireRequestEnvelopeV1Schema = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(RequestBase, {
  kind: z.literal('request'),
  method: PluginUiHostMethodV1Schema,
  payload: z.optional(PluginUiJsonValueV1Schema),
  targetedOperation: z.optional(PluginUiTargetedContributionOperationV1Schema),
  selectedActionInput: z.optional(PluginUiSelectActionInputTargetedSubmittedV1Schema),
  /**
   * A closed mounted-host execution fact. Its absence retains the selection
   * for a nonterminal relay; `true` consumes the exact host-retained pair
   * synchronously before the request reaches the mounted dispatcher.
   *
   * This is deliberately not public Action payload or author API data.
   */
  consumeSelectedActionInput: z.optional(z.literal(true)),
})).check(z.superRefine((request, ctx) => {
  if (
    (
      request.targetedOperation !== undefined
      || request.selectedActionInput !== undefined
      || request.consumeSelectedActionInput !== undefined
    )
    && request.method !== 'executeAction'
    && request.method !== 'openNewSession'
  ) {
    ctx.addIssue({
      code: "custom",
      path: ['targetedOperation'],
      message: 'A selected operation may accompany only executeAction or openNewSession.',
    });
  }
  if ((request.targetedOperation === undefined) !== (request.selectedActionInput === undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ['selectedActionInput'],
      message: 'A selected operation requires its complete selected settlement.',
    });
  }
  if (
    request.consumeSelectedActionInput !== undefined
    && (request.targetedOperation === undefined || request.selectedActionInput === undefined)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ['consumeSelectedActionInput'],
      message: 'A terminal selected settlement consumption requires its exact operation and settlement.',
    });
  }
  if (
    request.method === 'openNewSession'
    && request.targetedOperation !== undefined
    && request.consumeSelectedActionInput !== true
  ) {
    ctx.addIssue({
      code: "custom",
      path: ['consumeSelectedActionInput'],
      message: 'A prepared New Session operation is always terminally consumed.',
    });
  }
  if (
    request.targetedOperation !== undefined
    && request.selectedActionInput !== undefined
    && !pluginUiSelectedActionInputMatchesOperation(request.selectedActionInput, request.targetedOperation)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ['selectedActionInput'],
      message: 'A selected settlement must name its exact targeted operation.',
    });
  }
}));

export const PluginUiHostApiWireEnvelopeV1Schema = z.discriminatedUnion('kind', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WireBase, { kind: z.literal('negotiate'), apiRange: z.string().check(z.trim(), z.minLength(1)) })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WireBase, { kind: z.literal('negotiated'), apiVersion: z.string().check(z.trim(), z.minLength(1)), methods: z.array(PluginUiHostMethodV1Schema) })),
  PluginUiHostApiWireRequestEnvelopeV1Schema,
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(RequestBase, { kind: z.literal('cancel') })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(RequestBase, { kind: z.literal('result'), method: PluginUiHostMethodV1Schema, result: z.optional(PluginUiJsonValueV1Schema) })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(RequestBase, {
    kind: z.literal('error'),
    method: PluginUiHostMethodV1Schema,
    error: z.strictObject({
      name: z.literal('PluginError'),
      code: z.string().check(z.trim(), z.minLength(1)),
      message: z.optional(z.string()),
      retryable: z.optional(z.boolean()),
      details: z.optional(PluginUiJsonValueV1Schema),
      failureCause: PluginUiHostApiErrorPayloadV1Schema.shape.failureCause,
      remediation: z.optional(PluginUiHostApiDiagnosticRemediationV1Schema),
      diagnostics: z.optional(z.array(PluginUiHostApiDiagnosticV1Schema)),
      actionHandlerInvocation: z.optional(z.literal('notStarted')),
    }),
  })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(RequestBase, { kind: z.literal('subscribe'), subscriptionId: z.string().check(z.trim(), z.minLength(1)), method: PluginUiHostSubscriptionMethodV1Schema, payload: z.optional(PluginUiJsonValueV1Schema) })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WireBase, { kind: z.literal('subscription'), subscriptionId: z.string().check(z.trim(), z.minLength(1)), event: PluginUiJsonValueV1Schema })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(RequestBase, { kind: z.literal('disposeHostResource'), subscriptionId: z.string().check(z.trim(), z.minLength(1)) })),
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(WireBase, { kind: z.literal('disconnected'), reason: z.string().check(z.trim(), z.minLength(1)) })),
]);
export type PluginUiHostApiWireEnvelopeV1 = z.infer<typeof PluginUiHostApiWireEnvelopeV1Schema>;
