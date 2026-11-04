import { describe, expect, it, vi } from 'vitest';
import { projectBotTemplateContentV1, type BotTemplateDraftV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createBotTemplateEditorBuffer, type BotTemplateSave } from './botTemplateEditorBuffer';

const draft: BotTemplateDraftV1 = {
    v: 1, state: 'draft', sourceSessionRef: { serverId: 'home', sessionId: 'source' }, releaseArtifactId: 'release',
    content: { v: 1, identity: { name: 'Garden', description: 'Garden advice' }, instructions: { markdown: 'Original' },
        memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } },
    candidates: { memoryRules: [], skills: [] },
};

describe('template editor committed edits', () => {
    it('keeps unfinished need inputs in the shared buffer without saving them as template content', async () => {
        const buffer = createBotTemplateEditorBuffer({ draft, revision: { headerVersion: 1, bodyVersion: 1 } });
        const save = vi.fn<BotTemplateSave>(async () => ({ ok: true, revision: { headerVersion: 2, bodyVersion: 2 } }));
        buffer.editNeedAuthoring({ open: true, kind: 'mcpServers', name: 'Review helpers', endpoint: 'review-tools', envNames: 'ACCESS_TOKEN' });
        expect(buffer.getSnapshot().needAuthoring).toMatchObject({ open: true, name: 'Review helpers', endpoint: 'review-tools', envNames: 'ACCESS_TOKEN' });
        await buffer.commit(save);
        expect(save).not.toHaveBeenCalled();
        buffer.edit(current => ({ ...current, content: { ...current.content, firstTask: 'Review changes' } }));
        await buffer.commit(save);
        expect(save.mock.calls[0]?.[0]).not.toHaveProperty('needAuthoring');
        expect(buffer.getSnapshot().needAuthoring.name).toBe('Review helpers');
        buffer.editNeedAuthoring({ open: false });
        buffer.editNeedAuthoring({ open: true });
        expect(buffer.getSnapshot().needAuthoring.endpoint).toBe('review-tools');
    });

    it('reviews memory and general skill copies without changing source bytes, preserving binary companions and stable keys', async () => {
        const entries = [{ path: 'SKILL.md', contentKind: 'utf8' as const, contentBase64: encodeBase64(new TextEncoder().encode('---\nname: gardening\ndescription: Garden advice\n---\nPrivate notes')) },
            { path: 'seed.bin', contentKind: 'binary' as const, contentBase64: 'AP8B' }];
        const source: BotTemplateDraftV1 = { ...draft, candidates: {
            memoryRules: [{ key: 'personal', text: 'My address', personal: true, selected: false },
                { key: 'rule', text: 'Water at dusk', personal: false, selected: false }],
            skills: [{ key: 'skill', title: 'Gardening', bundleSchemaId: 'skills.skill_md_v1', entries, selection: 'private' }],
        } };
        const buffer = createBotTemplateEditorBuffer({ draft: source, revision: { headerVersion: 1, bodyVersion: 1 } });
        expect(projectBotTemplateContentV1(buffer.getSnapshot().draft)).toMatchObject({ memoryRules: [], skills: [] });
        buffer.selectMemory('rule', true);
        buffer.selectSkill('skill', 'general_copy');
        buffer.editSkillFile('skill', 'SKILL.md', '---\nname: gardening\ndescription: Garden advice\n---\nReusable advice');
        const portable = projectBotTemplateContentV1(buffer.getSnapshot().draft);
        expect(portable.memoryRules).toEqual([{ key: 'rule', text: 'Water at dusk' }]);
        expect(portable.skills[0]).toMatchObject({ key: 'skill', title: 'Gardening', entries: [
            { path: 'SKILL.md', contentBase64: encodeBase64(new TextEncoder().encode('---\nname: gardening\ndescription: Garden advice\n---\nReusable advice')) }, entries[1],
        ] });
        expect(source.candidates.skills[0]?.entries).toBe(entries);
        expect(source.candidates.skills[0]?.selection).toBe('private');
        expect(buffer.getSnapshot().draft.content).toBe(source.content);
        buffer.selectSkill('skill', 'as_is');
        expect(projectBotTemplateContentV1(buffer.getSnapshot().draft).skills[0]?.entries).toBe(entries);
        buffer.selectSkill('skill', 'private');
        expect(projectBotTemplateContentV1(buffer.getSnapshot().draft).skills).toEqual([]);
    });

    it('retains keystrokes locally, writes once on commit and adopts the acknowledged revision without rereading', async () => {
        const buffer = createBotTemplateEditorBuffer({ draft, revision: { headerVersion: 1, bodyVersion: 1 } });
        const save = vi.fn<BotTemplateSave>(async () => ({ ok: true as const, revision: { headerVersion: 2, bodyVersion: 2 } }));
        for (const markdown of ['N', 'Ne', 'New']) buffer.edit(current => ({ ...current,
            content: { ...current.content, instructions: { markdown } } }));
        expect(save).not.toHaveBeenCalled();
        expect(buffer.getSnapshot().status).toBe('unsaved');
        await buffer.commit(save);
        expect(save).toHaveBeenCalledTimes(1);
        expect(save.mock.calls[0]?.[0]).toMatchObject({ draft: { content: { instructions: { markdown: 'New' } } },
            revision: { headerVersion: 1, bodyVersion: 1 } });
        expect(buffer.getSnapshot()).toMatchObject({ status: 'saved', revision: { headerVersion: 2, bodyVersion: 2 } });
        await buffer.commit(save);
        expect(save).toHaveBeenCalledTimes(1);
    });

    it('keeps text after failure and conflict and never silently replaces it with the other revision', async () => {
        const buffer = createBotTemplateEditorBuffer({ draft, revision: { headerVersion: 1, bodyVersion: 1 } });
        buffer.edit(current => ({ ...current, content: { ...current.content, instructions: { markdown: 'Keep this' } } }));
        await buffer.commit(async () => ({ ok: false, code: 'network_error' }));
        expect(buffer.getSnapshot()).toMatchObject({ status: 'failed', errorCode: 'network_error',
            draft: { content: { instructions: { markdown: 'Keep this' } } } });
        await buffer.commit(async () => ({ ok: false, code: 'version_mismatch' }));
        expect(buffer.getSnapshot()).toMatchObject({ status: 'conflict', draft: { content: { instructions: { markdown: 'Keep this' } } } });
    });

    it('shares an in-flight commit and preserves newer local typing after its earlier save settles', async () => {
        const buffer = createBotTemplateEditorBuffer({ draft, revision: { headerVersion: 1, bodyVersion: 1 } });
        buffer.edit(current => ({ ...current, content: { ...current.content, firstTask: 'First edit' } }));
        let settle!: (value: { ok: true; revision: { headerVersion: number; bodyVersion: number } }) => void;
        const save = vi.fn(() => new Promise<{ ok: true; revision: { headerVersion: number; bodyVersion: number } }>(resolve => { settle = resolve; }));
        const pending = buffer.commit(save);
        const same = buffer.commit(save);
        buffer.edit(current => ({ ...current, content: { ...current.content, firstTask: 'Newer edit' } }));
        settle({ ok: true, revision: { headerVersion: 2, bodyVersion: 2 } });
        await Promise.all([pending, same]);
        expect(save).toHaveBeenCalledTimes(1);
        expect(buffer.getSnapshot()).toMatchObject({ status: 'unsaved', draft: { content: { firstTask: 'Newer edit' } },
            revision: { headerVersion: 2, bodyVersion: 2 } });
    });

    it('saves a second explicitly committed edit after the first save using its acknowledged revision', async () => {
        const buffer = createBotTemplateEditorBuffer({ draft, revision: { headerVersion: 1, bodyVersion: 1 } });
        let settle!: (value: { ok: true; revision: { headerVersion: number; bodyVersion: number } }) => void;
        const save = vi.fn<BotTemplateSave>().mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }))
            .mockResolvedValueOnce({ ok: true, revision: { headerVersion: 3, bodyVersion: 3 } });
        buffer.edit(current => ({ ...current, content: { ...current.content, firstTask: 'Field A' } }));
        const first = buffer.commit(save);
        buffer.edit(current => ({ ...current, content: { ...current.content, instructions: { markdown: 'Field B' } } }));
        const second = buffer.commit(save);
        settle({ ok: true, revision: { headerVersion: 2, bodyVersion: 2 } });
        await Promise.all([first, second]);
        expect(save).toHaveBeenCalledTimes(2);
        expect(save.mock.calls[1]?.[0]).toMatchObject({ revision: { headerVersion: 2, bodyVersion: 2 },
            draft: { content: { firstTask: 'Field A', instructions: { markdown: 'Field B' } } } });
        expect(buffer.getSnapshot()).toMatchObject({ status: 'saved', revision: { headerVersion: 3, bodyVersion: 3 } });
    });
});
