import { tokenizeAnsiText, type AnsiTextToken, type AnsiTokenizerState } from '@happier-dev/plugin-ui/ansi';
import type { ForgeCiJobRefV1, ForgeCiLogV1, ForgeCiStepV1 } from '@happier-dev/triage-protocol/ci/v1';
import { forgeCiJobKeyV1 } from '../identity.js';
import { buildForgeCiLogGroupsV1, type ForgeCiLogGroupV1 } from './groups.js';
import { readForgeCiLogAttributionV1, segmentForgeCiLogTimestampsV1, type ForgeCiLogAttributionV1, type ForgeCiLogStepWindowV1 } from './segmentation.js';

type AvailableLog = Extract<ForgeCiLogV1, {kind:'available'}>;
type DecodedLine = Readonly<{
  id: string; number: number; startByte: number; endByte: number; rawText: string; plainText: string;
  originalText: string; originalStartByte: number; lineEnding: '' | '\n' | '\r\n';
  timestamp: string | null; timestampMs: number | null; tokens: readonly AnsiTextToken[];
  ansiStart: AnsiTokenizerState; ansiEnd: AnsiTokenizerState;
}>;
export type ForgeCiLogLineV1 = DecodedLine & Readonly<{
  plainOffset: number; groupIds: readonly string[]; attribution: ForgeCiLogAttributionV1;
}>;
/** One admitted observation. A page basis never asserts native original offsets or whole-source coverage. */
export type LogContentV1 = Readonly<{
  logId: string; startLine: number; startByte: number; complete: boolean; continuation: unknown | null;
}> & (Readonly<{ text: string }> | Readonly<{ fragments: readonly Readonly<{ text: string; startLine: number; startByte: number }>[] }>);
export type LogIndexV1<Content extends LogContentV1 = LogContentV1> = Readonly<{
  sourceKey: string; positionBasis: 'source' | 'page';
  logId: string; log: Content; steps: readonly ForgeCiLogStepWindowV1[];
  plainText: string;
  lines: readonly ForgeCiLogLineV1[]; groups: readonly ForgeCiLogGroupV1[]; issues: readonly string[];
  complete: boolean; continuation: Content['continuation'];
  /** Original byte zero/line one through the admitted end, with no missing ranges. EOF is separate. */
  hasCompletePrefix: boolean;
  /** Work performed by the observation that created this index, for the shared profiler. */
  work: Readonly<{ decodedLines: number; tokenizedLines: number; indexedLines: number }>;
}>;
export type ForgeCiLogIndexV1 = LogIndexV1<AvailableLog> & Readonly<{ job: ForgeCiJobRefV1 }>;

/** Preserve the BOM until indexing so original byte offsets include its three UTF-8 bytes. */
export function decodeForgeCiLogBytesV1(chunks: Iterable<Uint8Array>): string {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const text: string[] = [];
  for (const chunk of chunks) text.push(decoder.decode(chunk, { stream: true }));
  text.push(decoder.decode());
  return text.join('');
}

export function sameForgeCiLogJobV1(left: ForgeCiJobRefV1, right: ForgeCiJobRefV1): boolean {
  return forgeCiJobKeyV1(left) === forgeCiJobKeyV1(right);
}

export function sameForgeCiLogContentV1(left: LogContentV1, right: LogContentV1): boolean {
  if (left === right) return true;
  if (left.startLine !== right.startLine || left.startByte !== right.startByte) return false;
  if ('text' in left || 'text' in right) return 'text' in left && 'text' in right && left.text === right.text;
  return left.fragments.length === right.fragments.length && left.fragments.every((fragment, i) => {
    const other = right.fragments[i]!;
    return fragment.text === other.text && fragment.startLine === other.startLine && fragment.startByte === other.startByte;
  });
}

function sameWindows(left: readonly ForgeCiLogStepWindowV1[], right: readonly ForgeCiLogStepWindowV1[]): boolean {
  return left.length === right.length && left.every((step, i) => step.id === right[i]!.id
    && step.startedAtMs === right[i]!.startedAtMs && step.completedAtMs === right[i]!.completedAtMs
    && step.timestampPrecision === right[i]!.timestampPrecision);
}
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, i) => value === right[i]);
}
function sameAnsi(left: AnsiTokenizerState, right: AnsiTokenizerState): boolean {
  return left.pending === right.pending && left.style.bold === right.style.bold && left.style.dim === right.style.dim
    && left.style.italic === right.style.italic && left.style.underline === right.style.underline && left.style.inverse === right.style.inverse
    && left.style.strikethrough === right.style.strikethrough && left.style.foreground === right.style.foreground && left.style.background === right.style.background;
}
const EMPTY_ANSI: AnsiTokenizerState = { style: {}, pending: '', offset: 0 };
const encoder = new TextEncoder();
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))[ \t]/u;
type LogFragment = Readonly<{ text: string; startLine: number; startByte: number }>;
// Parser continuation belongs to this in-process index, never to a consumer or a persisted carrier.
const groupScans = new WeakMap<readonly ForgeCiLogLineV1[], Pick<ReturnType<typeof buildForgeCiLogGroupsV1>, 'state' | 'beforeLast'>>();

function appendedFragments(log: LogContentV1, baseline: LogIndexV1): readonly LogFragment[] | null {
  if (log.startLine !== baseline.log.startLine || log.startByte !== baseline.log.startByte) return null;
  const last = baseline.lines.at(-1);
  const end = { startLine: last ? last.number + (last.lineEnding === '' ? 0 : 1) : log.startLine,
    startByte: last ? last.originalStartByte + encoder.encode(last.originalText).length : log.startByte };
  if ('text' in log) {
    if (!('text' in baseline.log) || !log.text.startsWith(baseline.log.text)) return null;
    return [{ ...end, text: log.text.slice(baseline.log.text.length) }];
  }
  const previousFragments = 'text' in baseline.log
    ? [{ text: baseline.log.text, startLine: baseline.log.startLine, startByte: baseline.log.startByte }]
    : baseline.log.fragments;
  if (log.fragments.length < previousFragments.length) return null;
  let extension: LogFragment | undefined;
  for (let i = 0; i < previousFragments.length; i += 1) {
    const old = previousFragments[i]!;
    const next = log.fragments[i]!;
    if (old.startLine !== next.startLine || old.startByte !== next.startByte) return null;
    if (old.text === next.text) continue;
    if (i !== previousFragments.length - 1 || !next.text.startsWith(old.text) || !last) return null;
    extension = { ...end, text: next.text.slice(old.text.length) };
  }
  const added = log.fragments.slice(previousFragments.length);
  return extension ? [extension, ...added] : added;
}

export function buildForgeCiLogIndexV1(input: Readonly<{log:AvailableLog;steps?:readonly (ForgeCiStepV1 | ForgeCiLogStepWindowV1)[];baseline?:ForgeCiLogIndexV1}>): ForgeCiLogIndexV1 {
  const next = buildLogIndexV1({ ...input, sourceKey: forgeCiJobKeyV1(input.log.job), positionBasis: 'source' });
  if (input.baseline && next === input.baseline) return input.baseline;
  return { ...next, job: input.log.job };
}

/** The single byte/ANSI/group indexer for CI originals and finite native pages. No cursor admission or retention. */
export function buildLogIndexV1<Content extends LogContentV1>(input: Readonly<{
  sourceKey: string; positionBasis: 'source' | 'page'; log: Content;
  steps?: readonly ForgeCiLogStepWindowV1[]; baseline?: LogIndexV1<Content>;
}>): LogIndexV1<Content> {
  const { log } = input;
  const inputSteps = input.steps ?? [];
  const baseline = input.baseline && input.baseline.logId === log.logId && input.baseline.sourceKey === input.sourceKey
    && input.baseline.positionBasis === input.positionBasis ? input.baseline : undefined;
  const unchangedContent = baseline !== undefined && sameForgeCiLogContentV1(baseline.log, log);
  const unchangedWindows = baseline !== undefined && sameWindows(baseline.steps, inputSteps);
  if (unchangedContent && unchangedWindows) {
    if (baseline.log.complete === log.complete && baseline.continuation === log.continuation) return baseline;
    return { ...baseline, log, complete: log.complete && baseline.hasCompletePrefix, continuation: log.continuation,
      work: { decodedLines: 0, tokenizedLines: 0, indexedLines: 0 } };
  }
  const steps = unchangedWindows ? baseline.steps : inputSteps.map(step => ({ id: step.id,
    ...(step.startedAtMs === undefined ? {} : { startedAtMs: step.startedAtMs }),
    ...(step.completedAtMs === undefined ? {} : { completedAtMs: step.completedAtMs }),
    ...(step.timestampPrecision === undefined ? {} : { timestampPrecision: step.timestampPrecision }) }));
  const priorScan = baseline && groupScans.get(baseline.lines);
  const appended = baseline && unchangedWindows && !unchangedContent && priorScan ? appendedFragments(log, baseline) : null;
  const last = baseline?.lines.at(-1);
  const firstAppend = appended?.[0];
  const replacesTail = appended !== null && last?.lineEnding === '' && firstAppend !== undefined
    && firstAppend.startByte === last.originalStartByte + encoder.encode(last.originalText).length && firstAppend.startLine === last.number;
  const retainedCount = appended !== null ? baseline!.lines.length - (replacesTail ? 1 : 0) : 0;
  const previousLines = appended === null ? new Map(baseline?.lines.map(line => [line.id, line])) : null;
  const previousNativeLines = appended === null ? new Map(baseline?.lines.map(line => [line.number, line])) : null;
  const previousLine = (id: string, number?: number) => appended !== null
    ? last && (last.id === id || last.number === number) ? last : undefined
    : previousLines!.get(id) ?? (number === undefined ? undefined : previousNativeLines!.get(number));
  const decoded: DecodedLine[] = [];
  let decodedLines = 0;
  let hasCompletePrefix = baseline?.hasCompletePrefix ?? false;
  if (unchangedContent) for (const line of baseline.lines) decoded.push(line);
  else {
    const fragments = appended === null ? 'text' in log ? [{ text: log.text, startLine: log.startLine, startByte: log.startByte }] : log.fragments
      : replacesTail ? [{ text: last!.originalText + firstAppend!.text, startLine: last!.number, startByte: last!.originalStartByte }, ...appended.slice(1)] : appended;
    const retainedLast = retainedCount > 0 ? baseline!.lines[retainedCount - 1] : undefined;
    let expectedByte = retainedLast ? retainedLast.originalStartByte + encoder.encode(retainedLast.originalText).length : appended !== null ? baseline!.log.startByte : 0;
    let expectedLine = retainedLast ? retainedLast.number + (retainedLast.lineEnding === '' ? 0 : 1) : appended !== null ? baseline!.log.startLine : 1;
    hasCompletePrefix = appended !== null ? baseline!.hasCompletePrefix : input.positionBasis === 'source';
    // Contiguous fragments of a carrier-split single line are one original line, not extra log lines.
    const ranges: Array<{ text: string; startLine: number; startByte: number; endByte: number }> = [];
    for (const fragment of fragments) {
      const previous = ranges.at(-1);
      const endByte = fragment.startByte + encoder.encode(fragment.text).length;
      if (fragment.startByte !== expectedByte || fragment.startLine !== expectedLine) hasCompletePrefix = false;
      expectedByte = endByte;
      expectedLine = fragment.startLine;
      for (const character of fragment.text) if (character === '\n') expectedLine += 1;
      if (previous && previous.endByte === fragment.startByte && !previous.text.endsWith('\n')) {
        previous.text += fragment.text;
        previous.endByte = endByte;
      } else ranges.push({ ...fragment, endByte });
    }
    let ansi = retainedLast?.ansiEnd ?? EMPTY_ANSI;
    let previousEndByte = retainedLast ? retainedLast.originalStartByte + encoder.encode(retainedLast.originalText).length : undefined;
    for (const range of ranges) {
      if (range.startByte !== previousEndByte) ansi = EMPTY_ANSI;
      let offset = range.startByte;
      let lineNumber = range.startLine;
      const rawLines = range.text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
      for (const original of rawLines) {
        const terminated = original.endsWith('\n');
        const lineEnding = terminated ? original.endsWith('\r\n') ? '\r\n' : '\n' : '';
        let rawText = terminated ? original.slice(0, -1).replace(/\r$/u, '') : original;
        let startByte = offset;
        if (offset === 0 && rawText.startsWith('\ufeff')) { rawText = rawText.slice(1); startByte += 3; }
        const id = `${input.sourceKey}:${encodeURIComponent(log.logId)}:${lineNumber}:${startByte}`;
        const old = previousLine(id, lineNumber);
        if (old && old.rawText === rawText && sameAnsi(old.ansiStart, ansi)) {
          decoded.push(old.id === id && old.originalText === original && old.originalStartByte === offset ? old
            : { ...old, id, startByte, endByte: startByte + encoder.encode(rawText).length,
              originalText: original, originalStartByte: offset, lineEnding });
          ansi = old.ansiEnd;
        } else {
          const match = TIMESTAMP.exec(rawText);
          const parsed = match ? Date.parse(match[1]!) : NaN;
          const timestamp = Number.isFinite(parsed) ? match![1]! : null;
          const body = timestamp !== null ? rawText.slice(match![0].length) : rawText;
          const tokenized = tokenizeAnsiText(body, { ...ansi, offset: 0 });
          const end = { ...tokenized.state, offset: 0 };
          decoded.push({ id, number: lineNumber, startByte, endByte: startByte + encoder.encode(rawText).length, rawText,
            originalText: original, originalStartByte: offset, lineEnding,
            plainText: tokenized.plainText, timestamp, timestampMs: timestamp === null ? null : parsed,
            tokens: tokenized.tokens, ansiStart: ansi, ansiEnd: end });
          ansi = end;
          decodedLines += 1;
        }
        offset += encoder.encode(original).length;
        lineNumber += 1;
      }
      previousEndByte = offset;
    }
  }
  const grouped = unchangedContent || appended !== null && decoded.length === 0 ? null : buildForgeCiLogGroupsV1(decoded, baseline?.groups,
    appended !== null ? replacesTail ? priorScan!.beforeLast : priorScan!.state : undefined);
  const attributions = segmentForgeCiLogTimestampsV1(decoded.map(line => line.timestampMs), steps);
  const prefixText = appended === null || retainedCount === 0 ? '' : replacesTail
    ? baseline!.plainText.slice(0, last!.plainOffset - 1) : baseline!.plainText;
  let plainOffset = appended !== null && retainedCount > 0 ? prefixText.length + 1 : 0;
  const lines = decoded.map(line => {
    const old = previousLine(line.id);
    const groups = grouped?.lineGroups.get(line.id) ?? old?.groupIds ?? [];
    const groupIds = old && sameStrings(old.groupIds, groups) ? old.groupIds : groups;
    const nextAttribution = readForgeCiLogAttributionV1(line.timestampMs, attributions);
    const attribution = old && old.attribution.kind === nextAttribution.kind && sameStrings(old.attribution.stepIds, nextAttribution.stepIds) ? old.attribution : nextAttribution;
    const value = old && old.tokens === line.tokens && old.originalText === line.originalText && old.originalStartByte === line.originalStartByte
      && old.plainOffset === plainOffset && old.groupIds === groupIds && old.attribution === attribution
      ? old : { ...line, plainOffset, groupIds, attribution };
    plainOffset += line.plainText.length + 1;
    return value;
  });
  const combined = appended !== null ? [...baseline!.lines.slice(0, retainedCount), ...lines] : lines;
  const retainedLines = appended === null && baseline && combined.length === baseline.lines.length && combined.every((line, i) => line === baseline.lines[i]) ? baseline.lines : combined;
  if (grouped) groupScans.set(retainedLines, { state: grouped.state, beforeLast: grouped.beforeLast });
  else if (priorScan) groupScans.set(retainedLines, priorScan);
  return { sourceKey: input.sourceKey, positionBasis: input.positionBasis, logId: log.logId, log, steps,
    plainText: retainedLines === baseline?.lines ? baseline.plainText : appended !== null
      ? prefixText + (retainedCount > 0 && lines.length > 0 ? '\n' : '') + lines.map(line => line.plainText).join('\n')
      : retainedLines.map(line => line.plainText).join('\n'),
    lines: retainedLines, groups: grouped?.groups ?? baseline?.groups ?? [],
    issues: grouped?.issues ?? baseline?.issues ?? [], complete: log.complete && hasCompletePrefix, continuation: log.continuation, hasCompletePrefix,
    work: { decodedLines, tokenizedLines: decodedLines, indexedLines: decoded.length } };
}
