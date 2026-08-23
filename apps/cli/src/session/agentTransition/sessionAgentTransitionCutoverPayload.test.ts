import { describe, expect, it } from 'vitest';
import {
  SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE,
  SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT,
  TranscriptRawRecordV1Schema,
  agentEventAttentionImpact,
  buildSessionAgentTransitionDividerLocalId,
  readSessionAgentTransitionDividerV1,
} from '@happier-dev/protocol';

import { buildSessionAgentTransitionDividerPayload } from './sessionAgentTransitionCutoverPayload';

describe('buildSessionAgentTransitionDividerPayload', () => {
  const build = (
    sourceCutoffSeqInclusive = 29_979,
    returningAgentLastSeenSeqInclusive: number | null = null,
  ) => buildSessionAgentTransitionDividerPayload({
    mode: 'plain',
    ctx: null,
    submittedLocalId: 'local-1',
    fromAgentId: 'claude',
    toAgentId: 'codex',
    sourceCutoffSeqInclusive,
    returningAgentLastSeenSeqInclusive,
  });

  it('uses the reserved deterministic divider identity', () => {
    expect(build().localId).toBe(buildSessionAgentTransitionDividerLocalId('local-1'));
  });

  it('is byte-identical across rebuilds, which is what makes a retry idempotent', () => {
    expect(JSON.stringify(build())).toEqual(JSON.stringify(build()));
  });

  it.each(['legacy', 'dataKey'] as const)(
    'seals an E2EE divider byte-identically for a retry while changing bytes for a changed boundary (%s)',
    (encryptionVariant) => {
      const params = {
        mode: 'e2ee' as const,
        ctx: {
          encryptionKey: new Uint8Array(32).fill(7),
          encryptionVariant,
        },
        submittedLocalId: 'local-1',
        fromAgentId: 'claude',
        toAgentId: 'codex',
        sourceCutoffSeqInclusive: 29_979,
        returningAgentLastSeenSeqInclusive: null,
      };
      const changedBoundary = { ...params, sourceCutoffSeqInclusive: 29_980 };

      const first = buildSessionAgentTransitionDividerPayload(params);
      const retry = buildSessionAgentTransitionDividerPayload(params);
      const changed = buildSessionAgentTransitionDividerPayload(changedBoundary);

      expect(retry.content).toEqual(first.content);
      expect(changed.content).not.toEqual(first.content);
    },
  );

  it('produces a record the canonical transcript schema accepts, with a required event id', () => {
    const payload = build();
    const record = (payload.content as { t: 'plain'; v: unknown }).v;

    const parsed = TranscriptRawRecordV1Schema.safeParse(record);
    expect(parsed.success).toBe(true);
    expect((record as { content: { id: string } }).content.id).toBe(payload.localId);
  });

  it('carries the sidecar the shared attention owner reads, and produces no user attention', () => {
    const payload = build();
    const record = (payload.content as { t: 'plain'; v: unknown }).v as {
      content: { data: Record<string, unknown> };
    };

    expect(readSessionAgentTransitionDividerV1({
      localId: payload.localId,
      event: record.content.data,
    })).toEqual({
      v: 1,
      fromAgentId: 'claude',
      toAgentId: 'codex',
      sourceCutoffSeqInclusive: 29_979,
    });
    expect(record.content.data.message).toBe(SESSION_AGENT_TRANSITION_DIVIDER_MESSAGE);
    expect(agentEventAttentionImpact(record.content.data, payload.localId)).toEqual(
      SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT,
    );
  });

  it('buys no attention exemption for the same sidecar under an ordinary localId', () => {
    // The payload builder is the only producer of the reserved localId; the
    // sidecar key itself is writable by anything that can post an agent event.
    const record = (build().content as { t: 'plain'; v: unknown }).v as {
      content: { data: Record<string, unknown> };
    };

    expect(readSessionAgentTransitionDividerV1({
      localId: 'local-1',
      event: record.content.data,
    })).toBeNull();
    expect(agentEventAttentionImpact(record.content.data, 'local-1'))
      .not.toEqual(SESSION_MESSAGE_NO_USER_ATTENTION_IMPACT);
  });

  /**
   * The cutoff is what makes the boundary explainable after the fact: the seed
   * text is blanked the instant the target accepts it, so a divider that does
   * not record which transcript prefix was replayed leaves the reader with a
   * boundary and no way to learn what crossed it.
   */
  it('records the transcript cutoff the brief was built from', () => {
    const payload = build(1_234);
    const record = (payload.content as { t: 'plain'; v: unknown }).v as {
      content: { data: Record<string, unknown> };
    };

    expect(readSessionAgentTransitionDividerV1({
      localId: payload.localId,
      event: record.content.data,
    })?.sourceCutoffSeqInclusive).toBe(1_234);
  });

  it('permits zero only when the post-stop transcript head itself is zero', () => {
    // Zero is a valid transcript head for a brand-new Session. A non-zero head
    // stays meaningful even when its bounded replay produced no dialog.
    const payload = build(0);
    const record = (payload.content as { t: 'plain'; v: unknown }).v as {
      content: { data: Record<string, unknown> };
    };

    expect(readSessionAgentTransitionDividerV1({
      localId: payload.localId,
      event: record.content.data,
    })?.sourceCutoffSeqInclusive).toBe(0);
  });

  /**
   * A native return hands over the AWAY-DELTA, not the prefix: the pass was
   * bounded below by the returning Agent's own departure head and above by the
   * cutoff. That lower bound lives in this machine's departure record, which
   * the next departure overwrites, so the boundary is the only place it can
   * survive — and without it every later rebuild replays the full prefix and
   * shows more than was handed over.
   */
  it('records the native-return departure bound the brief was replayed from', () => {
    const payload = build(29_979, 130);
    const record = (payload.content as { t: 'plain'; v: unknown }).v as {
      content: { data: Record<string, unknown> };
    };

    expect(readSessionAgentTransitionDividerV1({
      localId: payload.localId,
      event: record.content.data,
    })).toEqual({
      v: 1,
      fromAgentId: 'claude',
      toAgentId: 'codex',
      sourceCutoffSeqInclusive: 29_979,
      returningAgentLastSeenSeqInclusive: 130,
    });
  });

  /**
   * Discriminating control: a fresh target's boundary had no lower bound, and a
   * stored `null` would be a second spelling of the same fact that every reader
   * would then have to collapse. Absence is the one spelling.
   */
  it('leaves the bound absent for a fresh target, which had none', () => {
    const record = (build(29_979, null).content as { t: 'plain'; v: unknown }).v as {
      content: { data: Record<string, unknown> };
    };
    const sidecar = record.content.data.sessionAgentTransitionV1 as Record<string, unknown>;

    expect(sidecar).not.toHaveProperty('returningAgentLastSeenSeqInclusive');
  });
});
