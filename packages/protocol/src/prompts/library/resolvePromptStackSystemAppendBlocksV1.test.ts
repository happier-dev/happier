import { describe, expect, it } from 'vitest';
import { buildSessionInstructionsContextIntentV1 } from '../../actions/sessionStateFieldActions.js';
import { writeSessionContextIntentV1ToMetadata } from '../../sessions/context/sessionContextV1.js';

import { resolvePromptStackSystemAppendBlocksV1 } from './resolvePromptStackSystemAppendBlocksV1.js';
import predecessorPickerStack from '../../../fixtures/0.2-picker-skill-instructions-stack.json';
import { PromptStackEntryV1StoredSchema } from './promptStacksV1.js';
import { decodeBase64 } from '../../crypto/base64.js';
import { MemoryDocBodyV1Schema } from './memoryDocV1.js';

describe('resolvePromptStackSystemAppendBlocksV1', () => {
  it.each(['coding', 'voice'] as const)('skips skill-schema bundles on %s while retaining predecessor generic text and budgets', async surface => {
    // The fixture captures the actual 0.2 picker producer; its body also satisfies
    // the inspected generic schema at cd2bb4d853a259ae00ebc3e5981224e3e4bb5380.
    const captured = predecessorPickerStack.artifacts[1]!;
    const raw = predecessorPickerStack.stacks.surfaces.coding[1]!;
    const generic = { ...captured, id: 'generic', header: { ...captured.header, bundleSchemaId: 'bundle.generic_v1' } };
    const entries = ['system_append', 'skill_instructions', 'provider_asset', 'composer_insert'].map(placement =>
      PromptStackEntryV1StoredSchema.parse({ ...raw, id: placement, placement }));
    const genericEntry = PromptStackEntryV1StoredSchema.parse({ ...raw, id: 'generic', ref: { kind: 'bundle', artifactId: 'generic' }, maxChars: 43 });
    const body: { entries: { contentBase64: string }[] } = JSON.parse(captured.body);
    const expected = new TextDecoder().decode(decodeBase64(body.entries[0]!.contentBase64, 'base64')).trim().slice(0, 43);
    const result = await resolvePromptStackSystemAppendBlocksV1({ surface,
      accountEntries: entries, profileEntries: entries, projectEntries: entries, sessionEntries: [...entries, genericEntry],
      readArtifact: async ref => ref.artifactId === 'generic' ? generic : captured,
    });
    expect(result.blocks).toEqual([expected]);
    expect(result.admittedEntries.map(entry => entry.entryId)).toEqual(['generic']);
    // Skills have their own delivery/content admission owner, even when their
    // old stack attachment remains until conversion completes.
    await expect(resolvePromptStackSystemAppendBlocksV1({ surface, accountEntries: [entries[0]!],
      readArtifact: async () => ({ ...captured, body: '{not-json' }),
    })).resolves.toEqual({ blocks: [], admittedEntries: [] });
  });
  it('rejects a bundle whose header declares an unsupported schema even when SKILL.md is present', async () => {
    await expect(resolvePromptStackSystemAppendBlocksV1({
      surface: 'coding', sessionEntries: [{ id: 'bundle', ref: { kind: 'bundle', artifactId: 'bundle' }, enabled: true, required: true, placement: 'system_append' }],
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

  it('uses current placement, inherited exclusions and Memory-off policy for required Account entries', async () => {
    const scope = { serverId: 'home', accountId: 'account' };
    let kind = 'memory_doc.v1';
    const input = { surface: 'coding' as const, scope, memoryEnabled: false,
      accountEntries: [
        { ...entry('disabled'), enabled: false, required: true },
        { ...entry('excluded'), required: true },
        { ...entry('provider'), required: true, placement: 'provider_asset' as const },
        { ...entry('memory'), required: true },
      ], disabledInheritedEntryIds: ['excluded'],
      readArtifactHeader: async () => ({ header: { v: 1, kind, title: 'Current document' } }),
    };
    expect(await resolvePromptStackSystemAppendBlocksV1({ ...input,
      readArtifact: async () => { throw new Error('Memory-off must not demand a body'); },
    })).toEqual({ blocks: [], admittedEntries: [] });
    kind = 'prompt_doc.v2';
    expect((await resolvePromptStackSystemAppendBlocksV1({ ...input,
      readArtifact: async ref => artifact(ref.artifactId),
    })).blocks).toEqual(['memory']);
    kind = 'memory_doc.v1';
    await expect(resolvePromptStackSystemAppendBlocksV1({ ...input, accountEntries: [],
      readArtifact: async () => { throw new Error('Wrong-kind instructions must not demand a body'); },
      sessionEntries: [{ ...entry('session.instructions'), required: true }],
    })).rejects.toMatchObject({ code: 'attachment_unavailable', reason: 'wrong_kind' });
  });

  it('keeps transient optional entries pending while omitting only definitive absence and preserving cancellation', async () => {
    const scope = { serverId: 'home', accountId: 'account' };
    const readArtifact = async (ref: { artifactId: string }) => {
      if (ref.artifactId === 'optional') throw new Error('Home unavailable');
      return artifact(ref.artifactId);
    };
    const input = { surface: 'coding' as const, scope,
      accountEntries: [entry('optional'), { ...entry('required'), required: true }], readArtifact };
    await expect(resolvePromptStackSystemAppendBlocksV1(input)).rejects.toMatchObject({
      code: 'preparation_pending', reason: 'unavailable', admittedEntries: [
        { entryId: 'optional', outcome: 'unavailable', reason: 'unavailable', revision: null },
      ],
    });
    expect(await resolvePromptStackSystemAppendBlocksV1({ ...input,
      readArtifact: async ref => ref.artifactId === 'optional' ? null : artifact(ref.artifactId),
    })).toMatchObject({
      blocks: ['required'], admittedEntries: [
        { entryId: 'optional', outcome: 'unavailable', reason: 'not_found', revision: null },
        { entryId: 'required', outcome: 'ready' },
      ],
    });
    await expect(resolvePromptStackSystemAppendBlocksV1({ ...input,
      accountEntries: [{ ...entry('optional'), required: true }],
    })).rejects.toMatchObject({ code: 'preparation_pending', reason: 'unavailable' });
    const cancellation = new AbortController();
    const failure = new Error('Cancelled by user');
    await expect(resolvePromptStackSystemAppendBlocksV1({ ...input, signal: cancellation.signal,
      readArtifact: async () => { cancellation.abort(failure); throw failure; },
    })).rejects.toBe(failure);
  });

  it.each(['locked', 'malformed', 'wrong_kind'] as const)('refuses optional and required %s content and accepts a repaired retry', async reason => {
    const selected = entry('selected');
    const broken = reason === 'wrong_kind' ? { ...artifact('selected'), header: { v: 1, kind: 'other', title: 'Wrong kind' } }
      : { ...artifact('selected'), body: '{invalid-json' };
    const readArtifact = async () => {
      if (reason === 'locked') throw Object.assign(new Error('Private encryption detail'), { code: 'artifact_encryption_material_unavailable' });
      return broken;
    };
    await expect(resolvePromptStackSystemAppendBlocksV1({ surface: 'coding', accountEntries: [selected], readArtifact }))
      .rejects.toMatchObject({ code: 'attachment_unavailable', reason, ref: selected.ref,
        admittedEntries: [{ entryId: 'selected', outcome: 'unavailable', reason }] });
    await expect(resolvePromptStackSystemAppendBlocksV1({ surface: 'coding', accountEntries: [{ ...selected, required: true }], readArtifact }))
      .rejects.toMatchObject({ code: 'attachment_unavailable', reason, ref: selected.ref });
    expect((await resolvePromptStackSystemAppendBlocksV1({ surface: 'coding', accountEntries: [{ ...selected, required: true }],
      readArtifact: async () => artifact('selected', 'Repaired context'),
    })).blocks).toEqual(['Repaired context']);
  });

  it.each([true, false])('requires repair for retained Session Instructions pointing at memory when memoryEnabled=%s', async (memoryEnabled) => {
    const scope = { serverId: 'home', accountId: 'account', sessionId: 'session' };
    const metadata = writeSessionContextIntentV1ToMetadata({ work: {
      memoryEnabled, promptStack: [entry('session.memory', 'selected')],
    } }, buildSessionInstructionsContextIntentV1({ kind: 'doc', artifactId: 'selected' }));
    const memory = { id: 'selected', header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' },
      body: JSON.stringify(MemoryDocBodyV1Schema.parse({ v: 1, index: [{ id: 'fact', text: 'Remembered preference', createdAtMs: 1,
        sourceSessionRef: null }], topics: [] })), revision: { headerVersion: 3, bodyVersion: 7 } };
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
          body: JSON.stringify(MemoryDocBodyV1Schema.parse({ v: 1, index: [{ id: 'fact', text: 'Remembered preference', createdAtMs: 1,
            sourceSessionRef: null }], topics: [] })),
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

  it.each(['coding', 'voice'] as const)('loads only complete, budgeted decision index entries and topic summaries on %s, never decision metadata or topic detail', async surface => {
    const fact = (id: string, text: string) => ({ id, text, createdAtMs: 0, sourceSessionRef: null });
    const decision = { reason: 'Private review rationale', sourceMessageRef: { kind: 'session',
      session: { serverId: 'home', sessionId: 'source-session' }, messageId: 'committed-source' },
      approvedBy: { accountId: 'deciding-person', atMs: 1 } };
    const indexLine = '- Key preference [id: key; added: 1970-01-01]';
    const summaryLine = '- Topic: architecture — Design decisions';
    const index = `${indexLine}\n${summaryLine}`;
    const readArtifact = async () => ({ id: 'memory',
      header: { v: 1, kind: 'memory_doc.v1', title: 'Project memory' },
      body: JSON.stringify({ v: 1, index: [{ ...fact('key', 'Key preference'), decision }], topics: [
        { title: 'architecture', summary: 'Design decisions', facts: [{ ...fact('detail', 'Private on-demand topic detail'), decision }] },
        { title: 'archive', summary: 'Past facts', facts: [fact('old', 'Archived on-demand fact')] },
      ] }), revision: { headerVersion: 1, bodyVersion: 2 },
    });
    const result = await resolvePromptStackSystemAppendBlocksV1({
      surface, projectEntries: [{ ...entry('memory'), maxChars: index.length }],
      nowMs: () => 1, readArtifact,
    });
    expect(result.blocks).toEqual([`Memory: ${JSON.stringify({ document: 'Project memory', layer: 'project',
      ref: { kind: 'doc', artifactId: 'memory' } })}\n${index}`]);
    expect(result.admittedEntries).toEqual([expect.objectContaining({ memory: {
      loadedFactIds: ['key'], notLoadedFactIds: [], loadedTopicTitles: ['architecture'], notLoadedTopicTitles: ['archive'],
    } })]);
    await expect(resolvePromptStackSystemAppendBlocksV1({
      surface, projectEntries: [{ ...entry('memory'), maxChars: indexLine.length - 1 }],
      nowMs: () => 1, readArtifact,
    })).resolves.toMatchObject({ blocks: [expect.stringContaining(summaryLine)], admittedEntries: [expect.objectContaining({ memory: {
      loadedFactIds: [], notLoadedFactIds: ['key'], loadedTopicTitles: ['architecture'], notLoadedTopicTitles: ['archive'],
    } })] });
    await expect(resolvePromptStackSystemAppendBlocksV1({
      surface, projectEntries: [{ ...entry('memory'), maxChars: 0 }],
      nowMs: () => 1, readArtifact,
    })).resolves.toMatchObject({ blocks: [], admittedEntries: [{ entryId: 'memory', outcome: 'valid-empty', memory: {
      loadedFactIds: [], notLoadedFactIds: ['key'], loadedTopicTitles: [], notLoadedTopicTitles: ['architecture', 'archive'],
    } }] });
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
      surface: 'voice', scope, sessionEntries: [{ ...entry('selected'), required: true }],
      readArtifact: async () => { throw new Error('transport offline'); },
    })).rejects.toMatchObject({ status: 'preparation_pending', reason: 'unavailable', admittedEntries: [
      { entryId: 'selected', layer: 'session', scope, ref: { kind: 'doc', artifactId: 'selected', serverId: 'home' },
        outcome: 'unavailable', reason: 'unavailable', revision: null },
    ] });
  });

  it.each(['coding', 'voice'] as const)('never opens unknown-mode or mismatched content and respects requiredness on %s', async surface => {
    const scope = { serverId: 'home', accountId: 'account' };
    for (const memoryEnabled of [true, false]) {
      for (const required of [true, false]) {
        let errorCode: string | null = 'account_encryption_mode_unavailable';
        const read = async () => {
          if (errorCode) throw Object.assign(new Error(errorCode), { code: errorCode });
          return artifact('selected', 'Admitted context');
        };
        const input = { surface, scope, memoryEnabled,
          sessionEntries: [{ ...entry('selected'), required }],
          readArtifactHeader: read, readArtifact: read };
        const unavailable = resolvePromptStackSystemAppendBlocksV1(input);
        await expect(unavailable).rejects.toMatchObject({ code: 'preparation_pending', reason: 'unavailable', admittedEntries: [
          { entryId: 'selected', outcome: 'unavailable', reason: 'unavailable', revision: null },
        ] });
        // Missing currentness is retryable; a confirmed mode mismatch still needs repair.
        for (const lockedCode of ['artifact_account_mode_mismatch', 'artifact_encryption_material_unavailable']) {
          errorCode = lockedCode;
          const locked = resolvePromptStackSystemAppendBlocksV1(input);
          await expect(locked).rejects.toMatchObject({ code: 'attachment_unavailable', reason: 'locked', admittedEntries: [
            { entryId: 'selected', outcome: 'unavailable', reason: 'locked' },
          ] });
        }
        errorCode = null;
        await expect(resolvePromptStackSystemAppendBlocksV1(input)).resolves.toMatchObject({
          blocks: ['Admitted context'], admittedEntries: [{ entryId: 'selected', outcome: 'ready' }],
        });
      }
    }
  });

  it.each(['coding', 'voice'] as const)('keeps transient optional header/body failures pending and omits definitive absence on %s', async surface => {
    const scope = { serverId: 'home', accountId: 'account' };
    for (const memoryEnabled of [true, false]) {
      const args = { surface, scope, memoryEnabled,
        accountEntries: [entry('optional'), { ...entry('required'), required: true }],
        readArtifactHeader: async (ref: { artifactId: string }) => {
          if (ref.artifactId === 'optional') throw new Error('offline');
          return { header: artifact(ref.artifactId).header };
        },
        readArtifact: async (ref: { artifactId: string }) => {
          if (ref.artifactId === 'optional') throw new Error('offline');
          return artifact(ref.artifactId);
        } };
      await expect(resolvePromptStackSystemAppendBlocksV1(args)).rejects.toMatchObject({ code: 'preparation_pending', reason: 'unavailable',
        admittedEntries: [{ entryId: 'optional', outcome: 'unavailable', reason: 'unavailable' }] });
      await expect(resolvePromptStackSystemAppendBlocksV1({ ...args,
        readArtifactHeader: async ref => ref.artifactId === 'optional' ? null : { header: artifact(ref.artifactId).header },
        readArtifact: async ref => ref.artifactId === 'optional' ? null : artifact(ref.artifactId),
      })).resolves.toMatchObject({ blocks: ['required'],
        admittedEntries: [{ entryId: 'optional', outcome: 'unavailable', reason: 'not_found' },
          { entryId: 'required', outcome: 'ready' }] });
      await expect(resolvePromptStackSystemAppendBlocksV1({ ...args,
        accountEntries: [{ ...entry('optional'), required: true }] })).rejects.toMatchObject({ reason: 'unavailable' });
      const controller = new AbortController();
      controller.abort();
      await expect(resolvePromptStackSystemAppendBlocksV1({ ...args, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    }
  });

  it.each(['coding', 'voice'] as const)('keeps failed scope admission pending for optional and required entries on %s', async surface => {
    const args = { surface, accountEntries: [entry('optional')],
      readScope: async () => { throw new Error('Home offline'); },
      readArtifact: async () => { throw new Error('Must not read without scope'); } };
    await expect(resolvePromptStackSystemAppendBlocksV1(args)).rejects.toMatchObject({ code: 'preparation_pending',
      admittedEntries: [{ entryId: 'optional', scope: null, outcome: 'unavailable', reason: 'unavailable' }] });
    await expect(resolvePromptStackSystemAppendBlocksV1({ ...args,
      sessionEntries: [{ ...entry('required'), required: true }] })).rejects.toMatchObject({ reason: 'unavailable' });
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
              required: true,
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
