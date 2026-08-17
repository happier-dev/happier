import { z } from 'zod';

import { pluginJsonValuesEqual } from '../contributions/jsonSchemaValues.js';
import type { PluginUiJsonValueV1 } from '../contributions/ui/json.js';

import type {
  PluginUiSelectActionInputResultV1,
  PluginUiSelectActionInputTargetedSubmittedV1,
} from './hostApiRequests.js';
import { PluginUiSelectActionInputTargetedSubmittedV1Schema } from './hostApiRequests.js';
import {
  PluginUiTargetedContributionOperationV1Schema,
  type PluginUiTargetedContributionOperationV1,
} from './targetedContributions.js';

/**
 * The host-selected facts that are intentionally absent from public Action
 * input. This stays transient: it is valid only while its producing mount and
 * target admission remain current.
 */
export type PluginUiSelectedActionInputV1 = PluginUiSelectActionInputTargetedSubmittedV1;

/**
 * An untrusted transport carrier for one selected settlement and the exact
 * admitted operation that produced it. The issuer retains the active carrier;
 * this value itself does not confer authority across a realm.
 */
export const PluginUiSelectedActionInputCarrierV1Schema = z.object({
  operation: PluginUiTargetedContributionOperationV1Schema,
  result: PluginUiSelectActionInputTargetedSubmittedV1Schema,
}).strict().superRefine((carrier, ctx) => {
  if (!pluginUiSelectedActionInputMatchesOperation(carrier.result, carrier.operation)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['result'],
      message: 'Selected Action input does not match its targeted operation.',
    });
  }
});
export type PluginUiSelectedActionInputCarrierV1 = z.infer<
  typeof PluginUiSelectedActionInputCarrierV1Schema
>;

/** The selection-free shape accepted by the one input reconstruction owner. */
export type PluginUiSelectedActionInputForReconstructionV1 = Pick<
  PluginUiSelectedActionInputV1,
  'input' | 'connectedAccount'
>;

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
 */
export function reconstructPluginUiSelectedActionInput(
  result: PluginUiSelectedActionInputForReconstructionV1,
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
      if (index === segments.length - 1) return null;
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
    && selection.selection.contributor.immutableGenerationId
      === operation.contributor.immutableGenerationId;
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
    operation.contributor.immutableGenerationId,
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
