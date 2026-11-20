import type { JsonValue, PluginContributionRef } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import {
  TriageSessionHandoffInputV1Schema,
  TriageSessionHandoffResultV1Schema,
  type TriageSessionHandoffInputV1,
  TRIAGE_READ_SESSION_HANDOFF_CHOICES_ACTION_REF_V1,
  TriageReadSessionHandoffChoicesInputV1Schema,
  type TriageReadSessionHandoffChoicesInputV1,
  TriageSessionHandoffChoicesV1Schema,
  type TriageSessionHandoffChoicesV1,
} from '@happier-dev/triage-protocol/v1';

/** The existing host Action transport; all selection and delivery stay in Triage. */
export type TriageSessionHandoffHostV1 = Readonly<{
  executeAction(ref: PluginContributionRef, input: JsonValue, options?: Readonly<{ signal?: AbortSignal }>): Promise<JsonValue | void>;
}>;

export const TRIAGE_SESSION_HANDOFF_ACTION_REF_V1 = Object.freeze({ pluginId: 'happier.triage', localId: 'sessions/run-configured-v1' });

export type TriageSessionHandoffChoicesReadOutcomeV1 =
  | TriageSessionHandoffChoicesV1
  | Readonly<{ kind: 'actionOutcome'; outcome: JsonValue | void }>;

/** Reads the catalog owner's offered selections once; no selection or delivery is performed here. */
export async function readTriageSessionHandoffChoicesV1(
  host: TriageSessionHandoffHostV1,
  options: Readonly<Pick<TriageReadSessionHandoffChoicesInputV1, 'task' | 'source'> & { signal?: AbortSignal }> = {},
): Promise<TriageSessionHandoffChoicesReadOutcomeV1> {
  const input = TriageReadSessionHandoffChoicesInputV1Schema.parse({ v: 1, projection: 'sessionHandoff',
    ...(options.task === undefined ? {} : { task: options.task }),
    ...(options.source === undefined ? {} : { source: options.source }) });
  const response = await host.executeAction(TRIAGE_READ_SESSION_HANDOFF_CHOICES_ACTION_REF_V1, input,
    options.signal === undefined ? {} : { signal: options.signal });
  if (response === undefined) return { kind: 'actionOutcome', outcome: response };
  if (response && typeof response === 'object' && !Array.isArray(response) && 'ok' in response && response.ok === false) {
    return { kind: 'actionOutcome', outcome: response };
  }
  const result = response && typeof response === 'object' && !Array.isArray(response)
    && 'ok' in response && response.ok === true && 'result' in response ? response.result : response;
  if (isPluginActionApprovalRequestCreated(result)) return { kind: 'actionOutcome', outcome: response };
  const choices = TriageSessionHandoffChoicesV1Schema.safeParse(result);
  if (!choices.success) throw new TypeError('triage_handoff_choices_result_invalid');
  return choices.data;
}

/** Prepares the canonical operand for a host-rendered Action control without invoking it. */
export function prepareTriageSessionHandoffV1(input: TriageSessionHandoffInputV1): Readonly<{ input: JsonValue }> {
  const handoff = TriageSessionHandoffInputV1Schema.parse(input);
  return { input: projectNativeJsonValueForTransport({ v: 1, handoff }) };
}

/** Validates operands and invokes once. Approval, failure and recovery stay intact. */
export async function requestTriageSessionHandoffV1(
  host: TriageSessionHandoffHostV1,
  input: TriageSessionHandoffInputV1,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<JsonValue | void> {
  const prepared = prepareTriageSessionHandoffV1(input);
  const response = await host.executeAction(TRIAGE_SESSION_HANDOFF_ACTION_REF_V1, prepared.input, options);
  return settleTriageSessionHandoffV1(response);
}

/** Consumes the original host settlement; approval/failure/recovery identity is never rewritten. */
export function settleTriageSessionHandoffV1(response: JsonValue | void): JsonValue | void {
  // The executor owns its standard outer envelope. Validate only this Action's
  // successful result, retaining its action-owned recovery rather than cloning it.
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    if ('ok' in response && response.ok === false) return response;
    const result = 'ok' in response && response.ok === true && 'result' in response ? response.result : response;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      if ('kind' in result && result.kind === 'approval_request_created') return response;
      if ('v' in result && result.v === 1 && 'handoff' in result) {
        TriageSessionHandoffResultV1Schema.parse(result.handoff);
        return response;
      }
    }
  }
  throw new TypeError('triage_handoff_result_invalid');
}
