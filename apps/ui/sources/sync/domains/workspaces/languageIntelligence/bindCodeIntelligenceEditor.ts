import type { CodeEditorHandle, CodeEditorLanguageIntelligence } from '@/components/ui/code/editor/codeEditorTypes';
import type { CodeIntelligenceController } from './createCodeIntelligenceController';

export function bindCodeIntelligenceEditor(controller: CodeIntelligenceController, editor: Pick<CodeEditorHandle, 'onPointerPosition' | 'onActivatePosition'>
    & Partial<Pick<CodeEditorHandle, 'getValue' | 'inlineSuggestions' | 'setLanguageIntelligence'>>,
    preferences?: Pick<CodeEditorLanguageIntelligence, 'path' | 'inlayHints' | 'semanticHighlighting' | 'referencePreview' | 'nextEditKeys'>): () => void {
    if (preferences) editor.setLanguageIntelligence?.({ request: controller.request, getSnapshot: controller.getSnapshot, subscribe: controller.subscribe,
        nextEditSuggestions: controller.nextEditSuggestions, ...preferences });
    const stopPointer = editor.onPointerPosition?.(position => controller.inspect(position ? { line: position.line - 1, character: position.character, anchor: position.rect } : null));
    const stopActivation = editor.onActivatePosition?.(position => { void controller.definition({ line: position.line - 1, character: position.character }); });
    const inline = editor.inlineSuggestions;
    let stopInline: (() => void) | undefined;
    if (inline && editor.getValue) {
        const update = () => {
            const context = inline.getContext();
            if (context) controller.inlineSuggestions.updateContext(context, editor.getValue!());
            else controller.inlineSuggestions.retire();
        };
        const project = () => inline.set(controller.inlineSuggestions.getSnapshot().suggestion);
        const stopProjection = controller.inlineSuggestions.subscribe(project);
        const stopContext = inline.subscribeContext(update);
        const stopEvent = inline.onEvent(event => controller.inlineSuggestions.onEvent(event));
        inline.setAcceptGuard(id => {
            const context = inline.getContext();
            return context !== null && controller.inlineSuggestions.canAccept(id, context, editor.getValue!());
        });
        update(); project();
        stopInline = () => {
            inline.setAcceptGuard(null); stopProjection(); stopContext(); stopEvent();
            controller.inlineSuggestions.retire(); inline.set(null);
        };
    }
    return () => { stopPointer?.(); stopActivation?.(); stopInline?.(); editor.setLanguageIntelligence?.(null); };
}
