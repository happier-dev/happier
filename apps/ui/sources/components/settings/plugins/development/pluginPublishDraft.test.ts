import { describe, expect, it } from 'vitest';
import { createPluginPublishDraft, publicationDraftsEqual, publicationFromDraft, parsePluginPublishDraftPatch } from './pluginPublishDraft';

describe('mounted publication draft', () => {
    it('admits typed current-context field edits and rejects unknown or mistyped fields', () => {
        expect(parsePluginPublishDraftPatch({ title: 'Edited', github: true })).toEqual({ title: 'Edited', github: true });
        expect(parsePluginPublishDraftPatch({ version: false })).toBeNull();
        expect(parsePluginPublishDraftPatch({ unknown: 'x' })).toBeNull();
    });
    it('keeps independent field edits and publishes only changed values', () => {
        const draft = createPluginPublishDraft({ title: 'Triage', version: '1.2.0' });
        let changes = 0;
        const stop = draft.subscribe(() => { changes += 1; });
        draft.getState().patch({ title: 'Issue triage' });
        expect(draft.getState().fields).toMatchObject({ title: 'Issue triage', version: '1.2.0' });
        expect(changes).toBe(1);
        const stable = draft.getState();
        draft.getState().patch({ title: 'Issue triage' });
        expect(draft.getState()).toBe(stable);
        expect(changes).toBe(1);
        stop();
    });
    it('keeps the reviewed package current when only optional GitHub effects change', () => {
        const draft = createPluginPublishDraft({ title: 'Triage', version: '1.2.0' });
        const reviewed = draft.getState().fields;
        draft.getState().patch({ github: true, branch: 'main', release: false });
        expect(publicationDraftsEqual(draft.getState().fields, reviewed)).toBe(true);
        draft.getState().patch({ changelog: 'New release notes' });
        expect(publicationDraftsEqual(draft.getState().fields, reviewed)).toBe(false);
    });
    it('keeps selected public icon bytes in the reviewed publication', () => {
        const draft = createPluginPublishDraft({ iconDataBase64: 'UE5H' });
        expect(publicationFromDraft(draft.getState().fields).iconSource).toEqual({ dataBase64: 'UE5H', contentType: 'image/png' });
        const reviewed = draft.getState().fields;
        draft.getState().patch({ iconDataBase64: 'TkVX' });
        expect(publicationDraftsEqual(draft.getState().fields, reviewed)).toBe(false);
    });
});
