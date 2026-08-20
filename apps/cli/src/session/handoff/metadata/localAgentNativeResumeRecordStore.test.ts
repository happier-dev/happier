import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { writeProtectedLocalStateFileAtomic } from '@/utils/fs/protectedLocalState';

import {
  createLocalAgentNativeResumeRecordStoreAt,
} from './localAgentNativeResumeRecordStore';

/**
 * The machine-local native-return record (`AM-24`, `AM-26`).
 *
 * The disk shape is a CROSS-TREE contract, not an implementation detail: one
 * machine's `~/.happier` is shared across a CLI upgrade in either direction, so
 * the fingerprint domain, the separators, the directory layout and the exact key
 * set are pinned here rather than left to whatever the writer happens to emit.
 *
 * Every rejection degrades to the same observable outcome — a fresh target with
 * the FULL replay — so the tests assert `null`, never a coerced or partial
 * record.
 */

/** Written with an escape rather than a literal so no NUL byte enters a source file. */
const FINGERPRINT_SEPARATOR = String.fromCharCode(0);
const SESSION_ID = 'session-native-return-1';
const AGENT_ID = 'claude' as const;

function expectedRecordFileName(happierSessionId: string, agentId: string): string {
  return `${createHash('sha256')
    .update('happier.local-agent-native-resume.v1')
    .update(FINGERPRINT_SEPARATOR)
    .update(happierSessionId)
    .update(FINGERPRINT_SEPARATOR)
    .update(agentId)
    .digest('hex')}.json`;
}

describe('localAgentNativeResumeRecordStore', () => {
  let activeServerDir = '';
  let store: ReturnType<typeof createLocalAgentNativeResumeRecordStoreAt>;

  beforeEach(async () => {
    activeServerDir = await createTempDir('happier-cli-agent-native-resume-');
    store = createLocalAgentNativeResumeRecordStoreAt({ activeServerDir });
  });

  afterEach(async () => {
    if (activeServerDir) await removeTempDir(activeServerDir);
  });

  const key = { happierSessionId: SESSION_ID, agentId: AGENT_ID };

  it('stores the record under the domain-separated fingerprint, in the shared directory', () => {
    expect(store.resolveAgentNativeResumeRecordPath(key)).toBe(join(
      activeServerDir,
      'session-handoff',
      'agent-native-resume',
      expectedRecordFileName(SESSION_ID, AGENT_ID),
    ));
  });

  it('round-trips the vendor id and the departure seq, and stores nothing else', async () => {
    await store.writeAgentNativeResumeRecord({
      ...key,
      identity: { v: 1, vendorResumeId: 'claude-abc' },
      departureSeqInclusive: 42,
    });

    await expect(store.readAgentNativeResumeRecord(key)).resolves.toEqual({
      identity: { v: 1, vendorResumeId: 'claude-abc' },
      departureSeqInclusive: 42,
    });

    // The key set is the cross-tree contract: no continuity proof, no
    // `updatedAtMs`, and nothing the record has no reader for.
    const onDisk = JSON.parse(await readFile(store.resolveAgentNativeResumeRecordPath(key), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(onDisk).sort()).toEqual([
      'agentId',
      'departureSeqInclusive',
      'happierSessionId',
      'v',
      'vendorResumeId',
    ]);
    expect(onDisk).toEqual({
      v: 1,
      happierSessionId: SESSION_ID,
      agentId: AGENT_ID,
      vendorResumeId: 'claude-abc',
      departureSeqInclusive: 42,
    });
  });

  it('keeps a zero departure seq, which is a real boundary rather than an absent one', async () => {
    await store.writeAgentNativeResumeRecord({
      ...key,
      identity: { v: 1, vendorResumeId: 'claude-abc' },
      departureSeqInclusive: 0,
    });

    await expect(store.readAgentNativeResumeRecord(key)).resolves.toEqual({
      identity: { v: 1, vendorResumeId: 'claude-abc' },
      departureSeqInclusive: 0,
    });
  });

  it('removes the record when the departing Agent has no usable identity', async () => {
    await store.writeAgentNativeResumeRecord({
      ...key,
      identity: { v: 1, vendorResumeId: 'claude-abc' },
      departureSeqInclusive: 7,
    });

    await store.writeAgentNativeResumeRecord({ ...key, identity: null, departureSeqInclusive: 9 });

    await expect(store.readAgentNativeResumeRecord(key)).resolves.toBeNull();
  });

  it('never writes a record it could not read back', async () => {
    // A bound that cannot be a transcript head is not silently coerced to one:
    // an over-estimated boundary skips rows the departing Agent never saw.
    await store.writeAgentNativeResumeRecord({
      ...key,
      identity: { v: 1, vendorResumeId: 'claude-abc' },
      departureSeqInclusive: -1,
    });
    await expect(store.readAgentNativeResumeRecord(key)).resolves.toBeNull();

    await store.writeAgentNativeResumeRecord({
      ...key,
      identity: { v: 1, vendorResumeId: 'claude-abc' },
      departureSeqInclusive: 12.5,
    });
    await expect(store.readAgentNativeResumeRecord(key)).resolves.toBeNull();
  });

  it.each([
    ['a negative bound', -1],
    ['a fractional bound', 12.5],
  ])('reads a record carrying %s as absent, not as a coerced bound', async (_label, departureSeqInclusive) => {
    await writeProtectedLocalStateFileAtomic(
      store.resolveAgentNativeResumeRecordPath(key),
      JSON.stringify({
        v: 1,
        happierSessionId: SESSION_ID,
        agentId: AGENT_ID,
        vendorResumeId: 'claude-abc',
        departureSeqInclusive,
      }),
    );

    await expect(store.readAgentNativeResumeRecord(key)).resolves.toBeNull();
  });

  it('reads a predecessor-shaped record as absent', async () => {
    // The retired shape carried a nested continuity proof and an `updatedAtMs`
    // with no reader, and it carried NO departure bound. Accepting it would
    // resume a conversation while claiming a boundary that was never recorded.
    await writeProtectedLocalStateFileAtomic(
      store.resolveAgentNativeResumeRecordPath(key),
      JSON.stringify({
        v: 1,
        happierSessionId: SESSION_ID,
        agentId: AGENT_ID,
        vendorResumeId: 'claude-abc',
        continuityProof: { kind: 'transcriptPath', value: '/tmp/claude-abc.jsonl' },
        updatedAtMs: 1_700_000_000_000,
      }),
    );

    await expect(store.readAgentNativeResumeRecord(key)).resolves.toBeNull();
  });

  it('rejects a record whose plaintext scope does not match the requested pair', async () => {
    // The filename is a hash, so these two keys are the only proof the file
    // belongs here. A mismatch is a stale or tampered file, never a session.
    await writeProtectedLocalStateFileAtomic(
      store.resolveAgentNativeResumeRecordPath(key),
      JSON.stringify({
        v: 1,
        happierSessionId: 'a-different-session',
        agentId: AGENT_ID,
        vendorResumeId: 'claude-abc',
        departureSeqInclusive: 3,
      }),
    );

    await expect(store.readAgentNativeResumeRecord(key)).resolves.toBeNull();
  });

  it('reads an absent record as absent', async () => {
    await expect(store.readAgentNativeResumeRecord(key)).resolves.toBeNull();
  });
});
