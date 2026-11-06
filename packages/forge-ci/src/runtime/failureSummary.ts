import { fitActionResultTextV1 } from '@happier-dev/triage-sources/projection/actionResultText';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from '@happier-dev/plugin-sdk/actions';
import type {
  ForgeCiAnnotationV1, ForgeCiExcerptRequestV1, ForgeCiFailureContextReadInputV1, ForgeCiFailureExcerptV1, ForgeCiFailureSummaryV1,
  ForgeCiJobV1, ForgeCiRunV1, ForgeCiSelectionV1,
} from '@happier-dev/triage-protocol/ci/v1';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import { forgeCiJobKeyV1, forgeCiRunKeyV1, forgeCiSelectionKeyV1, readForgeCiSelectionRunV1 } from './identity.js';
import type { ForgeCiLogIndexV1, ForgeCiLogLineV1 } from './logs/index.js';
import { selectForgeCiLogLinesV1 } from './logs/selection.js';

export type ForgeCiFailureSummaryInputV1 = Readonly<{
  run: ForgeCiRunV1; selection: ForgeCiSelectionV1; jobs: readonly ForgeCiJobV1[];
  logs: readonly ForgeCiLogIndexV1[]; annotations?: readonly ForgeCiAnnotationV1[];
  /** Producer-observed missing evidence must participate in the same fit. */
  missing?: readonly string[];
  excerpt: ForgeCiExcerptRequestV1;
  /** Caller-owned summary-body boundary, in addition to the Action carrier boundary. */
  maxSerializedBytes: number;
}>;

/** Creates the required wire operands at the evidence producer, not in a UI. */
export function createForgeCiFailureContextReadRequestV1(input: Readonly<
  Omit<ForgeCiFailureContextReadInputV1, 'excerpt' | 'maxSerializedBytes'>
  & Partial<Pick<ForgeCiFailureContextReadInputV1, 'excerpt' | 'maxSerializedBytes'>>
>): ForgeCiFailureContextReadInputV1 {
  return { ...input,
    excerpt: input.excerpt ?? { contextLines: 0, tailLines: 0, failedOnly: true },
    maxSerializedBytes: input.maxSerializedBytes ?? EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  };
}
export type ForgeCiFailureSummaryResultV1 = Readonly<{ kind: 'value'; value: ForgeCiFailureSummaryV1 }>
  | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>;
type TextSlot = Readonly<{ text: string; offset: number }>;
type SelectedLog = Readonly<{ index: ForgeCiLogIndexV1; lines: readonly Readonly<{ line: ForgeCiLogLineV1; slot: TextSlot }>[] }>;

function unavailable(code: string): ForgeCiFailureSummaryResultV1 {
  return { kind: 'unavailable', failure: { class: 'unsupportedContract', code } };
}

function contextAndTail(index: ForgeCiLogIndexV1, candidates: readonly ForgeCiLogLineV1[], request: ForgeCiExcerptRequestV1): readonly ForgeCiLogLineV1[] {
  const candidateIds = new Set(candidates.map(line => line.id));
  const intervals: Array<{ start: number; end: number }> = [];
  const last = index.lines.length - 1;
  for (let i = 0; i <= last; i += 1) {
    if (!candidateIds.has(index.lines[i]!.id)) continue;
    const start = Math.max(0, i - request.contextLines);
    const end = Math.min(last, i + request.contextLines);
    const previous = intervals.at(-1);
    if (previous && previous.end + 1 >= start) previous.end = Math.max(previous.end, end);
    else intervals.push({ start, end });
  }
  if (request.tailLines > 0 && last >= 0) {
    let start = Math.max(0, index.lines.length - request.tailLines);
    while (intervals.length > 0 && intervals.at(-1)!.end + 1 >= start) start = Math.min(start, intervals.pop()!.start);
    intervals.push({ start, end: last });
  }
  const selected: ForgeCiLogLineV1[] = [];
  for (const interval of intervals) for (let i = interval.start; i <= interval.end; i += 1) selected.push(index.lines[i]!);
  return selected;
}

/** Pure data only. This owner never reads a provider, renders a prompt, or chooses/sends to a Session. */
export function buildForgeCiFailureSummaryV1(input: ForgeCiFailureSummaryInputV1): ForgeCiFailureSummaryResultV1 {
  if (!Number.isSafeInteger(input.maxSerializedBytes) || input.maxSerializedBytes <= 0) return unavailable('insufficient_summary_budget');
  const selectionKey = forgeCiSelectionKeyV1(input.selection);
  if (forgeCiRunKeyV1(input.run.ref) !== forgeCiRunKeyV1(readForgeCiSelectionRunV1(input.selection))
    || input.jobs.some(job => forgeCiSelectionKeyV1(job.ref.selection) !== selectionKey)) return unavailable('invalid_summary_selection');
  const missing = [...(input.missing ?? [])];
  const ambiguous: string[] = [];
  const omitted: string[] = [];
  const chunks: string[] = [];
  let textLength = 0;
  const slot = (text: string): TextSlot => {
    const value = { text, offset: textLength };
    chunks.push(text);
    textLength += text.length;
    return value;
  };
  const jobs = input.jobs.map(job => {
    const steps = job.steps.kind === 'available' ? job.steps.values : [];
    if (job.steps.kind !== 'available') missing.push(`${job.ref.jobId}:steps_${job.steps.kind}`);
    const stepIds = input.excerpt.stepIds;
    if (stepIds !== undefined && stepIds.some(id => !steps.some(step => step.id === id))) return null;
    return { job, name: slot(job.name), steps: steps.filter(step => stepIds !== undefined ? stepIds.includes(step.id)
      : !input.excerpt.failedOnly || step.state.outcomeBucket === 'failed' || step.state.outcomeBucket === 'unknown')
      .map(step => ({ step, name: slot(step.name) })) };
  });
  if (jobs.some(job => job === null)) return unavailable('invalid_step_selection');
  const admittedJobs = jobs.filter((job): job is NonNullable<typeof job> => job !== null);
  const jobKeys = new Set(input.jobs.map(job => forgeCiJobKeyV1(job.ref)));
  const annotations = (input.annotations ?? []).filter(annotation => jobKeys.has(forgeCiJobKeyV1(annotation.job))).map(annotation => ({
    annotation, message: slot(annotation.message),
    ...(annotation.title === undefined ? {} : { title: slot(annotation.title) }),
    ...(annotation.details === undefined ? {} : { details: slot(annotation.details) }),
    ...(annotation.path === undefined ? {} : { path: slot(annotation.path) }),
  }));
  if ((input.annotations?.length ?? 0) !== annotations.length) missing.push('annotations_mismatched_job');
  const logByJob = new Map(input.logs.map(index => [forgeCiJobKeyV1(index.job), index]));
  const selectedLogs: SelectedLog[] = [];
  let continuation: string | null = null;
  for (const job of input.jobs) {
    const index = logByJob.get(forgeCiJobKeyV1(job.ref));
    if (!index) { missing.push(`${job.ref.jobId}:log_unavailable`); continue; }
    if (!index.complete || index.continuation !== null) {
      missing.push(`${job.ref.jobId}:incomplete_log`);
      continuation ??= index.continuation;
    }
    let candidates = index.lines;
    const failedOnly = input.excerpt.failedOnly;
    const stepIds = input.excerpt.stepIds ?? (failedOnly && job.steps.kind === 'available'
      ? job.steps.values.filter(step => step.state.outcomeBucket === 'failed' || step.state.outcomeBucket === 'unknown').map(step => step.id) : undefined);
    if (stepIds && stepIds.length > 0) {
      const selected = selectForgeCiLogLinesV1(index, { kind: 'steps', stepIds });
      if (selected.kind === 'unavailable') return selected;
      candidates = selected.lines;
    } else if (failedOnly && job.steps.kind === 'available' && job.steps.values.length > 0) {
      // No admitted failed native step is not proof that unknown, unassigned log evidence passed.
      candidates = index.lines.filter(line => line.attribution.kind !== 'step');
    }
    const lines = contextAndTail(index, candidates, input.excerpt);
    if (lines.some(line => line.attribution.kind === 'unattributed')) ambiguous.push(`${job.ref.jobId}:unattributed_lines`);
    if (lines.some(line => line.attribution.kind === 'ambiguous')) ambiguous.push(`${job.ref.jobId}:ambiguous_step_windows`);
    for (const issue of index.issues) ambiguous.push(`${job.ref.jobId}:${issue}`);
    selectedLogs.push({ index, lines: lines.map(line => ({ line, slot: slot(line.plainText) })) });
  }
  const allText = chunks.join('');
  const readSlot = (value: TextSlot, included: number) => value.text.slice(0, Math.max(0, included - value.offset));
  const project = (prefix: string, truncated: boolean, truncationReason: string): ForgeCiFailureSummaryV1 => {
    const included = prefix.length;
    const excerptValues: ForgeCiFailureExcerptV1[] = [];
    const omittedEvidence = [...omitted];
    if (truncated) omittedEvidence.push(truncationReason);
    for (const { index, lines } of selectedLogs) {
      let previous: ForgeCiLogLineV1 | undefined;
      let count = 0;
      let omittedFirst: number | undefined;
      let omittedLast: number | undefined;
      for (const { line, slot: value } of lines) {
        if (value.offset >= included && value.text.length > 0) {
          count += 1;
          omittedFirst ??= line.number;
          omittedLast = line.number;
          continue;
        }
        const text = readSlot(value, included);
        const last = excerptValues.at(-1);
        if (previous && last && forgeCiJobKeyV1(last.job) === forgeCiJobKeyV1(index.job) && line.number === previous.number + 1
          && line.startByte >= previous.endByte && line.startByte - previous.endByte <= 2) {
          excerptValues[excerptValues.length - 1] = { ...last, endLine: line.number, endByte: line.endByte, text: last.text + '\n' + text };
        } else excerptValues.push({ job: index.job, startLine: line.number, endLine: line.number, startByte: line.startByte, endByte: line.endByte, text });
        if (text.length < value.text.length) omittedEvidence.push(`${index.job.jobId}:partial_line:${line.number}`);
        previous = line;
      }
      if (count > 0) omittedEvidence.push(`${index.job.jobId}:omitted_log_lines:${count}:first:${omittedFirst}:last:${omittedLast}`);
    }
    return {
      repository: input.run.ref.repository, selection: input.selection,
      ...(input.run.headSha === undefined ? {} : { headSha: input.run.headSha }),
      ...(input.run.workflow?.path === undefined ? {} : { workflowPath: input.run.workflow.path }),
      ...(input.run.webUrl === undefined ? {} : { webUrl: input.run.webUrl }),
      jobs: admittedJobs.map(({ job, name, steps }) => ({ job: job.ref, name: readSlot(name, included), state: job.state,
        steps: steps.map(({ step, name }) => ({ stepId: step.id, name: readSlot(name, included), state: step.state })) })),
      annotations: annotations.map(({ annotation, message, title, details, path }) => ({ ...annotation, message: readSlot(message, included),
        ...(title === undefined ? {} : { title: readSlot(title, included) }),
        ...(details === undefined ? {} : { details: readSlot(details, included) }),
        ...(path === undefined ? {} : { path: readSlot(path, included) }) })),
      excerpts: excerptValues, missing, ambiguous, omitted: omittedEvidence, continuation,
    };
  };
  const encoder = new TextEncoder();
  const measureSummary = (value: ForgeCiFailureSummaryV1) => encoder.encode(JSON.stringify(value)).byteLength;
  // The canonical carrier nests the result as JSON, not an escaped JSON string.
  // Measure its exact additive framing from this projection; no guessed reserve
  // or copied allowance competes with either caller or transport ownership.
  const base = project('', true, 'evidence_truncated_to_action_carrier');
  const framingBytes = measureExternalActionResultResponseEnvelopeUtf8BytesV1({ kind: 'value', value: base }) - measureSummary(base);
  const carrierSummaryBytes = EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - framingBytes;
  const maxSerializedBytes = Math.min(input.maxSerializedBytes, carrierSummaryBytes);
  const truncationReason = input.maxSerializedBytes <= carrierSummaryBytes
    ? 'evidence_truncated_to_caller_budget' : 'evidence_truncated_to_action_carrier';
  if (maxSerializedBytes <= 0) return unavailable('insufficient_summary_budget');
  try {
    const value = fitActionResultTextV1(allText, (prefix, truncated) => project(prefix, truncated, truncationReason),
      { maxSerializedBytes, measureSerializedBytes: measureSummary });
    return { kind: 'value', value };
  } catch (error) {
    if (error instanceof RangeError && error.message === 'action_result_base_exceeds_serialized_boundary') return unavailable('insufficient_summary_budget');
    throw error;
  }
}
