import * as React from 'react';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ThemeTryOnOwner } from '@/theme/profiles/themeTryOn';
import type { ThemeEditorDraft } from './themeProfileEditorActions';
import type { ThemeActionOutput } from '@happier-dev/protocol/actions/themeActionFamily';
import type { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

export function useThemeProfileEditorPreview(input: Readonly<{
    owner: ThemeTryOnOwner;
    draft: ThemeEditorDraft | null;
    preview(draft: ThemeEditorDraft): Promise<ThemeActionOutput<typeof THEME_ACTION_IDS.tryOn>>;
    onFailure(error: unknown): void;
}>): void {
    const presented = useLayoutPresentationActive();
    // A receipt identifies this editor's effect; only the shared owner decides
    // whether that preview is still current.
    const receipt = React.useRef<string | null>(null);
    const document = input.draft?.document;
    const draft = input.draft?.draft;
    const mode = input.draft?.mode;
    const css = input.draft?.css;
    React.useLayoutEffect(() => {
        if (!presented || !input.draft) return;
        let previewRef: string | null = null;
        let leave: (() => void) | undefined;
        const update = () => {
            const current = input.owner.read();
            const next = current?.origin.kind === 'editor' ? current.previewRef : null;
            if (next === previewRef) return;
            previewRef = next;
            const previousLeave = leave;
            leave = next ? input.owner.present(next) : undefined;
            previousLeave?.();
        };
        const stop = input.owner.subscribe(update);
        update();
        return () => { stop(); leave?.(); };
    }, [input.owner, presented, Boolean(input.draft)]);
    const revert = React.useCallback((previewRef: string) => {
        try { input.owner.revert(previewRef); }
        catch (error) {
            if (readActionErrorCodeV1(error) !== 'theme_preview_stale') input.onFailure(error);
        }
    }, [input.onFailure, input.owner]);
    React.useEffect(() => {
        if (!presented || !document || !draft || !mode) return;
        let cancelled = false;
        const timeout = setTimeout(() => {
            void input.preview({ document, draft, mode, ...(css !== undefined ? { css } : {}) })
                .then(result => {
                    if (cancelled) revert(result.previewRef);
                    else receipt.current = result.previewRef;
                }, error => {
                    if (!cancelled) input.onFailure(error);
                });
        }, 150);
        return () => { cancelled = true; clearTimeout(timeout); };
    }, [css, document, draft, input.onFailure, input.preview, mode, presented, revert]);
    React.useEffect(() => () => {
        if (receipt.current === null) return;
        revert(receipt.current);
    }, [revert]);
}
