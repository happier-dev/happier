import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import * as library from '../prompts/library/promptLibraryActionOperations.js';
import { encodeBase64 } from '../crypto/base64.js';
import { computePromptBundleDigestV1 } from '../prompts/library/promptLibraryDigests.js';
import { SkillReadResultV1Schema } from '../prompts/library/skills/skillReadV1.js';
import { readReadOnlySkillContentV1 } from '../prompts/library/promptBundleSchemas.js';

const skillMd = '---\nname: review\ndescription: Review the current change\n---\nPrivate full skill instructions';
const entries = [
  { path: 'SKILL.md', contentBase64: encodeBase64(new TextEncoder().encode(skillMd)), contentKind: 'utf8' as const },
  { path: 'scripts/check.bin', contentBase64: 'AAEC/w==', contentKind: 'binary' as const, unixMode: 0o755 },
];
const body = { v: 1 as const, entries, createdAtMs: 1, updatedAtMs: 1 };

describe('skills.read Action', () => {
  it('resolves a delivered qualified skill identity supplied as a native name', async () => {
    const content = readReadOnlySkillContentV1('happier:happier')!;
    const executor = createActionExecutor({ skillsRead: request => library.readSkillInLibrary({ request,
      sessionItems: [{ skillId: 'happier:happier', name: 'happier', digest: content.digest }],
      store: { read: async () => { throw new Error('Bundled read must not fetch an Artifact'); } },
    }) });
    expect(await executor.execute('skills.read', { name: 'happier:happier', sessionId: 'session' }, { surface: 'mcp' }))
      .toMatchObject({ ok: true, result: { skillId: 'happier:happier', skillMd: content.skillMd } });
    expect(await executor.execute('skills.read', { name: 'happier:outside', sessionId: 'session' }, { surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'not_found' });
  });
  it('records only admitted session reads and returns usage through the strict read consumer', async () => {
    const recorded: string[] = [];
    const executor = createActionExecutor({ skillsRead: request => library.readSkillInLibrary({
      request, sessionItems: [{ skillId: 'selected', name: 'review', digest: computePromptBundleDigestV1(body) }],
      usage: { v: 1, lastUsedAt: { selected: 123 } },
      recordSessionUse: async item => { recorded.push(item.skillId); return true; },
      store: { read: async id => ({ id, revision: { headerVersion: 1, bodyVersion: 1 },
        header: { v: 1, kind: 'prompt_bundle.v2', title: 'Review', bundleSchemaId: 'skills.skill_md_v1' }, body: JSON.stringify(body) }) },
    }) });
    const result = await executor.execute('skills.read', { name: 'review', sessionId: 'session' }, { surface: 'mcp' });
    expect(result).toMatchObject({ ok: true, result: { lastUsedAt: 123 } });
    if (!result.ok || !('result' in result)) throw new Error('Expected skill result');
    expect(SkillReadResultV1Schema.parse(result.result).lastUsedAt).toBe(123);
    expect(recorded).toEqual(['selected']);
    await executor.execute('skills.read', { skillId: 'selected' }, { surface: 'ui' });
    await executor.execute('skills.read', { name: 'unknown', sessionId: 'session' }, { surface: 'mcp' });
    await executor.execute('skills.read', { skillId: 'selected', sessionId: 'session', file: 'missing' }, { surface: 'mcp' });
    expect(recorded).toEqual(['selected']);
  });

  it('rejects a read whose owning session plan retired before recording', async () => {
    const result = await library.readSkillInLibrary({ request: { skillId: 'selected', sessionId: 'session' },
      sessionItems: [{ skillId: 'selected', name: 'review', digest: computePromptBundleDigestV1(body) }],
      recordSessionUse: async () => false,
      store: { read: async id => ({ id, revision: { headerVersion: 1, bodyVersion: 1 },
        header: { v: 1, kind: 'prompt_bundle.v2', title: 'Review', bundleSchemaId: 'skills.skill_md_v1' }, body: JSON.stringify(body) }) },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'not_found' });
  });

  it('reads only the session-resolved identity by name, with complete supporting bytes and modes', async () => {
    // The Artifact and current owning-session plan are external inputs. Admission,
    // bundle decoding and identity selection remain real.
    const executor = createActionExecutor({
      skillsRead: async request => library.readSkillInLibrary({
        request, sessionItems: request.sessionId === 'session' ? [{ skillId: 'selected', name: 'review', digest: computePromptBundleDigestV1(body) }] : null,
        store: { read: async id => ({ id, revision: { headerVersion: 1, bodyVersion: 1 },
          header: { v: 1, kind: 'prompt_bundle.v2', title: 'Review', bundleSchemaId: 'skills.skill_md_v1' },
          body: JSON.stringify(body) }) },
      }),
    });
    for (const surface of ['ui', 'cli', 'agent', 'mcp', 'rpc'] as const) {
      const result = await executor.execute('skills.read', { name: 'review', sessionId: 'session', file: 'scripts/check.bin' },
        { surface, authority: 'account_automation', defaultSessionId: 'session' });
      expect(result, JSON.stringify({ surface, result })).toMatchObject({ ok: true, result: {
          skillId: 'selected', name: 'review', skillMd,
          files: [{ path: 'SKILL.md', bytes: new TextEncoder().encode(skillMd).length },
            { path: 'scripts/check.bin', bytes: 4, unixMode: 0o755 }],
          file: { path: 'scripts/check.bin', contentBase64: 'AAEC/w==', contentKind: 'binary', unixMode: 0o755 },
        } });
    }
    expect(await executor.execute('skills.read', { name: 'review', sessionId: 'other' }, { surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'not_found' });
    expect(await executor.execute('skills.read', { skillId: 'outside', sessionId: 'session' }, { surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'not_found' });
    expect(await executor.execute('skills.read', { name: 'review' }, { surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(await executor.execute('skills.read', { skillId: 'selected', file: '../secret' }, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'not_found' });
    const stale = createActionExecutor({ skillsRead: request => library.readSkillInLibrary({ request,
      sessionItems: [{ skillId: 'selected', name: 'review', digest: 'sha256:stale' }],
      store: { read: async id => ({ id, revision: { headerVersion: 1, bodyVersion: 1 },
        header: { v: 1, kind: 'prompt_bundle.v2', title: 'Review', bundleSchemaId: 'skills.skill_md_v1' }, body: JSON.stringify(body) }) },
    }) });
    expect(await stale.execute('skills.read', { name: 'review', sessionId: 'session' }, { surface: 'mcp' }))
      .toMatchObject({ ok: false, errorCode: 'not_found' });
  });

  it('does not disclose missing, invalid or non-skill bundles', async () => {
    for (const artifact of [null, { id: 'generic', revision: { headerVersion: 1, bodyVersion: 1 },
      header: { v: 1, kind: 'prompt_bundle.v2', title: 'Generic', bundleSchemaId: 'bundle.generic_v1' },
      body: JSON.stringify({ v: 1, entries, createdAtMs: 1, updatedAtMs: 1 }) }]) {
      const executor = createActionExecutor({ skillsRead: request => library.readSkillInLibrary({
        request, store: { read: async () => artifact },
      }) });
      expect(await executor.execute('skills.read', { skillId: 'generic' }, { surface: 'ui' }))
        .toMatchObject({ ok: false, errorCode: 'not_found' });
    }
  });
});
