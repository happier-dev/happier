import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../../..');
const defaultScope = path.join(repoRoot, 'apps/ui/sources');
const TEST_FILE_RE = /\.(spec|test)\.[tj]sx?$/;
const TESTKIT_MODULE = '@/dev/testkit';

type RewriteShape =
    | 'findAllByTestId'
    | 'findInstanceByTypeContainingText'
    | 'findInstanceByTypeWithProps'
    | 'findByTestIdFromTypedCollection'
    | 'pressByTestId'
    | 'pressByTestIdAsync'
    | 'pressInstance'
    | 'pressInstanceAsync'
    | 'invokeInstanceHandler'
    | 'changeTextInstance'
    | 'changeTextByTestId'
    | 'rootProxyFinds';

type CliOptions = Readonly<{
    mode: 'dry-run' | 'write';
    targets: string[];
}>;

type RewriteResult = Readonly<{
    text: string;
    changed: boolean;
    counts: Record<RewriteShape, number>;
}>;

const SHAPES: readonly RewriteShape[] = [
    'findAllByTestId',
    'findInstanceByTypeContainingText',
    'findInstanceByTypeWithProps',
    'findByTestIdFromTypedCollection',
    'pressByTestId',
    'pressByTestIdAsync',
    'pressInstance',
    'pressInstanceAsync',
    'invokeInstanceHandler',
    'changeTextInstance',
    'changeTextByTestId',
    'rootProxyFinds',
];

function createCounts(): Record<RewriteShape, number> {
    return {
        findAllByTestId: 0,
        findInstanceByTypeContainingText: 0,
        findInstanceByTypeWithProps: 0,
        findByTestIdFromTypedCollection: 0,
        pressByTestId: 0,
        pressByTestIdAsync: 0,
        pressInstance: 0,
        pressInstanceAsync: 0,
        invokeInstanceHandler: 0,
        changeTextInstance: 0,
        changeTextByTestId: 0,
        rootProxyFinds: 0,
    };
}

function printUsage(): void {
    console.log([
        'Usage: tsx tools/migrations/rewrite-render-screen-tree-walks.ts [--dry-run|--write] [--scope <path>] [path ...]',
        '',
        'Default mode is dry-run. Paths may be files or directories, absolute, cwd-relative, or repo-relative.',
        'If no paths are provided, the script scans apps/ui/sources test files.',
    ].join('\n'));
}

function parseCliArgs(argv: readonly string[]): CliOptions {
    const targets: string[] = [];
    let mode: 'dry-run' | 'write' = 'dry-run';

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') {
            printUsage();
            process.exit(0);
        }
        if (arg === '--dry-run') {
            mode = 'dry-run';
            continue;
        }
        if (arg === '--write') {
            mode = 'write';
            continue;
        }
        if (arg === '--scope') {
            const next = argv[index + 1];
            if (!next) {
                throw new Error('Missing value for --scope');
            }
            targets.push(next);
            index += 1;
            continue;
        }
        targets.push(arg);
    }

    return {
        mode,
        targets: targets.length > 0 ? targets : [defaultScope],
    };
}

function toPosix(inputPath: string): string {
    return inputPath.split(path.sep).join('/');
}

function resolveTargetPath(inputPath: string): string {
    if (path.isAbsolute(inputPath)) return inputPath;
    const cwdResolved = path.resolve(process.cwd(), inputPath);
    if (fs.existsSync(cwdResolved)) return cwdResolved;
    return path.resolve(repoRoot, inputPath);
}

function shouldProcessFile(filePath: string): boolean {
    const rel = toPosix(path.relative(repoRoot, filePath));
    if (!rel.startsWith('apps/ui/sources/')) return false;
    if (!TEST_FILE_RE.test(rel)) return false;
    if (rel.includes('/node_modules/')) return false;
    if (rel.includes('/sources/dev/testkit/')) return false;
    return true;
}

function collectFiles(targetPath: string, out: Set<string>): void {
    if (!fs.existsSync(targetPath)) {
        throw new Error(`Path does not exist: ${targetPath}`);
    }
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            if (entry.name === 'node_modules') continue;
            collectFiles(path.join(targetPath, entry.name), out);
        }
        return;
    }
    if (shouldProcessFile(targetPath)) {
        out.add(targetPath);
    }
}

function replaceWithCounter(
    text: string,
    pattern: RegExp,
    counter: () => void,
    replacer: (...args: string[]) => string,
): string {
    return text.replace(pattern, (...rawArgs) => {
        counter();
        const args = rawArgs.slice(1, -2) as string[];
        return replacer(...args);
    });
}

function ensureNamedImport(text: string, modulePath: string, importName: string): string {
    const escapedModulePath = modulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const importPattern = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${escapedModulePath}['"];?`);
    const match = text.match(importPattern);
    if (match) {
        const names = match[1]
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean);
        if (names.includes(importName)) {
            return text;
        }
        const updated = [...names, importName].sort().join(', ');
        return text.replace(importPattern, `import { ${updated} } from '${modulePath}';`);
    }

    return `import { ${importName} } from '${modulePath}';\n${text}`;
}

function normalizeInstanceTarget(target: string): string {
    return target.trim().replace(/\?$/, '');
}

export function rewriteRenderScreenTreeWalks(text: string, filePath: string): RewriteResult {
    const hasTypedCollectionPropFilter = /\.findAllByType\([^)]+\)\.find\(\([^)]+\)\s*=>\s*[^)\n]+\.props\?\.[A-Za-z_$][\w$]*\s*===/.test(text);
    if (
        !text.includes('renderScreen(')
        || (
            !text.includes('.root.find')
            && !text.includes('.props.onPress')
            && !text.includes('.props.onClick')
            && !text.includes('.props.onChangeText')
            && !text.includes('?.props?.onPress')
            && !text.includes('?.props?.onClick')
            && !text.includes('?.props?.onChangeText')
            && !hasTypedCollectionPropFilter
        )
    ) {
        return {
            text,
            changed: false,
            counts: createCounts(),
        };
    }

    const counts = createCounts();
    let next = text;

    next = replaceWithCounter(
        next,
        /(^[ \t]*)const\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*!?)\.root\.findByProps\(\{\s*testID:\s*(['"`])([^'"`]+)\4\s*\}\);\n\1await act\(async \(\) => \{\n\1    (await\s+)?\2\.props\.(onPress|onClick)\(\);\n\1\}\);/gm,
        () => {
            counts.pressByTestIdAsync += 1;
        },
        (indent, _binding, target, quote, testId) => (
            `${indent}await act(async () => {\n${indent}    await ${target}.pressByTestIdAsync(${quote}${testId}${quote});\n${indent}});`
        ),
    );

    next = replaceWithCounter(
        next,
        /(^[ \t]*)await act\(async \(\) => \{\n\1    const\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*!?)\.root\.findByProps\(\{\s*testID:\s*(['"`])([^'"`]+)\4\s*\}\);\n\1    (await\s+)?\2\.props\.(onPress|onClick)\(\);\n\1\}\);/gm,
        () => {
            counts.pressByTestId += 1;
        },
        (indent, _binding, target, quote, testId) => (
            `${indent}await act(async () => {\n${indent}    ${target}.pressByTestId(${quote}${testId}${quote});\n${indent}});`
        ),
    );

    next = replaceWithCounter(
        next,
        /await\s+([A-Za-z_$][\w$]*!?)\.root\.findByProps\(\{\s*testID:\s*(['"`])([^'"`]+)\2\s*\}\)\.props\.(onPress|onClick)\(\)/g,
        () => {
            counts.pressByTestIdAsync += 1;
        },
        (target, quote, testId) => `await ${target}.pressByTestIdAsync(${quote}${testId}${quote})`,
    );

    next = replaceWithCounter(
        next,
        /\b([A-Za-z_$][\w$]*!?)\.root\.findByProps\(\{\s*testID:\s*(['"`])([^'"`]+)\2\s*\}\)\.props\.(onPress|onClick)\(\)/g,
        () => {
            counts.pressByTestId += 1;
        },
        (target, quote, testId) => `${target}.pressByTestId(${quote}${testId}${quote})`,
    );

    next = replaceWithCounter(
        next,
        /(^[ \t]*)const\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+?)\.findAllByType\((['"`])([^'"`]+)\4\)\.find\(\(([A-Za-z_$][\w$]*):\s*any\)\s*=>\s*\{\n(?:\1[ \t]+)const texts = \6\.findAllByType\?\.\((['"`])Text\7\) \?\? \[\];\n(?:\1[ \t]+)return texts\.some\(\(([A-Za-z_$][\w$]*):\s*any\)\s*=>\s*String\(\8\.props\.children \?\? ''\)\.includes\((['"`])([^'"`]+)\9\)\);\n\1\}\);/gm,
        () => {
            counts.findInstanceByTypeContainingText += 1;
        },
        (indent, binding, target, quote, typeName, _node, _textQuote, _textNode, matcherQuote, matcher) => (
            `${indent}const ${binding} = findTestInstanceByTypeContainingText(${target}, ${quote}${typeName}${quote}, ${matcherQuote}${matcher}${matcherQuote});`
        ),
    );

    next = replaceWithCounter(
        next,
        /\b([A-Za-z_$][\w$]*!?)\.root\.findByProps\(\{\s*testID:\s*(['"`])([^'"`]+)\2\s*\}\)\.props\.onChangeText\(([^)]+)\)/g,
        () => {
            counts.changeTextByTestId += 1;
        },
        (target, quote, testId, value) => `${target}.changeTextByTestId(${quote}${testId}${quote}, ${value})`,
    );

    next = replaceWithCounter(
        next,
        /\b([A-Za-z_$][\w$]*!?)(\?)?\.root\.findAllByProps\(\{\s*testID:\s*(['"`])([^'"`]+)\3\s*\}\)/g,
        () => {
            counts.findAllByTestId += 1;
        },
        (target, optional, quote, testId) => `${target}${optional ?? ''}.findAllByTestId(${quote}${testId}${quote})`,
    );

    next = replaceWithCounter(
        next,
        /\(\s*([^()\n]+?)\s+as\s+any\s*\)\.root\.findByType\((['"`])([^'"`]+)\2\)/g,
        () => {
            counts.rootProxyFinds += 1;
        },
        (target, quote, typeName) => `findFirstByType(${target.trim()}, ${quote}${typeName}${quote})`,
    );

    next = replaceWithCounter(
        next,
        /\(\s*([^()\n]+?)\s+as\s+any\s*\)\.root\.findAllByType\((['"`])([^'"`]+)\2\)/g,
        () => {
            counts.rootProxyFinds += 1;
        },
        (target, quote, typeName) => `findAllByType(${target.trim()}, ${quote}${typeName}${quote})`,
    );

    next = replaceWithCounter(
        next,
        /\b([A-Za-z_$][\w$]*!?)(\?)?\.root\.(findByType|findAllByType|findByProps|findAllByProps|find|findAll)\(/g,
        () => {
            counts.rootProxyFinds += 1;
        },
        (target, optional, method) => `${target}${optional ?? ''}.${method}(`,
    );

    next = replaceWithCounter(
        next,
        /\b([A-Za-z_$][\w$]*!?)(\?)?\.findAllByType\((['"`])([^'"`]+)\3\)\.find\(\(([A-Za-z_$][\w$]*)(?::\s*any)?\)\s*=>\s*\5\.props\?\.testID\s*===\s*(['"`])([^'"`]+)\6\)/g,
        () => {
            counts.findByTestIdFromTypedCollection += 1;
        },
        (target, optional, quote, _typeName, _node, testIdQuote, testId) => (
            `${target}${optional ?? ''}.findByTestId(${testIdQuote}${testId}${testIdQuote})`
        ),
    );

    next = replaceWithCounter(
        next,
        /\b([A-Za-z_$][\w$]*!?)(\?)?\.findAllByType\(([^)\n]+?)\)\.find\(\(([A-Za-z_$][\w$]*)(?::\s*any)?\)\s*=>\s*\4\.props\?\.([A-Za-z_$][\w$]*)\s*===\s*([^)\n]+)\)/g,
        () => {
            counts.findInstanceByTypeWithProps += 1;
        },
        (target, optional, typeExpr, _node, propName, value) => {
            const invocation = `findTestInstanceByTypeWithProps(${target}, ${typeExpr.trim()}, { ${propName}: ${value.trim()} })`;
            return optional ? `${target} ? ${invocation} : undefined` : invocation;
        },
    );

    const hasDirectChangeTextHandler = next.includes('.props.onChangeText?.(');
    const hasOptionalChangeTextHandler = next.includes('?.props?.onChangeText?.(');

    if (hasDirectChangeTextHandler) {
        next = replaceWithCounter(
            next,
            /(^[ \t]*)await act\(async \(\) => \{\n((?:\1[ \t]+[^\n]*\n)*?)(\1[ \t]+)([^;\n]+?)\.props\.onChangeText\?\.\(([^;\n]+?)\);\n\1\}\);/gm,
            () => {
                counts.changeTextInstance += 1;
            },
            (indent, prelude, pressIndent, target, value) => (
                `${indent}await act(async () => {\n${prelude}${pressIndent}changeTextTestInstance(${normalizeInstanceTarget(target)}, ${value});\n${indent}});`
            ),
        );
    }

    if (hasOptionalChangeTextHandler) {
        next = replaceWithCounter(
            next,
            /(^[ \t]*)await act\(async \(\) => \{\n(\1[ \t]+)([^;\n]+?)\?\.props\?\.onChangeText\?\.\(([^;\n]+?)\);\n\1\}\);/gm,
            () => {
                counts.changeTextInstance += 1;
            },
            (indent, pressIndent, target, value) => (
                `${indent}await act(async () => {\n${pressIndent}changeTextTestInstance(${normalizeInstanceTarget(target)}, ${value});\n${indent}});`
            ),
        );
    }

    if (/\.props\.(?!onPress\b|onClick\b|onChangeText\b)[A-Za-z_$][\w$]*\(/.test(next)) {
        next = replaceWithCounter(
            next,
            /(^[ \t]*)await act\(async \(\) => \{\n((?:\1[ \t]+[^\n]*\n)*?)(\1[ \t]+)([^;\n]+?)\.props\.((?!(?:onPress|onClick|onChangeText)\b)[A-Za-z_$][\w$]*)\(([\s\S]*?)\);\n\1\}\);/gm,
            () => {
                counts.invokeInstanceHandler += 1;
            },
            (indent, prelude, pressIndent, target, handlerName, payload) => (
                `${indent}await act(async () => {\n${prelude}${pressIndent}invokeTestInstanceHandler(${normalizeInstanceTarget(target)}, '${handlerName}', ${payload});\n${indent}});`
            ),
        );
    }

    const hasDirectPressHandler = next.includes('.props.onPress') || next.includes('.props.onClick');
    const hasOptionalPressHandler = next.includes('?.props?.onPress') || next.includes('?.props?.onClick');

    if (hasDirectPressHandler) {
        next = replaceWithCounter(
            next,
            /(^[ \t]*)await act\(async \(\) => \{\n((?:\1[ \t]+[^\n]*\n)*?)(\1[ \t]+)(?:await\s+)?([^;\n]+?)\.props\.(onPress|onClick)\?\.\(\);\n\3await Promise\.resolve\(\);\n\1\}\);/gm,
            () => {
                counts.pressInstanceAsync += 1;
            },
            (indent, prelude, pressIndent, target) => (
                `${indent}await act(async () => {\n${prelude}${pressIndent}await pressTestInstanceAsync(${normalizeInstanceTarget(target)});\n${pressIndent}await Promise.resolve();\n${indent}});`
            ),
        );

        next = replaceWithCounter(
            next,
            /(^[ \t]*)await act\(async \(\) => \{\n((?:\1[ \t]+[^\n]*\n)*?)(\1[ \t]+)(?:await\s+)?([^;\n]+?)\.props\.(onPress|onClick)\?\.\(\);\n\1\}\);/gm,
            () => {
                counts.pressInstanceAsync += 1;
            },
            (indent, prelude, pressIndent, target) => (
                `${indent}await act(async () => {\n${prelude}${pressIndent}await pressTestInstanceAsync(${normalizeInstanceTarget(target)});\n${indent}});`
            ),
        );

        next = replaceWithCounter(
            next,
            /(^[ \t]*)await act\(async \(\) => \{\n((?:\1[ \t]+[^\n]*\n)*?)(\1[ \t]+)(?:await\s+)?([^;\n]+?)\.props\.(onPress|onClick)\(\);\n\1\}\);/gm,
            () => {
                counts.pressInstanceAsync += 1;
            },
            (indent, prelude, pressIndent, target) => (
                `${indent}await act(async () => {\n${prelude}${pressIndent}await pressTestInstanceAsync(${normalizeInstanceTarget(target)});\n${indent}});`
            ),
        );

        next = replaceWithCounter(
            next,
            /(^[ \t]*)act\(\(\) => \{\n((?:\1[ \t]+[^\n]*\n)*?)(\1[ \t]+)([^;\n]+?)\.props\.(onPress|onClick)\?\.\(\);\n\1\}\);/gm,
            () => {
                counts.pressInstance += 1;
            },
            (indent, prelude, pressIndent, target) => (
                `${indent}act(() => {\n${prelude}${pressIndent}pressTestInstance(${normalizeInstanceTarget(target)});\n${indent}});`
            ),
        );
    }

    if (hasOptionalPressHandler) {
        next = replaceWithCounter(
            next,
            /(^[ \t]*)act\(\(\) => \{\n(\1[ \t]+)([^;\n]+?)\?\.props\?\.(onPress|onClick)\?\.\(\);\n\1\}\);/gm,
            () => {
                counts.pressInstance += 1;
            },
            (indent, pressIndent, target) => (
                `${indent}act(() => {\n${pressIndent}pressTestInstance(${normalizeInstanceTarget(target)});\n${indent}});`
            ),
        );

        next = replaceWithCounter(
            next,
            /(^[ \t]*)await act\(async \(\) => \{\n(\1[ \t]+)(?:await\s+)?([^;\n]+?)\?\.props\?\.(onPress|onClick)\?\.\(\);\n\2await Promise\.resolve\(\);\n\1\}\);/gm,
            () => {
                counts.pressInstanceAsync += 1;
            },
            (indent, pressIndent, target) => (
                `${indent}await act(async () => {\n${pressIndent}await pressTestInstanceAsync(${normalizeInstanceTarget(target)});\n${pressIndent}await Promise.resolve();\n${indent}});`
            ),
        );

        next = replaceWithCounter(
            next,
            /(^[ \t]*)await act\(async \(\) => \{\n(\1[ \t]+)(?:await\s+)?([^;\n]+?)\?\.props\?\.(onPress|onClick)\?\.\(\);\n\1\}\);/gm,
            () => {
                counts.pressInstanceAsync += 1;
            },
            (indent, pressIndent, target) => (
                `${indent}await act(async () => {\n${pressIndent}await pressTestInstanceAsync(${normalizeInstanceTarget(target)});\n${indent}});`
            ),
        );

        next = replaceWithCounter(
            next,
            /(^[ \t]*)await act\(async \(\) => \{\n(\1[ \t]+)(?:await\s+)?([^;\n]+?)\?\.props\?\.(onPress|onClick)\(\);\n\1\}\);/gm,
            () => {
                counts.pressInstanceAsync += 1;
            },
            (indent, pressIndent, target) => (
                `${indent}await act(async () => {\n${pressIndent}await pressTestInstanceAsync(${normalizeInstanceTarget(target)});\n${indent}});`
            ),
        );

        next = replaceWithCounter(
            next,
            /(^[ \t]*)act\(\(\) => \{\n\1    ([^;\n]+?)\.props\.(onPress|onClick)\(\);\n\1\}\);/gm,
            () => {
                counts.pressInstance += 1;
            },
            (indent, target) => `${indent}act(() => {\n${indent}    pressTestInstance(${normalizeInstanceTarget(target)});\n${indent}});`,
        );

        next = replaceWithCounter(
            next,
            /(^[ \t]*)act\(\(\) => \{\n\1    ([^;\n]+?)\?\.props\?\.(onPress|onClick)\(\);\n\1\}\);/gm,
            () => {
                counts.pressInstance += 1;
            },
            (indent, target) => `${indent}act(() => {\n${indent}    pressTestInstance(${normalizeInstanceTarget(target)});\n${indent}});`,
        );
    }

    if (counts.pressInstance > 0) {
        next = ensureNamedImport(next, TESTKIT_MODULE, 'pressTestInstance');
    }
    if (counts.pressInstanceAsync > 0) {
        next = ensureNamedImport(next, TESTKIT_MODULE, 'pressTestInstanceAsync');
    }
    if (counts.invokeInstanceHandler > 0) {
        next = ensureNamedImport(next, TESTKIT_MODULE, 'invokeTestInstanceHandler');
    }
    if (counts.changeTextInstance > 0) {
        next = ensureNamedImport(next, TESTKIT_MODULE, 'changeTextTestInstance');
    }
    if (counts.findInstanceByTypeContainingText > 0) {
        next = ensureNamedImport(next, TESTKIT_MODULE, 'findTestInstanceByTypeContainingText');
    }
    if (counts.findInstanceByTypeWithProps > 0) {
        next = ensureNamedImport(next, TESTKIT_MODULE, 'findTestInstanceByTypeWithProps');
    }
    if (/(^|[^.\w])findAllByType\(/m.test(next)) {
        next = ensureNamedImport(next, TESTKIT_MODULE, 'findAllByType');
    }
    if (/(^|[^.\w])findFirstByType\(/m.test(next)) {
        next = ensureNamedImport(next, TESTKIT_MODULE, 'findFirstByType');
    }

    return {
        text: next,
        changed: next !== text,
        counts,
    };
}

function formatCounts(counts: Record<RewriteShape, number>): string {
    return SHAPES
        .map((shape) => `${shape}=${counts[shape]}`)
        .filter((entry) => !entry.endsWith('=0'))
        .join(' ');
}

function main(): void {
    const options = parseCliArgs(process.argv.slice(2));
    const files = new Set<string>();
    for (const target of options.targets) {
        collectFiles(resolveTargetPath(target), files);
    }

    let changedFiles = 0;
    const aggregateCounts = createCounts();

    for (const filePath of [...files].sort()) {
        const source = fs.readFileSync(filePath, 'utf8');
        const result = rewriteRenderScreenTreeWalks(source, filePath);
        if (!result.changed) {
            continue;
        }
        changedFiles += 1;
        for (const shape of SHAPES) {
            aggregateCounts[shape] += result.counts[shape];
        }
        if (options.mode === 'write') {
            fs.writeFileSync(filePath, result.text);
        }
        const relativePath = toPosix(path.relative(repoRoot, filePath));
        console.log(`${options.mode === 'write' ? 'rewrote' : 'would rewrite'} ${relativePath} ${formatCounts(result.counts)}`);
    }

    console.log(`changedFiles=${changedFiles}`);
    console.log(formatCounts(aggregateCounts) || 'noChanges');
}

if (require.main === module) {
    main();
}
