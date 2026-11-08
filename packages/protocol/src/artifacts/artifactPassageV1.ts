import { PromptDocArtifactRefV1Schema, type PromptDocArtifactRefV1 } from '../prompts/library/promptArtifactRefsV1.js';
import { DocEditProposalV1Schema, DocPassageRefV1Schema, type DocPassageRefV1 } from './artifactCollaborationV1.js';
import type { ArtifactRevisionV1 } from './artifactRevisionV1.js';
import type { DiscussionOpenedMessageV1 } from '../discussions/actions.js';

type DocSourceV1 = Readonly<{ ref: PromptDocArtifactRefV1; revision: ArtifactRevisionV1; source: string }>;
type PassageRangeV1 = DocPassageRefV1['range'];

/** Reattachment is a later passage comment; suggestions retain their own immutable review basis. */
export function selectDocPassageThreadAnchorMessageV1<M extends Pick<DiscussionOpenedMessageV1,
  'seq' | 'content' | 'replyTarget'>>(messages: readonly M[]): M | null {
  let anchor: M | null = null;
  for (const message of messages) {
    if (message.replyTarget?.kind !== 'doc_passage') continue;
    const content = message.content;
    if (content !== null && (!('kind' in content)
      || (content.kind !== 'doc_passage_comment' && !(message.seq === 1 && content.kind === 'doc_edit_proposal')))) continue;
    if (!anchor || message.seq > anchor.seq) anchor = message;
  }
  return anchor;
}

function refuse(code: string): never { throw Object.assign(new Error(code), { code }); }

function contextMatches(source: string, target: DocPassageRefV1, start: number): boolean {
  const end = start + target.quote.length;
  return (target.prefix === undefined || start >= target.prefix.length
    && source.slice(start - target.prefix.length, start) === target.prefix)
    && (target.suffix === undefined || source.slice(end, end + target.suffix.length) === target.suffix);
}

/** Called only with source already opened under current Artifact access and Account mode. */
export function captureDocPassageV1(input: DocSourceV1 & Readonly<{ range: PassageRangeV1 }>): DocPassageRefV1 {
  if (!input.ref.serverId) refuse('server_target_required');
  return DocPassageRefV1Schema.parse({ ref: input.ref, revision: input.revision,
    range: input.range, quote: input.source.slice(input.range.start, input.range.end) });
}

export type DocPassageLocationV1 = Readonly<{ state: 'exact' | 'relocated'; range: PassageRangeV1 }>
  | Readonly<{ state: 'detached' }>;

export type DocPassageThreadLocationV1 = DocPassageLocationV1
  | Readonly<{ state: 'revised'; range: PassageRangeV1 }>;

/** One placement basis for the margin and subsequent proposals in an existing thread. */
export function locateDocPassageThreadV1<M extends Pick<DiscussionOpenedMessageV1,
  'seq' | 'content' | 'docEditProposalDispositionV1'>>(input: Readonly<{
    target: DocPassageRefV1; source: string; revision: ArtifactRevisionV1; messages: readonly M[];
  }>): Readonly<{ location: DocPassageThreadLocationV1; quote: string; acceptedProposal: M | null }> {
  let acceptedProposal: M | null = null;
  for (const message of input.messages) {
    const disposition = message.docEditProposalDispositionV1;
    if (message.content && 'kind' in message.content && message.content.kind === 'doc_edit_proposal'
      && disposition?.state === 'accepted'
      && disposition.acceptedRevision.headerVersion === input.revision.headerVersion
      && disposition.acceptedRevision.bodyVersion === input.revision.bodyVersion
      && (!acceptedProposal || message.seq > acceptedProposal.seq)) acceptedProposal = message;
  }
  const content = acceptedProposal?.content;
  if (content && 'kind' in content && content.kind === 'doc_edit_proposal') {
    const { target, after } = content.proposal;
    const start = target.range.start;
    if (after.length > 0 && input.source.slice(start, start + after.length) === after) {
      return { location: { state: 'revised', range: { start, end: start + after.length } },
        quote: after, acceptedProposal };
    }
  }
  return { location: locateDocPassageV1(input), quote: input.target.quote, acceptedProposal };
}

/** Relocation is display-only and never changes the immutable acceptance basis. */
export function locateDocPassageV1(input: Readonly<{ target: DocPassageRefV1; source: string; revision: ArtifactRevisionV1 }>): DocPassageLocationV1 {
  const target = DocPassageRefV1Schema.parse(input.target);
  if (target.revision.headerVersion === input.revision.headerVersion && target.revision.bodyVersion === input.revision.bodyVersion) {
    return input.source.slice(target.range.start, target.range.end) === target.quote && contextMatches(input.source, target, target.range.start)
      ? { state: 'exact', range: target.range } : { state: 'detached' };
  }
  let found: PassageRangeV1 | null = null;
  for (let start = input.source.indexOf(target.quote); start !== -1; start = input.source.indexOf(target.quote, start + 1)) {
    if (!contextMatches(input.source, target, start)) continue;
    if (found) return { state: 'detached' };
    found = { start, end: start + target.quote.length };
  }
  return found ? { state: 'relocated', range: found } : { state: 'detached' };
}

/** The key-holding client prepares text; the server's Artifact writer still owns CAS and persistence. */
export function prepareDocEditBodyV1(input: DocSourceV1 & Readonly<{ proposal: unknown }>): string {
  const proposal = DocEditProposalV1Schema.parse(input.proposal);
  const ref = PromptDocArtifactRefV1Schema.parse(input.ref);
  if (!ref.serverId || !proposal.target.ref.serverId || proposal.target.ref.serverId !== ref.serverId) refuse('server_target_mismatch');
  if (proposal.target.ref.artifactId !== ref.artifactId) refuse('doc_target_mismatch');
  if (proposal.baseRevision.headerVersion !== input.revision.headerVersion
    || proposal.baseRevision.bodyVersion !== input.revision.bodyVersion) refuse('version_mismatch');
  const { start, end } = proposal.target.range;
  if (input.source.slice(start, end) !== proposal.before || !contextMatches(input.source, proposal.target, start)) refuse('doc_passage_mismatch');
  return input.source.slice(0, start) + proposal.after + input.source.slice(end);
}
