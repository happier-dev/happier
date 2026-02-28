import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export type UserFacingStringHit = Readonly<{
    filePath: string;
    line: number;
    column: number;
    text: string;
    kind: 'jsxText' | 'jsxAttribute' | 'jsxExpressionString' | 'callArg' | 'variable';
}>;

const SCAN_EXTENSIONS = new Set(['.tsx', '.ts']);

const EXCLUDED_DIR_PARTS = new Set([
    `${path.sep}node_modules${path.sep}`,
    `${path.sep}dist${path.sep}`,
    `${path.sep}.project${path.sep}`,
    `${path.sep}sources${path.sep}dev${path.sep}`,
    // Debug-only routes under the app router.
    `${path.sep}sources${path.sep}app${path.sep}(app)${path.sep}dev${path.sep}`,
    `${path.sep}sources${path.sep}text${path.sep}translations${path.sep}`,
]);

const EXCLUDED_FILE_SUFFIXES = [
    '.test.ts',
    '.test.tsx',
    '.spec.ts',
    '.spec.tsx',
    '.integration.test.ts',
    '.integration.test.tsx',
    '.integration.spec.ts',
    '.integration.spec.tsx',
];

const JSX_ATTRIBUTE_USER_FACING_NAMES = new Set<string>([
    'title',
    'label',
    'placeholder',
    'accessibilityLabel',
    'accessibilityHint',
    'aria-label',
    'ariaLabel',
    'headerTitle',
    'subtitle',
    'description',
    'hint',
    'emptyTitle',
    'emptyDescription',
]);

const USER_FACING_OBJECT_PROPERTY_NAMES = new Set<string>([
    ...JSX_ATTRIBUTE_USER_FACING_NAMES,
    // Common object-shape properties used in JSX props (menus, items, sections).
    'text',
    'message',
    'header',
    'helperText',
    'confirmText',
    'cancelText',
    // Common alert/toast option keys.
    'errorTitle',
    'successTitle',
    'errorMessage',
    'successMessage',
]);

const JSX_ATTRIBUTE_NON_USER_FACING_NAMES = new Set<string>([
    'testID',
    'id',
    'key',
    'className',
    'style',
    'source',
    'href',
    'to',
    'name',
    'route',
    'icon',
    'variant',
    'color',
    'size',
    'width',
    'height',
]);

function shouldExcludeFile(filePath: string): boolean {
    for (const part of EXCLUDED_DIR_PARTS) {
        if (filePath.includes(part)) return true;
    }
    return EXCLUDED_FILE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

function listSourceFiles(rootDir: string): string[] {
    const out: string[] = [];

    const walk = (dirPath: string): void => {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === 'dist') continue;
                walk(fullPath);
                continue;
            }
            if (!entry.isFile()) continue;

            const ext = path.extname(entry.name);
            if (!SCAN_EXTENSIONS.has(ext)) continue;
            if (shouldExcludeFile(fullPath)) continue;

            out.push(fullPath);
        }
    };

    walk(rootDir);
    return out;
}

function isTriviallyIgnorableText(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length === 0) return true;
    // Common JSX whitespace helpers
    if (trimmed === '{' || trimmed === '}' || trimmed === ',' || trimmed === '.' || trimmed === ':') return true;
    // Bullet/decoration-only text
    if (trimmed === '•' || trimmed === '·' || trimmed === '—' || trimmed === '–') return true;
    // Layout-only punctuation
    if (trimmed === '(' || trimmed === ')' || trimmed === '[' || trimmed === ']') return true;
    return false;
}

function isLikelyUserFacingText(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;
    // Must contain at least one letter (any script); exclude pure punctuation/numbers.
    if (!/\p{L}/u.test(trimmed)) return false;

    // Ignore strings that look like internal identifiers / enum tokens / routes.
    // Examples: "loading", "read_only", "flex-start", "happier://...", "/restore", "small"
    if (/^([a-z]+):\/\//i.test(trimmed)) return false;
    if (trimmed.startsWith('/')) return false;
    if (/^[a-z0-9._/-]+$/.test(trimmed) && trimmed === trimmed.toLowerCase() && trimmed.length <= 48) return false;
    if (
        /^[a-z0-9_-]+$/.test(trimmed) &&
        trimmed === trimmed.toLowerCase() &&
        /[_-]/.test(trimmed) &&
        trimmed.length <= 48
    )
        return false;

    return true;
}

function getLineAndColumn(sourceFile: ts.SourceFile, pos: number): { line: number; column: number } {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
    return { line: line + 1, column: character + 1 };
}

function getObjectPropertyName(node: ts.ObjectLiteralElementLike, sourceFile: ts.SourceFile): string | null {
    if (!ts.isPropertyAssignment(node)) return null;
    const name = node.name;
    if (ts.isIdentifier(name)) return name.text;
    if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    return null;
}

function isTranslationCallExpression(expr: ts.Expression): boolean {
    return ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 't';
}

function normalizeTemplateExpressionText(expr: ts.TemplateExpression): string {
    // Turn `Hello ${name}!` into `Hello ${…}!` so the reported hit is stable and readable.
    let out = expr.head.text;
    for (const span of expr.templateSpans) {
        out += '${…}';
        out += span.literal.text;
    }
    return out;
}

function collectUserFacingStringsFromExpression(args: Readonly<{
    filePath: string;
    sourceFile: ts.SourceFile;
    expression: ts.Expression;
    hits: UserFacingStringHit[];
    kind: UserFacingStringHit['kind'];
}>): void {
    const { filePath, sourceFile, expression, hits, kind } = args;

    const pushHit = (node: ts.Node, text: string): void => {
        if (isTriviallyIgnorableText(text) || !isLikelyUserFacingText(text)) return;
        const { line, column } = getLineAndColumn(sourceFile, node.getStart(sourceFile));
        hits.push({ filePath, line, column, text: text.trim(), kind });
    };

    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            if (isTranslationCallExpression(node as unknown as ts.Expression)) return;
        }

        if (ts.isConditionalExpression(node)) {
            // Only traverse result branches; string literals in the condition are usually enum tokens / internal ids.
            visit(node.whenTrue);
            visit(node.whenFalse);
            return;
        }

        if (ts.isBinaryExpression(node)) {
            const op = node.operatorToken.kind;
            // Comparisons typically involve internal discriminants (e.g. `mode === 'readOnly'`).
            const isComparison =
                op === ts.SyntaxKind.EqualsEqualsToken ||
                op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
                op === ts.SyntaxKind.ExclamationEqualsToken ||
                op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
                op === ts.SyntaxKind.LessThanToken ||
                op === ts.SyntaxKind.LessThanEqualsToken ||
                op === ts.SyntaxKind.GreaterThanToken ||
                op === ts.SyntaxKind.GreaterThanEqualsToken ||
                op === ts.SyntaxKind.InKeyword ||
                op === ts.SyntaxKind.InstanceOfKeyword;

            if (isComparison) return;
            visit(node.left);
            visit(node.right);
            return;
        }

        if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isSpreadAssignment(node)) {
            if (!ts.isPropertyAssignment(node)) {
                ts.forEachChild(node, visit);
                return;
            }

            const propertyName = getObjectPropertyName(node, sourceFile);
            const init = node.initializer;

            // Skip most non-user-facing scalar literals (e.g. `{ style: 'cancel' }`),
            // but still traverse objects/arrays so we can find nested user-facing keys.
            if (propertyName && USER_FACING_OBJECT_PROPERTY_NAMES.has(propertyName)) {
                visit(init);
                return;
            }

            if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) {
                visit(init);
                return;
            }

            return;
        }

        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            pushHit(node, node.text);
            return;
        }

        if (ts.isTemplateExpression(node)) {
            pushHit(node, normalizeTemplateExpressionText(node));
            return;
        }

        ts.forEachChild(node, visit);
    };

    visit(expression);
}

function collectUserFacingStringLiteralsFromExpression(args: Readonly<{
    filePath: string;
    sourceFile: ts.SourceFile;
    expression: ts.Expression;
    hits: UserFacingStringHit[];
}>): void {
    const { filePath, sourceFile, expression, hits } = args;

    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            if (isTranslationCallExpression(node as unknown as ts.Expression)) return;
        }

        if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isSpreadAssignment(node)) {
            if (!ts.isPropertyAssignment(node)) {
                ts.forEachChild(node, visit);
                return;
            }

            const propertyName = getObjectPropertyName(node, sourceFile);
            const init = node.initializer;
            if (propertyName && USER_FACING_OBJECT_PROPERTY_NAMES.has(propertyName)) {
                if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
                    const value = init.text;
                    if (!isTriviallyIgnorableText(value) && isLikelyUserFacingText(value)) {
                        const { line, column } = getLineAndColumn(sourceFile, init.getStart(sourceFile));
                        hits.push({ filePath, line, column, text: value, kind: 'jsxExpressionString' });
                    }
                    return;
                }

                if (ts.isTemplateExpression(init)) {
                    const value = normalizeTemplateExpressionText(init);
                    if (!isTriviallyIgnorableText(value) && isLikelyUserFacingText(value)) {
                        const { line, column } = getLineAndColumn(sourceFile, init.getStart(sourceFile));
                        hits.push({ filePath, line, column, text: value, kind: 'jsxExpressionString' });
                    }
                    return;
                }
            }

            ts.forEachChild(node, visit);
            return;
        }

        ts.forEachChild(node, visit);
    };

    visit(expression);
}

export function scanUserFacingStrings(args: Readonly<{ sourcesRootDir: string }>): ReadonlyArray<UserFacingStringHit> {
    const resolvedSourcesRootDir = path.resolve(args.sourcesRootDir);
    const files = listSourceFiles(resolvedSourcesRootDir);
    const hits: UserFacingStringHit[] = [];

    for (const filePath of files) {
        const content = fs.readFileSync(filePath, 'utf8');
        // Fast path: most non-UI `.ts` files won't contain JSX or user-facing call sites.
        // Avoid parsing them with TypeScript unless they contain obvious candidates.
        if (!content.includes('<') && !content.includes('Modal.') && !content.includes('Toast.')) {
            continue;
        }
        const ext = path.extname(filePath);
        const scriptKind = ext === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
        const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.ESNext, true, scriptKind);

        // Track identifiers that are used in clearly user-facing JSX slots so we can
        // flag string/template literals assigned to those variables (e.g. `const title = '...'`).
        const userFacingIdentifierUses = new Set<string>();
        const collectUserFacingIdentifierUses = (node: ts.Node): void => {
            if (ts.isJsxAttribute(node)) {
                const name = node.name.getText(sourceFile);
                if (JSX_ATTRIBUTE_USER_FACING_NAMES.has(name)) {
                    const init = node.initializer;
                    if (init && ts.isJsxExpression(init) && init.expression && ts.isIdentifier(init.expression)) {
                        userFacingIdentifierUses.add(init.expression.text);
                    }
                }
            }

            if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) {
                const expr = node.expression;
                if (expr && ts.isIdentifier(expr)) {
                    const parent = node.parent;
                    if (ts.isJsxElement(parent) && parent.openingElement.tagName.getText(sourceFile) === 'Text') {
                        userFacingIdentifierUses.add(expr.text);
                    }
                }
            }

            ts.forEachChild(node, collectUserFacingIdentifierUses);
        };
        collectUserFacingIdentifierUses(sourceFile);

        const visit = (node: ts.Node): void => {
            if (ts.isVariableDeclaration(node)) {
                if (ts.isIdentifier(node.name) && node.initializer && userFacingIdentifierUses.has(node.name.text)) {
                    collectUserFacingStringsFromExpression({
                        filePath,
                        sourceFile,
                        expression: node.initializer,
                        hits,
                        kind: 'variable',
                    });
                }
            }

            if (ts.isCallExpression(node)) {
                const isModalCall =
                    ts.isPropertyAccessExpression(node.expression) &&
                    ts.isIdentifier(node.expression.expression) &&
                    node.expression.expression.text === 'Modal' &&
                    (node.expression.name.text === 'alert' ||
                        node.expression.name.text === 'confirm' ||
                        node.expression.name.text === 'prompt');

                const isToastCall =
                    ts.isPropertyAccessExpression(node.expression) &&
                    ts.isIdentifier(node.expression.expression) &&
                    node.expression.expression.text === 'Toast';

                if (isModalCall || isToastCall) {
                    for (const arg of node.arguments) {
                        collectUserFacingStringsFromExpression({
                            filePath,
                            sourceFile,
                            expression: arg,
                            hits,
                            kind: 'callArg',
                        });
                    }
                }
            }

            if (ts.isJsxText(node)) {
                const text = node.getText(sourceFile);
                if (!isTriviallyIgnorableText(text) && isLikelyUserFacingText(text)) {
                    const { line, column } = getLineAndColumn(sourceFile, node.getStart(sourceFile));
                    hits.push({ filePath, line, column, text: text.trim(), kind: 'jsxText' });
                }
            }

            if (ts.isJsxExpression(node)) {
                // Ignore attribute initializers like `color={'black'}` (usually non-user-facing).
                if (ts.isJsxAttribute(node.parent)) {
                    ts.forEachChild(node, visit);
                    return;
                }

                const expr = node.expression;
                if (expr && (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))) {
                    const value = expr.text;
                    if (!isTriviallyIgnorableText(value) && isLikelyUserFacingText(value)) {
                        const { line, column } = getLineAndColumn(sourceFile, expr.getStart(sourceFile));
                        hits.push({ filePath, line, column, text: value, kind: 'jsxExpressionString' });
                    }
                } else if (expr && ts.isTemplateExpression(expr)) {
                    const value = normalizeTemplateExpressionText(expr);
                    if (!isTriviallyIgnorableText(value) && isLikelyUserFacingText(value)) {
                        const { line, column } = getLineAndColumn(sourceFile, expr.getStart(sourceFile));
                        hits.push({ filePath, line, column, text: value, kind: 'jsxExpressionString' });
                    }
                }
            }

            if (ts.isJsxAttribute(node)) {
                const name = node.name.getText(sourceFile);
                if (JSX_ATTRIBUTE_NON_USER_FACING_NAMES.has(name)) {
                    // ignore
                } else if (JSX_ATTRIBUTE_USER_FACING_NAMES.has(name)) {
                    const init = node.initializer;
                    if (init && ts.isStringLiteral(init)) {
                        const value = init.text;
                        if (!isTriviallyIgnorableText(value) && isLikelyUserFacingText(value)) {
                            const { line, column } = getLineAndColumn(sourceFile, init.getStart(sourceFile));
                            hits.push({ filePath, line, column, text: value, kind: 'jsxAttribute' });
                        }
                    }
                    if (init && ts.isJsxExpression(init) && init.expression) {
                        const expr = init.expression;
                        collectUserFacingStringsFromExpression({
                            filePath,
                            sourceFile,
                            expression: expr,
                            hits,
                            kind: 'jsxAttribute',
                        });

                        if (ts.isObjectLiteralExpression(expr) || ts.isArrayLiteralExpression(expr)) {
                            collectUserFacingStringLiteralsFromExpression({ filePath, sourceFile, expression: expr, hits });
                        }
                    }
                } else {
                    const init = node.initializer;
                    if (init && ts.isJsxExpression(init) && init.expression) {
                        const expr = init.expression;
                        if (ts.isObjectLiteralExpression(expr) || ts.isArrayLiteralExpression(expr)) {
                            collectUserFacingStringLiteralsFromExpression({ filePath, sourceFile, expression: expr, hits });
                        }
                    }
                }
            }

            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
    }

    return hits;
}
