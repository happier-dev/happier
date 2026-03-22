import ts from 'typescript';

export type InlineMockFamilyName =
    | 'reactNative'
    | 'unistyles'
    | 'text'
    | 'modal'
    | 'router'
    | 'storage';

export type InlineMockFamilyStats = Readonly<Record<InlineMockFamilyName, Readonly<{
    total: number;
    canonical: number;
    adHoc: number;
}>>>;

type MutableInlineMockFamilyStats = Record<InlineMockFamilyName, {
    total: number;
    canonical: number;
    adHoc: number;
}>;

const FAMILY_SPECIFIERS: Record<string, InlineMockFamilyName> = {
    'react-native': 'reactNative',
    'react-native-unistyles': 'unistyles',
    '@/text': 'text',
    '@/modal': 'modal',
    'expo-router': 'router',
    '@/sync/domains/state/storage': 'storage',
};

const CANONICAL_MARKERS: Record<InlineMockFamilyName, readonly string[]> = {
    reactNative: ['createReactNativeWebMock'],
    unistyles: ['createUnistylesMock'],
    text: ['createTextModuleMock'],
    modal: ['createModalModuleMock'],
    router: ['createExpoRouterMock'],
    storage: ['createStorageModuleMock', 'createPartialStorageModuleMock', 'createStorageModuleStub'],
};

const CANONICAL_HELPER_MARKERS: Record<InlineMockFamilyName, readonly Readonly<{
    helper: string;
    importSpecifier: string;
}>[]> = {
    reactNative: [
        { helper: 'createFlashListChatListReactNativeMock', importSpecifier: '@/dev/testkit/harness/chatListHarness' },
        { helper: 'createLegacyChatListReactNativeMock', importSpecifier: '@/dev/testkit/harness/chatListHarness' },
    ],
    unistyles: [],
    text: [],
    modal: [],
    router: [],
    storage: [
        { helper: 'createFlashListChatListStorageMock', importSpecifier: '@/dev/testkit/harness/chatListHarness' },
        { helper: 'createLegacyChatListStorageMock', importSpecifier: '@/dev/testkit/harness/chatListHarness' },
    ],
};

function hasCanonicalMarker(text: string, family: InlineMockFamilyName): boolean {
    return (
        CANONICAL_MARKERS[family].some((marker) => text.includes(marker)) ||
        CANONICAL_HELPER_MARKERS[family].some(({ helper, importSpecifier }) => (
            text.includes(helper) && text.includes(importSpecifier)
        ))
    );
}

function collectReferencedIdentifierNames(node: ts.Node | readonly ts.Node[]): Set<string> {
    const referenced = new Set<string>();

    const visit = (current: ts.Node): void => {
        if (ts.isTypeNode(current)) {
            return;
        }
        if (ts.isIdentifier(current) && isReferenceIdentifier(current)) {
            referenced.add(current.text);
        }
        ts.forEachChild(current, visit);
    };

    for (const item of Array.isArray(node) ? node : [node]) {
        visit(item);
    }
    return referenced;
}

function isReferenceIdentifier(node: ts.Identifier): boolean {
    const parent = node.parent;
    if (!parent) {
        return true;
    }

    if (
        (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent)) &&
        parent.name === node
    ) {
        return false;
    }
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
        return false;
    }
    if (ts.isQualifiedName(parent) && parent.right === node) {
        return false;
    }
    if (
        ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isEnumDeclaration(parent) ||
        ts.isImportClause(parent) ||
        ts.isImportSpecifier(parent) ||
        ts.isNamespaceImport(parent) ||
        ts.isBindingElement(parent)
    ) {
        return parent.name !== node;
    }

    return true;
}

function collectCanonicalWrapperFamilies(sourceFile: ts.SourceFile): Map<string, Set<InlineMockFamilyName>> {
    const wrapperFamilies = new Map<string, Set<InlineMockFamilyName>>();

    const addWrapperFamily = (name: string, family: InlineMockFamilyName): void => {
        const existingFamilies = wrapperFamilies.get(name) ?? new Set<InlineMockFamilyName>();
        existingFamilies.add(family);
        wrapperFamilies.set(name, existingFamilies);
    };

    for (const statement of sourceFile.statements) {
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
                    continue;
                }
                const initializerText = declaration.initializer.getText(sourceFile);
                for (const family of Object.keys(CANONICAL_MARKERS) as InlineMockFamilyName[]) {
                    if (hasCanonicalMarker(initializerText, family)) {
                        addWrapperFamily(declaration.name.text, family);
                    }
                }
            }
            continue;
        }

        if (!ts.isFunctionDeclaration(statement) || !statement.name) {
            continue;
        }

        const functionText = statement.getText(sourceFile);
        for (const family of Object.keys(CANONICAL_MARKERS) as InlineMockFamilyName[]) {
            if (hasCanonicalMarker(functionText, family)) {
                addWrapperFamily(statement.name.text, family);
            }
        }
    }

    return wrapperFamilies;
}

function collectCanonicalAliasFamilies(sourceFile: ts.SourceFile): Map<string, Set<InlineMockFamilyName>> {
    const aliasFamilies = new Map<string, Set<InlineMockFamilyName>>();
    const wrapperFamilies = collectCanonicalWrapperFamilies(sourceFile);

    for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) {
            continue;
        }
        for (const declaration of statement.declarationList.declarations) {
            if (!declaration.initializer || !ts.isIdentifier(declaration.name)) {
                continue;
            }
            const initializerText = declaration.initializer.getText(sourceFile);
            for (const family of Object.keys(CANONICAL_MARKERS) as InlineMockFamilyName[]) {
                const isWrapperCall = (
                    ts.isCallExpression(declaration.initializer) &&
                    ts.isIdentifier(declaration.initializer.expression) &&
                    wrapperFamilies.get(declaration.initializer.expression.text)?.has(family) === true
                );
                const isCanonicalAlias = hasCanonicalMarker(initializerText, family) || isWrapperCall;
                if (!isCanonicalAlias) {
                    continue;
                }
                const existingFamilies = aliasFamilies.get(declaration.name.text) ?? new Set<InlineMockFamilyName>();
                existingFamilies.add(family);
                aliasFamilies.set(declaration.name.text, existingFamilies);
            }
        }
    }

    return aliasFamilies;
}

function createEmptyStats(): MutableInlineMockFamilyStats {
    return {
        reactNative: { total: 0, canonical: 0, adHoc: 0 },
        unistyles: { total: 0, canonical: 0, adHoc: 0 },
        text: { total: 0, canonical: 0, adHoc: 0 },
        modal: { total: 0, canonical: 0, adHoc: 0 },
        router: { total: 0, canonical: 0, adHoc: 0 },
        storage: { total: 0, canonical: 0, adHoc: 0 },
    };
}

export function collectInlineMockFamilyStats(
    text: string,
    options: Readonly<{ filePath?: string }> = {},
): InlineMockFamilyStats {
    const filePath = options.filePath ?? 'inlineMockClassifier.tsx';
    const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const stats = createEmptyStats();
    const canonicalAliasFamilies = collectCanonicalAliasFamilies(sourceFile);

    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression) &&
            node.expression.expression.text === 'vi' &&
            node.expression.name.text === 'mock'
        ) {
            const [target] = node.arguments;
            if (target && ts.isStringLiteral(target)) {
                const family = FAMILY_SPECIFIERS[target.text];
                if (family) {
                    const nodeText = node.getText(sourceFile);
                    const referencedAliases = collectReferencedIdentifierNames(node);
                    const canonical = (
                        CANONICAL_MARKERS[family].some((marker) => nodeText.includes(marker)) ||
                        CANONICAL_HELPER_MARKERS[family].some(({ helper, importSpecifier }) => (
                            nodeText.includes(helper) && nodeText.includes(importSpecifier)
                        )) ||
                        [...referencedAliases].some((alias) => canonicalAliasFamilies.get(alias)?.has(family) === true)
                    );
                    const current = stats[family];
                    stats[family] = {
                        total: current.total + 1,
                        canonical: current.canonical + (canonical ? 1 : 0),
                        adHoc: current.adHoc + (canonical ? 0 : 1),
                    };
                }
            }
        }
        ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return stats;
}
