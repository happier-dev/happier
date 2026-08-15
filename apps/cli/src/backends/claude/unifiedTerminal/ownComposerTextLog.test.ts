import { describe, expect, it } from 'vitest';

import { createClaudeOwnComposerTextLog } from './ownComposerTextLog';

describe('createClaudeOwnComposerTextLog (lane X, incident cmq8y3nlx user_draft starvation)', () => {
  it('matches a draft EXACTLY equal to a recorded injected prompt', () => {
    const log = createClaudeOwnComposerTextLog();
    log.record('please continue with the refactor');
    expect(log.matches('please continue with the refactor')).toBe(true);
    expect(log.matches('  please continue with the refactor \n')).toBe(true);
  });

  it('does not treat one line of a recorded multiline injection as clearable own residue', () => {
    const log = createClaudeOwnComposerTextLog();
    const prompt = 'first instruction line\nsecond instruction line\r\nthird line';
    log.record(prompt);

    expect(log.matches(prompt)).toBe(true);
    expect(log.matches('third line')).toBe(false);
    expect(log.matches('second instruction line')).toBe(false);
  });

  it('does not match a genuine edited draft with a one-letter suffix after a recorded prompt', () => {
    const log = createClaudeOwnComposerTextLog();
    const prompt = 'please continue with the refactor';
    log.record(prompt);

    expect(log.matches(`${prompt} d`)).toBe(false);
    expect(log.matches(`${prompt}\nd`)).toBe(false);
  });

  it('NEVER matches genuine user text, partial overlaps, or empty drafts', () => {
    const log = createClaudeOwnComposerTextLog();
    log.record('/effort medium');
    log.record('please continue');
    expect(log.matches('medium/effort medium')).toBe(false);
    expect(log.matches('please continue!')).toBe(false);
    expect(log.matches('please')).toBe(false);
    expect(log.matches('')).toBe(false);
    expect(log.matches('   ')).toBe(false);
  });

  it('matches a long visible window while the own injection remains recorded but rejects short windows', () => {
    let nowMs = 10_000;
    const log = createClaudeOwnComposerTextLog({
      nowMs: () => nowMs,
      prefixResidueWindowMs: 5_000,
    });
    const longPrompt = `please continue with the full implementation ${'x'.repeat(320)}`;
    log.record(longPrompt);

    expect(log.matches(longPrompt.slice(0, 280))).toBe(true);
    expect(log.matches(longPrompt.slice(-280))).toBe(true);
    expect(log.matches(longPrompt.slice(-80))).toBe(false);

    nowMs += 5_001;
    expect(log.matches(longPrompt.slice(-280))).toBe(true);
  });

  it('matches a short prefix only after a risky terminal write marked it as possible own residue', () => {
    let nowMs = 10_000;
    const log = createClaudeOwnComposerTextLog({
      nowMs: () => nowMs,
      prefixResidueWindowMs: 5_000,
    });
    const longPrompt = `please produce the full report ${'x'.repeat(320)}`;
    const shortResidue = longPrompt.slice(0, 34);
    log.record(longPrompt);

    expect(log.matches(shortResidue)).toBe(false);

    log.recordPossiblePartialResidue(longPrompt);

    expect(log.matches(shortResidue)).toBe(true);
    expect(log.matches('please produce a different draft')).toBe(false);

    nowMs += 5_001;
    expect(log.matches(shortResidue)).toBe(false);
  });

  it('keeps very short prefix clearing scoped to durable provider-claimed residue', () => {
    let nowMs = 10_000;
    const log = createClaudeOwnComposerTextLog({
      nowMs: () => nowMs,
      prefixResidueWindowMs: 5_000,
    });
    const longPrompt = `continue the exact pending message ${'x'.repeat(320)}`;
    const shortProviderResidue = longPrompt.slice(0, 19);
    log.record(longPrompt);

    log.recordPossiblePartialResidue(longPrompt);
    expect(log.matches(shortProviderResidue)).toBe(false);

    log.recordPossiblePartialResidue(longPrompt, { minPrefixChars: 16 });
    expect(log.matches(shortProviderResidue)).toBe(true);
    expect(log.matches('continue a different')).toBe(false);

    nowMs += 5_001;
    expect(log.matches(shortProviderResidue)).toBe(false);
  });

  it('matches a recent Claude collapsed paste marker for a recorded multiline injection', () => {
    let nowMs = 10_000;
    const log = createClaudeOwnComposerTextLog({
      nowMs: () => nowMs,
      prefixResidueWindowMs: 5_000,
    });
    const prompt = Array.from({ length: 41 }, (_, index) => `line ${index}`).join('\n');
    log.record(prompt);

    expect(log.matches('[Pasted text #1 +40 lines]')).toBe(true);
    expect(log.matches('[Pasted text +40 lines]')).toBe(true);
    expect(log.matches('[Pasted text #1 +39 lines]')).toBe(true);
    expect(log.matches('[Pasted text #1 +43 lines]')).toBe(true);
    expect(log.matches('[Pasted text #1 +44 lines]')).toBe(false);

    nowMs += 5_001;
    expect(log.matches('[Pasted text #1 +40 lines]')).toBe(false);
  });

  it('keeps large collapsed paste markers matchable through the scaled provider-acceptance wait', () => {
    let nowMs = 10_000;
    const log = createClaudeOwnComposerTextLog({ nowMs: () => nowMs });
    const prompt = Array.from({ length: 3_663 }, (_, index) => `line ${index}`).join('\n');
    log.record(prompt);

    nowMs += 181_000;
    expect(log.matches('[Pasted text #1 +3662 lines]')).toBe(true);

    nowMs += 10 * 60_000;
    expect(log.matches('[Pasted text #1 +3662 lines]')).toBe(false);
  });

  it('does not match a genuine draft that merely contains a Claude collapsed paste marker', () => {
    const log = createClaudeOwnComposerTextLog();
    const prompt = Array.from({ length: 41 }, (_, index) => `line ${index}`).join('\n');
    log.record(prompt);

    expect(log.matches('please explain why [Pasted text #1 +40 lines] happened')).toBe(false);
  });

  it('does not match Claude collapsed paste markers for single-line injections', () => {
    const log = createClaudeOwnComposerTextLog();
    log.record('please continue with the refactor');
    expect(log.matches('[Pasted text #1 +0 lines]')).toBe(false);
  });

  it('is bounded: oldest entries are evicted beyond the limit', () => {
    const log = createClaudeOwnComposerTextLog({ limit: 2 });
    log.record('one');
    log.record('two');
    log.record('three');
    expect(log.matches('one')).toBe(false);
    expect(log.matches('two')).toBe(true);
    expect(log.matches('three')).toBe(true);
  });
});

describe('createClaudeOwnComposerTextLog — soft-wrapped drafts (C11 live, runner pid 20327)', () => {
  it('matches a recorded single-line text whose draft rendering soft-wrapped across lines', () => {
    const log = createClaudeOwnComposerTextLog();
    log.record('QA-C11 M1: reply with exactly the word ALPHA and nothing else');
    expect(log.matches('QA-C11 M1: reply with exactly the word ALPHA\nand nothing else')).toBe(true);
  });

  it('still never matches a wrapped draft whose words differ from any recorded text', () => {
    const log = createClaudeOwnComposerTextLog();
    log.record('QA-C11 M1: reply with exactly the word ALPHA and nothing else');
    expect(log.matches('QA-C11 M1: reply with exactly the word ALPHA\nand nothing more')).toBe(false);
    expect(log.matches('QA-C11 M1: reply with exactly the word ALPHA')).toBe(false);
  });
});
