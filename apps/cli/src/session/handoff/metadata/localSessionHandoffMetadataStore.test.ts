import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createLocalSessionHandoffMetadataStore } from './localSessionHandoffMetadataStore';

async function createStore() {
  const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-local-resume-'));
  onTestFinished(() => rm(activeServerDir, { recursive: true, force: true }));
  return { activeServerDir, store: createLocalSessionHandoffMetadataStore({ activeServerDir }) };
}

const CLAUDE_IDENTITY = { v: 1, vendorResumeId: 'claude-1' } as const;
const DEPARTURE_SEQ = 412;

describe('localSessionHandoffMetadataStore — inactive Agent native record', () => {
  it('round-trips the id and the departure boundary for one Session and Agent', async () => {
    const { store } = await createStore();

    await store.writeAgentNativeResumeRecord({
      happierSessionId: 'session-1',
      agentId: 'claude',
      identity: CLAUDE_IDENTITY,
      departureSeqInclusive: DEPARTURE_SEQ,
    });

    await expect(store.readAgentNativeResumeRecord({
      happierSessionId: 'session-1',
      agentId: 'claude',
    })).resolves.toEqual({
      identity: CLAUDE_IDENTITY,
      departureSeqInclusive: DEPARTURE_SEQ,
    });
  });

  it.each([-1, 4.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])(
    'refuses to persist a departure boundary of %p rather than coercing it',
    async (departureSeqInclusive) => {
      const { store } = await createStore();

      await store.writeAgentNativeResumeRecord({
        happierSessionId: 'session-1',
        agentId: 'claude',
        identity: CLAUDE_IDENTITY,
        departureSeqInclusive,
      });

      // A garbage bound would truncate a real handoff to nothing, so the record
      // must read as ABSENT — which is the full-replay degradation.
      await expect(store.readAgentNativeResumeRecord({
        happierSessionId: 'session-1',
        agentId: 'claude',
      })).resolves.toBeNull();
    },
  );

  it('reads a predecessor-shaped record as absent instead of fabricating a zero bound', async () => {
    const { store } = await createStore();
    await store.writeAgentNativeResumeRecord({
      happierSessionId: 'session-1',
      agentId: 'claude',
      identity: CLAUDE_IDENTITY,
      departureSeqInclusive: DEPARTURE_SEQ,
    });
    const recordPath = store.resolveAgentNativeResumeRecordPath({
      happierSessionId: 'session-1',
      agentId: 'claude',
    });
    await writeFile(recordPath, JSON.stringify({
      v: 1,
      happierSessionId: 'session-1',
      agentId: 'claude',
      vendorResumeId: 'claude-1',
      continuityProof: { kind: 'transcriptPath', value: '/home/u/.claude/x/claude-1.jsonl' },
      updatedAtMs: 1_700_000_000_000,
    }), 'utf8');

    await expect(store.readAgentNativeResumeRecord({
      happierSessionId: 'session-1',
      agentId: 'claude',
    })).resolves.toBeNull();
  });

  it('scopes the record to the exact Session and Agent', async () => {
    const { store } = await createStore();
    await store.writeAgentNativeResumeRecord({
      happierSessionId: 'session-1',
      agentId: 'claude',
      identity: CLAUDE_IDENTITY,
      departureSeqInclusive: DEPARTURE_SEQ,
    });

    await expect(store.readAgentNativeResumeRecord({
      happierSessionId: 'session-2',
      agentId: 'claude',
    })).resolves.toBeNull();
    await expect(store.readAgentNativeResumeRecord({
      happierSessionId: 'session-1',
      agentId: 'codex',
    })).resolves.toBeNull();
  });

  it('reads the native resume identity and boundary despite retired stored fields', async () => {
    const { store } = await createStore();
    const key = { happierSessionId: 'session-1', agentId: 'claude' } as const;
    await store.writeAgentNativeResumeRecord({ ...key, identity: CLAUDE_IDENTITY, departureSeqInclusive: DEPARTURE_SEQ });
    const path = store.resolveAgentNativeResumeRecordPath(key);
    const record: unknown = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...(record as Record<string, unknown>), retiredField: true }));
    await expect(store.readAgentNativeResumeRecord(key)).resolves.toEqual({
      identity: CLAUDE_IDENTITY, departureSeqInclusive: DEPARTURE_SEQ,
    });
  });

  it('overwrites an outgoing record instead of accumulating generations', async () => {
    const { store } = await createStore();
    await store.writeAgentNativeResumeRecord({
      happierSessionId: 'session-1',
      agentId: 'claude',
      identity: CLAUDE_IDENTITY,
      departureSeqInclusive: DEPARTURE_SEQ,
    });
    await store.writeAgentNativeResumeRecord({
      happierSessionId: 'session-1',
      agentId: 'claude',
      identity: { v: 1, vendorResumeId: 'claude-2' },
      departureSeqInclusive: 900,
    });

    await expect(store.readAgentNativeResumeRecord({
      happierSessionId: 'session-1',
      agentId: 'claude',
    })).resolves.toEqual({
      identity: { v: 1, vendorResumeId: 'claude-2' },
      departureSeqInclusive: 900,
    });
  });

  it('removes an ineligible stale record', async () => {
    const { store } = await createStore();
    await store.writeAgentNativeResumeRecord({
      happierSessionId: 'session-1',
      agentId: 'claude',
      identity: CLAUDE_IDENTITY,
      departureSeqInclusive: DEPARTURE_SEQ,
    });

    await store.writeAgentNativeResumeRecord({
      happierSessionId: 'session-1',
      agentId: 'claude',
      identity: null,
      departureSeqInclusive: DEPARTURE_SEQ,
    });
    await expect(store.readAgentNativeResumeRecord({
      happierSessionId: 'session-1',
      agentId: 'claude',
    })).resolves.toBeNull();
  });

  it('removing an absent record is a no-op', async () => {
    const { store } = await createStore();

    await expect(store.writeAgentNativeResumeRecord({
      happierSessionId: 'session-1',
      agentId: 'claude',
      identity: null,
      departureSeqInclusive: 0,
    })).resolves.toBeUndefined();
  });

  it('treats a corrupt record as absent rather than resuming an arbitrary native session', async () => {
    const { activeServerDir, store } = await createStore();
    await store.writeAgentNativeResumeRecord({
      happierSessionId: 'session-1',
      agentId: 'claude',
      identity: CLAUDE_IDENTITY,
      departureSeqInclusive: DEPARTURE_SEQ,
    });

    const recordPath = store.resolveAgentNativeResumeRecordPath({
      happierSessionId: 'session-1',
      agentId: 'claude',
    });
    expect(recordPath.startsWith(activeServerDir)).toBe(true);
    await writeFile(recordPath, '{ not json', 'utf8');

    await expect(store.readAgentNativeResumeRecord({
      happierSessionId: 'session-1',
      agentId: 'claude',
    })).resolves.toBeNull();
  });

  it('rejects a record whose plaintext Session/Agent keys do not match the request', async () => {
    const { store } = await createStore();
    await store.writeAgentNativeResumeRecord({
      happierSessionId: 'session-1',
      agentId: 'claude',
      identity: CLAUDE_IDENTITY,
      departureSeqInclusive: DEPARTURE_SEQ,
    });

    const recordPath = store.resolveAgentNativeResumeRecordPath({
      happierSessionId: 'session-1',
      agentId: 'claude',
    });
    const raw = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
    await writeFile(recordPath, JSON.stringify({ ...raw, agentId: 'codex' }), 'utf8');

    await expect(store.readAgentNativeResumeRecord({
      happierSessionId: 'session-1',
      agentId: 'claude',
    })).resolves.toBeNull();
  });

  it('stores only the exact id and the departure boundary, never transcript or runtime content', async () => {
    const { store } = await createStore();
    await store.writeAgentNativeResumeRecord({
      happierSessionId: 'session-1',
      agentId: 'claude',
      identity: { ...CLAUDE_IDENTITY, vendorResumeId: '  claude-1  ' },
      departureSeqInclusive: DEPARTURE_SEQ,
    });

    const recordPath = store.resolveAgentNativeResumeRecordPath({
      happierSessionId: 'session-1',
      agentId: 'claude',
    });
    const raw = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;

    expect(Object.keys(raw).sort()).toEqual([
      'agentId',
      'departureSeqInclusive',
      'happierSessionId',
      'v',
      'vendorResumeId',
    ]);
    // The Agent minted this resume id and it is replayed to that Agent, so the
    // record keeps its exact bytes; the schema decides presence, not shape.
    expect(raw.vendorResumeId).toBe('  claude-1  ');
    expect(raw.departureSeqInclusive).toBe(DEPARTURE_SEQ);
  });

  it('writes the record with protected permissions where the platform supports them', async () => {
    const { store } = await createStore();
    await store.writeAgentNativeResumeRecord({
      happierSessionId: 'session-1',
      agentId: 'claude',
      identity: CLAUDE_IDENTITY,
      departureSeqInclusive: DEPARTURE_SEQ,
    });

    const recordPath = store.resolveAgentNativeResumeRecordPath({
      happierSessionId: 'session-1',
      agentId: 'claude',
    });
    if (process.platform === 'win32') return;
    expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
  });

});
