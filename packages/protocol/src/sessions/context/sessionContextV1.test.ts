import { describe, expect, it } from 'vitest';
import { buildSessionInstructionsContextIntentV1 } from '../../actions/sessionStateFieldActions.js';
import { admitSessionContextIntentV1, readSessionMemoryEnabledV1, SessionContextIntentV1Schema, writeSessionContextIntentV1ToMetadata } from './sessionContextV1.js';

describe('Session context field owner', () => {
  it('requires a PromptDoc for reserved Session Instructions while admitting ordinary memory context', async () => {
    const intent = buildSessionInstructionsContextIntentV1({ kind: 'doc', artifactId: 'selected', serverId: 'home-2' });
    const readMemoryHeader = async () => ({ header: { v: 1, kind: 'memory_doc.v1', title: 'Memory' } });
    await expect(admitSessionContextIntentV1(intent, readMemoryHeader))
      .rejects.toMatchObject({ code: 'attachment_unavailable', reason: 'wrong_kind',
        ref: { kind: 'doc', artifactId: 'selected', serverId: 'home-2' } });
    const memoryIntent = SessionContextIntentV1Schema.parse({ kind: 'attach', entry: {
      id: 'session.memory', ref: { kind: 'doc', artifactId: 'selected', serverId: 'home-2' },
    } });
    await expect(admitSessionContextIntentV1(memoryIntent, readMemoryHeader)).resolves.toEqual(memoryIntent);
    await expect(admitSessionContextIntentV1(intent, async () => ({ header: {
      v: 1, kind: 'prompt_doc.v2', title: 'Instructions',
    } }))).resolves.toEqual(intent);
  });

  it('admits attachments from the current qualified header and rejects a dashboard before mutation', async () => {
    const intent = SessionContextIntentV1Schema.parse({ kind: 'attach', entry: {
      id: 'context', ref: { kind: 'bundle', artifactId: 'dashboard', serverId: 'home-2' },
    } });
    await expect(admitSessionContextIntentV1(intent, async ref => {
      expect(ref.serverId).toBe('home-2');
      return { header: { v: 1, kind: 'prompt_bundle.v2', title: 'Dashboard', bundleSchemaId: 'dashboard.v1' } };
    })).rejects.toMatchObject({ code: 'attachment_unavailable', reason: 'malformed' });
    await expect(admitSessionContextIntentV1(intent, async () => ({ header: {
      v: 1, kind: 'prompt_bundle.v2', title: 'Instructions', bundleSchemaId: 'skills.skill_md_v1',
    } }))).resolves.toEqual(intent);
    const docIntent = SessionContextIntentV1Schema.parse({ kind: 'attach', entry: {
      id: 'memory', ref: { kind: 'doc', artifactId: 'memory' },
    } });
    await expect(admitSessionContextIntentV1(docIntent, async () => ({ header: {
      v: 1, kind: 'memory_doc.v1', title: 'Memory',
    } }))).resolves.toEqual(docIntent);
    await expect(admitSessionContextIntentV1(intent, async () => null))
      .rejects.toMatchObject({ code: 'attachment_unavailable', reason: 'not_found' });
  });
  it('edits only selected entries and local inherited switches, preserving stored placements and Notes', () => {
    const metadata = { summary: { text: 'Keep title', updatedAt: 1 }, work: { memoryEnabled: false,
      sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Keep notes' },
      promptStack: [{ id: 'first', ref: { kind: 'doc', artifactId: 'shared-doc' }, enabled: true, placement: 'composer_insert', maxChars: 12 }],
    } };
    const attached = writeSessionContextIntentV1ToMetadata(metadata, SessionContextIntentV1Schema.parse({ kind: 'attach', entry: {
      id: 'second', ref: { kind: 'doc', artifactId: 'shared-doc' }, enabled: true,
    } }));
    const disabled = writeSessionContextIntentV1ToMetadata(attached, { kind: 'inherited_enable', entryId: 'first', enabled: false });
    expect(disabled.work).toMatchObject({ memoryEnabled: false, disabledInheritedEntryIds: ['first'],
      sessionRolesV1: metadata.work.sessionRolesV1, promptStack: [metadata.work.promptStack[0], { id: 'second', placement: 'system_append', enabled: true }] });
    const moved = writeSessionContextIntentV1ToMetadata(disabled, { kind: 'reorder', entryId: 'second', siblingId: 'first', position: 'before' });
    const cleared = writeSessionContextIntentV1ToMetadata(moved, { kind: 'set_budget', entryId: 'first', maxChars: null });
    expect(cleared.work.promptStack.map((entry) => entry.id)).toEqual(['second', 'first']);
    expect(cleared.work.promptStack[1]).not.toHaveProperty('maxChars');
    expect(cleared.work.promptStack[1]).toHaveProperty('placement', 'composer_insert');
    expect(cleared.summary).toEqual(metadata.summary);
    expect(() => writeSessionContextIntentV1ToMetadata(attached, SessionContextIntentV1Schema.parse({ kind: 'attach', entry: {
      id: 'first', ref: { kind: 'doc', artifactId: 'different-doc' },
    } }))).toThrow('entry_conflict');
  });

  it('refuses new attachment authority fields and non-system placements without rewriting retained entries', () => {
    for (const entry of [
      { id: 'entry', ref: { kind: 'doc', artifactId: 'doc', credentials: 'forged' } },
      { id: 'entry', ref: { kind: 'doc', artifactId: 'doc' }, placement: 'composer_insert' },
    ]) expect(SessionContextIntentV1Schema.safeParse({ kind: 'attach', entry }).success).toBe(false);
  });

  it('reads only the retained Session choice or kind baseline, including malformed-present fail-off', () => {
    expect(readSessionMemoryEnabledV1({})).toBe(false);
    expect(readSessionMemoryEnabledV1({ bot: { kind: 'bot' } })).toBe(true);
    expect(readSessionMemoryEnabledV1({ work: { bot: { kind: 'bot' } } })).toBe(true);
    expect(readSessionMemoryEnabledV1({ bot: { kind: 'bot' }, work: { memoryEnabled: false } })).toBe(false);
    expect(readSessionMemoryEnabledV1({ bot: { kind: 'bot' }, work: { memoryEnabled: 'true' } })).toBe(false);
  });
});
