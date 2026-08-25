/**
 * What every GitLab write declaration must say to be BOTH reachable by the only
 * thing that renders them and unreachable by an agent.
 *
 * These two properties pull in opposite directions and are checked together on
 * purpose. A write declared `['ui']` alone reads like the safer choice and is in
 * fact the broken one: the controls live in this source's own mounted detail
 * artifact, a mounted plugin surface dispatches as a `plugin` caller, and
 * `evaluateTargetActionPolicy` refuses an Action whose declared surfaces omit the
 * calling surface with `plugin_action_surface_unavailable` before the handler
 * runs. So `['ui']` yields a write nobody can perform, while `['ui','plugin']`
 * yields one only a person at the panel can.
 *
 * The omissions carry the actual human gate, so they are asserted as their own
 * cases rather than folded into one `toEqual`: an `agent` or `mcp` surface added
 * later would make these writes agent-reachable, and a single equality assertion
 * that also covered ordering and arity would be just as likely to be "fixed" by
 * updating the expected array.
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

  it.each(WRITE_IDS)('%s is reachable from the mounted plugin surface that renders it', (id) => {
    // Without this the control dispatches and the host refuses it outright, which
    // is indistinguishable to a user from the control not existing.
    expect(declarationOf(id).surfaces).toContain('plugin');
  });

  it.each(WRITE_IDS)('%s is declared a human surface', (id) => {
    expect(declarationOf(id).surfaces).toContain('ui');
  });

  it.each(WRITE_IDS)('%s is not reachable by an agent', (id) => {
    // The gate is reachability, not a prompt. A danger level plus `agent` would
    // only floor an agent invocation to an approval, which is strictly weaker.
    expect(declarationOf(id).surfaces).not.toContain('agent');
  });

  it.each(WRITE_IDS)('%s is not reachable over MCP', (id) => {
    expect(declarationOf(id).surfaces).not.toContain('mcp');
  });

  it.each(WRITE_IDS)('%s is not reachable from the CLI', (id) => {
    // `cli` is the SDK's default when an Action declares no surfaces at all, so a
    // declaration that silently lost its surfaces would land here and nowhere else.
    expect(declarationOf(id).surfaces).not.toContain('cli');
  });

  it.each(WRITE_IDS)('%s carries a confirmation and a non-safe danger level', (id) => {
    const declaration = declarationOf(id);
    // The confirmation is host-owned manifest metadata raised before the handler
    // runs; the panel must never render a second "are you sure" of its own.
    expect(declaration.confirmation.title.fallback).not.toBe('');
    expect(declaration.confirmation.body.fallback).not.toBe('');
    expect(declaration.dangerLevel).not.toBe('safe');
  });
});
