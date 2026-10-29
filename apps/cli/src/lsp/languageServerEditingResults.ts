import {
    LanguageIntelligenceCompletionItemSchema, LanguageIntelligenceSignatureHelpSchema, LanguageIntelligenceInlayHintSchema,
    LanguageIntelligenceSemanticTokensSchema, LanguageIntelligenceCallHierarchyItemSchema,
    type LanguageIntelligenceCompletionItem, type LanguageIntelligenceCallHierarchyItem, type LanguageIntelligencePosition,
} from '@happier-dev/protocol/machines/languageIntelligence';
import { readLspList, readLspObject, readLspRange } from './languageServerResults';
import { workspaceUriToPath } from './workspaceUris';

/** Plain text is escaped before the one untrusted Markdown renderer consumes it. */
function documentation(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    const object = readLspObject(value);
    const text = typeof value === 'string' ? value : typeof object?.value === 'string' ? object.value : undefined;
    if (text === undefined) throw new Error('Invalid language-server documentation');
    return object?.kind === 'markdown' ? text : text.replace(/[\\`*_{}[\]<>()#!|]/gu, '\\$&');
}
/** Project native completion positions into the held document before either editor consumes them. */
export function createCompletionNormalizer(serverId: string, text: string): (value: unknown) => LanguageIntelligenceCompletionItem {
    // Build one index for the whole list, not one document scan per completion item.
    const lineLengths = text.split(/\r\n|\r|\n/u).map(line => line.length);
    const end = { line: lineLengths.length - 1, character: lineLengths[lineLengths.length - 1] };
    const position = (value: LanguageIntelligencePosition): LanguageIntelligencePosition => value.line >= lineLengths.length
        ? end : { line: value.line, character: Math.min(value.character, lineLengths[value.line]) };
    const range = (value: unknown) => {
        const native = readLspRange(value);
        return { start: position(native.start), end: position(native.end) };
    };
    return (value: unknown): LanguageIntelligenceCompletionItem => {
        const item = readLspObject(value);
        if (!item) throw new Error('Invalid language-server completion item');
        const edit = readLspObject(item.textEdit);
        return LanguageIntelligenceCompletionItemSchema.parse({
            serverId, itemId: item.itemId, label: item.label,
            ...Object.fromEntries(['kind', 'detail', 'insertText', 'insertTextFormat', 'sortText', 'filterText', 'preselect', 'commitCharacters']
                .filter(key => item[key] !== undefined).map(key => [key, item[key]])),
            ...(item.documentation === undefined ? {} : { documentation: documentation(item.documentation) }),
            ...(edit ? { textEdit: edit.range ? { range: range(edit.range), newText: edit.newText }
                : { insert: range(edit.insert), replace: range(edit.replace), newText: edit.newText } } : {}),
            ...(item.additionalTextEdits === undefined ? {} : { additionalTextEdits: readLspList(item.additionalTextEdits).map(raw => {
                const change = readLspObject(raw);
                if (!change) throw new Error('Invalid completion edit');
                return { range: range(change.range), newText: change.newText };
            }) }),
        });
    };
}
export function normalizeSignatureHelp(value: unknown) {
    if (value === null) return null;
    const help = readLspObject(value);
    if (!help) throw new Error('Invalid language-server signature help');
    return LanguageIntelligenceSignatureHelpSchema.parse({
        signatures: readLspList(help.signatures).map(raw => {
            const signature = readLspObject(raw);
            if (!signature) throw new Error('Invalid signature');
            return { label: signature.label, ...(signature.documentation === undefined ? {} : { documentation: documentation(signature.documentation) }),
                ...(signature.activeParameter === undefined ? {} : { activeParameter: signature.activeParameter }),
                ...(signature.parameters === undefined ? {} : { parameters: readLspList(signature.parameters).map(rawParameter => {
                    const parameter = readLspObject(rawParameter);
                    if (!parameter) throw new Error('Invalid signature parameter');
                    return { label: parameter.label, ...(parameter.documentation === undefined ? {} : { documentation: documentation(parameter.documentation) }) };
                }) }) };
        }),
        ...(help.activeSignature === undefined ? {} : { activeSignature: help.activeSignature }),
        ...(help.activeParameter === undefined ? {} : { activeParameter: help.activeParameter }),
    });
}
export function normalizeInlayHint(serverId: string, value: unknown) {
    const hint = readLspObject(value);
    if (!hint) throw new Error('Invalid language-server inlay hint');
    return LanguageIntelligenceInlayHintSchema.parse({ serverId, position: hint.position,
        label: typeof hint.label === 'string' ? hint.label : readLspList(hint.label).map(part => {
            const label = readLspObject(part);
            if (typeof label?.value !== 'string') throw new Error('Invalid inlay label');
            return label.value;
        }).join(''),
        ...Object.fromEntries(['kind', 'paddingLeft', 'paddingRight', 'textEdits'].filter(key => hint[key] !== undefined).map(key => [key, hint[key]])),
        ...(hint.tooltip === undefined ? {} : { tooltip: documentation(hint.tooltip) }),
    });
}
export function normalizeSemanticTokens(serverId: string, value: unknown) {
    const tokens = readLspObject(value);
    if (!tokens) throw new Error('Invalid semantic tokens');
    return LanguageIntelligenceSemanticTokensSchema.parse({ serverId, legend: tokens.legend,
        ...Object.fromEntries(['data', 'edits', 'resultId'].filter(key => tokens[key] !== undefined).map(key => [key, tokens[key]])) });
}
export function normalizeCallHierarchyItem(context: Readonly<{ rootPath: string; platform: NodeJS.Platform }>, serverId: string, value: unknown): LanguageIntelligenceCallHierarchyItem {
    const item = readLspObject(value);
    if (!item || typeof item.uri !== 'string') throw new Error('Invalid call hierarchy item');
    return LanguageIntelligenceCallHierarchyItemSchema.parse({ serverId, itemId: item.itemId, name: item.name, kind: item.kind,
        ...workspaceUriToPath(context, item.uri), range: readLspRange(item.range), selectionRange: readLspRange(item.selectionRange),
        ...(item.detail === undefined ? {} : { detail: item.detail }) });
}
