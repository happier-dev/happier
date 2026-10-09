import { describe, expect, it } from 'vitest';
import { buildSessionInstructionsContextIntentV1 } from '../../actions/sessionStateFieldActions.js';
import { writeSessionContextIntentV1ToMetadata } from '../../sessions/context/sessionContextV1.js';

import { resolvePromptStackSystemAppendBlocksV1 } from './resolvePromptStackSystemAppendBlocksV1.js';

describe('resolvePromptStackSystemAppendBlocksV1', () => {
  it('rejects a bundle whose header declares an unsupported schema even when SKILL.md is present', async () => {
    await expect(resolvePromptStackSystemAppendBlocksV1({
      surface: 'coding', sessionEntries: [{ id: 'bundle', ref: { kind: 'bundle', artifactId: 'bundle' }, enabled: true, placement: 'system_append' }],
      readArtifact: async () => ({ id: 'bundle', revision: { headerVersion: 1, bodyVersion: 1 },
        header: { v: 1, kind: 'prompt_bundle.v2', title: 'Bundle', bundleSchemaId: 'dashboard.v1' },
        body: JSON.stringify({ v: 1, entries: [{ path: 'SKILL.md', contentKind: 'utf8', contentBase64: 'SGVsbG8=' }], createdAtMs: 1, updatedAtMs: 1 }),
      }),
    })).rejects.toMatchObject({ reason: 'malformed' });
  });
  const entry = (id: string, artifactId = id) => ({
    id, ref: { kind: 'doc' as const, artifactId }, enabled: true,
    placement: 'system_append' as const,
  });
  const artifact = (id: string, markdown = id) => ({
    id, header: { v: 1, kind: 'prompt_doc.v2', title: id },
    body: JSON.stringify({ v: 1, markdown, createdAtMs: 1, updatedAtMs: 1 }),
    revision: { headerVersion: 1, bodyVersion: 1 },
  });

  it.each([true, false])('requires repair for retained Session Instructions pointing at memory when memoryEnabled=%s', async (memoryEnabled) => {
    const scope = { serverId: 'home', accountId: 'account', sessionId: 'session' };
    const metadata = writeSessionContextIntentV1ToMetadata({ work: {
      memoryEnabled, promptStack: [entry('session.memory', 'selected')],
    } }, buildSessionInstructionsContextIntentV1({ kind: 'doc', artifactId: 'selected' }));
    const memory = { id: 'selected', header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' },
      body: JSON.stringify({ v: 1, facts: [{ id: 'fact', text: 'Remembered preference', createdAtMs: 1,
        sourceSessionRef: null }], archive: [] }), revision: { headerVersion: 3, bodyVersion: 7 } };
    await expect(resolvePromptStackSystemAppendBlocksV1({
      surface: 'coding', scope, sessionEntries: metadata.work.promptStack, memoryEnabled,
      readArtifactHeader: async () => ({ header: memory.header }),
      readArtifact: async () => memory,
    })).rejects.toMatchObject({ code: 'attachment_unavailable', reason: 'wrong_kind', admittedEntries: expect.arrayContaining([
      { entryId: 'session.instructions', layer: 'session', scope,
        ref: { kind: 'doc', artifactId: 'selected', serverId: 'home' }, outcome: 'unavailable', reason: 'wrong_kind',
        revision: memoryEnabled ? memory.revision : null },
    ]) });

    const repaired = writeSessionContextIntentV1ToMetadata(metadata,
      buildSessionInstructionsContextIntentV1({ kind: 'doc', artifactId: 'instructions' }));
    const bodyReads: string[] = [];
    const result = await resolvePromptStackSystemAppendBlocksV1({
      surface: 'coding', scope, accountEntries: [entry('session.instructions', 'selected')],
      sessionEntries: repaired.work.promptStack, memoryEnabled,
      readArtifactHeader: async ref => ({ header: ref.artifactId === 'selected' ? memory.header : artifact('instructions').header }),
      readArtifact: async ref => { bodyReads.push(ref.artifactId); return ref.artifactId === 'selected'
        ? memory : artifact('instructions', 'Ordinary instructions'); },
    });
    expect(result.blocks.at(-1)).toBe('Ordinary instructions');
    expect(result.blocks).toHaveLength(memoryEnabled ? 3 : 1);
    expect(bodyReads).toEqual(memoryEnabled ? ['selected', 'instructions'] : ['instructions']);
  });

  it('composes all four layers even when the legacy Account stack is absent', async () => {
    const result = await resolvePromptStackSystemAppendBlocksV1({
      surface: 'coding', promptStacksV1: null, profileId: null,
      accountEntries: [entry('account')], profileEntries: [entry('profile')],
      projectEntries: [entry('project')], sessionEntries: [entry('session')],
      readArtifact: async (ref) => artifact(ref.artifactId),
    });
    expect(result.blocks).toEqual(['account', 'profile', 'project', 'session']);
  });

  it.each(['coding', 'voice'] as const)('labels each loaded memory by document, layer and qualified ref on %s', async (surface) => {
    const local = { kind: 'doc' as const, artifactId: 'memory' };
    const remote = { ...local, serverId: 'other-home' };
    const reads: string[] = [];
    const result = await resolvePromptStackSystemAppendBlocksV1({
      surface,
      accountEntries: [{ ...entry('account-memory'), ref: local }],
      profileEntries: [{ ...entry('profile-memory'), ref: local }],
      projectEntries: [{ ...entry('project-memory'), ref: remote }],
      sessionEntries: [{ ...entry('session-memory'), ref: local }, entry('instructions')],
      nowMs: () => 2,
      readArtifact: async ref => {
        reads.push(`${ref.serverId ?? 'local'}:${ref.artifactId}`);
        if (ref.artifactId === 'instructions') return artifact('instructions', 'Ordinary instructions');
        return { id: ref.artifactId,
          header: { v: 1, kind: 'memory_doc.v1', title: ref.serverId ? 'Shared project memory' : 'Personal memory' },
          body: JSON.stringify({ v: 1, facts: [{ id: 'fact', text: 'Remembered preference', createdAtMs: 1,
            sourceSessionRef: null }], archive: [] }),
          revision: { headerVersion: 3, bodyVersion: 7 } };
      },
    });
    expect(result.blocks).toHaveLength(5);
    for (const [index, layer, ref, document] of [
      [0, 'account', local, 'Personal memory'],
      [1, 'profile', local, 'Personal memory'],
      [2, 'project', remote, 'Shared project memory'],
      [3, 'session', local, 'Personal memory'],
    ] as const) {
      expect(result.blocks[index]).toContain(`Memory: ${JSON.stringify({ document, layer, ref })}`);
      expect(result.blocks[index]).toContain('Remembered preference');
    }
    expect(result.blocks[4]).toBe('Ordinary instructions');
    expect(reads).toEqual(['local:memory', 'other-home:memory', 'local:instructions']);
  });

  it('loads only complete, budgeted index entries and topic summaries, never topic detail', async () => {
    const fact = (id: string, text: string) => ({ id, text, createdAtMs: 0, sourceSessionRef: null });
    const indexLine = '- Key preference [id: key; added: 1970-01-01]';
    const summaryLine = '- Topic: architecture — Design decisions';
    const index = `${indexLine}\n${summaryLine}`;
    const readArtifact = async () => ({ id: 'memory',
      header: { v: 1, kind: 'memory_doc.v1', title: 'Project memory' },
      body: JSON.stringify({ v: 1, index: [fact('key', 'Key preference')], topics: [
        { title: 'architecture', summary: 'Design decisions', facts: [fact('detail', 'Private on-demand topic detail')] },
        { title: 'archive', summary: 'Past facts', facts: [fact('old', 'Archived on-demand fact')] },
      ] }), revision: { headerVersion: 1, bodyVersion: 2 },
    });
    const result = await resolvePromptStackSystemAppendBlocksV1({
      surface: 'coding', projectEntries: [{ ...entry('memory'), maxChars: index.length }],
      nowMs: () => 1, readArtifact,
    });
    expect(result.blocks).toEqual([`Memory: ${JSON.stringify({ document: 'Project memory', layer: 'project',
      ref: { kind: 'doc', artifactId: 'memory' } })}\n${index}`]);
    await expect(resolvePromptStackSystemAppendBlocksV1({
      surface: 'coding', projectEntries: [{ ...entry('memory'), maxChars: indexLine.length - 1 }],
      nowMs: () => 1, readArtifact,
    })).resolves.toMatchObject({ blocks: [expect.stringContaining(summaryLine)] });
    await expect(resolvePromptStackSystemAppendBlocksV1({
      surface: 'coding', projectEntries: [{ ...entry('memory'), maxChars: 0 }],
      nowMs: () => 1, readArtifact,
    })).resolves.toMatchObject({ blocks: [], admittedEntries: [{ entryId: 'memory', outcome: 'valid-empty' }] });
  });

  it('publishes the admitted inventory with qualified addresses, revisions and valid-empty versus unavailable outcomes', async () => {
    const scope = { serverId: 'home', accountId: 'account', sessionId: 'session', projectKey: 'project' };
    const reads: string[] = [];
    const result = await resolvePromptStackSystemAppendBlocksV1({
      surface: 'coding', scope,
      accountEntries: [entry('account-entry', 'shared'), entry('suppressed')],
      projectEntries: [{ ...entry('project-entry', 'shared'), ref: { kind: 'doc', artifactId: 'shared', serverId: 'other-home' } }],
      sessionEntries: [entry('empty'), entry('missing')], disabledInheritedEntryIds: ['suppressed'],
      readArtifact: async ref => {
        reads.push(`${ref.serverId ?? 'implicit'}:${ref.artifactId}`);
        return ref.artifactId === 'missing' ? null : artifact(ref.artifactId, ref.artifactId === 'empty' ? '' : ref.serverId ?? 'home');
      },
    });
    expect(result).toMatchObject({ blocks: ['home', 'other-home'], admittedEntries: [
      { entryId: 'account-entry', layer: 'account', scope, ref: { kind: 'doc', artifactId: 'shared', serverId: 'home' },
        outcome: 'ready', revision: { headerVersion: 1, bodyVersion: 1 } },
      { entryId: 'project-entry', layer: 'project', scope, ref: { kind: 'doc', artifactId: 'shared', serverId: 'other-home' },
        outcome: 'ready', revision: { headerVersion: 1, bodyVersion: 1 } },
      { entryId: 'empty', layer: 'session', scope, ref: { kind: 'doc', artifactId: 'empty', serverId: 'home' },
        outcome: 'valid-empty', revision: { headerVersion: 1, bodyVersion: 1 } },
      { entryId: 'missing', layer: 'session', scope, ref: { kind: 'doc', artifactId: 'missing', serverId: 'home' },
        outcome: 'unavailable', reason: 'not_found', revision: null },
    ] });
    expect(reads).toEqual(['home:shared', 'other-home:shared', 'home:empty', 'home:missing']);
  });

  it('retains typed pending failure and its unavailable inventory without publishing prepared blocks', async () => {
    const scope = { serverId: 'home', accountId: 'account' };
    await expect(resolvePromptStackSystemAppendBlocksV1({
      surface: 'voice', scope, sessionEntries: [entry('selected')],
      readArtifact: async () => { throw new Error('transport offline'); },
    })).rejects.toMatchObject({ status: 'preparation_pending', reason: 'unavailable', admittedEntries: [
      { entryId: 'selected', layer: 'session', scope, ref: { kind: 'doc', artifactId: 'selected', serverId: 'home' },
        outcome: 'unavailable', reason: 'unavailable', revision: null },
    ] });
  });

  it('suppresses inherited ids before reads while preserving the Session entry with that id', async () => {
    const read: string[] = [];
    const result = await resolvePromptStackSystemAppendBlocksV1({
      surface: 'coding', promptStacksV1: null, profileId: null,
      accountEntries: [entry('hidden', 'shared'), entry('visible', 'shared')],
      projectEntries: [entry('hidden', 'project')], sessionEntries: [entry('hidden', 'own')],
      disabledInheritedEntryIds: ['hidden'],
      readArtifact: async (ref) => { read.push(ref.artifactId); return artifact(ref.artifactId); },
    });
    expect(result.blocks).toEqual(['shared', 'own']);
    expect(read).toEqual(['shared', 'own']);
  });

  it('distinguishes a required missing document from transient unavailable and valid empty', async () => {
    const args = { surface: 'coding' as const, profileId: null,
      promptStacksV1: { v: 1 as const, surfaces: { coding: [{ ...entry('required'), required: true }], voice: [], profilesById: {} } },
    };
    await expect(resolvePromptStackSystemAppendBlocksV1({ ...args, readArtifact: async () => null }))
      .rejects.toMatchObject({ status: 'attachment_unavailable', reason: 'not_found' });
    await expect(resolvePromptStackSystemAppendBlocksV1({ ...args, readArtifact: async () => { throw new Error('offline'); } }))
      .rejects.toMatchObject({ status: 'preparation_pending', reason: 'unavailable' });
    await expect(resolvePromptStackSystemAppendBlocksV1({ ...args, readArtifact: async () => artifact('required', '') }))
      .resolves.toMatchObject({ blocks: [], admittedEntries: [{ entryId: 'required', outcome: 'valid-empty' }] });
  });

  it('omits memory in every layer before body reads, including required memory', async () => {
    const bodies: string[] = [];
    const result = await resolvePromptStackSystemAppendBlocksV1({
      surface: 'voice', profileId: null, promptStacksV1: null,
      accountEntries: [{ ...entry('memory'), required: true }],
      projectEntries: [entry('project-memory')], sessionEntries: [entry('instructions')],
      memoryEnabled: false,
      readArtifactHeader: async (ref) => ({ header: { kind: ref.artifactId.includes('memory') ? 'memory_doc.v1' : 'prompt_doc.v2' } }),
      readArtifact: async (ref) => { bodies.push(ref.artifactId); return artifact(ref.artifactId); },
    });
    expect(result.blocks).toEqual(['instructions']);
    expect(result.admittedEntries.map(entry => entry.entryId)).toEqual(['instructions']);
    expect(bodies).toEqual(['instructions']);
  });
  it('reports malformed content without treating it as definitive absence', async () => {
    await expect(resolvePromptStackSystemAppendBlocksV1({
      surface: 'coding',
      promptStacksV1: {
        v: 1,
        surfaces: {
          coding: [
            {
              id: 'e1',
              ref: { kind: 'doc', artifactId: 'd1' },
              enabled: true,
              placement: 'system_append',
            },
          ],
          voice: [],
          profilesById: {},
        },
      },
      profileId: null,
      readArtifact: async () => ({ ...artifact('d1'), body: '{not-json' }),
    })).rejects.toMatchObject({ reason: 'malformed' });
  });

  it('reads and truncates valid prompt docs', async () => {
    await expect(resolvePromptStackSystemAppendBlocksV1({
      surface: 'coding',
      promptStacksV1: {
        v: 1,
        surfaces: {
          coding: [
            {
              id: 'e1',
              ref: { kind: 'doc', artifactId: 'd1' },
              enabled: true,
              placement: 'system_append',
              maxChars: 5,
            },
          ],
          voice: [],
          profilesById: {},
        },
      },
      profileId: null,
      readArtifact: async () => artifact('d1', 'Hello world'),
    })).resolves.toMatchObject({ blocks: ['Hello'] });
  });

  it('reads voice surface blocks and appends matching profile blocks without mixing in coding blocks', async () => {
    await expect(resolvePromptStackSystemAppendBlocksV1({
      surface: 'voice',
      promptStacksV1: {
        v: 1,
        surfaces: {
          coding: [
            {
              id: 'coding',
              ref: { kind: 'doc', artifactId: 'coding-doc' },
              enabled: true,
              placement: 'system_append',
            },
          ],
          voice: [
            {
              id: 'voice',
              ref: { kind: 'doc', artifactId: 'voice-doc' },
              enabled: true,
              placement: 'system_append',
            },
          ],
          profilesById: {
            p1: [
              {
                id: 'profile',
                ref: { kind: 'doc', artifactId: 'profile-doc' },
                enabled: true,
                placement: 'system_append',
              },
            ],
          },
        },
      },
      profileId: 'p1',
      readArtifact: async (ref) => artifact(ref.artifactId),
    })).resolves.toMatchObject({ blocks: ['voice-doc', 'profile-doc'] });
  });
});
