import { z } from 'zod';
import type { ScmDiffSummaryModelOutput } from '@happier-dev/protocol';

/** Private admission evidence, never accepted from an execution.run.start caller. */
export const reviewFindingCitationsSchema = z.array(z.object({
  alias: z.string().regex(/^F[1-9]\d*$/), runId: z.string().min(1), findingId: z.string().min(1),
}).strict());
export type ReviewFindingCitations = z.infer<typeof reviewFindingCitationsSchema>;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

/** Both retained single-review payloads and multi-review host context use this owner. */
export function collectReviewFindingCitations(narration: unknown, findingsContext?: string): ReviewFindingCitations {
  const input = record(narration);
  const runs = record(input.provenance).reviewedRuns;
  const payloads = Array.isArray(input.reviewFindings) ? input.reviewFindings : [];
  let reviews: unknown[] = [];
  try { const parsed = record(JSON.parse(findingsContext ?? '{}')); if (Array.isArray(parsed.reviews)) reviews = parsed.reviews; } catch { /* Human instructions carry no findings authority. */ }
  const sources = reviews.length ? reviews.map(value => ({ run: record(record(value).runRef), findings: record(value).findings }))
    : payloads.map(value => ({ run: record(record(value).runRef), findings: record(value).findings }));
  const citations: ReviewFindingCitations = [];
  for (const source of sources) {
    if (typeof source.run.runId !== 'string' || !Array.isArray(source.findings) || !Array.isArray(runs)
      || !runs.some(value => { const run = record(value); return run.runId === source.run.runId
        && run.callId === source.run.callId && run.backendId === source.run.backendId; })) continue;
    for (const value of source.findings) {
      const finding = record(value);
      if (typeof finding.id !== 'string' || !finding.id || citations.some(item => item.runId === source.run.runId && item.findingId === finding.id)) continue;
      citations.push({ alias: `F${citations.length + 1}`, runId: source.run.runId, findingId: finding.id });
    }
  }
  return citations;
}

export const findingCitationInstructions = 'Finding citations: use only the supplied F aliases in findingRefs and Markdown links [text](finding:F3). A link must be listed in that stop\'s findingRefs. Never write real finding IDs or run-qualified finding URLs.';

function encodeFindingDestination(identity: string): string | undefined {
  try { return encodeURI(identity).replace(/\(/g, '%28').replace(/\)/g, '%29'); }
  catch { return undefined; } // A lone surrogate is not a serializable URI; keep its label.
}

function decodeFindingDestination(destination: string): string | undefined {
  try { return decodeURI(destination); }
  catch { return undefined; }
}

function rewriteLinks(markdown: string, resolve: (reference: string) => string | undefined) {
  // Only explicit finding links are in this contract. Match balanced labels/destinations,
  // including Markdown's angle destination and optional title, without parsing other prose.
  function closing(start: number, open: string, close: string) {
    let depth = 1;
    for (let index = start + 1; index < markdown.length; index++) {
      if (markdown[index] === '\\') { index++; continue; }
      if (markdown[index] === open) depth++;
      else if (markdown[index] === close && --depth === 0) return index;
    }
    return -1;
  }
  let output = '';
  for (let index = 0; index < markdown.length; index++) {
    if (markdown[index] !== '[' || markdown[index - 1] === '\\' || markdown[index - 1] === '!') { output += markdown[index]; continue; }
    const labelEnd = closing(index, '[', ']');
    const end = labelEnd >= 0 && markdown[labelEnd + 1] === '(' ? closing(labelEnd + 1, '(', ')') : -1;
    const destination = end >= 0 ? markdown.slice(labelEnd + 2, end).trimStart() : '';
    const reference = /^<?finding:([^\s>]+)>?(?:\s|$)/.exec(destination)?.[1];
    if (!reference) { output += markdown[index]; continue; }
    const label = rewriteLinks(markdown.slice(index + 1, labelEnd), resolve);
    const target = resolve(reference);
    output += target ? `[${label}](finding:${target})` : label;
    index = end;
  }
  return output;
}

export function publishFindingCitationMarkdown(markdown: string, aliases: readonly string[], citations: ReviewFindingCitations): string {
  return rewriteLinks(markdown, reference => {
    const citation = aliases.includes(reference) ? citations.find(item => item.alias === reference) : undefined;
    return citation ? encodeFindingDestination(`${citation.runId}:${citation.findingId}`) : undefined;
  });
}

export function publishReviewFindingCitations(model: ScmDiffSummaryModelOutput, citations: ReviewFindingCitations): ScmDiffSummaryModelOutput {
  if (!model.walkthrough) return model;
  return { ...model, walkthrough: { ...model.walkthrough, stops: model.walkthrough.stops.map(stop => {
    const aliases = stop.findingRefs ?? [];
    const findingRefs = citations.filter(item => aliases.includes(item.alias)).map(item => `${item.runId}:${item.findingId}`);
    return { ...stop, ...(stop.findingRefs ? { findingRefs } : {}),
      explanationMarkdown: publishFindingCitationMarkdown(stop.explanationMarkdown, aliases, citations) };
  }) } };
}

/** Carryforward may keep a canonical link only when current host evidence still owns it. */
export function validatePublishedFindingCitationMarkdown(markdown: string, refs: readonly string[], citations: ReviewFindingCitations): string {
  return rewriteLinks(markdown, reference => {
    const identity = decodeFindingDestination(reference);
    return identity !== undefined && refs.includes(identity)
      && citations.some(item => `${item.runId}:${item.findingId}` === identity) ? encodeFindingDestination(identity) : undefined;
  });
}

/** Present existing saved/context identities as aliases without manufacturing membership. */
export function presentReviewFindingCitations(value: unknown, citations: ReviewFindingCitations): unknown {
  if (typeof value === 'string') return rewriteLinks(value, reference => {
    const identity = decodeFindingDestination(reference);
    return identity !== undefined ? citations.find(item => `${item.runId}:${item.findingId}` === identity)?.alias : undefined;
  });
  if (Array.isArray(value)) return value.map(item => presentReviewFindingCitations(item, citations));
  if (!value || typeof value !== 'object') return value;
  const input = record(value);
  return Object.fromEntries(Object.entries(input).map(([key, entry]) => {
    if (key === 'findingRefs' && Array.isArray(entry)) return [key, entry.flatMap(ref => {
      const identity = typeof ref === 'string' ? ref : `${record(ref).runId}:${record(ref).findingId}`;
      const citation = citations.find(item => `${item.runId}:${item.findingId}` === identity);
      return citation ? [citation.alias] : [];
    })];
    if (key === 'findings' && Array.isArray(entry)) {
      const runId = record(input.runRef).runId;
      return [key, entry.map(finding => {
        const row = record(finding);
        const matches = citations.filter(item => item.findingId === row.id && (runId === undefined || item.runId === runId));
        return presentReviewFindingCitations({ ...row, id: matches.length === 1 ? matches[0]!.alias : undefined }, citations);
      })];
    }
    // Proposed-comment and anchor indexes contain real finding IDs, not narrator evidence.
    if (key === 'proposedComments' || key === 'anchorsByFindingId') return [key, undefined];
    return [key, presentReviewFindingCitations(entry, citations)];
  }));
}
