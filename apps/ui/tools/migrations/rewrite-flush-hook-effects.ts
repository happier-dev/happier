import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../../..');
const defaultScope = path.join(repoRoot, 'apps/ui/sources');
const TEST_FILE_RE = /\.(spec|test)\.[tj]sx?$/;
const TESTKIT_MODULE = '@/dev/testkit';
const FLUSH_HOOK_EFFECTS_MODULE = '@/dev/testkit/hooks/flushHookEffects';

type RewriteShape = 'flushHookEffectsTail';

type CliOptions = Readonly<{
    mode: 'dry-run' | 'write';
    targets: string[];
}>;

type RewriteResult = Readonly<{
    text: string;
    changed: boolean;
    counts: Record<RewriteShape, number>;
}>;

function createCounts(): Record<RewriteShape, number> {
    return { flushHookEffectsTail: 0 };
}

function printUsage(): void {
    console.log([
        'Usage: tsx tools/migrations/rewrite-flush-hook-effects.ts [--dry-run|--write] [--scope <path>] [path ...]',
        '',
        'Default mode is dry-run. Paths may be files or directories, absolute, cwd-relative, or repo-relative.',
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
    return true;
}

function collectFiles(targetPath: string, out: Set<string>): void {
    if (!fs.existsSync(targetPath)) {
        throw new Error(`Path does not exist: ${targetPath}`);
    }
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            collectFiles(path.join(targetPath, entry.name), out);
        }
        return;
    }
    if (shouldProcessFile(targetPath)) {
        out.add(targetPath);
    }
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
        if (names.includes(importName)) return text;
        const updated = [...names, importName].sort().join(', ');
        return text.replace(importPattern, `import { ${updated} } from '${modulePath}';`);
    }
    return `import { ${importName} } from '${modulePath}';\n${text}`;
}

function moveNamedImport(text: string, fromModulePath: string, toModulePath: string, importName: string): string {
    const escapedModulePath = fromModulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const importPattern = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${escapedModulePath}['"];?\\n?`);
    const match = text.match(importPattern);
    if (!match) return text;

    const names = match[1]
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    if (!names.includes(importName)) return text;

    const remaining = names.filter((name) => name !== importName);
    const replacement = remaining.length > 0
        ? `import { ${remaining.join(', ')} } from '${fromModulePath}';\n`
        : '';
    return ensureNamedImport(text.replace(importPattern, replacement), toModulePath, importName);
}

function lineMatchesIndent(line: string, indent: string): boolean {
    return line.startsWith(indent) && line.trim().length > 0;
}

function buildFlushHookEffectsCall(options: {
    turns: number;
    frames: number;
    advanceTimersMs?: string;
    runOnlyPendingTimers?: boolean;
}): string {
    const parts = ['cycles: 1'];
    if (options.turns > 0 || typeof options.advanceTimersMs === 'string' || options.runOnlyPendingTimers) {
        parts.push(`turns: ${options.turns}`);
    }
    if (options.frames > 0) parts.push(`frames: ${options.frames}`);
    if (typeof options.advanceTimersMs === 'string') parts.push(`advanceTimersMs: ${options.advanceTimersMs}`);
    if (options.runOnlyPendingTimers) parts.push('runOnlyPendingTimers: true');
    return `await flushHookEffects({ ${parts.join(', ')} });`;
}

function rewriteActBlock(match: string, indent: string, body: string, counts: Record<RewriteShape, number>): string {
    const lines = body
        .split('\n')
        .filter((line) => line.length > 0);
    if (lines.length === 0) return match;

    let index = lines.length - 1;
    let frames = 0;
    while (index >= 0 && /^\s*await flushAnimationFrame\(\);\s*$/.test(lines[index]!)) {
        frames += 1;
        index -= 1;
    }

    let turns = 0;
    while (index >= 0 && /^\s*await Promise\.resolve\(\);\s*$/.test(lines[index]!)) {
        turns += 1;
        index -= 1;
    }

    let advanceTimersMs: string | undefined;
    if (index >= 0) {
        const timerMatch = lines[index]!.match(/^\s*vi\.advanceTimersByTime\((.+)\);\s*$/);
        if (timerMatch) {
            advanceTimersMs = timerMatch[1]!.trim();
            index -= 1;
        }
    }

    let runOnlyPendingTimers = false;
    if (index >= 0 && /^\s*vi\.runOnlyPendingTimers\(\);\s*$/.test(lines[index]!)) {
        runOnlyPendingTimers = true;
        index -= 1;
    }

    if (turns === 0 && frames === 0 && typeof advanceTimersMs === 'undefined' && !runOnlyPendingTimers) {
        return match;
    }

    const prelude = lines.slice(0, index + 1);
    if (prelude.some((line) => (
        /^\s*await Promise\.resolve\(\);\s*$/.test(line)
        || /^\s*await flushAnimationFrame\(\);\s*$/.test(line)
        || /^\s*vi\.advanceTimersByTime\(.+\);\s*$/.test(line)
        || /^\s*vi\.runOnlyPendingTimers\(\);\s*$/.test(line)
    ))) {
        return match;
    }
    const innerIndentMatch = lines.find((line) => line.trim().length > 0)?.match(/^(\s*)/);
    const innerIndent = innerIndentMatch?.[1] ?? `${indent}    `;

    const rebuiltLines = [...prelude];
    rebuiltLines.push(`${innerIndent}${buildFlushHookEffectsCall({ turns, frames, advanceTimersMs, runOnlyPendingTimers })}`);

    counts.flushHookEffectsTail += 1;
    return `${indent}await act(async () => {\n${rebuiltLines.join('\n')}\n${indent}});`;
}

export function rewriteFlushHookEffects(text: string, _filePath: string): RewriteResult {
    const shouldNormalizeExistingImport = text.includes("import { flushHookEffects } from '@/dev/testkit'")
        && text.includes('flushHookEffects(');
    if (
        !text.includes('await act(async () => {')
        || (
            !text.includes('await Promise.resolve();')
            && !text.includes('flushAnimationFrame()')
            && !text.includes('vi.advanceTimersByTime(')
            && !text.includes('vi.runOnlyPendingTimers()')
            && !shouldNormalizeExistingImport
        )
    ) {
        return { text, changed: false, counts: createCounts() };
    }

    const counts = createCounts();
    let next = text.replace(
        /(^[ \t]*)await act\(async \(\) => \{\n((?:.*\n)*?)^\1\}\);/gm,
        (match, indent: string, body: string) => rewriteActBlock(match, indent, body, counts),
    );

    if (counts.flushHookEffectsTail > 0 || shouldNormalizeExistingImport) {
        next = moveNamedImport(next, TESTKIT_MODULE, FLUSH_HOOK_EFFECTS_MODULE, 'flushHookEffects');
        next = ensureNamedImport(next, FLUSH_HOOK_EFFECTS_MODULE, 'flushHookEffects');
    }

    return {
        text: next,
        changed: next !== text,
        counts,
    };
}

function formatCounts(counts: Record<RewriteShape, number>): string {
    return Object.entries(counts)
        .map(([shape, count]) => `${shape}=${count}`)
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
    const totalCounts = createCounts();

    for (const filePath of [...files].sort()) {
        const source = fs.readFileSync(filePath, 'utf8');
        const result = rewriteFlushHookEffects(source, filePath);
        if (!result.changed) continue;

        changedFiles += 1;
        totalCounts.flushHookEffectsTail += result.counts.flushHookEffectsTail;

        if (options.mode === 'write') {
            fs.writeFileSync(filePath, result.text, 'utf8');
        }

        const relativePath = toPosix(path.relative(repoRoot, filePath));
        console.log(`${options.mode === 'write' ? 'rewrote' : 'would rewrite'} ${relativePath} ${formatCounts(result.counts)}`);
    }

    console.log(`changedFiles=${changedFiles}`);
    console.log(formatCounts(totalCounts) || 'noChanges');
}

if (require.main === module) {
    main();
}
