import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { computeCanonicalDomainSeparatedDigest } from '../../crypto/canonicalDigest.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';

import { pluginJsonValuesEqual } from '../contributions/jsonSchemaValues.js';
import type { PluginUiJsonValueV1 } from '../contributions/ui/json.js';
import { PluginContributionIdentityV1Schema, type PluginContributionIdentityV1 } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { defineProtocolCanonicalJsonValue } from '../actions/protocolComposableSchema.js';
import { PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1 } from './semanticCommands.js';
import { ConnectedAccountActionFormSelectionV1Schema } from '../../connect/connectedAccountPurposeBindings.js';
import { pluginSourceCustodyV1Equal } from '../runtime/sourceCustody.js';

import type {
  PluginUiSelectActionInputResultV1,
} from './hostApiRequests.js';
import {
  PluginTargetedContributionSelectionV1Schema,
  PluginUiTargetedContributionOperationV1Schema,
  type PluginUiTargetedContributionOperationV1,
} from './targetedContributions.js';

/**
 * A resolved contributed Action reference is always exact. Declarative
 * selectors and mounted-action normalization consume this form after their
 * caller binding has been established.
 */
export const PluginUiQualifiedActionReferenceV1Schema = lazyDefinition(() => PluginContributionIdentityV1Schema);
export type PluginUiQualifiedActionReferenceV1 = PluginContributionIdentityV1;

export type PluginUiJsonObjectV1 = { readonly [key: string]: PluginUiJsonValueV1 };

function isPluginUiJsonObject(value: PluginUiJsonValueV1): value is PluginUiJsonObjectV1 {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Selection values share the incumbent bounded host-input JSON boundary. */
export const PluginUiJsonObjectV1Schema = lazyZodSchema(() => asProtocolZod(defineProtocolCanonicalJsonValue<PluginUiJsonObjectV1>({
  maxSerializedUtf8Bytes: PLUGIN_UI_LAUNCH_INPUT_MAX_UTF8_BYTES_V1,
  parse: (value) => isPluginUiJsonObject(value) ? value : null,
})));

const PluginUiSelectActionInputConnectedAccountV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('selected'),
    fieldPath: z.string().check(z.trim(), z.minLength(1)),
    ref: ConnectedAccountActionFormSelectionV1Schema,
  }),
]));

const PluginUiSelectActionInputPresentationV1Schema = lazyZodSchema(() => z.strictObject({
  connectedAccountLabel: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
  machineDisplayName: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
}));

export const PluginUiSelectActionInputTargetedSubmittedV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('submitted'),
  action: asProtocolZod(PluginUiQualifiedActionReferenceV1Schema),
  input: PluginUiJsonObjectV1Schema,
  selection: asProtocolZod(PluginTargetedContributionSelectionV1Schema),
  connectedAccount: PluginUiSelectActionInputConnectedAccountV1Schema,
  presentation: PluginUiSelectActionInputPresentationV1Schema,
}));
export type PluginUiSelectActionInputTargetedSubmittedV1 =
  z.infer<typeof PluginUiSelectActionInputTargetedSubmittedV1Schema>;

/**
 * The host-selected facts that are intentionally absent from public Action
 * input. This stays transient: it is valid only while its producing UI binding and
 * target admission remain current.
 */
export type PluginUiSelectedActionInputV1 = PluginUiSelectActionInputTargetedSubmittedV1;

/**
 * An untrusted transport carrier for one selected settlement and the exact
 * admitted operation that produced it. The issuer retains the active carrier;
 * this value itself does not confer authority across a realm.
 */
export const PluginUiSelectedActionInputCarrierV1Schema = lazyZodSchema(() => z.strictObject({
  operation: PluginUiTargetedContributionOperationV1Schema,
  result: PluginUiSelectActionInputTargetedSubmittedV1Schema,
}).check(z.superRefine((carrier, ctx) => {
  if (!pluginUiSelectedActionInputMatchesOperation(carrier.result, carrier.operation)) {
    ctx.addIssue({
      code: "custom",
      path: ['result'],
      message: 'Selected Action input does not match its targeted operation.',
    });
  }
})));
export type PluginUiSelectedActionInputCarrierV1 = z.infer<
  typeof PluginUiSelectedActionInputCarrierV1Schema
>;

/** The mounted selection and outer operands share the installation-sealed payload. */
export const PrivateMountedSelectedActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  carrier: PluginUiSelectedActionInputCarrierV1Schema,
  input: StrictJsonValueSchema,
}));
export type PrivateMountedSelectedActionInputV1 = z.infer<typeof PrivateMountedSelectedActionInputV1Schema>;

/** Bind the exact private mounted selection to the existing signed request. */
export function computePluginUiSelectedActionInputDigestV1(selection: PrivateMountedSelectedActionInputV1): string {
  return computeCanonicalDomainSeparatedDigest('happier.mounted-selected-action-input.v1', [
    createCanonicalJsonSigningInput(selection),
  ]);
}

/** The selection-free shape accepted by the one input reconstruction owner. */
export type PluginUiSelectedActionInputForReconstructionV1<
  Input extends PluginUiJsonValueV1 = PluginUiSelectedActionInputV1['input'],
> = Readonly<{
  input: Input;
  connectedAccount: PluginUiSelectedActionInputV1['connectedAccount'];
}>;

const unsafeInputPathSegments = new Set(['__proto__', 'constructor', 'prototype']);

function readSafeInputPath(path: string): readonly string[] | null {
  const segments = path.split('.');
  return segments.length > 0
    && segments.every((segment) => (
      segment.trim().length > 0 && !unsafeInputPathSegments.has(segment)
    ))
    ? segments
    : null;
}

function isPlainJsonRecord(value: PluginUiJsonValueV1): value is Readonly<Record<string, PluginUiJsonValueV1>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Restores the one Account ref removed by target-scoped form selection. It is
 * the sole realm-neutral reconstruction owner; callers must first establish
 * that the selected settlement is an active, exact admitted operation.
 * Retained input may opt into preserving an already-present exact Account;
 * form settlements keep rejecting every occupied selection field.
 */
export function reconstructPluginUiSelectedActionInput(
  result: PluginUiSelectedActionInputForReconstructionV1<PluginUiJsonValueV1>,
  options?: Readonly<{ allowMatchingConnectedAccount?: boolean }>,
): Readonly<Record<string, PluginUiJsonValueV1>> | null {
  const input = result.input;
  if (!isPlainJsonRecord(input)) return null;
  const connectedAccount = result.connectedAccount;
  if (connectedAccount.kind === 'none') return input;

  const segments = readSafeInputPath(connectedAccount.fieldPath);
  if (!segments) return null;
  const insert = (
    source: Readonly<Record<string, PluginUiJsonValueV1>>,
    index: number,
  ): Readonly<Record<string, PluginUiJsonValueV1>> | null => {
    const segment = segments[index]!;
    if (Object.prototype.hasOwnProperty.call(source, segment)) {
      if (index === segments.length - 1) {
        return options?.allowMatchingConnectedAccount
          && pluginJsonValuesEqual(source[segment], connectedAccount.ref)
          ? source
          : null;
      }
      const child = source[segment];
      if (!child || !isPlainJsonRecord(child)) return null;
      const inserted = insert(child, index + 1);
      return inserted ? { ...source, [segment]: inserted } : null;
    }
    if (index === segments.length - 1) {
      return { ...source, [segment]: connectedAccount.ref };
    }
    const inserted = insert({}, index + 1);
    return inserted ? { ...source, [segment]: inserted } : null;
  };

  return insert(input, 0);
}

/** Exact JSON equality is the cross-realm selected-settlement contract. */
export function pluginUiSelectedActionInputsEqual(
  left: PluginUiSelectedActionInputV1,
  right: PluginUiSelectedActionInputV1,
): boolean {
  return pluginJsonValuesEqual(left, right);
}

/** Whether the submitted settlement names this exact admitted operation. */
export function pluginUiSelectedActionInputMatchesOperation(
  selection: PluginUiSelectedActionInputV1,
  operation: PluginUiTargetedContributionOperationV1,
): boolean {
  return selection.action.pluginId === operation.action.pluginId
    && selection.action.localId === operation.action.localId
    && selection.selection.point.pointId === operation.point.pointId
    && selection.selection.point.protocol.id === operation.point.protocol.id
    && selection.selection.point.protocol.version === operation.point.protocol.version
    && selection.selection.contributor.pluginId === operation.contributor.pluginId
    && selection.selection.contributor.contributionId === operation.contributor.contributionId
    && pluginSourceCustodyV1Equal(
      selection.selection.contributor.sourceCustody,
      operation.contributor.sourceCustody,
    );
}

/**
 * A deterministic in-memory key for one exact admitted operation. It includes
 * role because a contributor may bind the same Action under more than one
 * operation role. It is not persisted or sent as an authority token.
 */
export function pluginUiTargetedContributionOperationKey(
  operation: PluginUiTargetedContributionOperationV1,
): string {
  return [
    operation.point.pointId,
    operation.point.protocol.id,
    operation.point.protocol.version,
    operation.contributor.pluginId,
    operation.contributor.contributionId,
    operation.contributor.occurrenceId,
    operation.role,
    operation.action.pluginId,
    operation.action.localId,
  ].map((part) => JSON.stringify(part)).join('|');
}

/** Narrows a closed selectActionInput result to its targeted submitted arm. */
export function isPluginUiSelectedActionInput(
  value: PluginUiSelectActionInputResultV1,
): value is PluginUiSelectedActionInputV1 {
  return value.kind === 'submitted';
}
