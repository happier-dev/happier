import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { mergeThemeProfileDocumentEdit, type ThemeProfileDocument, type ThemeProfileMode, type ThemeReference } from '@happier-dev/protocol/account/settings/themeProfiles';
import type { ThemeUiActionExecute } from './useThemeActionExecution';

export type ThemeEditorExecute = ThemeUiActionExecute;
export type ThemeEditorDraft = Readonly<{ document: ThemeProfileDocument; mode: ThemeProfileMode }>;

/** The mounted editor supplies its captured Action executor; persistence and the
 * single temporary preview remain with their existing Action owners. */
export function createThemeProfileEditorActions(execute: ThemeEditorExecute) {
    const tryDocument = (document: ThemeProfileDocument, mode: ThemeProfileMode, transition?: 'none') =>
        execute(THEME_ACTION_IDS.tryOn, { document, mode, origin: { kind: 'editor' }, ...(transition ? { transition } : {}) });
    return {
        preview(input: ThemeEditorDraft) { return tryDocument(input.document, input.mode, 'none'); },
        async saveAndUse(input: ThemeEditorDraft & Readonly<{ reference?: ThemeReference }>) {
            let document = input.document;
            if (input.reference) {
                const saved = await execute(THEME_ACTION_IDS.save, { document, ref: input.reference });
                document = mergeThemeProfileDocumentEdit(document, { id: saved.entry.id });
            }
            const preview = await tryDocument(document, input.mode);
            const { entry } = await execute(THEME_ACTION_IDS.keep, { previewRef: preview.previewRef });
            if (entry === null) {
                throw createActionExecuteFailureError({ ok: false, errorCode: 'theme_not_found', error: 'theme_not_found' });
            }
            return entry;
        },
    };
}
