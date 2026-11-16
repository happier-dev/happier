import type { ThemeTryOnOwner } from '@/theme/profiles/themeTryOn';
import type { ThemeEditorDraft } from './themeProfileEditorActions';
import type { ThemeActionOutput } from '@happier-dev/protocol/actions/themeActionFamily';
import type { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';

export function useThemeProfileEditorPreview(input: Readonly<{
    owner: ThemeTryOnOwner;
    draft: ThemeEditorDraft | null;
    preview(draft: ThemeEditorDraft): Promise<ThemeActionOutput<typeof THEME_ACTION_IDS.tryOn>>;
    onFailure(error: unknown): void;
}>): void {
    // A receipt identifies this editor's effect; only the shared owner decides
    // whether that preview is still current.
    const receipt = React.useRef<string | null>(null);
    const document = input.draft?.document;
    const draft = input.draft?.draft;
    const mode = input.draft?.mode;
    const css = input.draft?.css;
    React.useEffect(() => {
        if (!document || !draft || !mode) return;
        const timeout = setTimeout(() => {
            void input.preview({ document, draft, mode, ...(css !== undefined ? { css } : {}) })
                .then(result => { receipt.current = result.previewRef; }, input.onFailure);
        }, 150);
        return () => clearTimeout(timeout);
    }, [css, document, draft, input.onFailure, input.preview, mode]);
    React.useEffect(() => () => {
        if (receipt.current === null) return;
        try { input.owner.revert(receipt.current); }
        catch (error) {
            if (readActionErrorCodeV1(error) !== 'theme_preview_stale') input.onFailure(error);
        }
    }, [input.onFailure, input.owner]);
}
import * as React from 'react';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
