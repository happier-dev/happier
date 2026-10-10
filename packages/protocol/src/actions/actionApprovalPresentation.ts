import { StructuredQuestionAnswersV1Schema } from '../tools/structuredQuestionAnswersV1.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { getActionSpec } from './actionSpecs.js';
import { resolveEffectiveActionInputFields } from './actionInputHintsRuntime.js';
import { actionInputFieldAcceptsNull } from './actionInputSchemaPath.js';
import type { ActionId } from './actionIds.js';
import { VoiceConversationTargetSchema } from './voiceConversationActionFamily.js';
import type { ActionInputFieldHint } from './actionInputHintsRuntime.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export type ApprovalStructuredAnswer = Readonly<{
  question: string;
  values: readonly string[];
}>;

export type ApprovalUnrepresentableReason =
  | 'malformed_entry'
  | 'duplicate_question'
  | 'exceeds_protocol_bounds'
  | 'missing_required_context';

export type ApprovalStructuredAnswersProjection =
  | Readonly<{ kind: 'valid'; answers: readonly ApprovalStructuredAnswer[] }>
  | Readonly<{ kind: 'unrepresentable'; reason: ApprovalUnrepresentableReason }>;

export type ApprovalActionFieldRow =
  | Readonly<{ kind: 'value'; path: string; title: string; value: string; reference?: ApprovalActionReference }>
  | Readonly<{ kind: 'structuredAnswers'; path: string; title: string; answers: readonly ApprovalStructuredAnswer[] }>
  | Readonly<{ kind: 'unrepresentable'; path: string; title: string; reason: ApprovalUnrepresentableReason }>;

export type ApprovalActionReference =
  | Readonly<{ kind: 'session'; id: string; serverId?: string }>
  | Readonly<{ kind: 'home'; id: string }>;

// These are declared Action field keys, not a guess from an opaque value or suffix.
const SESSION_REFERENCE_KEYS = new Set([
  'sessionId', 'leadSessionId', 'expectedLeadSessionId', 'sourceSessionId', 'targetSessionId',
  'underSessionId', 'parentSessionId', 'originSessionId',
]);

function describeApprovalReference(actionId: string, field: ActionInputFieldHint, values: readonly unknown[]): ApprovalActionReference | undefined {
  if (values.length !== 1) return undefined;
  const value = values[0];
  if (field.path === 'target' && (actionId === 'ui.voice_global.start' || actionId === 'ui.voice_global.get')) {
    // Only this declared typed union owns this discriminator. Arbitrary JSON that happens
    // to contain kind/sessionId keys remains data, including access principals/configuration.
    const target = VoiceConversationTargetSchema.safeParse(value);
    if (target.success && target.data.kind === 'session' && target.data.sessionAddress) {
      return { kind: 'session', id: target.data.sessionAddress.sessionId, serverId: target.data.sessionAddress.serverId };
    }
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const key = field.path.split('.').at(-1);
  if ((field.inputType && 'hostType' in field.inputType && field.inputType.hostType === 'session')
    || (key !== undefined && SESSION_REFERENCE_KEYS.has(key))) {
    return { kind: 'session', id: value.trim() };
  }
  if (key === 'serverId') return { kind: 'home', id: value.trim() };
  return undefined;
}

export type ApprovalActionFieldsPresentation = Readonly<{
  rows: readonly ApprovalActionFieldRow[];
  unrepresentable: Readonly<{ path: string; reason: ApprovalUnrepresentableReason }> | null;
}>;

export type ApprovalRequestApproveAdmission = Readonly<
  | {
      status: 'available';
      presentation: ApprovalActionFieldsPresentation;
    }
  | {
      status: 'unavailable';
      reason: 'legacy_request';
      presentation: ApprovalActionFieldsPresentation;
    }
  | {
      status: 'unavailable';
      reason: 'context_unavailable';
      details: NonNullable<ApprovalActionFieldsPresentation['unrepresentable']>;
      presentation: ApprovalActionFieldsPresentation;
    }
>;

const STRUCTURED_ANSWER_FIELD_PATH_BY_ACTION_ID: Readonly<Record<string, string>> = {
  'session.user_action.answer': 'answers',
};

function visitSegments(value: unknown, segments: readonly string[], index: number, output: unknown[]): void {
  if (index >= segments.length) {
    output.push(value);
    return;
  }
  const segment = segments[index];
  if (!segment) return;
  if (segment === '[]') {
    if (!Array.isArray(value)) return;
    for (const entry of value) visitSegments(entry, segments, index + 1, output);
    return;
  }
  if (!isRecord(value)) return;
  visitSegments(value[segment], segments, index + 1, output);
}

export function getApprovalFieldValues(input: unknown, path: string): readonly unknown[] {
  if (path === 'answers.[].values' && isRecord(input) && Array.isArray(input.answers)) {
    return input.answers.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      if (Array.isArray(entry.values)) return entry.values;
      return typeof entry.answer === 'string' ? [entry.answer] : [];
    });
  }
  const segments = path.split('.').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return [];
  const output: unknown[] = [];
  visitSegments(input, segments, 0, output);
  return output;
}

export function shouldHideApprovalField(path: string, allPaths: readonly string[]): boolean {
  if (!path || path.endsWith('.[]')) return true;
  return allPaths.some((candidate) => candidate !== path
    && (candidate.startsWith(`${path}.`) || candidate.startsWith(`${path}.[`)));
}

export function formatApprovalFieldValues(values: readonly unknown[], options: Readonly<{ preserveStructuredValues?: boolean }> = {}): string | null {
  const displayValues = options.preserveStructuredValues ? values : values.flatMap((value) => (Array.isArray(value) ? value : [value]));
  const formatted = displayValues
    .map((value) => {
      if (typeof value === 'string') return value.trim();
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (value && typeof value === 'object') {
        try {
          return JSON.stringify(value) ?? '';
        } catch {
          return '';
        }
      }
      return '';
    })
    .filter((value) => value.length > 0);
  return formatted.length > 0 ? formatted.join(', ') : null;
}

export function projectApprovalStructuredAnswers(values: readonly unknown[]): ApprovalStructuredAnswersProjection {
  const entries = values.flatMap((value) => {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
  });
  const candidate = Object.create(null) as Record<string, readonly string[]>;
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.question !== 'string') {
      return { kind: 'unrepresentable', reason: 'malformed_entry' };
    }
    if (Object.hasOwn(candidate, entry.question)) {
      return { kind: 'unrepresentable', reason: 'duplicate_question' };
    }
    const rawValues = Array.isArray(entry.values)
      ? entry.values
      : (entry.answer === undefined ? [] : [entry.answer]);
    if (rawValues.length === 0 || rawValues.some((value) => typeof value !== 'string')) {
      return { kind: 'unrepresentable', reason: 'malformed_entry' };
    }
    candidate[entry.question] = rawValues as readonly string[];
  }
  const parsed = StructuredQuestionAnswersV1Schema.safeParse(candidate);
  if (!parsed.success) return { kind: 'unrepresentable', reason: 'exceeds_protocol_bounds' };
  return {
    kind: 'valid',
    answers: Object.entries(parsed.data).map(([question, values]) => ({ question, values })),
  };
}

/**
 * Selects the host-owned observation-safe arguments persisted in the approval
 * preview. Released artifacts without that envelope fall back to the Action's
 * own observation projection; raw secret-bearing arguments are never selected
 * merely because the presentation envelope is absent or mismatched.
 */
export function resolveApprovalPresentationInput(input: Readonly<{
  actionId: string;
  actionArgs: unknown;
  preview?: unknown;
}>): unknown {
  if (isRecord(input.preview)
    && input.preview.actionId === input.actionId
    && Object.hasOwn(input.preview, 'actionArgs')) {
    return input.preview.actionArgs;
  }
  try {
    const spec = getActionSpec(input.actionId as ActionId);
    return spec.projectObservationInput
      ? spec.projectObservationInput(input.actionArgs)
      : input.actionArgs;
  } catch {
    return {};
  }
}

/** One Protocol-owned reading governs both rendered fields and approval admission. */
export function describeApprovalActionFields(input: Readonly<{
  actionId: string;
  actionArgs: unknown;
  preview?: unknown;
}>): ApprovalActionFieldsPresentation {
  let spec;
  try {
    spec = getActionSpec(input.actionId as ActionId);
  } catch {
    return { rows: [], unrepresentable: null };
  }
  const presentationInput = resolveApprovalPresentationInput(input);
  const resolved = resolveEffectiveActionInputFields(spec, presentationInput);
  const paths = resolved.map((field) => field.path);
  const structuredAnswerPath = STRUCTURED_ANSWER_FIELD_PATH_BY_ACTION_ID[input.actionId];
  const rows: ApprovalActionFieldRow[] = [];
  let unrepresentable: ApprovalActionFieldsPresentation['unrepresentable'] = null;

  for (const field of resolved) {
    if (shouldHideApprovalField(field.path, paths)) continue;
    const values = getApprovalFieldValues(presentationInput, field.path);
    if (structuredAnswerPath !== undefined && field.path === structuredAnswerPath) {
      const projection = projectApprovalStructuredAnswers(values);
      if (projection.kind === 'unrepresentable') {
        unrepresentable ??= { path: field.path, reason: projection.reason };
        rows.push({ kind: 'unrepresentable', path: field.path, title: field.title, reason: projection.reason });
      } else if (projection.answers.length > 0) {
        rows.push({ kind: 'structuredAnswers', path: field.path, title: field.title, answers: projection.answers });
      }
      continue;
    }
    const value = formatApprovalFieldValues(values, { preserveStructuredValues: field.widget === 'json' });
    if (value === null) {
      // A required field whose schema declares `null` and that carries exactly
      // that null is present context with nothing to display, not missing context.
      const declaredNull = values.length > 0
        && values.every((entry) => entry === null)
        && actionInputFieldAcceptsNull(spec, field.path);
      // Live-only input deliberately leaves required private fields out of the
      // durable observation projection. Their presence is guaranteed by the
      // admitted invocation that retains the raw input; omission here means
      // withheld, not missing approval context.
      const withheldByLiveOnlyCustody = spec.approvalInputCustody === 'live_only';
      if (field.required && !declaredNull && !withheldByLiveOnlyCustody) {
        const reason = 'missing_required_context' as const;
        unrepresentable ??= { path: field.path, reason };
        rows.push({ kind: 'unrepresentable', path: field.path, title: field.title, reason });
      }
      continue;
    }
    const reference = describeApprovalReference(input.actionId, field, values);
    rows.push({ kind: 'value', path: field.path, title: field.title, value, ...(reference ? { reference } : {}) });
  }
  return { rows, unrepresentable };
}

export function describeApprovalRequestFields(
  request: Pick<ApprovalRequest, 'actionId' | 'actionArgs' | 'preview'>,
): ApprovalActionFieldsPresentation {
  return describeApprovalActionFields({
    actionId: request.actionId,
    actionArgs: request.actionArgs,
    ...(request.preview === undefined ? {} : { preview: request.preview }),
  });
}

/**
 * The single Protocol-owned admission for an Approve decision.
 *
 * Released V1 requests stay readable and rejectable, but cannot prove the
 * immutable execution origin needed for replay. Current requests additionally
 * fail closed when the Action's required observation-safe context could not be
 * represented. UI controls and the executor consume this same result so a
 * button cannot advertise an effect that the decision owner will reject.
 */
export function resolveApprovalRequestApproveAdmission(
  request: ApprovalRequest,
): ApprovalRequestApproveAdmission {
  const presentation = describeApprovalRequestFields(request);
  if (request.v === 1) {
    return { status: 'unavailable', reason: 'legacy_request', presentation };
  }
  if (presentation.unrepresentable) {
    return {
      status: 'unavailable',
      reason: 'context_unavailable',
      details: presentation.unrepresentable,
      presentation,
    };
  }
  return { status: 'available', presentation };
}
