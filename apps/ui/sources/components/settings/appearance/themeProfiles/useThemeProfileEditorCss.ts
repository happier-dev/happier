import * as React from 'react';
import { getThemeSurfaceReference, type SurfaceId } from '@happier-dev/plugin-sdk/ui';
import type { ThemeProfileDocument, ThemeProfileMode, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import type { CodeEditorHandle, EditorDecoration } from '@/components/ui/code/editor/codeEditorTypes';
import { projectThemeSurfacePaintMap } from '@/theme/css/themeSurfacePaintMap';
import { usePreparedThemeCss } from '@/theme/css/usePreparedThemeCss';
import { useThemeColorInspector, type ThemeInspectionTarget } from '@/theme/css/useThemeColorInspector';
import { THEME_PROFILE_TOKEN_DEFINITIONS_BY_ID } from '@/theme/profiles/themeProfileTokenRegistry';
import { t } from '@/text';
import type { ThemeEditorView, ThemeProfileEditorViewProps } from './themeProfileEditorViewTypes';

const EMPTY_IDS: readonly string[] = [];
const excludeEditor = (element: Element) => Boolean(element.closest('[data-testid="settings-theme-profile-editor"]'));

function editableTokens(target: ThemeInspectionTarget): readonly string[] {
    return [...new Set(target.paintRoles.flatMap(role => role.source.kind === 'token' ? [role.source.ref]
        : role.source.kind === 'derived' ? role.source.from : EMPTY_IDS))]
        .filter(id => THEME_PROFILE_TOKEN_DEFINITIONS_BY_ID[id] !== undefined);
}
function tokenLabel(id: string): string {
    const token = THEME_PROFILE_TOKEN_DEFINITIONS_BY_ID[id];
    return token?.labelKey ? t(token.labelKey) : token?.label ?? id;
}

/** Existing editor views consume the CSS and paint owners only while demanded. */
export function useThemeProfileEditorCss(input: Readonly<{
    draft: ThemeProfileV1 | null;
    mode: ThemeProfileMode;
    view: ThemeEditorView;
    presented: boolean;
    readonly: boolean;
    document: (profile: ThemeProfileV1) => ThemeProfileDocument;
    editorRef: React.RefObject<CodeEditorHandle | null>;
    onChange: (css: string) => void;
    onViewChange: (view: ThemeEditorView) => void;
    onQueryChange: (query: string) => void;
}>) {
    const [pickedTokenIds, setPickedTokenIds] = React.useState<readonly string[] | undefined>();
    const getPaintMap = React.useCallback(() => input.draft
        ? projectThemeSurfacePaintMap(input.document(input.draft), input.mode) : [],
    [input.draft, input.document, input.mode]);
    const onPick = React.useCallback((target: ThemeInspectionTarget) => {
        const ids = editableTokens(target);
        setPickedTokenIds(ids);
        input.onQueryChange('');
        input.onViewChange('colors');
    }, [input.onQueryChange, input.onViewChange]);
    const inspector = useThemeColorInspector({ paintMap: getPaintMap, onPick,
        onCancel: () => setPickedTokenIds(undefined), excludeElement: excludeEditor });
    React.useEffect(() => {
        if (!input.presented || input.view === 'css') inspector.cancel();
    }, [input.presented, input.view, inspector.cancel]);
    const toggle = React.useCallback(() => {
        if (inspector.active) inspector.cancel();
        else inspector.activate();
    }, [inspector.active, inspector.activate, inspector.cancel]);
    const active = input.presented && (input.view === 'css' || inspector.active);
    const source = input.draft?.css ?? '';
    const { prepared, error } = usePreparedThemeCss(active ? source : '', active);
    const facts = React.useMemo(() => {
        if (!active || !prepared) return null;
        const coverage = prepared.detailedCoverage;
        const reasons = coverage.rules.flatMap(rule => rule.reasons.map((reason, index) => ({
            id: `${rule.ruleIndex}:${index}`, range: reason.range,
            message: `${reason.kind}: ${reason.property ?? rule.selector}`, stripped: reason.kind === 'stripped',
        })));
        const represented = new Set(reasons.filter(reason => reason.stripped).map(reason => `${reason.range.start}:${reason.range.end}`));
        reasons.push(...coverage.stripped.filter(item => !represented.has(`${item.range.start}:${item.range.end}`))
            .map((item, index) => ({ id: `stripped:${index}`, range: item.range, message: item.reason, stripped: true })));
        const decorations: EditorDecoration[] = reasons.map(reason => {
            const lines = source.slice(reason.range.start, reason.range.end).split('\n');
            return { layer: 'diagnostic', id: reason.id, severity: reason.stripped ? 'warning' : 'information',
                startLine: reason.range.line, startCharacter: reason.range.column - 1,
                endLine: reason.range.line + lines.length - 1,
                endCharacter: lines.length === 1 ? reason.range.column - 1 + lines[0]!.length : lines[lines.length - 1]!.length,
                message: reason.message, source: 'CSS' };
        });
        return { counts: { total: coverage.total, native: coverage.native, webOnly: coverage.webOnly },
            webOnlyRules: coverage.rules.filter(rule => !rule.native).map(rule => ({ line: rule.range.line, selector: rule.selector })),
            decorations };
    }, [active, prepared, source]);
    const decorate = React.useCallback(() => {
        input.editorRef.current?.setDecorations('diagnostic', facts?.decorations ?? []);
    }, [input.editorRef, facts]);
    React.useEffect(decorate, [decorate]);
    const surfaces = React.useMemo(() => active ? getThemeSurfaceReference() : undefined, [active]);
    const reveal = React.useCallback((line: number) => {
        input.editorRef.current?.revealLine(line, { focus: true, select: true });
    }, [input.editorRef]);
    const insert = React.useCallback(async (surface: SurfaceId) => {
        if (input.readonly) return;
        const editor = input.editorRef.current;
        await editor?.flushPendingChange();
        const current = editor?.getValue() ?? source;
        const suffix = `${current.endsWith('\n') || current.length === 0 ? '' : '\n'}[data-surface="${surface}"] {\n  \n}\n`;
        input.onChange(current + suffix);
        reveal(current.split('\n').length + (current.endsWith('\n') || current.length === 0 ? 0 : 1));
    }, [input.editorRef, input.onChange, input.readonly, reveal, source]);
    const targetIds = inspector.target ? editableTokens(inspector.target) : EMPTY_IDS;
    const picker: ThemeProfileEditorViewProps['picker'] = inspector.available ? {
        active: inspector.active, onToggle: toggle,
        target: inspector.target ? { surface: inspector.target.address.surface,
            roleLabel: targetIds.length ? targetIds.map(tokenLabel).join(' · ') : t('common.unavailable'),
            roleId: targetIds.length ? targetIds.join(', ') : inspector.target.selector } : null,
    } : undefined;
    return { picker, pickedTokenIds,
        highlightedTokenId: pickedTokenIds?.length === 1 ? pickedTokenIds[0] : null,
        error,
        css: { value: source, resetKey: input.draft?.id ?? '', onChange: input.onChange,
            editorRef: input.editorRef, onReady: decorate, surfaces, onInsertSelector: insert,
            ...(facts ? { coverage: facts.counts, webOnlyRules: facts.webOnlyRules, onRevealLine: reveal } : {}) },
    };
}
