/**
 * What the three GitLab merge-request write declarations must say to be BOTH
 * reachable by the only thing that renders them and unreachable by an agent.
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

const WRITE_IDS = [
  GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMerge,
  GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestMarkReady,
  GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestClose,
] as const;

function declarationOf(id: string) {
  const declaration = GITLAB_TRIAGE_MUTATION_ACTION_DECLARATIONS.find(
    (candidate) => candidate.id === id,
  );
  if (declaration === undefined) throw new Error(`missing declaration: ${id}`);
  return declaration;
}

describe('GitLab merge-request write declarations', () => {
  it('declares all three writes', () => {
    expect(GITLAB_TRIAGE_MUTATION_ACTION_DECLARATIONS.map((entry) => entry.id))
      .toEqual([...WRITE_IDS]);
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
