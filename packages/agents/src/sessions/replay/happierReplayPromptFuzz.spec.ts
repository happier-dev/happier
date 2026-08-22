import { describe, expect, it } from 'vitest';

import {
  buildHappierReplayPromptFromDialog,
  fitHappierReplaySeedWithinTotalBudget,
} from './happierReplayPrompt.js';

/**
 * The same class, guarded by a generated corpus instead of by the next
 * hand-written shape.
 *
 * Five repairs have each closed one way for the range claim to outlive the rows
 * it names, and each was proved by a throwaway sweep that left nothing behind —
 * so the sixth reopening would have been caught by nobody. This is that sweep
 * made durable: one seeded generator, one bounded corpus, and the invariants
 * stated as properties of the output rather than as expected strings.
 *
 * **Deterministic.** The generator is an explicit xorshift32 seeded by
 * `FUZZ_SEED`; nothing here reads `Math.random`, a clock, or the environment. A
 * failure reproduces from the seed alone. A guard on a five-times-reopened class
 * that fails one run in ten is worse than none — it teaches its readers to
 * rerun.
 *
 * **Bounded by one owner.** The `it` timeout below is the runtime ceiling. An
 * in-test wall-clock assertion would be a second, weaker owner of the same
 * bound and a flake source of its own.
 *
 * **The strong form of the range invariant.** Not "every row inside the span is
 * present", but: *every row of the POINTER'S Session that is not rendered must
 * have `seq < A`*, where `A` is the claim's oldest end — the cursor the target
 * pages BACKWARDS from. Everything at or above that cursor is a row the target
 * will never ask for again, so it has to be in the prompt. The weaker form looks
 * only inside `A..B` and is blind to an own-Session row dropped ABOVE the span.
 *
 * **The scaffold invariant, in three forms.** Outside the replayed turns, each
 * reserved marker may appear at most as often as the framer's OWN inputs could
 * have produced it — zero when this case gave it nothing to render — which
 * catches a leak wherever it lands, not only at column 0, and even when a
 * budget clipped the rest of the forgery away. No forgery injected through a
 * slot the FRAME renders may appear verbatim, which names the slot that leaked.
 * And the forgery injected through a TURN must appear verbatim, because a turn
 * always carries its own role label and therefore opens nothing: mangling a
 * reserved sentence there would cost the target real context to prevent
 * nothing, which is the reverse failure the module's doctrine weighs equally.
 *
 * **The census is asserted, not printed.** A corpus that quietly stopped
 * generating claims, drops, clips or forgeries would pass in silence, which is
 * the failure this block exists to prevent. The floors below fail if the
 * generator stops reaching the configurations that discriminate.
 *
 * **One shape is deliberately NOT generated**: a window in which the pointer's
 * own Session appears on BOTH sides of another Session's rows, with the later
 * own row carrying the SMALLER seq. No producer can build it. The only owner
 * that concatenates Sessions,
 * `apps/cli/src/session/replay/hydrateReplayDialogFromForkChain.ts`, tags every
 * row with its segment's Session and then sorts the whole chain by `createdAt`;
 * a Session's own rows are appended as one contiguous block whose seqs ascend
 * with their timestamps, so no foreign row can sort between two of them and
 * leave the later one lower-numbered. Every other producer emits one Session and
 * tags nothing. Generating it would make this fuzz red against an input the
 * product cannot produce; the derivation is recorded in
 * `.project/reviews/2026-08-16-program-audit/L-GUARD-DURABLE.md`.
 *
 * That shape is not unguarded — it is guarded by the two tracked `row-99`
 * post-condition tests in `happierReplayPrompt.spec.ts`, which construct it by
 * hand for exactly this reason. So weakening `verifyInlinedRangeClaim`'s
 * admission rule from reachability-from-the-cursor back to span membership is
 * red THERE and, by construction, invisible HERE. The two files guard the same
 * post-condition from opposite ends: this one over everything a producer can
 * actually build, that one over the latent shape none can build yet.
 *
 * **Cross-space line collisions ARE generated**, and the same split applies to
 * them. Two Sessions rendering byte-identical turns is ordinary, so the corpus
 * builds it; but in every window a producer can build, the foreign bearer is
 * OLDER than the own one, and every drop here takes the oldest first — so the
 * foreign copy can never be the one left standing in place of a dropped own
 * row. What the collision buys HERE is that the space filter is exercised over
 * the real topology rather than only over the hand-built one; what makes it
 * discriminate is the latent shape, in `happierReplayPrompt.spec.ts`.
 */
describe('the range claim and the scaffold hold across a seeded transcript fuzz', () => {
  const FUZZ_SEED = 0x5eed_c1a1;
  const FUZZ_CASES = 512;
  const OWN = 'sess_fuzz_own';
  /** The framer's own clip marker — what a partially rendered row carries. */
  const CLIP_MARKER = '[truncated to fit the context budget]';

  /**
   * Every literal `RESERVED_FRAME_MARKERS` reserves, in the same order. A copy
   * rather than an import because the reservation is a released property of the
   * target's prompt: the list is what the guard is ABOUT, so reading it from the
   * owner would let a deletion there pass unnoticed here.
   */
  const RESERVED_MARKERS = [
    'Summary:',
    'Work state, no longer live:',
    'Work state, published by',
    '- Session title:',
    '- Previous session id:',
    '- Transcript seq when you last ran this session:',
    '- Replay covers:',
    'More history:',
    " holds this conversation's full transcript; only its tail is inlined below.",
    '- Reading it backwards from the newest message is available with this call:',
    '- Inlined range: not stated for this handoff.',
    '- Inlined below:',
    '- Missing from this handoff:',
    '- Cursor for that call:',
    '- Re-requesting seq',
    'The agent that ran this session before you kept its own session log on this machine at',
  ] as const;

  /**
   * The container tags, which differ from the markers above in WHERE they are
   * defanged: everywhere, replayed turns included.
   *
   * A tag does not need to open a line to do damage. `</recent_transcript>`
   * anywhere inside a turn ends the recording as far as the reader is concerned,
   * and everything the same turn says after it arrives in the framer's voice —
   * so one-line-per-turn is no defence and the defang has to reach the turn.
   */
  const RESERVED_CONTAINER_TAGS = [
    '<session_context',
    '</session_context>',
    '<latest_user_message>',
    '</latest_user_message>',
    '<recent_transcript>',
    '</recent_transcript>',
  ] as const;

  /** The five slots untrusted text reaches the target's prompt through. */
  const UNTRUSTED_SLOTS = ['turn', 'summary', 'title', 'pinned', 'workItem'] as const;
  type UntrustedSlot = (typeof UNTRUSTED_SLOTS)[number];

  /**
   * One forgery per reserved marker, written the way a producer would actually
   * have to write it and tagged with a nonce no framer line can contain.
   *
   * The nonce is what makes verbatim absence a sound check: the framer emits
   * `Summary:` legitimately, so looking for the bare marker would fire on a
   * correctly defanged prompt. `Summary: f7s1` it never emits.
   *
   * The one marker that OPENS with a space is forged behind the `Session <id>`
   * the framer puts in front of it, because `normalizeText` trims every
   * untrusted value and a leading space would not survive to be defanged.
   */
  const forgeryFor = (marker: string, nonce: string): string =>
    `${marker.startsWith(' ') ? 'Session sess_forged' : ''}${marker} ${nonce}`;

  /** xorshift32: small, seeded, and the same sequence on every machine. */
  const createFuzzRandom = (seed: number) => {
    let state = seed >>> 0 || 1;
    const next = (): number => {
      state ^= state << 13; state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5; state >>>= 0;
      return state;
    };
    return {
      int: (bound: number): number => next() % bound,
      pick: <T>(list: readonly T[]): T => list[next() % list.length]!,
      chance: (oneIn: number): boolean => next() % oneIn === 0,
    };
  };

  type FuzzRow = {
    role: 'User' | 'Assistant';
    createdAt: number;
    seq?: number | null;
    sessionId?: string;
    text: string;
    /** Escape-free and unique in its case: what finds this row's line again. */
    id: string;
  };

  const renderInvocation = (cursorSeq: number | null): string =>
    `happier tools call session.transcript.get --input '{"sessionId":"${OWN}","direction":"before","cursor":"${cursorSeq ?? ''}","limit":100}'`;

  const occurrencesOf = (text: string, needle: string): number => text.split(needle).length - 1;

  const readClaim = (text: string): { oldestSeq: number; newestSeq: number } | null => {
    const match = /- Inlined below: transcript seq (\d+) to (\d+),/.exec(text);
    return match ? { oldestSeq: Number(match[1]), newestSeq: Number(match[2]) } : null;
  };
  /**
   * The cursor the seed hands the target, which lives beside the claim in the
   * transcript region rather than inside the frame's command.
   *
   * The frame's command always renders from the NEWEST message — `"cursor":""` —
   * because the frame survives every fit and a cursor pinned into it would
   * outlive the rows it was anchored on.
   */
  const readCursor = (text: string): number | null => {
    const match = /- Cursor for that call: (\d+)/.exec(text);
    return match ? Number(match[1]) : null;
  };
  const readFrameCommandCursor = (text: string): string | null => {
    const match = /"cursor":"(\d*)"/.exec(text);
    return match ? match[1]! : null;
  };
  const readMissingRange = (text: string): { fromSeq: number; toSeq: number } | null => {
    const match = /- Missing from this handoff: transcript seq (\d+) to (\d+)\./.exec(text);
    return match ? { fromSeq: Number(match[1]), toSeq: Number(match[2]) } : null;
  };

  it('never claims a row it did not carry, and lets no untrusted slot forge one', { timeout: 60_000 }, () => {
    const random = createFuzzRandom(FUZZ_SEED);

    const violations: string[] = [];
    let violationCount = 0;
    const record = (detail: string): void => {
      violationCount += 1;
      if (violations.length < 12) violations.push(detail);
    };
    const census = new Map<string, number>();
    const saw = (what: string): void => census.set(what, (census.get(what) ?? 0) + 1);
    /** Which reserved marker was forged through which slot, over the whole corpus. */
    const forgedMarkerSlotPairs = new Set<string>();
    /** The same census for the container tags, which are forged in every case. */
    const forgedTagSlotPairs = new Set<string>();

    let builds = 0;
    let fits = 0;

    for (let caseIndex = 0; caseIndex < FUZZ_CASES; caseIndex += 1) {
      /**
       * Tagged windows are what the fork-chain producer builds: every row
       * carries its segment's Session, ancestors first and the pointer's own
       * Session last. Untagged is what every single-Session producer builds —
       * and what a chain looked like before it tagged anything, which is a
       * window carrying two seq spaces it cannot tell apart.
       */
      const tagged = random.chance(2);
      const segmentCount = random.pick([1, 1, 1, 2, 2, 3]);
      const rows: FuzzRow[] = [];
      const segments: Array<{ space: string; seqs: number[] }> = [];
      let createdAt = 1;
      for (let segment = 0; segment < segmentCount; segment += 1) {
        const isNewest = segment === segmentCount - 1;
        // The walk can skip its own starting segment when that segment's first
        // page cannot be fetched, so the newest segment is not always the
        // pointer's Session.
        const foreign = tagged && (!isNewest || random.chance(6));
        const space = foreign ? `sess_fuzz_fork_${segment}` : OWN;
        // Bases chosen so a run crosses a digit-width boundary — 9→10, 99→100,
        // 999→1000, 9999→10000, 99999→100000. A collapsed range used to grow
        // the frame past what had been reserved for it.
        const base = random.pick([1, 7, 95, 98, 997, 9_995, 99_997]);
        const step = random.pick([1, 1, 1, 2, 5, 37]);
        const length = random.pick([1, 2, 3, 4, 5, 6, 8]);
        const seqs: number[] = [];
        let seq = base;
        for (let n = 0; n < length; n += 1) {
          const index = rows.length;
          const id = `r${index}#`;
          const oversized = random.chance(9);
          const filler = random.pick([16, 48, 120, 260]);
          const row: FuzzRow = {
            role: index % 2 === 0 ? 'User' : 'Assistant',
            createdAt,
            text: `${id} ${'abcdefgh'[index % 8]!.repeat(oversized ? 2_400 : filler)}`,
            id,
          };
          // Unnumbered rows (the voice hydrator has no transcript rows behind
          // it) and duplicate seqs both make a window whose claim must be
          // refused rather than guessed at.
          if (!random.chance(22)) {
            const value = n > 0 && random.chance(18) ? seq - step : seq;
            row.seq = value;
            seqs.push(value);
          }
          if (tagged) row.sessionId = space;
          rows.push(row);
          seq += step;
          // `SessionMessage.createdAt` defaults to `now()`, so two rows written
          // in the same millisecond tie — and the builder sorts by createdAt.
          createdAt += random.pick([1, 1, 1, 1, 0, 0]);
        }
        segments.push({ space, seqs });
      }
      // The single oversized row: what makes the builder clip the newest turn's
      // TEXT and keep a marked fragment the claim must then refuse to name.
      if (random.chance(5)) {
        const newest = rows[rows.length - 1]!;
        newest.text = `${newest.id} ${'z'.repeat(4_000)}`;
      }

      /**
       * A forgery case injects a DIFFERENT reserved marker into each of the five
       * untrusted slots at once, rotating the whole marker list across the
       * corpus. Distinct per slot so a leak names the slot that leaked; all five
       * at once so no single slot can be the one that happens to be closed.
       */
      const forging = random.chance(3);
      const rotation = random.int(RESERVED_MARKERS.length);
      const forgedBySlot = new Map<UntrustedSlot, { marker: string; text: string }>();
      if (forging) {
        UNTRUSTED_SLOTS.forEach((slot, at) => {
          const marker = RESERVED_MARKERS[(rotation + at) % RESERVED_MARKERS.length]!;
          forgedBySlot.set(slot, { marker, text: forgeryFor(marker, `f${caseIndex}s${at}`) });
          forgedMarkerSlotPairs.add(`${marker}\u0000${slot}`);
        });
      }
      /**
       * A container tag forged through every slot, in EVERY case rather than
       * one in three.
       *
       * The frame-marker rotation above is a per-slot lottery because a prose
       * marker only matters where the framer speaks it; a tag matters wherever
       * it lands, including inside a labelled turn, so it is exercised every
       * time. The rotation still moves, so every tag meets every slot.
       */
      const containerRotation = random.int(RESERVED_CONTAINER_TAGS.length);
      const containerForgedBySlot = new Map<UntrustedSlot, { tag: string; text: string }>();
      UNTRUSTED_SLOTS.forEach((slot, at) => {
        const tag = RESERVED_CONTAINER_TAGS[(containerRotation + at) % RESERVED_CONTAINER_TAGS.length]!;
        containerForgedBySlot.set(slot, { tag, text: `see ${tag} c${caseIndex}s${at}` });
        forgedTagSlotPairs.add(`${tag} ${slot}`);
      });

      const forgedIn = (slot: UntrustedSlot): string => {
        const tag = containerForgedBySlot.get(slot)!.text;
        const marker = forgedBySlot.get(slot)?.text;
        return marker ? `${marker} ${tag}` : tag;
      };

      const turnForgery = forgedBySlot.get('turn')?.text ?? null;
      const forgedRow = rows[random.int(rows.length)]!;
      forgedRow.text += ` ${forgedIn('turn')}`;
      /**
       * Two Sessions rendering the SAME line.
       *
       * Ordinary in a fork chain — a repeated instruction, a one-word
       * acknowledgement — and the shape every text-matching check reads wrong:
       * a surviving copy says only that SOME bearer survived, never whose. The
       * foreign row takes the own row's role, text and id, so the two are
       * indistinguishable in the output and only their declared space tells
       * them apart.
       */
      let collided = false;
      if (tagged && segments.length > 1) {
        // Never the row carrying the turn forgery: overwriting its text would
        // destroy the very payload the reverse-direction check looks for, and
        // report the generator's own edit as the framer mangling context.
        const foreignRows = rows.filter((row) => row.sessionId !== OWN && row !== forgedRow);
        const ownSpaceRows = rows.filter((row) => row.sessionId === OWN);
        if (foreignRows.length > 0 && ownSpaceRows.length > 0 && random.chance(3)) {
          const source = ownSpaceRows[random.int(ownSpaceRows.length)]!;
          const target = foreignRows[random.int(foreignRows.length)]!;
          target.role = source.role;
          target.text = source.text;
          target.id = source.id;
          collided = true;
        }
      }
      const summaryText: string | null = forgedIn('summary');
      const sessionTitle: string | null = forgedIn('title');
      const pinnedText: string | null = forgedIn('pinned');
      const workItemTitle: string | null = forgedIn('workItem');

      const sameSession = random.chance(4) !== true;
      /**
       * The native return: the transcript head the target itself last saw.
       *
       * Generated across the whole span the window can produce — below every
       * row, inside it, and above all of it — because the gap line is derived
       * from BOTH the bound and the surviving rows, and the two ends move
       * independently. `null` is the fresh target, which must be byte-identical
       * to a build that was never given a bound at all.
       */
      const seqsInWindow = rows
        .map((row) => row.seq)
        .filter((value): value is number => typeof value === 'number');
      const nativeReturn = sameSession && random.chance(2);
      const returningAgentLastSeenSeq = !nativeReturn
        ? null
        : seqsInWindow.length === 0
          ? random.int(50)
          : random.pick([
            Math.max(0, Math.min(...seqsInWindow) - random.int(40) - 1),
            Math.max(0, Math.min(...seqsInWindow) - 1),
            Math.max(0, Math.floor((Math.min(...seqsInWindow) + Math.max(...seqsInWindow)) / 2)),
            Math.max(...seqsInWindow),
            Math.max(...seqsInWindow) + random.int(40),
          ]);
      const sourceAgentLabel = sameSession && random.chance(2) ? 'Claude Code CLI' : null;
      const strategy = (summaryText ? 'summary_plus_recent' : 'recent_messages') as
        'summary_plus_recent' | 'recent_messages';
      const nativeTranscriptPath = random.chance(3) ? '/home/u/.happier/agent/x/abc.jsonl' : null;

      const common = {
        previousSessionId: OWN,
        continuity: (sameSession ? 'same_session_agent_change' : 'previous_session') as
          'same_session_agent_change' | 'previous_session',
        strategy,
        recentMessagesCount: null,
        dialog: rows,
        retrieval: {
          sessionId: OWN,
          renderInvocation,
          ...(nativeTranscriptPath === null ? {} : { nativeTranscriptPath }),
        },
        ...(random.chance(4) ? { historyIncomplete: true } : {}),
        ...(random.chance(4) ? { windowTruncated: true } : {}),
        ...(returningAgentLastSeenSeq === null ? {} : { returningAgentLastSeenSeq }),
        ...(sourceAgentLabel === null ? {} : { sourceAgentLabel }),
        ...(summaryText === null ? {} : { summaryText }),
        ...(sessionTitle === null ? {} : { sessionTitle }),
        ...(pinnedText === null ? {} : {
          lastUserInstruction: { role: 'User' as const, createdAt: 0, text: pinnedText },
        }),
        ...(workItemTitle === null ? {} : {
          workState: {
            v: 1 as const,
            backendId: 'claude',
            updatedAt: 10,
            items: [{
              id: 'w1',
              kind: 'task' as const,
              origin: 'vendor' as const,
              status: 'active' as const,
              title: workItemTitle,
              updatedAt: 10,
            }],
          },
        }),
      };

      /**
       * How many times the FRAMER could emit each reserved marker for this case,
       * derived from the inputs it was given rather than from the output.
       *
       * Every marker is emitted at most once, and a marker whose input is absent
       * cannot be emitted at all — which is what makes this bite on a leak that a
       * budget clipped down to the bare marker, where the nonce check below has
       * nothing left to find.
       */
      const legitimateLimit = new Map<string, number>(RESERVED_MARKERS.map((marker) => [marker, 1]));
      legitimateLimit.set('- Previous session id:', sameSession ? 0 : 1);
      legitimateLimit.set('Summary:', strategy === 'summary_plus_recent' && summaryText ? 1 : 0);
      legitimateLimit.set('- Session title:', sessionTitle ? 1 : 0);
      legitimateLimit.set('Work state, no longer live:', workItemTitle && !sourceAgentLabel ? 1 : 0);
      legitimateLimit.set('Work state, published by', workItemTitle && sourceAgentLabel ? 1 : 0);
      legitimateLimit.set('- Transcript seq when you last ran this session:', nativeReturn ? 1 : 0);
      legitimateLimit.set('- Replay covers:', nativeReturn ? 1 : 0);
      legitimateLimit.set(
        'The agent that ran this session before you kept its own session log on this machine at',
        nativeTranscriptPath ? 1 : 0,
      );
      /**
       * The container tags, counted over the WHOLE prompt rather than outside the
       * turns: they are defanged everywhere, so a turn may never carry one either.
       * An opener without its closer is the defect this layout was designed
       * against — the live user turn the dispatch appends lands inside the
       * recording.
       */
      const containerLimit = new Map<string, number>([
        ['<session_context', 1],
        ['</session_context>', 1],
        ['<latest_user_message>', pinnedText ? 1 : 0],
        ['</latest_user_message>', pinnedText ? 1 : 0],
        ['<recent_transcript>', 1],
        ['</recent_transcript>', 1],
      ]);

      // What this case actually exercises, counted where it is generated rather
      // than inferred from the output.
      if (forging) saw('a forgery in all five untrusted slots');
      if (nativeReturn) saw('a native return with a stated boundary');
      if (collided) saw('two Sessions rendering the same line');
      if (tagged && segments.length > 1) saw('a tagged chain of two or more Sessions');
      if (!tagged && segments.length > 1) saw('an untagged window carrying two seq spaces');
      if (segments.some((one) => one.seqs.some((value, at) => at > 0 && value <= one.seqs[at - 1]!))) {
        saw('a duplicate or non-ascending seq');
      }
      if (rows.some((row) => row.seq === undefined)) saw('an unnumbered row');
      if (new Set(rows.map((row) => row.createdAt)).size !== rows.length) saw('a createdAt tie');
      if (rows.some((row) => row.text.length > 2_000)) saw('an oversized row');
      {
        const widths = new Set(rows
          .map((row) => row.seq)
          .filter((value): value is number => typeof value === 'number')
          .map((value) => String(value).length));
        if (widths.size > 1) saw('a digit-width transition');
        const spans = segments.filter((one) => one.seqs.length > 0);
        for (let at = 1; at < spans.length; at += 1) {
          const older = spans[at - 1]!;
          const newer = spans[at]!;
          if (older.space !== newer.space && Math.max(...older.seqs) < Math.min(...newer.seqs)) {
            saw('two spaces that are disjoint AND ascending');
          }
        }
      }

      /**
       * What each row's WHOLE line is, answered by the builder itself at no
       * budget — where nothing is dropped and nothing is clipped.
       *
       * Re-deriving it here would mean a second copy of the untrusted-history
       * escaper in the spec, which can only ever drift toward agreeing with a
       * broken one. The unbounded render is the owner's own statement of "this
       * row, entire", and the property under test — which rows a claim may name
       * — is independent of how the row is escaped.
       */
      const unbounded = buildHappierReplayPromptFromDialog({ ...common, maxPromptChars: null });
      builds += 1;
      if (!unbounded) { record(`case ${caseIndex}: the unbounded build produced no seed`); continue; }
      const unboundedLines = unbounded.split('\n');
      const wholeLineOf = new Map<string, string>();
      // A colliding case gives two rows the same role, text and id on purpose,
      // so an opening may legitimately match more than once — but every match
      // has to be the same line, or the two rows are not the collision this
      // case meant to build.
      const bearersOfOpening = new Map<string, number>();
      for (const row of rows) {
        const opening = `${row.role}: ${row.id}`;
        bearersOfOpening.set(opening, (bearersOfOpening.get(opening) ?? 0) + 1);
      }
      for (const row of rows) {
        const opening = `${row.role}: ${row.id}`;
        const bearers = bearersOfOpening.get(opening) ?? 0;
        const matches = unboundedLines.filter((line) => line.startsWith(opening));
        if (matches.length !== bearers || new Set(matches).size !== 1) {
          record(`case ${caseIndex}: row ${row.id} rendered ${matches.length} unbounded lines against ${bearers} bearers`);
          continue;
        }
        wholeLineOf.set(row.id, matches[0]!);
      }
      const ownRows = rows.filter((row) => (row.sessionId ?? OWN) === OWN);

      const inspect = (label: string, text: string, cap: number): void => {
        if (!text) return;
        if (text.length > cap) record(`${label}: ${text.length} chars against a ${cap} cap`);
        const lines = text.split('\n');
        /**
         * The transcript region, which is the only place a replayed turn may
         * appear. Reading turns out of the whole prompt would let a summary that
         * happens to open `User: ` count as one.
         */
        const markerAt = text.indexOf('\n<recent_transcript>\n');
        // The region ends at the container's CLOSER, never at the guidance: the
        // guidance is droppable and the closer is not, so keying on the guidance
        // reads the closer back as a transcript line.
        const closingAt = text.lastIndexOf('\n</recent_transcript>');
        const bodyLines = markerAt < 0
          ? null
          : text
            .slice(markerAt + '\n<recent_transcript>\n'.length, closingAt < 0 ? undefined : closingAt)
            .split('\n');
        if (bodyLines === null) record(`${label}: no transcript region`);
        /**
         * Which rows this prompt carried, WHOLE, by aligning the rendered turns
         * with the window rather than by asking whether their text appears
         * somewhere in it.
         *
         * Membership stops answering that question the moment two Sessions can
         * render byte-identical turns: a surviving copy proves only that SOME
         * bearer of that line survived, and every drop here takes the oldest
         * rows first, so the copy left standing can be the foreign one. Both
         * truncators keep a SUFFIX of the window, so the k-th rendered turn IS
         * the k-th row of that suffix. That is an exact answer instead of a
         * guess — and it also fails, rather than quietly agreeing, if a fill
         * ever reordered or interleaved what it kept.
         */
        const bodyTurns = (bodyLines ?? []).filter((line) =>
          line.startsWith('User: ') || line.startsWith('Assistant: '));
        const carried = new Set<FuzzRow>();
        const offset = rows.length - bodyTurns.length;
        if (offset < 0) record(`${label}: ${bodyTurns.length} rendered turns against ${rows.length} rows`);
        for (let at = 0; offset >= 0 && at < bodyTurns.length; at += 1) {
          const row = rows[offset + at]!;
          if (bodyTurns[at] === wholeLineOf.get(row.id)) carried.add(row);
        }
        const isWhole = (row: FuzzRow): boolean => carried.has(row);
        const claim = readClaim(text);
        const cursor = readCursor(text);

        const lost = ownRows.filter((row) => !isWhole(row));
        if (lost.length > 0) saw('a prompt that lost an own-Session row');
        if (text.includes(CLIP_MARKER)) saw('a prompt carrying a clipped row');

        if (claim) {
          saw('a prompt carrying a claim');
          if (readMissingRange(text)) saw('a native return that stated a gap');
          if (lost.length > 0) saw('a claim standing over a lost own-Session row');
          // The claim, the cursor, the paging anchor and the re-request note are
          // one statement about one range: any of them disagreeing sends the
          // target to a different row than the one the seed vouched for.
          if (cursor !== claim.oldestSeq) record(`${label}: cursor ${cursor} against claim ${claim.oldestSeq}`);
          if (!text.includes(`- Re-requesting seq ${claim.oldestSeq} to ${claim.newestSeq}`)) {
            record(`${label}: the re-request note does not restate ${claim.oldestSeq} to ${claim.newestSeq}`);
          }
          // The frame's own command never carries a row-derived cursor. It
          // survives every fit, so a cursor baked into it would outlive the rows
          // it was anchored on and send the target below a message the prompt
          // never delivered.
          if (readFrameCommandCursor(text) !== '') {
            record(`${label}: the frame command carries cursor ${readFrameCommandCursor(text)}`);
          }
          /**
           * The gap and the claim are complements, not two opinions.
           *
           * `D+1 .. oldest-1` missing and `oldest .. newest` inlined must be
           * contiguous and non-overlapping, or the returning Agent is told it
           * holds a row that is in neither — the permanent skip, arrived at by
           * arithmetic instead of by a dropped line.
           */
          const gap = readMissingRange(text);
          if (returningAgentLastSeenSeq === null) {
            if (gap) record(`${label}: a gap statement with no returning boundary`);
          } else if (gap) {
            if (gap.fromSeq !== returningAgentLastSeenSeq + 1) {
              record(`${label}: gap starts at ${gap.fromSeq} against boundary ${returningAgentLastSeenSeq}`);
            }
            if (gap.toSeq !== claim.oldestSeq - 1) {
              record(`${label}: gap ends at ${gap.toSeq} against claim ${claim.oldestSeq}`);
            }
          } else if (claim.oldestSeq > returningAgentLastSeenSeq + 1) {
            record(`${label}: no gap stated between ${returningAgentLastSeenSeq + 1} and ${claim.oldestSeq - 1}`);
          }
          // Both ends are rows of the pointer's OWN Session, rendered whole. A
          // seq is only a number until a Session is named beside it.
          const endpointHeld = (seq: number): boolean => ownRows.some((row) => row.seq === seq && isWhole(row));
          if (!endpointHeld(claim.oldestSeq)) record(`${label}: oldest end ${claim.oldestSeq} is no own rendered row`);
          if (!endpointHeld(claim.newestSeq)) record(`${label}: newest end ${claim.newestSeq} is no own rendered row`);
          // The strong form: nothing of the pointer's Session at or above the
          // cursor may be missing, whether it sits inside the span or above it.
          // Above it is the shape a span-only check cannot see, and it is the
          // permanent skip — the target pages backwards and never comes back up.
          const skipped = ownRows
            .filter((row) => typeof row.seq === 'number' && row.seq >= claim.oldestSeq && !isWhole(row))
            .map((row) => `${row.id}@${row.seq}`);
          if (skipped.length > 0) {
            record(`${label}: claim ${claim.oldestSeq}-${claim.newestSeq} skips ${skipped.join(',')} forever`);
          }
        } else if (cursor !== null || readMissingRange(text) !== null) {
          record(`${label}: a cursor or a gap outlived its claim`);
        }

        // No reserved marker may appear more often than the framer's own inputs
        // could have put it there — anywhere OUTSIDE a replayed turn, not only at
        // column 0, so a leak inside a block whose own prefix would hide it from
        // a line-start check is caught too. The turns are excluded because a
        // reserved sentence inside one is prose the framer must not mangle; that
        // direction is asserted per case, against the unbounded render.
        const scaffoldText = lines
          .filter((line) => !line.startsWith('User: ') && !line.startsWith('Assistant: '))
          .join('\n');
        for (const marker of RESERVED_MARKERS) {
          const occurrences = occurrencesOf(scaffoldText, marker);
          const allowed = legitimateLimit.get(marker) ?? 1;
          if (occurrences > allowed) {
            record(`${label}: ${JSON.stringify(marker)} appears ${occurrences}x against ${allowed} the framer could emit`);
          }
        }
        // And no forgery injected through a FRAME slot survives verbatim, which
        // names the slot that leaked.
        for (const [slot, forged] of forgedBySlot) {
          if (slot === 'turn') continue;
          if (text.includes(forged.text)) record(`${label}: the ${slot} slot leaked ${JSON.stringify(forged.marker)} intact`);
        }
        /**
         * The container tags, over the WHOLE prompt rather than outside the
         * turns, because they are defanged everywhere — and a tag inside a turn
         * is the case one-line-per-turn does not cover.
         *
         * The balance check is the one this layout was designed against: an
         * opener whose closer a fit dropped leaves the live user turn the
         * dispatch appends rendering inside the recording, attributed to the
         * conversation being replayed.
         */
        for (const [tag, allowed] of containerLimit) {
          const seen = occurrencesOf(text, tag);
          if (seen > allowed) record(`${label}: container ${JSON.stringify(tag)} appears ${seen}x against ${allowed}`);
        }
        // Counted as WHOLE tags. A defanged forgery still starts
        // `<session_context`, and counting that prefix would report the framer's
        // own balanced pair as unbalanced every time a forgery landed — the
        // guard firing on the defence working.
        for (const [openings, close] of [
          [['<session_context'], '</session_context>'],
          [['<latest_user_message>'], '</latest_user_message>'],
          [['<recent_transcript>'], '</recent_transcript>'],
        ] as const) {
          const opened = openings.reduce((total, open) => total + occurrencesOf(text, open), 0);
          const closed = occurrencesOf(text, close);
          if (opened !== closed) record(`${label}: ${close} opened ${opened}x and closed ${closed}x`);
        }
        // Including the turn slot: a tag does not need to open a line to end the
        // recording, so one-line-per-turn is no defence and the defang reaches it.
        for (const [slot, forged] of containerForgedBySlot) {
          if (text.includes(forged.text)) record(`${label}: the ${slot} slot leaked container ${JSON.stringify(forged.tag)} intact`);
        }
        // The live user turn the dispatch appends after this seed must land
        // OUTSIDE the recording, at every budget and every reservation.
        const dispatched = `${text}\n\nship the fix now`;
        const lastClose = dispatched.lastIndexOf('</recent_transcript>');
        if (lastClose < 0 || dispatched.indexOf('ship the fix now') < lastClose) {
          record(`${label}: the live user turn renders inside the recording`);
        }

        // Every line of the transcript region is whole: a replayed turn, one of
        // the framer's notices, or a complete pointer line — never a fragment.
        for (const line of bodyLines ?? []) {
          if (line.length === 0) continue;
          const whole = /^(User: |Assistant: |\[|- Inlined below: |- Missing from this handoff: |- Cursor for that call: |- Re-requesting seq |- Inlined range: not stated for this handoff\.$)/.test(line);
          if (!whole) record(`${label}: partial body line ${JSON.stringify(line.slice(0, 48))}`);
        }
      };

      inspect(`case ${caseIndex} unbounded`, unbounded, Number.MAX_SAFE_INTEGER);
      // The reverse direction, checked where nothing is dropped or clipped: the
      // turn slot's reserved PROSE is context, and it arrives whole. This is the
      // half that keeps the tag rule from turning into "defang everything" —
      // mangling a reserved sentence inside a labelled turn costs the target real
      // context to prevent nothing.
      if (turnForgery && !unbounded.includes(turnForgery)) {
        record(`case ${caseIndex} unbounded: the turn slot's reserved sentence was mangled`);
      }

      /**
       * Five build budgets per case: the reachable wire floor, three derived from
       * this case's own unbounded length so the builder genuinely drops PART of
       * the window at three different depths, and one that seals everything.
       *
       * Sampled rather than swept. The dense per-character build sweep and the
       * exhaustive per-character reservation sweep already live in
       * `happierReplayPrompt.spec.ts` over fixed shapes; what this adds is shape
       * variety. The three middles are PROPORTIONAL so every generated shape
       * gets its partial-drop cases rather than only the small ones, and there
       * are three rather than one because WHICH row a budget drops decides
       * whether a case can discriminate at all: with a single middle, the
       * strong-form admission rule was exercised in one tree and not the other
       * purely because the two framers' notice lengths move the drop point by a
       * few characters.
       */
      const proportional = (percent: number): number =>
        Math.max(200, Math.min(9_000, Math.round((unbounded.length * percent) / 100)));
      const budgets = [
        random.pick([200, 260, 400, 520, 640]),
        proportional(random.pick([25, 30, 36])),
        proportional(random.pick([45, 52, 60])),
        proportional(random.pick([68, 78, 88])),
        random.pick([3_200, 9_000, 100_000]),
      ];
      for (const maxPromptChars of budgets) {
        const seed = buildHappierReplayPromptFromDialog({ ...common, maxPromptChars });
        builds += 1;
        if (!seed) { saw('a budget that refused to seal any seed'); continue; }
        inspect(`case ${caseIndex} build ${maxPromptChars}`, seed, maxPromptChars);

        // Six dispatch reservations per sealed seed, spread across its whole
        // length so the fit runs from "nothing to trim" to "almost everything".
        for (let step = 0; step < 6; step += 1) {
          const reservedChars = Math.min(seed.length, Math.floor((seed.length * step) / 6) + random.int(9));
          const fitted = fitHappierReplaySeedWithinTotalBudget({
            seedText: seed,
            reservedChars,
            maxPromptChars: seed.length,
          });
          fits += 1;
          if (!fitted) continue;
          inspect(`case ${caseIndex} build ${maxPromptChars} fit ${reservedChars}`, fitted, seed.length - reservedChars);
        }
      }
    }

    const reached = (what: string): number => census.get(what) ?? 0;

    // The corpus really did reach every configuration this guard claims to
    // cover, and it really did produce the ONE that discriminates: a claim
    // standing over a window that lost rows.
    expect({
      builds,
      // One fit per reservation step behind every budget that sealed something.
      fits: fits === (FUZZ_CASES * 5 - reached('a budget that refused to seal any seed')) * 6,
      forgedMarkerSlotPairs: forgedMarkerSlotPairs.size,
      forgedTagSlotPairs: forgedTagSlotPairs.size,
      nativeReturns: reached('a native return with a stated boundary') >= 100,
      nativeReturnGaps: reached('a native return that stated a gap') >= 40,
      claims: reached('a prompt carrying a claim') >= 400,
      claimsOverALoss: reached('a claim standing over a lost own-Session row') >= 50,
      lostRows: reached('a prompt that lost an own-Session row') >= 1_500,
      clipped: reached('a prompt carrying a clipped row') >= 300,
      refusedBudgets: reached('a budget that refused to seal any seed') >= 50,
      collisions: reached('two Sessions rendering the same line') >= 20,
      taggedChains: reached('a tagged chain of two or more Sessions') >= 50,
      disjointAscending: reached('two spaces that are disjoint AND ascending') >= 20,
      untaggedTwoSpaces: reached('an untagged window carrying two seq spaces') >= 50,
      nonAscendingSeqs: reached('a duplicate or non-ascending seq') >= 40,
      unnumberedRows: reached('an unnumbered row') >= 40,
      createdAtTies: reached('a createdAt tie') >= 100,
      digitWidthTransitions: reached('a digit-width transition') >= 100,
      oversizedRows: reached('an oversized row') >= 100,
      forgeryCases: reached('a forgery in all five untrusted slots') >= 100,
    }).toEqual({
      builds: FUZZ_CASES * 6,
      fits: true,
      // Every reserved marker forged through every untrusted slot.
      forgedMarkerSlotPairs: RESERVED_MARKERS.length * UNTRUSTED_SLOTS.length,
      forgedTagSlotPairs: RESERVED_CONTAINER_TAGS.length * UNTRUSTED_SLOTS.length,
      nativeReturns: true,
      nativeReturnGaps: true,
      claims: true,
      claimsOverALoss: true,
      lostRows: true,
      clipped: true,
      refusedBudgets: true,
      collisions: true,
      taggedChains: true,
      disjointAscending: true,
      untaggedTwoSpaces: true,
      nonAscendingSeqs: true,
      unnumberedRows: true,
      createdAtTies: true,
      digitWidthTransitions: true,
      oversizedRows: true,
      forgeryCases: true,
    });

    expect({ violationCount, sample: violations }).toEqual({ violationCount: 0, sample: [] });
  });
});
