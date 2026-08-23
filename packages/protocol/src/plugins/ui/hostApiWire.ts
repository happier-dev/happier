import { z } from 'zod';

import { PluginUiJsonValueV1Schema } from '../contributions/ui/json.js';
import {
  PluginUiHostMethodV1Schema,
  PluginUiHostSubscriptionMethodV1Schema,
} from './hostApiDefinition.js';
import {
  PluginUiHostApiDiagnosticRemediationV1Schema,
  PluginUiHostApiDiagnosticV1Schema,
} from './hostApiRequests.js';
import { PluginUiSelectActionInputTargetedSubmittedV1Schema } from './hostApiRequests.js';
import { pluginUiSelectedActionInputMatchesOperation } from './selectedActionInput.js';
import { PluginUiTargetedContributionOperationV1Schema } from './targetedContributions.js';

export const PLUGIN_UI_HOST_API_WIRE_VERSION_V1 = 1 as const;

export const PluginUiHostApiWireIdentityV1Schema = z.object({
  pluginId: z.string().trim().min(1),
  pluginVersion: z.string().trim().min(1),
  viewId: z.string().trim().min(1),
  generation: z.string().trim().min(1),
  sessionId: z.string().trim().min(1).optional(),
}).strict();
export type PluginUiHostApiWireIdentityV1 = z.infer<typeof PluginUiHostApiWireIdentityV1Schema>;

/**
 * The one wire-identity equality operation. Every realm that addresses a
 * mounted surface — the host bridge adapter, the client transport, and the
 * hosted-web guest — answers "is this envelope mine?" with exactly this
 * comparison, so adding an identity member cannot leave one realm accepting
 * an envelope the other two reject.
 *
 * `sessionId` is compared including its absent state: a Session-scoped mount
 * and an Account-scoped mount of the same plugin/view/generation are different
 * addressees, not the same one with a missing field.
 */
export function pluginUiHostApiWireIdentitiesEqual(
  expected: PluginUiHostApiWireIdentityV1,
  actual: PluginUiHostApiWireIdentityV1,
): boolean {
  return expected.pluginId === actual.pluginId;
}

const WireBase = z.object({ wireVersion: z.literal(PLUGIN_UI_HOST_API_WIRE_VERSION_V1), identity: PluginUiHostApiWireIdentityV1Schema });
const RequestBase = WireBase.extend({ requestId: z.string().trim().min(1) });

/**
 * A selected contributor operation and its complete settlement are a
 * host-private currentness carrier. They cross only the canonical
 * executeAction wire arm: public Action payloads remain closed
 * `{ action, input }` values.
 */
const PluginUiHostApiWireRequestEnvelopeV1Schema = RequestBase.extend({
  kind: z.literal('request'),
  method: PluginUiHostMethodV1Schema,
  payload: PluginUiJsonValueV1Schema.optional(),
  targetedOperation: PluginUiTargetedContributionOperationV1Schema.optional(),
  selectedActionInput: PluginUiSelectActionInputTargetedSubmittedV1Schema.optional(),
  /**
   * A closed mounted-host execution fact. Its absence retains the selection
   * for a nonterminal relay; `true` consumes the exact host-retained pair
   * synchronously before the request reaches the mounted dispatcher.
   *
   * This is deliberately not public Action payload or author API data.
   */
  consumeSelectedActionInput: z.literal(true).optional(),
}).strict().superRefine((request, ctx) => {
  if (
    (
      request.targetedOperation !== undefined
      || request.selectedActionInput !== undefined
      || request.consumeSelectedActionInput !== undefined
    )
    && request.method !== 'executeAction'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['targetedOperation'],
      message: 'A selected operation may accompany only executeAction.',
    });
  }
  if ((request.targetedOperation === undefined) !== (request.selectedActionInput === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectedActionInput'],
      message: 'A selected operation requires its complete selected settlement.',
    });
  }
  if (
    request.consumeSelectedActionInput !== undefined
    && (request.targetedOperation === undefined || request.selectedActionInput === undefined)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['consumeSelectedActionInput'],
      message: 'A terminal selected settlement consumption requires its exact operation and settlement.',
    });
  }
  if (
    request.targetedOperation !== undefined
    && request.selectedActionInput !== undefined
    && !pluginUiSelectedActionInputMatchesOperation(request.selectedActionInput, request.targetedOperation)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['selectedActionInput'],
      message: 'A selected settlement must name its exact targeted operation.',
    });
  }
});

export const PluginUiHostApiWireEnvelopeV1Schema = z.discriminatedUnion('kind', [
  WireBase.extend({ kind: z.literal('negotiate'), apiRange: z.string().trim().min(1) }).strict(),
  WireBase.extend({ kind: z.literal('negotiated'), apiVersion: z.string().trim().min(1), methods: z.array(PluginUiHostMethodV1Schema), surface: PluginUiJsonValueV1Schema }).strict(),
  PluginUiHostApiWireRequestEnvelopeV1Schema,
  RequestBase.extend({ kind: z.literal('cancel') }).strict(),
  RequestBase.extend({ kind: z.literal('result'), method: PluginUiHostMethodV1Schema, result: PluginUiJsonValueV1Schema.optional() }).strict(),
  RequestBase.extend({
    kind: z.literal('error'),
    method: PluginUiHostMethodV1Schema,
    error: z.object({
      name: z.literal('PluginError'),
      code: z.string().trim().min(1),
      message: z.string().optional(),
      retryable: z.boolean().optional(),
      details: PluginUiJsonValueV1Schema.optional(),
      remediation: PluginUiHostApiDiagnosticRemediationV1Schema.optional(),
      diagnostics: z.array(PluginUiHostApiDiagnosticV1Schema).optional(),
    }).strict(),
  }).strict(),
  RequestBase.extend({ kind: z.literal('subscribe'), subscriptionId: z.string().trim().min(1), method: PluginUiHostSubscriptionMethodV1Schema, payload: PluginUiJsonValueV1Schema.optional() }).strict(),
  WireBase.extend({ kind: z.literal('subscription'), subscriptionId: z.string().trim().min(1), event: PluginUiJsonValueV1Schema }).strict(),
  RequestBase.extend({ kind: z.literal('disposeHostResource'), subscriptionId: z.string().trim().min(1) }).strict(),
  WireBase.extend({ kind: z.literal('disconnected'), reason: z.string().trim().min(1) }).strict(),
]);
export type PluginUiHostApiWireEnvelopeV1 = z.infer<typeof PluginUiHostApiWireEnvelopeV1Schema>;
