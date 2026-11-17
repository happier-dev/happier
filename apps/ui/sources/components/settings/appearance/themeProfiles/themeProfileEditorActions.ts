import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { mergeThemeProfileDocumentEdit, type ThemeProfileDocument, type ThemeProfileMode, type ThemeProfileV1, type ThemeReference } from '@happier-dev/protocol/account/settings/themeProfiles';
import type { ThemeUiActionExecute } from './useThemeActionExecution';

export type ThemeEditorExecute = ThemeUiActionExecute;
export type ThemeEditorDraft = Readonly<{ document: ThemeProfileDocument; draft: ThemeProfileV1; mode: ThemeProfileMode; css?: string }>;

function editedDocument(input: ThemeEditorDraft): ThemeProfileDocument {
    const draft = { ...input.draft, ...(input.css !== undefined ? { css: input.css } : {}) };
    const removeKnownFields = (['seeds', 'style', 'css'] as const).filter(field => draft[field] === undefined);
    return mergeThemeProfileDocumentEdit(input.document, draft, { removeKnownFields });
}

/** The mounted editor supplies its captured Action executor; persistence and the
 * single temporary preview remain with their existing Action owners. */
export function createThemeProfileEditorActions(execute: ThemeEditorExecute) {
    const tryDocument = (document: ThemeProfileDocument, mode: ThemeProfileMode) =>
        execute(THEME_ACTION_IDS.tryOn, { document, mode, origin: { kind: 'editor' } });
    return {
        preview(input: ThemeEditorDraft) { return tryDocument(editedDocument(input), input.mode); },
        async saveAndUse(input: ThemeEditorDraft & Readonly<{ reference?: ThemeReference }>) {
            let document = editedDocument(input);
            if (input.reference) {
                const saved = await execute(THEME_ACTION_IDS.save, { document, ref: input.reference });
                document = mergeThemeProfileDocumentEdit(document, { id: saved.entry.id });
            }
            const preview = await tryDocument(document, input.mode);
            return execute(THEME_ACTION_IDS.keep, { previewRef: preview.previewRef });
        },
    };
}
