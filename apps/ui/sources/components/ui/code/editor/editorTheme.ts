import type { Theme } from '@/theme';

export type CodeEditorSyntaxTheme = Readonly<{
    defaultColor: string;
    keywordColor: string;
    stringColor: string;
    commentColor: string;
    numberColor: string;
    functionColor: string;
}>;

export type CodeEditorTheme = Readonly<{
    monacoThemeName: 'happier-editor-light' | 'happier-editor-dark';
    isDark: boolean;
    backgroundColor: string;
    textColor: string;
    dividerColor: string;
    lineNumberColor: string;
    activeLineColor: string;
    selectionColor: string;
    syntax: CodeEditorSyntaxTheme;
}>;

type MonacoThemeData = Readonly<{
    base: 'vs' | 'vs-dark';
    inherit: true;
    rules: ReadonlyArray<Readonly<{ token: string; foreground: string }>>;
    colors: Readonly<Record<string, string>>;
}>;

type CodeEditorThemeSource = Readonly<{
    dark: boolean;
    colors: Pick<
        Theme['colors'],
        | 'accent'
        | 'divider'
        | 'surface'
        | 'surfaceHigh'
        | 'surfaceHighest'
        | 'surfaceSelected'
        | 'syntaxComment'
        | 'syntaxDefault'
        | 'syntaxFunction'
        | 'syntaxKeyword'
        | 'syntaxNumber'
        | 'syntaxString'
        | 'text'
        | 'textTertiary'
    >;
}>;

function withoutHash(value: string): string {
    return value.startsWith('#') ? value.slice(1) : value;
}

export function resolveCodeEditorTheme(theme: CodeEditorThemeSource): CodeEditorTheme {
    const colors = theme.colors;
    return {
        monacoThemeName: theme.dark ? 'happier-editor-dark' : 'happier-editor-light',
        isDark: Boolean(theme.dark),
        backgroundColor: colors.surfaceHighest,
        textColor: colors.text,
        dividerColor: colors.divider,
        lineNumberColor: colors.textTertiary,
        activeLineColor: colors.surfaceHigh,
        selectionColor: colors.accent.blue,
        syntax: {
            defaultColor: colors.syntaxDefault,
            keywordColor: colors.syntaxKeyword,
            stringColor: colors.syntaxString,
            commentColor: colors.syntaxComment,
            numberColor: colors.syntaxNumber,
            functionColor: colors.syntaxFunction,
        },
    };
}

export function buildMonacoEditorThemeData(editorTheme: CodeEditorTheme): MonacoThemeData {
    const syntax = editorTheme.syntax;
    return {
        base: editorTheme.isDark ? 'vs-dark' : 'vs',
        inherit: true,
        rules: [
            { token: '', foreground: withoutHash(syntax.defaultColor) },
            { token: 'comment', foreground: withoutHash(syntax.commentColor) },
            { token: 'string', foreground: withoutHash(syntax.stringColor) },
            { token: 'number', foreground: withoutHash(syntax.numberColor) },
            { token: 'keyword', foreground: withoutHash(syntax.keywordColor) },
            { token: 'operator', foreground: withoutHash(syntax.keywordColor) },
            { token: 'type', foreground: withoutHash(syntax.functionColor) },
            { token: 'function', foreground: withoutHash(syntax.functionColor) },
            { token: 'delimiter', foreground: withoutHash(syntax.defaultColor) },
        ],
        colors: {
            'editor.background': editorTheme.backgroundColor,
            'editor.foreground': syntax.defaultColor,
            'editorGutter.background': editorTheme.backgroundColor,
            'editorLineNumber.foreground': editorTheme.lineNumberColor,
            'editorLineNumber.activeForeground': editorTheme.textColor,
            'editorCursor.foreground': editorTheme.textColor,
            'editor.selectionBackground': editorTheme.selectionColor,
            'editor.inactiveSelectionBackground': editorTheme.activeLineColor,
            'editor.lineHighlightBackground': editorTheme.activeLineColor,
            'editor.lineHighlightBorder': editorTheme.dividerColor,
            'editorIndentGuide.background1': editorTheme.dividerColor,
            'editorIndentGuide.activeBackground1': editorTheme.lineNumberColor,
            'editorWidget.background': editorTheme.backgroundColor,
            'editorWidget.border': editorTheme.dividerColor,
            'input.background': editorTheme.backgroundColor,
            'input.foreground': editorTheme.textColor,
            'input.border': editorTheme.dividerColor,
        },
    };
}
