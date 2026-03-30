import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

export type InlineMockFamily = 'reactNative' | 'text' | 'modal' | 'router' | 'storage' | 'unistyles';

export type InlineMockRewrite = Readonly<{
    family: InlineMockFamily;
    target: string;
}>;

export type InlineMockRewriteResult = Readonly<{
    text: string;
    rewrites: readonly InlineMockRewrite[];
}>;

type Replacement = Readonly<{
    start: number;
    end: number;
    value: string;
    rewrite: InlineMockRewrite;
}>;

const CHAT_LIST_HARNESS_SPECIFIER = '@/dev/testkit/harness/chatListHarness';
const LEGACY_CHAT_LIST_HARNESS_SPECIFIER = './ChatList.legacyListTestHarness';
const UNISTYLES_MOCK_SPECIFIER = '@/dev/testkit/mocks/unistyles';

const LOW_SIGNAL_UNISTYLES_THEME_SHAPES = new Set([
    "{theme:{colors:{input:{placeholder:'#777'},accent:{blue:'#00f'},textSecondary:'#999'}}}",
    "{theme:{colors:{groupped:{background:'white'},textSecondary:'#999',divider:'#ddd',input:{background:'#fff',text:'#111',placeholder:'#666'},accent:{blue:'#00f',indigo:'#60f',purple:'#90f'}}}}",
    "{theme:{colors:{text:'#000',textSecondary:'#666',warning:'#f90',surfaceHigh:'#fff',surfaceHighest:'#fff'}}}",
    "{theme:{colors:{text:'#000',textSecondary:'#666',permissionButton:{allow:{background:'#0f0'},deny:{background:'#f00'},allowAll:{background:'#00f'}}}}}",
    "{theme:{colors:{header:{tint:'#000'},textSecondary:'#666',button:{secondary:{tint:'#000'},primary:{background:'#00f'}},surface:'#fff',text:'#000',status:{connected:'#0f0',disconnected:'#f00'},input:{placeholder:'#999'}}}}",
    "{theme:{colors:{groupped:{background:'#fff'},text:'#111',textSecondary:'#777',surface:'#fff',surfaceHigh:'#f7f7f7',surfaceHighest:'#eee',surfacePressedOverlay:'#f0f0f0',divider:'#ddd',shadow:{color:'#000',opacity:0.15},fab:{background:'#0a84ff'}}}}",
    "{theme:{colors:{groupped:{background:'#fff',chevron:'#777',sectionTitle:'#666'},surface:'#fff',surfaceHigh:'#f7f7f7',surfaceHighest:'#eee',surfacePressed:'#f0f0f0',surfacePressedOverlay:'#ececec',surfaceSelected:'#e6f0ff',surfaceRipple:'#ddd',text:'#111',textSecondary:'#777',textDestructive:'#c00',input:{background:'#eee',placeholder:'#999'},divider:'#ddd',accent:{blue:'#0a84ff'},modal:{border:'#ddd'},shadow:{color:'#000',opacity:0.2}}}}",
    "{theme:{colors:{text:'#fff',textSecondary:'#aaa',textLink:'#00f',surface:'#000',surfaceHigh:'#111',divider:'#222',border:'#222',indigo:'#5856D6',accent:{blue:'#007AFF',green:'#34C759',orange:'#FF9500',yellow:'#FFCC00',red:'#FF3B30',indigo:'#5856D6',purple:'#AF52DE'},modal:{border:'#222'},input:{background:'#111'},header:{tint:'#fff'},status:{error:'#f00'},shadow:{color:'#000',opacity:0.2},groupped:{background:'#111',chevron:'#222',sectionTitle:'#aaa'}}}}",
    "{theme:{dark:false,colors:{textSecondary:'#666'}}}",
    "{theme:{colors:{divider:'#ddd',groupped:{background:'#ffffff',sectionTitle:'#000'},header:{tint:'#000'},input:{background:'#fff',placeholder:'#aaa',text:'#000'},status:{connected:'#0f0',disconnected:'#f00',error:'#f00'},surface:'#fff',textSecondary:'#666',shadow:{color:'#000',opacity:0.2}}}}",
    "{theme:{colors:{textSecondary:'#666',header:{tint:'#000'},surface:'#fff'}}}",
]);

type StructuralUnistylesThemeFamily = Readonly<{
    required: readonly string[];
    optional: readonly string[];
    forbidden: readonly string[];
}>;

const STRUCTURAL_LOW_SIGNAL_UNISTYLES_THEME_FAMILIES: readonly StructuralUnistylesThemeFamily[] = [
    {
        required: ['surfaceHigh', 'surfaceHighest', 'text', 'textSecondary', 'warning'],
        optional: ['shadow.color', 'shadow.opacity', 'success', 'surfacePressedOverlay'],
        forbidden: ['surface', 'divider', 'textLink', 'textDestructive', 'accent', 'background', 'border', 'borderSubtle', 'diff', 'box'],
    },
    {
        required: [
            'success',
            'text',
            'textSecondary',
            'surface',
            'surfaceHigh',
            'surfaceHighest',
            'divider',
            'overlay.text',
            'overlay.scrimStrong',
            'shadow.color',
            'input.background',
            'userMessageBackground',
            'agentEventText',
        ],
        optional: ['link', 'warning', 'border', 'card', 'tint'],
        forbidden: ['surfacePressedOverlay', 'textDestructive', 'warningCritical', 'header', 'accent', 'background', 'borderSubtle', 'diff', 'box'],
    },
    {
        required: ['surface', 'surfaceHigh', 'divider', 'textSecondary'],
        optional: ['text', 'surfaceHighest', 'textLink', 'success', 'warning', 'input.background', 'input.placeholder'],
        forbidden: [
            'surfacePressedOverlay',
            'textDestructive',
            'accent',
            'overlay',
            'shadow',
            'card',
            'box',
            'groupped',
            'background',
            'border',
            'borderSubtle',
            'diff',
            'header',
            'modal',
            'fab',
            'userMessageBackground',
            'agentEventText',
            'danger',
            'permissionButton',
        ],
    },
    {
        required: ['card', 'text', 'textSecondary', 'textDestructive', 'agentEventText', 'success', 'surfacePressedOverlay'],
        optional: ['divider', 'input.background'],
        forbidden: [
            'overlay',
            'shadow',
            'warning',
            'warningCritical',
            'accent',
            'background',
            'border',
            'borderSubtle',
            'diff',
            'box',
            'userMessageBackground',
            'header',
            'tint',
            'link',
            'surface',
            'surfaceHigh',
            'surfaceHighest',
            'danger',
        ],
    },
    {
        required: ['surface', 'surfaceHigh', 'surfaceHighest', 'divider', 'text', 'textSecondary', 'textLink', 'groupped.background'],
        optional: ['warning', 'textDestructive', 'danger', 'success'],
        forbidden: [
            'surfacePressedOverlay',
            'accent',
            'overlay',
            'shadow',
            'card',
            'box',
            'header',
            'userMessageBackground',
            'agentEventText',
            'background',
            'border',
            'borderSubtle',
            'diff',
            'input',
            'permissionButton',
        ],
    },
    {
        required: [
            'accent.orange',
            'accent.indigo',
            'success',
            'surface',
            'warningCritical',
            'text',
            'textSecondary',
            'border',
            'borderSubtle',
            'background',
        ],
        optional: [],
        forbidden: [
            'surfaceHigh',
            'surfaceHighest',
            'surfacePressedOverlay',
            'card',
            'divider',
            'overlay',
            'shadow',
            'box',
            'header',
            'userMessageBackground',
            'agentEventText',
            'textDestructive',
            'danger',
            'input',
        ],
    },
    {
        required: ['surface', 'text', 'textSecondary'],
        optional: [],
        forbidden: [
            'surfaceHigh',
            'surfaceHighest',
            'surfacePressedOverlay',
            'divider',
            'shadow',
            'accent',
            'overlay',
            'card',
            'box',
            'background',
            'border',
            'borderSubtle',
            'header',
            'modal',
            'groupped',
            'input',
            'warning',
            'warningCritical',
            'success',
            'danger',
            'textLink',
            'textDestructive',
            'agentEventText',
            'userMessageBackground',
            'permissionButton',
            'diff',
            'indigo',
            'status',
        ],
    },
    {
        required: ['text', 'textSecondary', 'surfaceHigh', 'surfaceHighest', 'surfacePressedOverlay'],
        optional: ['divider', 'shadow.color', 'shadow.opacity', 'accent.blue'],
        forbidden: [
            'surface',
            'overlay',
            'card',
            'box',
            'background',
            'border',
            'borderSubtle',
            'header',
            'modal',
            'groupped',
            'input',
            'warning',
            'warningCritical',
            'success',
            'danger',
            'textLink',
            'textDestructive',
            'agentEventText',
            'userMessageBackground',
            'permissionButton',
            'diff',
            'indigo',
            'status',
        ],
    },
];

function isViMockCall(node: ts.CallExpression): boolean {
    return (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'vi' &&
        (node.expression.name.text === 'mock' || node.expression.name.text === 'doMock')
    );
}

function getViMockMethodName(node: ts.CallExpression): 'mock' | 'doMock' {
    if (!ts.isPropertyAccessExpression(node.expression) || !ts.isIdentifier(node.expression.expression)) {
        return 'mock';
    }
    return node.expression.name.text === 'doMock' ? 'doMock' : 'mock';
}

function getFactoryReturnObject(factory: ts.Expression): ts.ObjectLiteralExpression | null {
    if (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)) {
        const expressionBody = ts.isParenthesizedExpression(factory.body) ? factory.body.expression : factory.body;
        if (ts.isObjectLiteralExpression(expressionBody)) {
            return expressionBody;
        }
        if (ts.isBlock(factory.body)) {
            for (const statement of factory.body.statements) {
                if (!ts.isReturnStatement(statement) || !statement.expression) {
                    continue;
                }
                const returnedExpression = ts.isParenthesizedExpression(statement.expression)
                    ? statement.expression.expression
                    : statement.expression;
                if (returnedExpression && ts.isObjectLiteralExpression(returnedExpression)) {
                    return returnedExpression;
                }
            }
        }
    }
    return null;
}

function getPropertyInitializer(objectLiteral: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
    for (const property of objectLiteral.properties) {
        if (ts.isPropertyAssignment(property)) {
            const propertyName = property.name.getText();
            if (propertyName === name) {
                return property.initializer;
            }
        }
        if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
            return property.name;
        }
    }
    return null;
}

function unwrapTypeAssertionExpression(expression: ts.Expression): ts.Expression {
    let current = expression;
    while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current)
    ) {
        current = current.expression;
    }
    return current;
}

function getInlineFunctionReturnExpression(expression: ts.Expression): ts.Expression | null {
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
        if (ts.isBlock(expression.body)) {
            for (const statement of expression.body.statements) {
                if (ts.isReturnStatement(statement) && statement.expression) {
                    return ts.isParenthesizedExpression(statement.expression)
                        ? statement.expression.expression
                        : statement.expression;
                }
            }
            return null;
        }
        return ts.isParenthesizedExpression(expression.body) ? expression.body.expression : expression.body;
    }
    return null;
}

function resolveFactoryLocalObjectInitializer(
    factory: ts.Expression,
    identifierName: string,
): ts.ObjectLiteralExpression | null {
    const initializer = resolveFactoryLocalInitializer(factory, identifierName);
    return initializer && ts.isObjectLiteralExpression(initializer) ? initializer : null;
}

function resolveFactoryLocalInitializer(
    factory: ts.Expression,
    identifierName: string,
): ts.Expression | null {
    if (!(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)) || !ts.isBlock(factory.body)) {
        return null;
    }

    for (const statement of factory.body.statements) {
        if (!ts.isVariableStatement(statement)) {
            continue;
        }
        for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || declaration.name.text !== identifierName) {
                continue;
            }
            if (declaration.initializer) {
                return declaration.initializer;
            }
        }
    }

    return null;
}

function resolveTopLevelIdentifierInitializer(
    sourceFile: ts.SourceFile,
    identifierName: string,
    currentFilePath: string = sourceFile.fileName,
): ts.Expression | null {
    for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) {
            continue;
        }
        for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || declaration.name.text !== identifierName || !declaration.initializer) {
                continue;
            }

            const unwrappedInitializer = unwrapTypeAssertionExpression(declaration.initializer);

            if (ts.isCallExpression(unwrappedInitializer)) {
                const [factory] = unwrappedInitializer.arguments;
                const returnedObject = factory ? getFactoryReturnObject(factory) : null;
                if (returnedObject) {
                    return returnedObject;
                }
            }

            return unwrappedInitializer;
        }
    }

    const importedInitializer = resolveImportedIdentifierInitializer(sourceFile, identifierName, currentFilePath);
    if (importedInitializer) {
        return importedInitializer;
    }

    return null;
}

const PARSED_SOURCE_FILE_CACHE = new Map<string, ts.SourceFile>();

function parseExistingSourceFile(filePath: string): ts.SourceFile | null {
    const cached = PARSED_SOURCE_FILE_CACHE.get(filePath);
    if (cached) {
        return cached;
    }
    if (!fs.existsSync(filePath)) {
        return null;
    }
    const text = fs.readFileSync(filePath, 'utf8');
    const scriptKind = filePath.endsWith('.tsx') || filePath.endsWith('.jsx')
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS;
    const parsed = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKind);
    PARSED_SOURCE_FILE_CACHE.set(filePath, parsed);
    return parsed;
}

function resolveRelativeImportFilePath(currentFilePath: string, moduleSpecifier: string): string | null {
    if (!moduleSpecifier.startsWith('.')) {
        return null;
    }

    const absoluteCurrentFilePath = path.isAbsolute(currentFilePath)
        ? currentFilePath
        : path.resolve(process.cwd(), currentFilePath);
    const targetBasePath = path.resolve(path.dirname(absoluteCurrentFilePath), moduleSpecifier);
    const candidates = [
        targetBasePath,
        `${targetBasePath}.ts`,
        `${targetBasePath}.tsx`,
        `${targetBasePath}.js`,
        `${targetBasePath}.jsx`,
        path.join(targetBasePath, 'index.ts'),
        path.join(targetBasePath, 'index.tsx'),
        path.join(targetBasePath, 'index.js'),
        path.join(targetBasePath, 'index.jsx'),
    ];

    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function resolveImportedIdentifierInitializer(
    sourceFile: ts.SourceFile,
    identifierName: string,
    currentFilePath: string,
): ts.Expression | null {
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !statement.importClause) {
            continue;
        }
        if (!ts.isStringLiteral(statement.moduleSpecifier)) {
            continue;
        }

        const moduleSpecifier = statement.moduleSpecifier.text;
        const namedBindings = statement.importClause.namedBindings;
        if (!(namedBindings && ts.isNamedImports(namedBindings))) {
            continue;
        }

        const matchingElement = namedBindings.elements.find((element) => element.name.text === identifierName);
        if (!matchingElement) {
            continue;
        }

        const importedFilePath = resolveRelativeImportFilePath(currentFilePath, moduleSpecifier);
        if (!importedFilePath) {
            continue;
        }

        const importedSourceFile = parseExistingSourceFile(importedFilePath);
        if (!importedSourceFile) {
            continue;
        }

        const importedIdentifierName = matchingElement.propertyName?.text ?? matchingElement.name.text;
        return resolveTopLevelIdentifierInitializer(importedSourceFile, importedIdentifierName, importedFilePath);
    }

    return null;
}

function getStyleSheetCreateThemeExpression(
    styleSheetInitializer: ts.ObjectLiteralExpression | null,
    sourceFile: ts.SourceFile,
): string | undefined {
    if (!styleSheetInitializer) {
        return undefined;
    }

    const createInitializer = getPropertyInitializer(styleSheetInitializer, 'create');
    if (!(createInitializer && (ts.isArrowFunction(createInitializer) || ts.isFunctionExpression(createInitializer)))) {
        return undefined;
    }

    const [firstParameter] = createInitializer.parameters;
    if (!(firstParameter && ts.isIdentifier(firstParameter.name))) {
        return undefined;
    }
    const factoryName = firstParameter.name.text;
    const returnedExpression = getInlineFunctionReturnExpression(createInitializer);
    if (!returnedExpression) {
        return undefined;
    }

    const extractThemeFromCall = (expression: ts.Expression): string | undefined => {
        if (
            ts.isCallExpression(expression) &&
            ts.isIdentifier(expression.expression) &&
            expression.expression.text === factoryName &&
            expression.arguments.length === 1
        ) {
            return expression.arguments[0].getText(sourceFile);
        }
        return undefined;
    };

    if (ts.isConditionalExpression(returnedExpression)) {
        return (
            extractThemeFromCall(returnedExpression.whenTrue) ??
            extractThemeFromCall(returnedExpression.whenFalse)
        );
    }

    return extractThemeFromCall(returnedExpression);
}

function getFactoryBlockStatements(factory: ts.Expression): readonly ts.Statement[] {
    if (!(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)) || !ts.isBlock(factory.body)) {
        return [];
    }
    return factory.body.statements;
}

function getObjectBindingAliasForImport(
    factory: ts.Expression,
    importSpecifier: string,
    exportName: string,
): string | null {
    for (const statement of getFactoryBlockStatements(factory)) {
        if (!ts.isVariableStatement(statement)) {
            continue;
        }
        for (const declaration of statement.declarationList.declarations) {
            if (
                !ts.isObjectBindingPattern(declaration.name) ||
                !declaration.initializer ||
                !isImportCallForSpecifier(declaration.initializer, importSpecifier)
            ) {
                continue;
            }
            for (const element of declaration.name.elements) {
                if (
                    element.propertyName &&
                    ts.isIdentifier(element.propertyName) &&
                    element.propertyName.text === exportName &&
                    ts.isIdentifier(element.name)
                ) {
                    return element.name.text;
                }
                if (!element.propertyName && ts.isIdentifier(element.name) && element.name.text === exportName) {
                    return element.name.text;
                }
            }
        }
    }
    return null;
}

function getHarnessHelperCall(
    factory: ts.Expression,
    helperName: string,
    importSpecifier: string,
): ts.CallExpression | null {
    const returnedExpression = getInlineFunctionReturnExpression(factory);
    if (!returnedExpression || !ts.isCallExpression(returnedExpression)) {
        return null;
    }

    if (
        ts.isPropertyAccessExpression(returnedExpression.expression) &&
        returnedExpression.expression.name.text === helperName &&
        isImportCallForSpecifier(returnedExpression.expression.expression, importSpecifier)
    ) {
        return returnedExpression;
    }

    const helperAlias = getObjectBindingAliasForImport(factory, importSpecifier, helperName);
    if (
        helperAlias &&
        ts.isIdentifier(returnedExpression.expression) &&
        returnedExpression.expression.text === helperAlias
    ) {
        return returnedExpression;
    }

    return null;
}

function unwrapParenthesizedExpression(expression: ts.Expression): ts.Expression {
    let current = expression;
    while (ts.isParenthesizedExpression(current)) {
        current = current.expression;
    }
    return current;
}

function unwrapAwaitedExpression(expression: ts.Expression): ts.Expression {
    const unwrappedExpression = unwrapParenthesizedExpression(expression);
    return ts.isAwaitExpression(unwrappedExpression)
        ? unwrapParenthesizedExpression(unwrappedExpression.expression)
        : unwrappedExpression;
}

function getObjectBindingAliasFromFunctionParameter(
    expression: ts.Expression,
    exportName: string,
): string | null {
    if (!(ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))) {
        return null;
    }
    const [firstParameter] = expression.parameters;
    if (!(firstParameter && ts.isObjectBindingPattern(firstParameter.name))) {
        return null;
    }
    for (const element of firstParameter.name.elements) {
        if (
            element.propertyName &&
            ts.isIdentifier(element.propertyName) &&
            element.propertyName.text === exportName &&
            ts.isIdentifier(element.name)
        ) {
            return element.name.text;
        }
        if (!element.propertyName && ts.isIdentifier(element.name) && element.name.text === exportName) {
            return element.name.text;
        }
    }
    return null;
}

function getReactNativeHelperCall(
    factory: ts.Expression,
): ts.CallExpression | null {
    const helperSpecifier = '@/dev/testkit/mocks/reactNative';
    const returnedExpression = getInlineFunctionReturnExpression(factory);
    if (!returnedExpression) {
        return null;
    }

    const directCandidate = unwrapAwaitedExpression(returnedExpression);
    if (ts.isCallExpression(directCandidate)) {
        if (
            ts.isIdentifier(directCandidate.expression) &&
            (directCandidate.expression.text === 'createReactNativeWebMock' ||
                directCandidate.expression.text === getObjectBindingAliasForImport(factory, helperSpecifier, 'createReactNativeWebMock'))
        ) {
            return directCandidate;
        }

        if (
            ts.isPropertyAccessExpression(directCandidate.expression) &&
            directCandidate.expression.name.text === 'createReactNativeWebMock' &&
            isImportCallForSpecifier(directCandidate.expression.expression, helperSpecifier)
        ) {
            return directCandidate;
        }
    }

    if (
        ts.isCallExpression(directCandidate) &&
        ts.isPropertyAccessExpression(directCandidate.expression) &&
        directCandidate.expression.name.text === 'then' &&
        isImportCallForSpecifier(directCandidate.expression.expression, helperSpecifier)
    ) {
        const [callback] = directCandidate.arguments;
        const callbackReturnExpression = callback ? getInlineFunctionReturnExpression(callback) : null;
        const callbackCandidate = callbackReturnExpression ? unwrapAwaitedExpression(callbackReturnExpression) : null;
        const helperAlias = callback ? getObjectBindingAliasFromFunctionParameter(callback, 'createReactNativeWebMock') : null;
        if (
            callbackCandidate &&
            ts.isCallExpression(callbackCandidate) &&
            ts.isIdentifier(callbackCandidate.expression) &&
            (callbackCandidate.expression.text === 'createReactNativeWebMock' ||
                (helperAlias !== null && callbackCandidate.expression.text === helperAlias))
        ) {
            return callbackCandidate;
        }
    }

    return null;
}

function normalizeMockShape(value: string): string {
    let normalized = value.replace(/\s+/g, '');
    while (normalized.includes(',}') || normalized.includes(',]')) {
        normalized = normalized.replace(/,\}/g, '}').replace(/,\]/g, ']');
    }
    return normalized;
}

function collectObjectLiteralLeafPaths(
    objectLiteral: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile,
    prefix = '',
): string[] {
    const paths: string[] = [];

    for (const property of objectLiteral.properties) {
        if (!ts.isPropertyAssignment(property)) {
            return [];
        }
        const propertyName = property.name.getText(sourceFile);
        const nextPrefix = prefix.length > 0 ? `${prefix}.${propertyName}` : propertyName;
        if (ts.isObjectLiteralExpression(property.initializer)) {
            paths.push(...collectObjectLiteralLeafPaths(property.initializer, sourceFile, nextPrefix));
            continue;
        }
        paths.push(nextPrefix);
    }

    return paths;
}

function matchesPathPrefix(path: string, prefix: string): boolean {
    return path === prefix || path.startsWith(`${prefix}.`);
}

function matchesStructuralLowSignalUnistylesThemeOptions(
    themeExpression: ts.Expression,
    sourceFile: ts.SourceFile,
): boolean {
    if (!ts.isObjectLiteralExpression(themeExpression)) {
        return false;
    }

    let colorsInitializer: ts.ObjectLiteralExpression | null = null;
    for (const property of themeExpression.properties) {
        if (!ts.isPropertyAssignment(property)) {
            return false;
        }

        const propertyName = property.name.getText(sourceFile);
        if (propertyName === 'colors') {
            if (!ts.isObjectLiteralExpression(property.initializer)) {
                return false;
            }
            colorsInitializer = property.initializer;
            continue;
        }

        if (propertyName === 'dark') {
            if (
                property.initializer.kind !== ts.SyntaxKind.TrueKeyword &&
                property.initializer.kind !== ts.SyntaxKind.FalseKeyword
            ) {
                return false;
            }
            continue;
        }

        return false;
    }

    if (!colorsInitializer) {
        return false;
    }

    const colorLeafPaths = collectObjectLiteralLeafPaths(colorsInitializer, sourceFile);
    if (colorLeafPaths.length === 0) {
        return false;
    }

    return STRUCTURAL_LOW_SIGNAL_UNISTYLES_THEME_FAMILIES.some((family) => {
        if (family.required.some((path) => !colorLeafPaths.includes(path))) {
            return false;
        }

        if (
            colorLeafPaths.some((path) =>
                family.forbidden.some((forbiddenPath) => matchesPathPrefix(path, forbiddenPath)),
            )
        ) {
            return false;
        }

        const allowedPaths = new Set([...family.required, ...family.optional]);
        return colorLeafPaths.every((path) => allowedPaths.has(path));
    });
}

function normalizeResolvedLowSignalUnistylesThemeOptions(
    themeExpression: ts.Expression,
    sourceFile: ts.SourceFile,
): string | null {
    if (!ts.isObjectLiteralExpression(themeExpression)) {
        return null;
    }

    let resolvedIdentifierBackedColors = false;
    const propertyTexts: string[] = [];

    for (const property of themeExpression.properties) {
        if (!ts.isPropertyAssignment(property)) {
            return null;
        }

        const propertyName = property.name.getText(sourceFile);
        if (propertyName === 'colors') {
            const resolvedColorsText = resolveLowSignalUnistylesObjectLiteralText(property.initializer, sourceFile);
            if (!resolvedColorsText) {
                return null;
            }
            propertyTexts.push(`colors:${resolvedColorsText}`);
            resolvedIdentifierBackedColors = true;
            continue;
        }

        propertyTexts.push(`${propertyName}:${property.initializer.getText(sourceFile)}`);
    }

    if (!resolvedIdentifierBackedColors) {
        return null;
    }

    return normalizeMockShape(`{theme:{${propertyTexts.join(',')}}}`);
}

function resolveLowSignalUnistylesObjectLiteralText(
    expression: ts.Expression,
    sourceFile: ts.SourceFile,
): string | null {
    const activeSourceFile = expression.getSourceFile?.() ?? sourceFile;

    if (ts.isIdentifier(expression)) {
        const resolved = resolveTopLevelIdentifierInitializer(activeSourceFile, expression.text, activeSourceFile.fileName);
        if (!resolved) {
            return null;
        }
        return resolveLowSignalUnistylesObjectLiteralText(resolved, resolved.getSourceFile?.() ?? activeSourceFile);
    }

    if (!ts.isObjectLiteralExpression(expression)) {
        return null;
    }

    const propertyTexts: string[] = [];

    for (const property of expression.properties) {
        if (ts.isSpreadAssignment(property)) {
            const spreadText = resolveLowSignalUnistylesObjectLiteralText(property.expression, property.expression.getSourceFile?.() ?? activeSourceFile);
            if (!spreadText) {
                return null;
            }
            const normalizedSpread = normalizeMockShape(spreadText);
            if (!(normalizedSpread.startsWith('{') && normalizedSpread.endsWith('}'))) {
                return null;
            }
            const spreadBody = normalizedSpread.slice(1, -1);
            if (spreadBody.length > 0) {
                propertyTexts.push(spreadBody);
            }
            continue;
        }

        if (!ts.isPropertyAssignment(property)) {
            return null;
        }

        const propertyName = property.name.getText(activeSourceFile);
        const resolvedInitializerText = resolveLowSignalUnistylesInitializerText(property.initializer, property.initializer.getSourceFile?.() ?? activeSourceFile);
        if (!resolvedInitializerText) {
            return null;
        }
        propertyTexts.push(`${propertyName}:${resolvedInitializerText}`);
    }

    return `{${propertyTexts.join(',')}}`;
}

function resolveLowSignalUnistylesInitializerText(
    initializer: ts.Expression,
    sourceFile: ts.SourceFile,
): string | null {
    const activeSourceFile = initializer.getSourceFile?.() ?? sourceFile;

    if (ts.isObjectLiteralExpression(initializer) || ts.isIdentifier(initializer)) {
        return resolveLowSignalUnistylesObjectLiteralText(initializer, activeSourceFile) ?? initializer.getText(activeSourceFile);
    }

    if (
        ts.isPropertyAccessExpression(initializer) &&
        ts.isIdentifier(initializer.expression)
    ) {
        const resolvedOwner = resolveTopLevelIdentifierInitializer(activeSourceFile, initializer.expression.text, activeSourceFile.fileName);
        if (!resolvedOwner || !ts.isObjectLiteralExpression(resolvedOwner)) {
            return null;
        }

        const resolvedProperty = resolvedOwner.properties.find((property) => (
            ts.isPropertyAssignment(property) &&
            property.name.getText(resolvedOwner.getSourceFile()) === initializer.name.text
        ));
        if (!resolvedProperty || !ts.isPropertyAssignment(resolvedProperty)) {
            return null;
        }

        return resolveLowSignalUnistylesInitializerText(
            resolvedProperty.initializer,
            resolvedProperty.initializer.getSourceFile?.() ?? activeSourceFile,
        );
    }

    return initializer.getText(activeSourceFile);
}

function isLowSignalUnistylesThemeOptions(
    optionsInitializer: ts.Expression,
    sourceFile: ts.SourceFile,
): boolean {
    if (!ts.isObjectLiteralExpression(optionsInitializer)) {
        return false;
    }

    const rtExpression = getPropertyInitializer(optionsInitializer, 'rt');
    const runtimeExpression = getPropertyInitializer(optionsInitializer, 'runtime');
    if (runtimeExpression) {
        return false;
    }
    if (rtExpression && !isDefaultUnistylesRuntimeOptions(rtExpression, sourceFile)) {
        return false;
    }

    const themeExpression = getPropertyInitializer(optionsInitializer, 'theme');
    if (!themeExpression) {
        return false;
    }

    const normalized = normalizeMockShape(`{theme:${themeExpression.getText(sourceFile)}}`);
    const resolvedNormalized = normalizeResolvedLowSignalUnistylesThemeOptions(themeExpression, sourceFile);
    return (
        LOW_SIGNAL_UNISTYLES_THEME_SHAPES.has(normalized) ||
        (resolvedNormalized !== null && LOW_SIGNAL_UNISTYLES_THEME_SHAPES.has(resolvedNormalized)) ||
        matchesStructuralLowSignalUnistylesThemeOptions(themeExpression, sourceFile)
    );
}

function isDefaultUnistylesRuntimeOptions(
    runtimeInitializer: ts.Expression,
    sourceFile: ts.SourceFile,
): boolean {
    if (!ts.isObjectLiteralExpression(runtimeInitializer)) {
        return false;
    }

    return normalizeMockShape(runtimeInitializer.getText(sourceFile)) === "{themeName:'light'}";
}

function buildHarnessHelperCallText(
    helperName: string,
    argsText: string,
): string {
    return `(await import('${CHAT_LIST_HARNESS_SPECIFIER}')).${helperName}(${argsText})`;
}

function createTextMockReplacement(params: {
    translateExpression?: string;
    translateLooseExpression?: string;
    getPreferredLanguageExpression?: string;
}): string {
    const optionLines: string[] = [];
    if (params.translateExpression) {
        optionLines.push(`        translate: ${params.translateExpression},`);
    }
    if (params.translateLooseExpression) {
        optionLines.push(`        translateLoose: ${params.translateLooseExpression},`);
    }
    if (params.getPreferredLanguageExpression) {
        optionLines.push(`        getPreferredLanguage: ${params.getPreferredLanguageExpression},`);
    }

    if (optionLines.length === 0) {
        return [
            "vi.mock('@/text', async () => {",
            "    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');",
            '    return createTextModuleMock();',
            '})',
        ].join('\n');
    }

    return [
        "vi.mock('@/text', async () => {",
        "    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');",
        '    return createTextModuleMock({',
        ...optionLines,
        '    });',
        '})',
    ].join('\n');
}

function indentBlock(value: string, spaces = 4): string {
    const prefix = ' '.repeat(spaces);
    return value
        .split('\n')
        .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
        .join('\n');
}

function createReactNativeMockReplacement(overridesText?: string, mockMethod: 'mock' | 'doMock' = 'mock'): string {
    if (!overridesText || overridesText === '{}') {
        return [
            `vi.${mockMethod}('react-native', async () => {`,
            "    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');",
            '    return createReactNativeWebMock();',
            '})',
        ].join('\n');
    }

    return [
        `vi.${mockMethod}('react-native', async () => {`,
        "    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');",
        '    return createReactNativeWebMock(',
        indentBlock(overridesText, 8),
        '    );',
        '})',
    ].join('\n');
}

function createModalMockReplacement(params: Readonly<{
    spiesText?: string;
    spiesExpression?: string;
    mockMethod?: 'mock' | 'doMock';
}> = {}): string {
    const mockMethod = params.mockMethod ?? 'mock';
    if (params.spiesExpression) {
        return [
            `vi.${mockMethod}('@/modal', async () => {`,
            "    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');",
            '    return createModalModuleMock({',
            `        spies: ${params.spiesExpression},`,
            '    }).module;',
            '})',
        ].join('\n');
    }

    if (params.spiesText) {
        return [
            `vi.${mockMethod}('@/modal', async () => {`,
            "    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');",
            '    return createModalModuleMock({',
            '        spies: {',
            indentBlock(params.spiesText, 12),
            '        },',
            '    }).module;',
            '})',
        ].join('\n');
    }

    return [
        `vi.${mockMethod}('@/modal', async () => {`,
        "    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');",
        '    return createModalModuleMock().module;',
        '})',
    ].join('\n');
}

function createRouterMockReplacement(params: {
    routerExpression?: string;
    paramsExpression?: string;
    navigationExpression?: string;
    pathnameExpression?: string;
    segmentsExpression?: string;
    mockMethod?: 'mock' | 'doMock';
}): string {
    const mockMethod = params.mockMethod ?? 'mock';
    const optionLines: string[] = [];
    if (params.routerExpression) {
        optionLines.push(`        router: ${params.routerExpression},`);
    }
    if (params.paramsExpression) {
        optionLines.push(`        params: ${params.paramsExpression},`);
    }
    if (params.navigationExpression) {
        optionLines.push(`        navigation: ${params.navigationExpression},`);
    }
    if (params.pathnameExpression) {
        optionLines.push(`        pathname: ${params.pathnameExpression},`);
    }
    if (params.segmentsExpression) {
        optionLines.push(`        segments: ${params.segmentsExpression},`);
    }

    if (optionLines.length === 0) {
        return [
            `vi.${mockMethod}('expo-router', async () => {`,
            "    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');",
            '    return createExpoRouterMock().module;',
            '})',
        ].join('\n');
    }

    return [
        `vi.${mockMethod}('expo-router', async () => {`,
        "    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');",
        '    const expoRouterMock = createExpoRouterMock({',
        ...optionLines,
        '    });',
        '    return expoRouterMock.module;',
        '})',
    ].join('\n');
}

function createStorageMockReplacement(overridesText: string, mockMethod: 'mock' | 'doMock' = 'mock'): string {
    return [
        `vi.${mockMethod}('@/sync/domains/state/storage', async () => {`,
        "    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');",
        `    return createStorageModuleStub(${overridesText});`,
        '})',
    ].join('\n');
}

function createPartialStorageModuleMockReplacement(params: {
    importOriginalParamName: string;
    overridesText: string;
    mockMethod?: 'mock' | 'doMock';
}): string {
    const mockMethod = params.mockMethod ?? 'mock';
    return [
        `vi.${mockMethod}('@/sync/domains/state/storage', async (${params.importOriginalParamName}) => {`,
        "    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');",
        `    return createPartialStorageModuleMock(${params.importOriginalParamName}, ${params.overridesText});`,
        '})',
    ].join('\n');
}

function createUnistylesMockReplacement(params: {
    themeExpression?: string;
    rtExpression?: string;
    runtimeExpression?: string;
    mockMethod?: 'mock' | 'doMock';
}): string {
    const mockMethod = params.mockMethod ?? 'mock';
    const optionLines: string[] = [];
    if (params.themeExpression) {
        optionLines.push(`        theme: ${params.themeExpression},`);
    }
    if (params.rtExpression) {
        optionLines.push(`        rt: ${params.rtExpression},`);
    }
    if (params.runtimeExpression) {
        optionLines.push(`        runtime: ${params.runtimeExpression},`);
    }

    if (optionLines.length === 0) {
        return [
            `vi.${mockMethod}('react-native-unistyles', async () => {`,
            "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
            '    return createUnistylesMock();',
            '})',
        ].join('\n');
    }

    return [
        `vi.${mockMethod}('react-native-unistyles', async () => {`,
        "    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');",
        '    return createUnistylesMock({',
        ...optionLines,
        '    });',
        '})',
    ].join('\n');
}

function isImportCallForSpecifier(expression: ts.Expression, specifier: string): boolean {
    const unwrappedExpression = ts.isParenthesizedExpression(expression) ? expression.expression : expression;
    const candidate = ts.isAwaitExpression(unwrappedExpression) ? unwrappedExpression.expression : unwrappedExpression;
    return (
        ts.isCallExpression(candidate) &&
        candidate.expression.kind === ts.SyntaxKind.ImportKeyword &&
        candidate.arguments.length === 1 &&
        ts.isStringLiteral(candidate.arguments[0]) &&
        candidate.arguments[0].text === specifier
    );
}

function isCallToIdentifier(expression: ts.Expression, identifier: string): boolean {
    const candidate = ts.isAwaitExpression(expression) ? expression.expression : expression;
    return ts.isCallExpression(candidate) && ts.isIdentifier(candidate.expression) && candidate.expression.text === identifier;
}

function isViImportActualCallForSpecifier(expression: ts.Expression, specifier: string): boolean {
    const candidate = ts.isAwaitExpression(expression) ? expression.expression : expression;
    return (
        ts.isCallExpression(candidate) &&
        ts.isPropertyAccessExpression(candidate.expression) &&
        ts.isIdentifier(candidate.expression.expression) &&
        candidate.expression.expression.text === 'vi' &&
        candidate.expression.name.text === 'importActual' &&
        candidate.arguments.length === 1 &&
        ts.isStringLiteral(candidate.arguments[0]) &&
        candidate.arguments[0].text === specifier
    );
}

function getImportedBindingName(sourceFile: ts.SourceFile, specifier: string): string | null {
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
            continue;
        }
        if (statement.moduleSpecifier.text !== specifier || !statement.importClause) {
            continue;
        }
        if (statement.importClause.name) {
            return statement.importClause.name.text;
        }
        const namedBindings = statement.importClause.namedBindings;
        if (namedBindings && ts.isNamespaceImport(namedBindings)) {
            return namedBindings.name.text;
        }
    }

    return null;
}

function getReactImportAliasNames(factory: ts.Expression): readonly string[] {
    if (!(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)) || !ts.isBlock(factory.body)) {
        return [];
    }

    const aliases: string[] = [];
    for (const statement of factory.body.statements) {
        if (!ts.isVariableStatement(statement)) {
            continue;
        }
        for (const declaration of statement.declarationList.declarations) {
            if (
                ts.isIdentifier(declaration.name) &&
                declaration.initializer &&
                isImportCallForSpecifier(declaration.initializer, 'react')
            ) {
                aliases.push(declaration.name.text);
            }
        }
    }

    return aliases;
}

function getReactRequireAliasNames(factory: ts.Expression): readonly string[] {
    if (!(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)) || !ts.isBlock(factory.body)) {
        return [];
    }

    const aliases: string[] = [];
    for (const statement of factory.body.statements) {
        if (!ts.isVariableStatement(statement)) {
            continue;
        }
        for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
                continue;
            }
            const initializer = ts.isAsExpression(declaration.initializer)
                ? declaration.initializer.expression
                : declaration.initializer;
            if (
                ts.isCallExpression(initializer) &&
                ts.isIdentifier(initializer.expression) &&
                initializer.expression.text === 'require' &&
                initializer.arguments.length === 1 &&
                ts.isStringLiteral(initializer.arguments[0]) &&
                initializer.arguments[0].text === 'react'
            ) {
                aliases.push(declaration.name.text);
            }
        }
    }

    return aliases;
}

function sanitizeReactNativeNestedObjectLiteral(
    objectLiteral: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile,
    aliasNames: readonly string[],
    reactAliasNames: readonly string[],
    reactImportBindingName: string | null,
    factory: ts.Expression,
    indentLevel = 0,
): string[] | null {
    const indent = '    '.repeat(indentLevel);
    const propertyIndent = '    '.repeat(indentLevel + 1);
    const lines: string[] = [`${indent}{`];
    const skipPropertySentinel = '__HAPPIER_SKIP_REACT_NATIVE_PROPERTY__';

    const normalizeExpressionText = (value: string): string => {
        let nextValue = value;
        for (const aliasName of aliasNames) {
            nextValue = nextValue.replace(
                new RegExp(`${aliasName}\\.Platform\\.select\\(([^)]+)\\)`, 'g'),
                (_match, arg: string) =>
                    `${arg}?.default ?? ${arg}?.web ?? ${arg}?.native ?? ${arg}?.ios ?? ${arg}?.android`,
            );
        }
        if (reactImportBindingName) {
            for (const reactAliasName of reactAliasNames) {
                nextValue = nextValue.replace(
                    new RegExp(`\\b${reactAliasName}\\.createElement\\b`, 'g'),
                    `${reactImportBindingName}.createElement`,
                );
                nextValue = nextValue.replace(
                    new RegExp(`\\b${reactAliasName}\\.Fragment\\b`, 'g'),
                    `${reactImportBindingName}.Fragment`,
                );
                nextValue = nextValue.replace(
                    new RegExp(`\\b${reactAliasName}\\.forwardRef\\b`, 'g'),
                    `${reactImportBindingName}.forwardRef`,
                );
            }
        }

        for (const aliasName of aliasNames) {
            if (
                nextValue === `${aliasName}.AppState` ||
                nextValue === `${aliasName}.Platform` ||
                nextValue === `${aliasName}.Dimensions` ||
                nextValue === `${aliasName}.useWindowDimensions`
            ) {
                return skipPropertySentinel;
            }

            const useWindowDimensionsFallbackMatch = nextValue.match(
                new RegExp(`^${aliasName}\\.useWindowDimensions\\s*\\?\\?\\s*(.+)$`),
            );
            if (useWindowDimensionsFallbackMatch?.[1]) {
                return useWindowDimensionsFallbackMatch[1].trim();
            }

            const platformSelectFallbackMatch = nextValue.match(
                new RegExp(`^\\(${aliasName}\\.Platform\\?\\.select\\s*\\?\\?\\s*(.+)\\)$`),
            );
            if (platformSelectFallbackMatch?.[1]) {
                return platformSelectFallbackMatch[1].trim();
            }
        }

        return nextValue;
    };

    const referencesAlias = (value: string): boolean =>
        aliasNames.some((aliasName) => new RegExp(`\\b${aliasName}(\\b|\\.)`).test(value));

    for (const property of objectLiteral.properties) {
        if (ts.isSpreadAssignment(property)) {
            if (
                ts.isIdentifier(property.expression) ||
                isImportCallForSpecifier(property.expression, '@/dev/reactNativeStub') ||
                referencesAlias(property.expression.getText(sourceFile))
            ) {
                continue;
            }
            return null;
        }
        if (ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
            const accessorText = normalizeExpressionText(property.getText(sourceFile));
            if (referencesAlias(accessorText)) {
                return null;
            }
            const accessorLines = accessorText.split('\n');
            if (accessorLines.length === 1) {
                lines.push(`${propertyIndent}${accessorLines[0]},`);
                continue;
            }
            lines.push(`${propertyIndent}${accessorLines[0]}`);
            for (const accessorLine of accessorLines.slice(1, -1)) {
                lines.push(`${propertyIndent}${accessorLine}`);
            }
            lines.push(`${propertyIndent}${accessorLines[accessorLines.length - 1]},`);
            continue;
        }
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
            return null;
        }

        const propertyName = property.name.getText(sourceFile);
        const propertyInitializer = ts.isShorthandPropertyAssignment(property)
            ? property.name
            : property.initializer;
        const effectiveInitializer = ts.isIdentifier(propertyInitializer)
            ? (resolveFactoryLocalInitializer(factory, propertyInitializer.text) ?? propertyInitializer)
            : propertyInitializer;
        if (ts.isObjectLiteralExpression(effectiveInitializer)) {
            const nestedLines = sanitizeReactNativeNestedObjectLiteral(
                effectiveInitializer,
                sourceFile,
                aliasNames,
                reactAliasNames,
                reactImportBindingName,
                factory,
                indentLevel + 1,
            );
            if (!nestedLines) {
                return null;
            }
            if (nestedLines.length > 2) {
                lines.push(`${propertyIndent}${propertyName}: ${nestedLines[0].trimStart()}`);
                lines.push(...nestedLines.slice(1, -1));
                lines.push(`${nestedLines[nestedLines.length - 1]},`);
            }
            continue;
        }

        const initializerText = normalizeExpressionText(effectiveInitializer.getText(sourceFile));
        if (initializerText === skipPropertySentinel) {
            continue;
        }
        if (referencesAlias(initializerText)) {
            return null;
        }
        lines.push(`${propertyIndent}${propertyName}: ${initializerText},`);
    }

    lines.push(`${indent}}`);
    return lines;
}

function getReactNativeOverrideText(
    objectLiteral: ts.ObjectLiteralExpression,
    sourceFile: ts.SourceFile,
    factory: ts.Expression,
): string | null {
    const aliasNames = objectLiteral.properties.flatMap((property) =>
        ts.isSpreadAssignment(property) && ts.isIdentifier(property.expression)
            ? [property.expression.text]
            : [],
    );
    const reactAliasNames = getReactImportAliasNames(factory);
    const reactRequireAliasNames = getReactRequireAliasNames(factory);
    const reactImportBindingName = getImportedBindingName(sourceFile, 'react');
    const lines = sanitizeReactNativeNestedObjectLiteral(
        objectLiteral,
        sourceFile,
        aliasNames,
        [...reactAliasNames, ...reactRequireAliasNames],
        reactImportBindingName,
        factory,
    );
    if (!lines) {
        return null;
    }
    return lines.join('\n');
}

function maybeRewriteReactNativeMock(
    sourceFile: ts.SourceFile,
    callExpression: ts.CallExpression,
): Replacement | null {
    const mockMethod = getViMockMethodName(callExpression);
    const [target, factory] = callExpression.arguments;
    if (!target || !ts.isStringLiteral(target) || target.text !== 'react-native' || !factory) {
        return null;
    }

    let returnedObject = getFactoryReturnObject(factory);
    if (returnedObject) {
        const overridesText = getReactNativeOverrideText(returnedObject, sourceFile, factory);
        if (!overridesText) {
            return null;
        }

        return {
            start: callExpression.getStart(sourceFile),
            end: callExpression.getEnd(),
            value: createReactNativeMockReplacement(overridesText, mockMethod),
            rewrite: {
                family: 'reactNative',
                target: 'react-native',
            },
        };
    }

    if (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)) {
        const expressionBody = ts.isBlock(factory.body)
            ? null
            : (ts.isParenthesizedExpression(factory.body) ? factory.body.expression : factory.body);
        if (expressionBody && isImportCallForSpecifier(expressionBody, '@/dev/reactNativeStub')) {
            return {
                start: callExpression.getStart(sourceFile),
                end: callExpression.getEnd(),
                value: createReactNativeMockReplacement(undefined, mockMethod),
                rewrite: {
                    family: 'reactNative',
                    target: 'react-native',
                },
            };
        }
    }

    if (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)) {
        const reactNativeHelperCall = getReactNativeHelperCall(factory);
        if (reactNativeHelperCall) {
            const [firstArgument] = reactNativeHelperCall.arguments;
            return {
                start: callExpression.getStart(sourceFile),
                end: callExpression.getEnd(),
                value: createReactNativeMockReplacement(firstArgument?.getText(sourceFile), mockMethod),
                rewrite: {
                    family: 'reactNative',
                    target: 'react-native',
                },
            };
        }

        const legacyHelperCall = getHarnessHelperCall(
            factory,
            'createLegacyChatListReactNativeMock',
            LEGACY_CHAT_LIST_HARNESS_SPECIFIER,
        );
        if (legacyHelperCall) {
            const argsText = legacyHelperCall.arguments.map((argument) => argument.getText(sourceFile)).join(', ');
            return {
                start: callExpression.getStart(sourceFile),
                end: callExpression.getEnd(),
                value: [
                    `vi.${mockMethod}('react-native', async () => (`,
                    `    ${buildHarnessHelperCallText('createLegacyChatListReactNativeMock', argsText)}`,
                    '))',
                ].join('\n'),
                rewrite: {
                    family: 'reactNative',
                    target: 'react-native',
                },
            };
        }

        const flashListHelperCall = getHarnessHelperCall(
            factory,
            'createFlashListChatListReactNativeMock',
            CHAT_LIST_HARNESS_SPECIFIER,
        );
        if (flashListHelperCall) {
            const argsText = flashListHelperCall.arguments.map((argument) => argument.getText(sourceFile)).join(', ');
            return {
                start: callExpression.getStart(sourceFile),
                end: callExpression.getEnd(),
                value: [
                    `vi.${mockMethod}('react-native', async () => (`,
                    `    ${buildHarnessHelperCallText('createFlashListChatListReactNativeMock', argsText)}`,
                    '))',
                ].join('\n'),
                rewrite: {
                    family: 'reactNative',
                    target: 'react-native',
                },
            };
        }
    }

    return null;
}

function maybeRewriteTextMock(
    sourceFile: ts.SourceFile,
    callExpression: ts.CallExpression,
): Replacement | null {
    const [target, factory] = callExpression.arguments;
    if (!target || !ts.isStringLiteral(target) || target.text !== '@/text' || !factory) {
        return null;
    }
    let returnedObject = getFactoryReturnObject(factory);
    if (!returnedObject || returnedObject.properties.length === 0 || returnedObject.properties.length > 3) {
        return null;
    }
    const translateInitializer = getPropertyInitializer(returnedObject, 't');
    const translateLooseInitializer = getPropertyInitializer(returnedObject, 'tLoose');
    const getPreferredLanguageInitializer = getPropertyInitializer(returnedObject, 'getPreferredLanguage');
    if (!translateInitializer && !translateLooseInitializer && !getPreferredLanguageInitializer) {
        return null;
    }
    const allowedPropertyNames = new Set(['t', 'tLoose', 'getPreferredLanguage']);
    for (const property of returnedObject.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
            return null;
        }
        const propertyName = property.name.getText();
        if (!allowedPropertyNames.has(propertyName)) {
            return null;
        }
    }
    const declaredIdentifiers = new Set([
        ...collectTopLevelDeclaredIdentifierNames(sourceFile),
        ...collectDeclaredIdentifierNames(factory),
    ]);
    const referencedIdentifiers = collectReferencedIdentifierNames(
        [translateInitializer, translateLooseInitializer, getPreferredLanguageInitializer].filter(
            (value): value is ts.Expression => Boolean(value),
        ),
    );
    if (
        [...referencedIdentifiers].some(
            (identifier) => !declaredIdentifiers.has(identifier) && !isWellKnownIdentifier(identifier),
        )
    ) {
        return null;
    }
    return {
        start: callExpression.getStart(sourceFile),
        end: callExpression.getEnd(),
        value: createTextMockReplacement({
            translateExpression: translateInitializer?.getText(sourceFile),
            translateLooseExpression: translateLooseInitializer?.getText(sourceFile),
            getPreferredLanguageExpression: getPreferredLanguageInitializer?.getText(sourceFile),
        }),
        rewrite: {
            family: 'text',
            target: '@/text',
        },
    };
}

function maybeRewriteModalMock(
    sourceFile: ts.SourceFile,
    callExpression: ts.CallExpression,
): Replacement | null {
    const mockMethod = getViMockMethodName(callExpression);
    const [target, factory] = callExpression.arguments;
    if (!target || !ts.isStringLiteral(target) || target.text !== '@/modal' || !factory) {
        return null;
    }
    let returnedObject = getFactoryReturnObject(factory);
    if (!returnedObject || returnedObject.properties.length !== 1) {
        return null;
    }
    const modalProviderInitializer = getPropertyInitializer(returnedObject, 'ModalProvider');
    if (modalProviderInitializer) {
        return {
            start: callExpression.getStart(sourceFile),
            end: callExpression.getEnd(),
            value: createModalMockReplacement({ mockMethod }),
            rewrite: {
                family: 'modal',
                target: '@/modal',
            },
        };
    }
    const modalInitializer = getPropertyInitializer(returnedObject, 'Modal');
    if (!modalInitializer) {
        return null;
    }

    const modalObject = ts.isObjectLiteralExpression(modalInitializer)
        ? modalInitializer
        : (ts.isIdentifier(modalInitializer)
            ? (
                resolveFactoryLocalObjectInitializer(factory, modalInitializer.text) ??
                resolveTopLevelIdentifierInitializer(sourceFile, modalInitializer.text)
            )
            : null);
    if (!modalObject || !ts.isObjectLiteralExpression(modalObject) || modalObject.properties.length === 0) {
        return null;
    }

    const modalProperties = modalObject.properties.map((property) => {
        if (ts.isPropertyAssignment(property)) {
            return {
                name: property.name.getText(sourceFile),
                initializer: property.initializer,
                initializerText: property.initializer.getText(sourceFile),
            };
        }
        if (ts.isShorthandPropertyAssignment(property)) {
            return {
                name: property.name.getText(sourceFile),
                initializer: property.name,
                initializerText: property.name.getText(sourceFile),
            };
        }
        return null;
    });
    const allowedPropertyNames = new Set(['show', 'hide', 'update', 'hideAll', 'alert', 'alertAsync', 'prompt', 'confirm']);
    if (modalProperties.some((property) => property == null || !allowedPropertyNames.has(property.name))) {
            return null;
    }

    const declaredIdentifiers = new Set([
        ...collectTopLevelDeclaredIdentifierNames(sourceFile),
        ...collectDeclaredIdentifierNames(factory),
    ]);
    const referencedIdentifiers = collectReferencedIdentifierNames(modalObject.properties);
    if (
        [...referencedIdentifiers].some(
            (identifier) => !declaredIdentifiers.has(identifier) && !isWellKnownIdentifier(identifier),
        )
    ) {
        return null;
    }

    const alertProperty = modalProperties.find((property) => property?.name === 'alert') ?? null;
    const alertInitializer = alertProperty?.initializer ?? null;
    const nonAlertPropertyNames = modalProperties
        .filter((property): property is NonNullable<typeof property> => property != null)
        .map((property) => property.name)
        .filter((name) => name !== 'alert');
    const isAlertOnlyViFn =
        modalProperties.length === 1 &&
        alertInitializer &&
        ts.isCallExpression(alertInitializer) &&
        alertInitializer.expression.getText(sourceFile) === 'vi.fn';

    const modalSpiesText = !isAlertOnlyViFn && !ts.isIdentifier(modalInitializer)
        ? modalProperties
              .filter((property): property is NonNullable<typeof property> => property != null)
              .map((property) => `${property.name}: ${property.initializerText},`)
              .join('\n')
        : undefined;

    return {
        start: callExpression.getStart(sourceFile),
        end: callExpression.getEnd(),
        value: createModalMockReplacement({
            mockMethod,
            spiesExpression: ts.isIdentifier(modalInitializer) ? modalInitializer.getText(sourceFile) : undefined,
            spiesText: modalSpiesText && (nonAlertPropertyNames.length > 0 || !isAlertOnlyViFn) ? modalSpiesText : undefined,
        }),
        rewrite: {
            family: 'modal',
            target: '@/modal',
        },
    };
}

function isSimpleStackStub(initializer: ts.Expression): boolean {
    if (!ts.isObjectLiteralExpression(initializer) || initializer.properties.length !== 1) {
        return false;
    }
    const [screenProperty] = initializer.properties;
    if (!ts.isPropertyAssignment(screenProperty) || screenProperty.name.getText() !== 'Screen') {
        return false;
    }

    const screenInitializer = screenProperty.initializer;
    return (
        ts.isStringLiteral(screenInitializer) ||
        ts.isArrowFunction(screenInitializer) ||
        ts.isFunctionExpression(screenInitializer)
    );
}

function isSimpleStackInitializer(initializer: ts.Expression): boolean {
    if (isSimpleStackStub(initializer)) {
        return true;
    }

    if (
        ts.isCallExpression(initializer) &&
        ts.isPropertyAccessExpression(initializer.expression) &&
        ts.isIdentifier(initializer.expression.expression) &&
        initializer.expression.expression.text === 'Object' &&
        initializer.expression.name.text === 'assign' &&
        initializer.arguments.length >= 2
    ) {
        const screenObject = initializer.arguments[1];
        return ts.isObjectLiteralExpression(screenObject) && isSimpleStackStub(screenObject);
    }

    return false;
}

function hasFactoryLocalPropertyAssignment(
    factory: ts.Expression,
    identifierName: string,
    propertyName: string,
): boolean {
    if (!(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)) || !ts.isBlock(factory.body)) {
        return false;
    }

    return factory.body.statements.some((statement) => {
        if (
            !ts.isExpressionStatement(statement) ||
            !ts.isBinaryExpression(statement.expression) ||
            statement.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
            !ts.isPropertyAccessExpression(statement.expression.left) ||
            !ts.isIdentifier(statement.expression.left.expression) ||
            statement.expression.left.expression.text !== identifierName ||
            statement.expression.left.name.text !== propertyName
        ) {
            return false;
        }

        const right = statement.expression.right;
        return ts.isArrowFunction(right) || ts.isFunctionExpression(right) || ts.isStringLiteral(right);
    });
}

function isSimpleStackAliasInitializer(
    factory: ts.Expression,
    stackIdentifierName: string,
    initializer: ts.Expression | null,
): boolean {
    return Boolean(
        initializer &&
            (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
            hasFactoryLocalPropertyAssignment(factory, stackIdentifierName, 'Screen'),
    );
}

function getRouterOptionExpression(
    sourceFile: ts.SourceFile,
    propertyName: string,
    initializer: ts.Expression | null,
): string | null {
    if (!initializer) {
        return null;
    }

    if (
        (propertyName === 'usePathname' || propertyName === 'useSegments') &&
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
        ts.isBlock(initializer.body)
    ) {
        return initializer.getText(sourceFile);
    }

    const inlineReturnExpression = getInlineFunctionReturnExpression(initializer);
    if (inlineReturnExpression) {
        return inlineReturnExpression.getText(sourceFile);
    }

    if (propertyName === 'useLocalSearchParams' && ts.isIdentifier(initializer)) {
        const resolvedInitializer = resolveTopLevelIdentifierInitializer(sourceFile, initializer.text);
        if (
            resolvedInitializer &&
            (
                ts.isCallExpression(resolvedInitializer) ||
                ts.isArrowFunction(resolvedInitializer) ||
                ts.isFunctionExpression(resolvedInitializer)
            )
        ) {
            return `() => ${initializer.getText(sourceFile)}()`;
        }
    }

    return null;
}

function maybeRewriteRouterMock(
    sourceFile: ts.SourceFile,
    callExpression: ts.CallExpression,
): Replacement | null {
    const mockMethod = getViMockMethodName(callExpression);
    const [target, factory] = callExpression.arguments;
    if (!target || !ts.isStringLiteral(target) || target.text !== 'expo-router' || !factory) {
        return null;
    }
    const returnedObject = getFactoryReturnObject(factory);
    if (!returnedObject || returnedObject.properties.length === 0 || returnedObject.properties.length > 4) {
        return null;
    }

    const routerInitializer = getPropertyInitializer(returnedObject, 'useRouter');
    const directRouterInitializer = getPropertyInitializer(returnedObject, 'router');
    const paramsInitializer = getPropertyInitializer(returnedObject, 'useLocalSearchParams');
    const navigationInitializer = getPropertyInitializer(returnedObject, 'useNavigation');
    const pathnameInitializer = getPropertyInitializer(returnedObject, 'usePathname');
    const segmentsInitializer = getPropertyInitializer(returnedObject, 'useSegments');
    const stackInitializer = getPropertyInitializer(returnedObject, 'Stack');
    const redirectInitializer = getPropertyInitializer(returnedObject, 'Redirect');
    const linkInitializer = getPropertyInitializer(returnedObject, 'Link');
    const allowedPropertyNames = new Set(['Link', 'Redirect', 'Stack', 'router', 'useRouter', 'useLocalSearchParams', 'useNavigation', 'usePathname', 'useSegments']);
    for (const property of returnedObject.properties) {
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
            return null;
        }
        const propertyName = property.name.getText();
        if (!allowedPropertyNames.has(propertyName)) {
            return null;
        }
        if (propertyName === 'Stack') {
            const explicitInitializer = ts.isPropertyAssignment(property) ? property.initializer : null;
            const stackIdentifierName = ts.isShorthandPropertyAssignment(property)
                ? property.name.text
                : explicitInitializer && ts.isIdentifier(explicitInitializer)
                  ? explicitInitializer.text
                  : null;
            const stackCandidate = stackIdentifierName
                ? resolveFactoryLocalInitializer(factory, stackIdentifierName)
                : explicitInitializer;
            if (
                !stackCandidate ||
                (!isSimpleStackInitializer(stackCandidate) &&
                    !(stackIdentifierName && isSimpleStackAliasInitializer(factory, stackIdentifierName, stackCandidate)))
            ) {
                return null;
            }
        }
    }

    const routerExpression = routerInitializer
        ? getInlineFunctionReturnExpression(routerInitializer)
        : directRouterInitializer ?? null;
    const paramsExpression = getRouterOptionExpression(sourceFile, 'useLocalSearchParams', paramsInitializer);
    const navigationExpression = getRouterOptionExpression(sourceFile, 'useNavigation', navigationInitializer);
    const pathnameExpression = getRouterOptionExpression(sourceFile, 'usePathname', pathnameInitializer);
    const segmentsExpression = getRouterOptionExpression(sourceFile, 'useSegments', segmentsInitializer);
    if (
        !routerExpression &&
        !paramsExpression &&
        !navigationExpression &&
        !pathnameExpression &&
        !segmentsExpression &&
        !stackInitializer &&
        !redirectInitializer &&
        !linkInitializer
    ) {
        return null;
    }

    return {
        start: callExpression.getStart(sourceFile),
        end: callExpression.getEnd(),
        value: createRouterMockReplacement({
            mockMethod,
            routerExpression: routerExpression?.getText(sourceFile),
            paramsExpression: paramsExpression ?? undefined,
            navigationExpression: navigationExpression ?? undefined,
            pathnameExpression: pathnameExpression ?? undefined,
            segmentsExpression: segmentsExpression ?? undefined,
        }),
        rewrite: {
            family: 'router',
            target: 'expo-router',
        },
    };
}

function maybeRewriteStorageMock(
    sourceFile: ts.SourceFile,
    callExpression: ts.CallExpression,
): Replacement | null {
    const mockMethod = getViMockMethodName(callExpression);
    const [target, factory] = callExpression.arguments;
    if (!target || !ts.isStringLiteral(target) || target.text !== '@/sync/domains/state/storage' || !factory) {
        return null;
    }

    if (ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)) {
        const legacyHelperCall = getHarnessHelperCall(
            factory,
            'createLegacyChatListStorageMock',
            LEGACY_CHAT_LIST_HARNESS_SPECIFIER,
        );
        if (legacyHelperCall) {
            const parameterText = factory.parameters.map((parameter) => parameter.getText(sourceFile)).join(', ');
            const argsText = legacyHelperCall.arguments.map((argument) => argument.getText(sourceFile)).join(', ');
            return {
                start: callExpression.getStart(sourceFile),
                end: callExpression.getEnd(),
                value: [
                    `vi.${mockMethod}('@/sync/domains/state/storage', async (${parameterText}) => (`,
                    `    ${buildHarnessHelperCallText('createLegacyChatListStorageMock', argsText)}`,
                    '))',
                ].join('\n'),
                rewrite: {
                    family: 'storage',
                    target: '@/sync/domains/state/storage',
                },
            };
        }
    }

    let returnedObject = getFactoryReturnObject(factory);
    if (!returnedObject) {
        if (!(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)) || !ts.isBlock(factory.body)) {
            return null;
        }

        const statement = factory.body.statements.find((candidate) => {
            if (!ts.isReturnStatement(candidate) || !candidate.expression) {
                return false;
            }
            const expression = ts.isParenthesizedExpression(candidate.expression)
                ? candidate.expression.expression
                : candidate.expression;
            return (
                ts.isCallExpression(expression) &&
                ts.isIdentifier(expression.expression) &&
                expression.expression.text === 'createStorageModuleStub' &&
                expression.arguments.length === 1 &&
                ts.isObjectLiteralExpression(expression.arguments[0])
            );
        });

        if (!statement || !ts.isReturnStatement(statement) || !statement.expression) {
            return null;
        }
        const expression = ts.isParenthesizedExpression(statement.expression)
            ? statement.expression.expression
            : statement.expression;
        if (
            !ts.isCallExpression(expression) ||
            !ts.isIdentifier(expression.expression) ||
            expression.expression.text !== 'createStorageModuleStub' ||
            expression.arguments.length !== 1 ||
            !ts.isObjectLiteralExpression(expression.arguments[0])
        ) {
            return null;
        }

        returnedObject = expression.arguments[0];
    }

    const declaredIdentifiers = new Set([
        ...collectTopLevelDeclaredIdentifierNames(sourceFile),
        ...collectDeclaredIdentifierNames(factory),
    ]);
    const importOriginalParamName = getFactoryImportOriginalParamName(factory);
    const importOriginalAliases = getFactoryImportOriginalAliases(factory, importOriginalParamName);
    const keptProperties: ts.ObjectLiteralElementLike[] = [];
    let droppedUndeclaredSpread = false;
    let needsImportOriginalMerge = false;

    for (const property of returnedObject.properties) {
        if (!ts.isSpreadAssignment(property)) {
            keptProperties.push(property);
            continue;
        }

        if (ts.isIdentifier(property.expression)) {
            if (importOriginalAliases.has(property.expression.text)) {
                needsImportOriginalMerge = true;
                continue;
            }
            if (!declaredIdentifiers.has(property.expression.text)) {
                droppedUndeclaredSpread = true;
                continue;
            }
        }

        return null;
    }

    const referencedIdentifiers = collectReferencedIdentifierNames(keptProperties);

    if (
        [...referencedIdentifiers].some(
            (identifier) =>
                !declaredIdentifiers.has(identifier) &&
                !isWellKnownIdentifier(identifier) &&
                !importOriginalAliases.has(identifier),
        )
    ) {
        return null;
    }

    const overridesText = buildObjectLiteralText(sourceFile, keptProperties);
    if (!overridesText) {
        return null;
    }

    return {
        start: callExpression.getStart(sourceFile),
        end: callExpression.getEnd(),
        value:
            needsImportOriginalMerge
                ? createPartialStorageModuleMockReplacement({
                      importOriginalParamName: importOriginalParamName ?? 'importOriginal',
                      overridesText,
                      mockMethod,
                  })
                : droppedUndeclaredSpread
                  ? createStorageMockReplacement(overridesText, mockMethod)
                  : createStorageMockReplacement(overridesText, mockMethod),
        rewrite: {
            family: 'storage',
            target: '@/sync/domains/state/storage',
        },
    };
}

function getFactoryImportOriginalParamName(factory: ts.Expression): string | null {
    if (!(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory))) {
        return null;
    }
    const [firstParameter] = factory.parameters;
    return firstParameter && ts.isIdentifier(firstParameter.name) ? firstParameter.name.text : null;
}

function getFactoryImportOriginalAliases(factory: ts.Expression, importOriginalParamName: string | null): ReadonlySet<string> {
    if (!(ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)) || !ts.isBlock(factory.body)) {
        return new Set();
    }

    const aliases = new Set<string>();
    for (const statement of factory.body.statements) {
        if (!ts.isVariableStatement(statement)) {
            continue;
        }
        for (const declaration of statement.declarationList.declarations) {
            if (
                ts.isIdentifier(declaration.name) &&
                declaration.initializer &&
                (
                    (importOriginalParamName && isCallToIdentifier(declaration.initializer, importOriginalParamName)) ||
                    isViImportActualCallForSpecifier(declaration.initializer, '@/sync/domains/state/storage')
                )
            ) {
                aliases.add(declaration.name.text);
            }
        }
    }
    return aliases;
}

function buildObjectLiteralText(
    sourceFile: ts.SourceFile,
    properties: readonly ts.ObjectLiteralElementLike[],
): string | null {
    if (properties.some((property) => !ts.isPropertyAssignment(property) && !ts.isSpreadAssignment(property))) {
        return null;
    }
    if (properties.length === 0) {
        return '{}';
    }
    return ['{', ...properties.map((property) => `    ${property.getText(sourceFile)},`), '}'].join('\n');
}

function collectTopLevelDeclaredIdentifierNames(sourceFile: ts.SourceFile): Set<string> {
    const declared = new Set<string>();

    const addBindingName = (name: ts.BindingName): void => {
        if (ts.isIdentifier(name)) {
            declared.add(name.text);
            return;
        }
        for (const element of name.elements) {
            if (ts.isOmittedExpression(element)) {
                continue;
            }
            addBindingName(element.name);
        }
    };

    for (const statement of sourceFile.statements) {
        if (ts.isImportDeclaration(statement) && statement.importClause) {
            if (statement.importClause.name) {
                declared.add(statement.importClause.name.text);
            }
            const namedBindings = statement.importClause.namedBindings;
            if (namedBindings) {
                if (ts.isNamespaceImport(namedBindings)) {
                    declared.add(namedBindings.name.text);
                } else {
                    for (const element of namedBindings.elements) {
                        declared.add(element.name.text);
                    }
                }
            }
            continue;
        }
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                addBindingName(declaration.name);
            }
            continue;
        }
        if (
            (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
            statement.name
        ) {
            declared.add(statement.name.text);
        }
    }

    return declared;
}

function collectDeclaredIdentifierNames(node: ts.Node): Set<string> {
    const declared = new Set<string>();

    const addBindingName = (name: ts.BindingName): void => {
        if (ts.isIdentifier(name)) {
            declared.add(name.text);
            return;
        }
        for (const element of name.elements) {
            if (ts.isOmittedExpression(element)) {
                continue;
            }
            addBindingName(element.name);
        }
    };

    const visit = (current: ts.Node): void => {
        if (ts.isTypeNode(current)) {
            return;
        }
        if (ts.isImportClause(current)) {
            if (current.name) {
                declared.add(current.name.text);
            }
        } else if (ts.isNamespaceImport(current) || ts.isImportSpecifier(current)) {
            declared.add(current.name.text);
        } else if (ts.isVariableDeclaration(current)) {
            addBindingName(current.name);
        } else if (ts.isParameter(current)) {
            addBindingName(current.name);
        } else if (ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current) || ts.isEnumDeclaration(current)) {
            if (current.name) {
                declared.add(current.name.text);
            }
        }
        ts.forEachChild(current, visit);
    };

    visit(node);
    return declared;
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

function isWellKnownIdentifier(identifier: string): boolean {
    return new Set([
        'Array',
        'Boolean',
        'Date',
        'Error',
        'JSON',
        'Map',
        'Math',
        'Number',
        'Object',
        'Promise',
        'Set',
        'String',
        'console',
        'globalThis',
        'null',
        'undefined',
        'vi',
    ]).has(identifier);
}

function maybeRewriteUnistylesMock(
    sourceFile: ts.SourceFile,
    callExpression: ts.CallExpression,
): Replacement | null {
    const mockMethod = getViMockMethodName(callExpression);
    const [target, factory] = callExpression.arguments;
    if (!target || !ts.isStringLiteral(target) || target.text !== 'react-native-unistyles' || !factory) {
        return null;
    }

    const returnedObject = getFactoryReturnObject(factory);
    if (!returnedObject) {
        const helperCall = getHarnessHelperCall(factory, 'createUnistylesMock', UNISTYLES_MOCK_SPECIFIER);
        if (!helperCall) {
            return null;
        }

        const [optionsInitializer] = helperCall.arguments;
        if (!optionsInitializer || !isLowSignalUnistylesThemeOptions(optionsInitializer, sourceFile)) {
            return null;
        }

        return {
            start: callExpression.getStart(sourceFile),
            end: callExpression.getEnd(),
            value: createUnistylesMockReplacement({ mockMethod }),
            rewrite: {
                family: 'unistyles',
                target: 'react-native-unistyles',
            },
        };
    }

    const allowedPropertyNames = new Set(['__esModule', 'useUnistyles', 'StyleSheet', 'UnistylesRuntime']);
    for (const property of returnedObject.properties) {
        if (ts.isSpreadAssignment(property)) {
            if (!ts.isIdentifier(property.expression)) {
                return null;
            }
            continue;
        }
        if (!ts.isPropertyAssignment(property)) {
            return null;
        }
        if (!allowedPropertyNames.has(property.name.getText(sourceFile))) {
            return null;
        }
    }

    const useUnistylesInitializer = getPropertyInitializer(returnedObject, 'useUnistyles');
    const styleSheetInitializer = getPropertyInitializer(returnedObject, 'StyleSheet');
    const runtimeInitializer = getPropertyInitializer(returnedObject, 'UnistylesRuntime');
    if (!useUnistylesInitializer && !styleSheetInitializer) {
        return null;
    }
    if (styleSheetInitializer && !ts.isObjectLiteralExpression(styleSheetInitializer)) {
        return null;
    }

    const useUnistylesReturn = useUnistylesInitializer
        ? getInlineFunctionReturnExpression(useUnistylesInitializer)
        : null;
    if (useUnistylesInitializer && (!useUnistylesReturn || !ts.isObjectLiteralExpression(useUnistylesReturn))) {
        return null;
    }

    const useUnistylesObject = useUnistylesReturn && ts.isObjectLiteralExpression(useUnistylesReturn)
        ? useUnistylesReturn
        : null;
    const themeExpression = useUnistylesObject
        ? getPropertyInitializer(useUnistylesObject, 'theme')?.getText(sourceFile)
        : getStyleSheetCreateThemeExpression(
            styleSheetInitializer && ts.isObjectLiteralExpression(styleSheetInitializer)
                ? styleSheetInitializer
                : null,
            sourceFile,
        );
    const rtExpression = useUnistylesObject
        ? getPropertyInitializer(useUnistylesObject, 'rt')?.getText(sourceFile)
        : undefined;
    const runtimeExpression = runtimeInitializer?.getText(sourceFile);

    return {
        start: callExpression.getStart(sourceFile),
        end: callExpression.getEnd(),
        value: createUnistylesMockReplacement({
            mockMethod,
            themeExpression,
            rtExpression,
            runtimeExpression,
        }),
        rewrite: {
            family: 'unistyles',
            target: 'react-native-unistyles',
        },
    };
}

export function rewriteInlineMockFamilies(
    text: string,
    options: Readonly<{
        families?: readonly InlineMockFamily[];
        filePath?: string;
    }> = {},
): InlineMockRewriteResult {
    const families = new Set(options.families ?? ['reactNative', 'text', 'modal', 'router', 'storage', 'unistyles']);
    const filePath = options.filePath ?? 'inlineMockFamilies.tsx';
    const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const replacements: Replacement[] = [];

    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && isViMockCall(node)) {
            const candidates: Array<Replacement | null> = [];
            if (families.has('reactNative')) {
                candidates.push(maybeRewriteReactNativeMock(sourceFile, node));
            }
            if (families.has('text')) {
                candidates.push(maybeRewriteTextMock(sourceFile, node));
            }
            if (families.has('modal')) {
                candidates.push(maybeRewriteModalMock(sourceFile, node));
            }
            if (families.has('router')) {
                candidates.push(maybeRewriteRouterMock(sourceFile, node));
            }
            if (families.has('storage')) {
                candidates.push(maybeRewriteStorageMock(sourceFile, node));
            }
            if (families.has('unistyles')) {
                candidates.push(maybeRewriteUnistylesMock(sourceFile, node));
            }
            for (const candidate of candidates) {
                if (candidate) {
                    replacements.push(candidate);
                    return;
                }
            }
        }
        ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    if (replacements.length === 0) {
        return {
            text,
            rewrites: [],
        };
    }

    const sorted = [...replacements].sort((left, right) => right.start - left.start);
    let nextText = text;
    for (const replacement of sorted) {
        nextText = `${nextText.slice(0, replacement.start)}${replacement.value}${nextText.slice(replacement.end)}`;
    }

    return {
        text: nextText,
        rewrites: replacements.map((replacement) => replacement.rewrite),
    };
}
