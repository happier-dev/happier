/**
 * What every GitLab write declaration must say to be reachable from its mounted
 * human control while remaining unreachable to direct plugin or backend code.
 *
 * The mounted contributed-Action dispatcher host-stamps `executionSurface: 'ui'`.
 * `plugin` is reserved for direct plugin/backend execution, so adding it here
 * would widen these human mutations beyond the detail-panel interaction that
 * owns them. Exact equality keeps every autonomous surface out of the contract.
 */

import { describe, expect, it } from 'vitest';

import {
  GITLAB_TRIAGE_MUTATION_ACTION_DECLARATIONS,
  GITLAB_TRIAGE_MUTATION_ACTION_IDS,
} from './contribution.js';

/**
 * Every enabled write, read from the id map rather than listed here.
 *
 * A hand-written list is exactly how three of these writes came to be declared with
 * no surface gate at all: `merge-request/reopen`, `issue/close` and `issue/reopen`
 * landed, the list did not grow, and the per-write `agent`/`mcp`/`cli` cases silently
 * stopped covering them. Deriving the set means a write cannot be added without
 * acquiring the gate.
 */
const WRITE_IDS = Object.values(GITLAB_TRIAGE_MUTATION_ACTION_IDS);

const APPROVED_WRITE_IDS = Object.freeze([
  'gitlab/merge-request/merge',
  'gitlab/merge-request/mark-ready',
  'gitlab/merge-request/close',
  'gitlab/merge-request/reopen',
  'gitlab/merge-request/reviewer-change',
  'gitlab/merge-request/discussion-resolution',
  'gitlab/issue/close',
  'gitlab/issue/reopen',
  'gitlab/issue/assign',
  'gitlab/issue/label',
  'gitlab/merge-request/submit-review',
  'gitlab/merge-request/review-comment-create',
  'gitlab/merge-request/thread-reply',
  'gitlab/issue/comment',
] as const);

function declarationOf(id: string) {
  const declaration = GITLAB_TRIAGE_MUTATION_ACTION_DECLARATIONS.find(
    (candidate) => candidate.id === id,
  );
  if (declaration === undefined) throw new Error(`missing declaration: ${id}`);
  return declaration;
}

describe('GitLab merge-request write declarations', () => {
  it('mounts every mutation the approved GitLab V1 source contract enables', () => {
    expect([...WRITE_IDS].sort()).toEqual([...APPROVED_WRITE_IDS].sort());
  });

  it('declares exactly the enabled write ids, once each', () => {
    // Two independent constants: the id map names what is enabled, the declaration
    // array is what the manifest actually publishes. A write that exists in one and
    // not the other is the defect this compares for, and neither side can be
    // "fixed" by editing this file.
    const declared = GITLAB_TRIAGE_MUTATION_ACTION_DECLARATIONS.map((entry) => entry.id);
    expect([...declared].sort()).toEqual([...WRITE_IDS].sort());
    expect(new Set(declared).size).toBe(declared.length);
  });

  it.each(WRITE_IDS)('%s is reachable only from a mounted human surface', (id) => {
    expect(declarationOf(id).surfaces).toEqual(['ui']);
  });

  it.each(WRITE_IDS)('%s carries a confirmation and a non-safe danger level', (id) => {
    const declaration = declarationOf(id);
    // The confirmation is host-owned manifest metadata raised before the handler
    // runs; the panel must never render a second "are you sure" of its own.
    expect(declaration.confirmation.title.fallback).not.toBe('');
    expect(declaration.confirmation.body.fallback).not.toBe('');
    expect(declaration.dangerLevel).not.toBe('safe');
  });

  it('advertises only the review verdicts GitLab can publish without collateral writes', () => {
    const inputSchema = JSON.stringify(
      declarationOf(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestSubmitReview).inputSchema,
    );

    expect(inputSchema).toContain('"approve"');
    expect(inputSchema).toContain('"comment"');
    expect(inputSchema).not.toContain('"requestChanges"');
  });
});
