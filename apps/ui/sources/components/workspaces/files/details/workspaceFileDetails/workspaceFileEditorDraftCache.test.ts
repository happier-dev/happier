import { afterEach, describe, expect, it } from 'vitest';

import { readWorkspaceFileEditorDraft, workspaceFileEditorDraftCache } from './workspaceFileEditorDraftCache';

const address = { workspaceCacheKey: 'home:machine:/project', filePath: '.happier/project.json' };
const aliceDraft = { accountId: 'alice', isEditingFile: true, editorOriginalText: '{"version":1}', editorOriginalHash: 'a'.repeat(64), editorText: '{"version":' };

afterEach(() => {
    for (const accountId of ['alice', 'bob']) workspaceFileEditorDraftCache.setDraft({ ...address, accountId, draft: null });
});

describe('workspace file editor draft ownership', () => {
    it('isolates private drafts by Account while retaining the same Account’s exact invalid bytes', () => {
        workspaceFileEditorDraftCache.setDraft({ ...address, accountId: 'alice', draft: aliceDraft });
        expect(workspaceFileEditorDraftCache.getDraft({ ...address, accountId: 'bob' })).toBeNull();
        workspaceFileEditorDraftCache.setDraft({ ...address, accountId: 'bob', draft: { ...aliceDraft, accountId: 'bob', editorText: '{"version":1,"bob":true}' } });
        expect(workspaceFileEditorDraftCache.getDraft({ ...address, accountId: 'alice' })).toEqual(aliceDraft);
    });

    it('neither restores nor persists private drafts when Account authority is unavailable', () => {
        workspaceFileEditorDraftCache.setDraft({ ...address, accountId: 'alice', draft: aliceDraft });
        expect(workspaceFileEditorDraftCache.getDraft({ ...address, accountId: null })).toBeNull();
        workspaceFileEditorDraftCache.setDraft({ ...address, accountId: null, draft: { ...aliceDraft, editorText: 'unowned' } });
        expect(workspaceFileEditorDraftCache.getDraft({ ...address, accountId: 'alice' })).toEqual(aliceDraft);
    });

    it('does not admit a draft tagged for a different Account', () => {
        workspaceFileEditorDraftCache.setDraft({ ...address, accountId: 'bob', draft: aliceDraft });
        expect(workspaceFileEditorDraftCache.getDraft({ ...address, accountId: 'bob' })).toBeNull();
    });

    it('qualifies persisted bytes and editing metadata before any pane consumer receives them', () => {
        expect(readWorkspaceFileEditorDraft(aliceDraft, 'alice')).toEqual(aliceDraft);
        expect(readWorkspaceFileEditorDraft(aliceDraft, 'bob')).toBeNull();
        expect(readWorkspaceFileEditorDraft(aliceDraft, null)).toBeNull();
        const legacy = { isEditingFile: true, editorOriginalText: 'original', editorText: 'unqualified private bytes' };
        expect(readWorkspaceFileEditorDraft(legacy, 'alice')).toBeNull();
        expect(legacy.editorText).toBe('unqualified private bytes');
    });
});
