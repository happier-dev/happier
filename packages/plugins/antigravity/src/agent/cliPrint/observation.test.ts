import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type {
  AgentExternalSessionsResolvedIdentity,
} from '@happier-dev/plugin-sdk/sessions/external';
import {
  canonicalizePath,
} from '@happier-dev/plugin-sdk/fs';
import { describe, expect, it, vi } from 'vitest';

import {
  createAntigravityExternalSessionObservationContribution,
} from './observation.js';
import {
  resolveAntigravityTranscriptFullPath,
} from './conversationStore.js';
import {
  snapshotAntigravityTranscriptSource,
} from './transcript/jsonl.js';

async function createConversationFixture(
  mtimeMs?: number,
): Promise<Readonly<{
  brainDir: string;
  homeDir: string;
  identity: AgentExternalSessionsResolvedIdentity;
  transcriptPath: string;
}>> {
  const homeDir = await mkdtemp(join(tmpdir(), 'antigravity-observation-'));
  const configuredBrainDir = join(
    homeDir,
    '.gemini',
    'antigravity-cli',
    'brain',
  );
  const conversationId = 'conversation-a';
  const configuredTranscriptPath = resolveAntigravityTranscriptFullPath(
    configuredBrainDir,
    conversationId,
  );
  await mkdir(dirname(configuredTranscriptPath), { recursive: true });
  await writeFile(
    configuredTranscriptPath,
    `${JSON.stringify({ type: 'user_input', text: 'redacted' })}\n`,
    'utf8',
  );
  if (mtimeMs !== undefined) {
    await utimes(
      configuredTranscriptPath,
      new Date(mtimeMs),
      new Date(mtimeMs),
    );
  }
  const brainDir = await canonicalizePath(configuredBrainDir);
  const transcriptPath = resolveAntigravityTranscriptFullPath(
    brainDir,
    conversationId,
  );
  const snapshot = await snapshotAntigravityTranscriptSource(transcriptPath);
  if (!snapshot) throw new Error('Missing Antigravity transcript fixture');
  return {
    brainDir,
    homeDir,
    transcriptPath,
    identity: {
      source: {
        kind: 'antigravityCliPrint',
        brainDir,
        conversationId,
        sourceRevision: snapshot.sourceRevision,
      },
      remoteSessionId: conversationId,
      linkData: { sourceRevision: snapshot.sourceRevision },
    },
  };
}

describe('Antigravity External Session observation', () => {
  it('groups the canonical transcript without granting host watch authority', async () => {
    const fixture = await createConversationFixture();
    const contribution = createAntigravityExternalSessionObservationContribution({
      env: { HOME: fixture.homeDir },
    });

    const first = contribution.describeResource(fixture.identity);
    const duplicate = contribution.describeResource(fixture.identity);

    expect(duplicate).toEqual(first);
    expect(first).toEqual({
      resourceKey: expect.stringMatching(/^antigravity-transcript-resource-v1:/u),
      linkKey: expect.stringMatching(/^antigravity-transcript-link-v1:/u),
    });
    await expect(contribution.reconcileResource({
      purpose: 'resource_descriptors',
      resourceKey: first.resourceKey,
      links: [{
        linkKey: first.linkKey,
        linkedSource: fixture.identity,
      }],
      signal: new AbortController().signal,
    })).resolves.toEqual({
      purpose: 'resource_descriptors',
      outcomes: [{
        kind: 'described',
        descriptor: {
          ...first,
          changeObservation: 'watch_file_changes',
          watchFileChanges: { files: [fixture.transcriptPath] },
        },
      }],
    });
    expect(first.resourceKey.length).toBeLessThanOrEqual(256);
    expect(first.linkKey.length).toBeLessThanOrEqual(256);
    expect(JSON.stringify([first.resourceKey, first.linkKey])).not.toContain(
      fixture.brainDir,
    );
    expect(JSON.stringify([first.resourceKey, first.linkKey])).not.toContain(
      'conversation-a',
    );
  });

  it('accepts the same configured brain directory through a symlinked home path', async () => {
    const fixture = await createConversationFixture();
    const homeAlias = `${fixture.homeDir}-alias`;
    await symlink(
      fixture.homeDir,
      homeAlias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const contribution = createAntigravityExternalSessionObservationContribution({
      env: { HOME: homeAlias },
    });

    expect(() => contribution.describeResource(fixture.identity)).not.toThrow();
  });

  it('rejects an identity without the durable link-data source revision', async () => {
    const fixture = await createConversationFixture();
    const contribution = createAntigravityExternalSessionObservationContribution({
      env: { HOME: fixture.homeDir },
    });

    expect(() => contribution.describeResource({
      ...fixture.identity,
      linkData: {},
    })).toThrow(/transcript source revision/u);
  });

  it('keeps natural-resource grouping stable when the transcript is replaced', async () => {
    const fixture = await createConversationFixture();
    const contribution = createAntigravityExternalSessionObservationContribution({
      env: { HOME: fixture.homeDir },
    });
    const before = contribution.describeResource(fixture.identity);
    const replacement = `${fixture.transcriptPath}.replacement`;
    await writeFile(
      replacement,
      `${JSON.stringify({ type: 'planner_response', text: 'redacted' })}\n`,
      'utf8',
    );
    await rm(fixture.transcriptPath);
    await rename(replacement, fixture.transcriptPath);

    const after = contribution.describeResource(fixture.identity);

    expect(after).toEqual(before);
  });

  it('reconciles mtime as recently-active only, never liveness or a completed boundary', async () => {
    const fixture = await createConversationFixture(99_500);
    const contribution = createAntigravityExternalSessionObservationContribution({
      env: {
        HOME: fixture.homeDir,
        HAPPIER_EXTERNAL_SESSIONS_RECENT_ACTIVITY_WINDOW_MS: '5000',
      },
      now: () => 100_000,
    });
    const descriptor = contribution.describeResource(fixture.identity);

    const result = await contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: descriptor.resourceKey,
      links: [{
        linkKey: descriptor.linkKey,
        linkedSource: fixture.identity,
      }],
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      purpose: 'observation_evidence',
      outcomes: [{
        linkKey: descriptor.linkKey,
        facts: [
          {
            kind: 'recent_activity',
            evidenceClass: 'reconciliation',
            observedAtMs: 100_000,
            expiresAtMs: 115_000,
          },
          {
            kind: 'unsupported',
            axis: 'liveness',
            evidenceClass: 'reconciliation',
            observedAtMs: 100_000,
          },
          {
            kind: 'unsupported',
            axis: 'boundary',
            evidenceClass: 'reconciliation',
            observedAtMs: 100_000,
          },
        ],
      }],
    });
    expect(JSON.stringify(result)).not.toContain(fixture.transcriptPath);
    expect(JSON.stringify(result)).not.toContain('conversation-a');
    expect(JSON.stringify(result)).not.toContain('redacted');
  });

  it('reports old mtime as an unsupported turn distinction rather than idle or stopped', async () => {
    const fixture = await createConversationFixture(1_000);
    const contribution = createAntigravityExternalSessionObservationContribution({
      env: {
        HOME: fixture.homeDir,
        HAPPIER_EXTERNAL_SESSIONS_RECENT_ACTIVITY_WINDOW_MS: '5000',
      },
      now: () => 100_000,
    });
    const descriptor = contribution.describeResource(fixture.identity);

    const result = await contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: descriptor.resourceKey,
      links: [{
        linkKey: descriptor.linkKey,
        linkedSource: fixture.identity,
      }],
      signal: new AbortController().signal,
    });

    expect(result.outcomes[0]?.facts).toEqual([
      expect.objectContaining({
        kind: 'successful_empty',
        emptyTurnPhase: 'unsupported',
      }),
      expect.objectContaining({ kind: 'unsupported', axis: 'liveness' }),
      expect.objectContaining({ kind: 'unsupported', axis: 'boundary' }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /"emptyTurnPhase":"idle"|"kind":"liveness"|"kind":"boundary"/u,
    );
  });

  it('keeps reconciliation expiry timestamps inside the safe-integer contract', async () => {
    const fixture = await createConversationFixture();
    const contribution = createAntigravityExternalSessionObservationContribution({
      env: { HOME: fixture.homeDir },
      now: () => Number.MAX_SAFE_INTEGER,
    });
    const descriptor = contribution.describeResource(fixture.identity);

    const result = await contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: descriptor.resourceKey,
      links: [{
        linkKey: descriptor.linkKey,
        linkedSource: fixture.identity,
      }],
      signal: new AbortController().signal,
    });

    expect(result.outcomes[0]?.facts[0]).toEqual(expect.objectContaining({
      kind: 'successful_empty',
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    }));
  });

  it('fails all evidence axes closed after source replacement', async () => {
    const fixture = await createConversationFixture();
    const contribution = createAntigravityExternalSessionObservationContribution({
      env: { HOME: fixture.homeDir },
      now: () => 100_000,
    });
    const descriptor = contribution.describeResource(fixture.identity);
    await writeFile(
      `${fixture.transcriptPath}.replacement`,
      `${JSON.stringify({ type: 'planner_response', text: 'redacted' })}\n`,
      'utf8',
    );
    await rm(fixture.transcriptPath);
    await rename(`${fixture.transcriptPath}.replacement`, fixture.transcriptPath);

    const result = await contribution.reconcileResource({
      purpose: 'observation_evidence',
      resourceKey: descriptor.resourceKey,
      links: [{
        linkKey: descriptor.linkKey,
        linkedSource: fixture.identity,
      }],
      signal: new AbortController().signal,
    });

    expect(result.outcomes[0]?.facts).toEqual([
      expect.objectContaining({ kind: 'retrieval_failed', axis: 'liveness' }),
      expect.objectContaining({ kind: 'retrieval_failed', axis: 'turn_phase' }),
      expect.objectContaining({ kind: 'retrieval_failed', axis: 'boundary' }),
    ]);
  });

  it('returns descriptor-purpose results and reports a missing file as unavailable', async () => {
    const fixture = await createConversationFixture();
    const contribution = createAntigravityExternalSessionObservationContribution({
      env: { HOME: fixture.homeDir },
    });
    const descriptor = contribution.describeResource(fixture.identity);

    await expect(contribution.reconcileResource({
      purpose: 'resource_descriptors',
      resourceKey: descriptor.resourceKey,
      links: [{
        linkKey: descriptor.linkKey,
        linkedSource: fixture.identity,
      }],
      signal: new AbortController().signal,
    })).resolves.toEqual({
      purpose: 'resource_descriptors',
      outcomes: [{
        kind: 'described',
        descriptor: {
          ...descriptor,
          changeObservation: 'watch_file_changes',
          watchFileChanges: { files: [fixture.transcriptPath] },
        },
      }],
    });

    await rm(fixture.transcriptPath);
    await expect(contribution.reconcileResource({
      purpose: 'resource_descriptors',
      resourceKey: descriptor.resourceKey,
      links: [{
        linkKey: descriptor.linkKey,
        linkedSource: fixture.identity,
      }],
      signal: new AbortController().signal,
    })).resolves.toEqual({
      purpose: 'resource_descriptors',
      outcomes: [{ kind: 'unavailable', linkKey: descriptor.linkKey }],
    });
  });

  it('opens no plugin watcher and rejects mismatched linked identities', async () => {
    const fixture = await createConversationFixture();
    const contribution = createAntigravityExternalSessionObservationContribution({
      env: { HOME: fixture.homeDir },
    });
    const descriptor = contribution.describeResource(fixture.identity);
    const emit = vi.fn();
    const requestReconcile = vi.fn();
    const requestTranscriptRefresh = vi.fn();

    const disposable = await contribution.observeResource({
      resourceKey: descriptor.resourceKey,
      signal: new AbortController().signal,
      emit,
      requestReconcile,
      requestTranscriptRefresh,
    });

    expect(emit).not.toHaveBeenCalled();
    expect(requestReconcile).not.toHaveBeenCalled();
    expect(requestTranscriptRefresh).not.toHaveBeenCalled();
    expect(() => disposable.dispose()).not.toThrow();
    expect(() => disposable.dispose()).not.toThrow();
    expect(() => contribution.describeResource({
      ...fixture.identity,
      remoteSessionId: 'conversation-b',
    })).toThrow(/conversation identity/u);
  });
});
