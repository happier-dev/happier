import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    collectResidualFileCounts,
    readResidualInventoryEntries,
    type ResidualFileSummary,
} from '../../sources/dev/testkit/inventory/residualFamilies';
import { collectInlineMockFamilyStats, type InlineMockFamilyName } from './inlineMockClassifier';

const repoRoot = path.resolve(__dirname, '../../../..');
const INLINE_MOCK_FAMILIES = ['reactNative', 'unistyles', 'text', 'modal', 'router', 'storage'] as const satisfies readonly InlineMockFamilyName[];

type DirectoryInlineMockCounts = Readonly<Record<InlineMockFamilyName | 'total', number>>;
type DirectoryInlineMockShapeCounts = Readonly<{
    total: number;
    canonical: number;
    adHoc: number;
}>;

export type VerifyInlineMockFamiliesOptions = Readonly<{
    scope: string;
    top: number;
    json: boolean;
    failOnAdHoc: boolean;
    failOnFamilies: readonly InlineMockFamilyName[];
    allowDirectories: readonly string[];
    maxAdHoc?: number;
    maxTotal?: number;
}>;

type VerificationAggregate = Readonly<{
    total: number;
    canonical: number;
    adHoc: number;
    families: Readonly<Record<InlineMockFamilyName, number>>;
}>;

export type InlineMockVerificationReport = Readonly<{
    summary: VerificationAggregate;
    enforced: VerificationAggregate;
    allowedDirectories: readonly string[];
    violations: readonly string[];
}>;

function parseOptionalInt(value: string | undefined, flag: string): number {
    const parsed = Number.parseInt(value ?? '', 10);
    if (!Number.isFinite(parsed)) {
        throw new Error(`Expected ${flag} <number>.`);
    }
    return parsed;
}

function normalizePathForComparison(inputPath: string): string {
    return inputPath.replace(/\\/g, '/').replace(/\/+$/, '');
}

function normalizeDirectory(directory: string, scope: string): string {
    const normalized = normalizePathForComparison(directory);
    if (normalized.length === 0) {
        return normalizePathForComparison(scope);
    }
    if (path.isAbsolute(normalized)) {
        return normalized;
    }

    const normalizedScope = normalizePathForComparison(scope);
    if (
        normalized.startsWith('apps/ui/') ||
        normalized.startsWith('/Users/') ||
        normalized === normalizedScope ||
        normalized.startsWith(`${normalizedScope}/`)
    ) {
        return normalized;
    }

    return normalizePathForComparison(path.posix.join(normalizedScope, normalized));
}

function createEmptyFamilyCounts(): Record<InlineMockFamilyName, number> {
    return {
        reactNative: 0,
        unistyles: 0,
        text: 0,
        modal: 0,
        router: 0,
        storage: 0,
    };
}

function createEmptyAggregate(): {
    total: number;
    canonical: number;
    adHoc: number;
    families: Record<InlineMockFamilyName, number>;
} {
    return {
        total: 0,
        canonical: 0,
        adHoc: 0,
        families: createEmptyFamilyCounts(),
    };
}

export function parseVerifyInlineMockFamiliesArgs(argv: readonly string[]): VerifyInlineMockFamiliesOptions {
    let scope = 'apps/ui/sources';
    let top = 20;
    let json = false;
    let failOnAdHoc = false;
    const failOnFamilies: InlineMockFamilyName[] = [];
    const allowDirectories: string[] = [];
    let maxAdHoc: number | undefined;
    let maxTotal: number | undefined;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--scope') {
            scope = argv[index + 1] ?? scope;
            index += 1;
            continue;
        }
        if (arg === '--top') {
            top = parseOptionalInt(argv[index + 1], '--top');
            index += 1;
            continue;
        }
        if (arg === '--json') {
            json = true;
            continue;
        }
        if (arg === '--fail-on-ad-hoc') {
            failOnAdHoc = true;
            continue;
        }
        if (arg === '--fail-on-family') {
            const family = argv[index + 1];
            if (!family || !INLINE_MOCK_FAMILIES.includes(family as InlineMockFamilyName)) {
                throw new Error(`Expected --fail-on-family <${INLINE_MOCK_FAMILIES.join('|')}>.`);
            }
            failOnFamilies.push(family as InlineMockFamilyName);
            index += 1;
            continue;
        }
        if (arg === '--allow-directory') {
            const directory = argv[index + 1];
            if (!directory) {
                throw new Error('Expected --allow-directory <path>.');
            }
            allowDirectories.push(directory);
            index += 1;
            continue;
        }
        if (arg === '--max-ad-hoc') {
            maxAdHoc = parseOptionalInt(argv[index + 1], '--max-ad-hoc');
            index += 1;
            continue;
        }
        if (arg === '--max-total') {
            maxTotal = parseOptionalInt(argv[index + 1], '--max-total');
            index += 1;
        }
    }

    return {
        scope,
        top,
        json,
        failOnAdHoc,
        failOnFamilies,
        allowDirectories,
        maxAdHoc,
        maxTotal,
    };
}

function aggregateByDirectory(files: readonly ResidualFileSummary[]) {
    const buckets = new Map<string, Record<string, number>>();

    for (const file of files) {
        const current = buckets.get(file.directory) ?? {
            reactNative: 0,
            unistyles: 0,
            text: 0,
            modal: 0,
            router: 0,
            storage: 0,
            total: 0,
        };
        current.reactNative += file.counts.inlineMocks.reactNative;
        current.unistyles += file.counts.inlineMocks.unistyles;
        current.text += file.counts.inlineMocks.text;
        current.modal += file.counts.inlineMocks.modal;
        current.router += file.counts.inlineMocks.router;
        current.storage += file.counts.inlineMocks.storage;
        current.total += (
            file.counts.inlineMocks.reactNative +
            file.counts.inlineMocks.unistyles +
            file.counts.inlineMocks.text +
            file.counts.inlineMocks.modal +
            file.counts.inlineMocks.router +
            file.counts.inlineMocks.storage
        );
        buckets.set(file.directory, current);
    }

    return [...buckets.entries()]
        .filter(([, counts]) => counts.total > 0)
        .sort((left, right) => right[1].total - left[1].total || left[0].localeCompare(right[0]));
}

function aggregateInlineMockShapeByDirectory(files: readonly ResidualFileSummary[], rootDir: string) {
    const buckets = new Map<string, Record<string, number>>();

    for (const file of files) {
        const absolutePath = path.isAbsolute(file.path) ? file.path : path.resolve(rootDir, file.path);
        const text = fs.readFileSync(absolutePath, 'utf8');
        const stats = collectInlineMockFamilyStats(text, { filePath: absolutePath });
        const current = buckets.get(file.directory) ?? {
            total: 0,
            canonical: 0,
            adHoc: 0,
        };

        for (const family of Object.keys(stats) as InlineMockFamilyName[]) {
            current.total += stats[family].total;
            current.canonical += stats[family].canonical;
            current.adHoc += stats[family].adHoc;
        }

        buckets.set(file.directory, current);
    }

    return [...buckets.entries()]
        .filter(([, counts]) => counts.total > 0)
        .sort((left, right) => right[1].adHoc - left[1].adHoc || right[1].canonical - left[1].canonical || left[0].localeCompare(right[0]));
}

function buildAggregate(files: readonly ResidualFileSummary[]): VerificationAggregate {
    const aggregate = createEmptyAggregate();

    for (const file of files) {
        aggregate.total += file.inlineMockShapes.total;
        aggregate.canonical += file.inlineMockShapes.canonical;
        aggregate.adHoc += file.inlineMockShapes.adHoc;
        for (const family of INLINE_MOCK_FAMILIES) {
            aggregate.families[family] += file.counts.inlineMocks[family];
        }
    }

    return aggregate;
}

function isAllowedDirectory(directory: string, allowedDirectories: readonly string[]): boolean {
    const normalizedDirectory = normalizePathForComparison(directory);
    return allowedDirectories.some((allowedDirectory) => (
        normalizedDirectory === allowedDirectory ||
        normalizedDirectory.startsWith(`${allowedDirectory}/`)
    ));
}

export function createInlineMockVerificationReport(
    files: readonly ResidualFileSummary[],
    options: VerifyInlineMockFamiliesOptions,
): InlineMockVerificationReport {
    const allowedDirectories = options.allowDirectories.map((directory) => normalizeDirectory(directory, options.scope));
    const enforcedFiles = files.filter((file) => !isAllowedDirectory(file.directory, allowedDirectories));
    const summary = buildAggregate(files);
    const enforced = buildAggregate(enforcedFiles);
    const violations: string[] = [];

    if (options.failOnAdHoc && enforced.adHoc > 0) {
        violations.push(`Ad hoc inline mock families remain outside the allowlist (count=${enforced.adHoc}).`);
    }

    for (const family of options.failOnFamilies) {
        const count = enforced.families[family];
        if (count > 0) {
            violations.push(`Inline mock family "${family}" remains outside the allowlist (count=${count}).`);
        }
    }

    if (options.maxAdHoc !== undefined && enforced.adHoc > options.maxAdHoc) {
        violations.push(`Ad hoc inline mock count ${enforced.adHoc} exceeds max allowed ${options.maxAdHoc}.`);
    }

    if (options.maxTotal !== undefined && enforced.total > options.maxTotal) {
        violations.push(`Total inline mock count ${enforced.total} exceeds max allowed ${options.maxTotal}.`);
    }

    return {
        summary,
        enforced,
        allowedDirectories,
        violations,
    };
}

function buildOutput(files: readonly ResidualFileSummary[], options: VerifyInlineMockFamiliesOptions, rootDir: string) {
    const directories = aggregateByDirectory(files).slice(0, options.top);
    const inlineShapeDirectories = aggregateInlineMockShapeByDirectory(files, rootDir).slice(0, options.top);
    const verification = createInlineMockVerificationReport(files, options);

    return {
        scope: options.scope,
        fileCount: files.length,
        topDirectories: directories.map(([directory, counts]) => ({
            directory,
            ...(counts as DirectoryInlineMockCounts),
        })),
        topInlineShapeDirectories: inlineShapeDirectories.map(([directory, counts]) => ({
            directory,
            ...(counts as DirectoryInlineMockShapeCounts),
        })),
        topEligibleFiles: files
            .filter((file) => file.codemodEligible)
            .slice(0, options.top)
            .map((file) => ({
                path: file.path,
                directory: file.directory,
                family: file.family,
                area: file.area,
                hotspotScore: file.hotspotScore,
                inlineMocks: file.counts.inlineMocks,
            })),
        verification,
    };
}

function printOutput(output: ReturnType<typeof buildOutput>): void {
    console.log(`scope=${output.scope}`);
    console.log(`fileCount=${output.fileCount}`);
    console.log('topDirectories:');
    for (const directory of output.topDirectories as Array<{
        directory: string;
        total: number;
        reactNative: number;
        unistyles: number;
        text: number;
        modal: number;
        router: number;
        storage: number;
    }>) {
        console.log(
            `  - ${directory.directory}: total=${directory.total} reactNative=${directory.reactNative} unistyles=${directory.unistyles} text=${directory.text} modal=${directory.modal} router=${directory.router} storage=${directory.storage}`,
        );
    }
    console.log('topEligibleFiles:');
    for (const file of output.topEligibleFiles) {
        console.log(
            `  - ${file.path}: hotspotScore=${file.hotspotScore} reactNative=${file.inlineMocks.reactNative} unistyles=${file.inlineMocks.unistyles} text=${file.inlineMocks.text} modal=${file.inlineMocks.modal} router=${file.inlineMocks.router} storage=${file.inlineMocks.storage}`,
        );
    }
    console.log('topInlineShapeDirectories:');
    for (const directory of output.topInlineShapeDirectories as Array<{
        directory: string;
        total: number;
        canonical: number;
        adHoc: number;
    }>) {
        console.log(`  - ${directory.directory}: total=${directory.total} canonical=${directory.canonical} adHoc=${directory.adHoc}`);
    }
    console.log('verification:');
    console.log(`  summary.total=${output.verification.summary.total}`);
    console.log(`  summary.canonical=${output.verification.summary.canonical}`);
    console.log(`  summary.adHoc=${output.verification.summary.adHoc}`);
    console.log(`  enforced.total=${output.verification.enforced.total}`);
    console.log(`  enforced.canonical=${output.verification.enforced.canonical}`);
    console.log(`  enforced.adHoc=${output.verification.enforced.adHoc}`);
    if (output.verification.allowedDirectories.length > 0) {
        console.log(`  allowDirectories=${output.verification.allowedDirectories.join(',')}`);
    }
    if (output.verification.violations.length === 0) {
        console.log('  violations=0');
        return;
    }
    console.log('  violations:');
    for (const violation of output.verification.violations) {
        console.log(`    - ${violation}`);
    }
}

export function main(argv: readonly string[] = process.argv.slice(2)): void {
    const options = parseVerifyInlineMockFamiliesArgs(argv);
    const rootDir = path.isAbsolute(options.scope) ? options.scope : path.resolve(repoRoot, options.scope);
    const entries = readResidualInventoryEntries(rootDir);
    const files = collectResidualFileCounts(entries);
    const output = buildOutput(files, options, rootDir);

    if (options.json) {
        console.log(JSON.stringify(output, null, 2));
    } else {
        printOutput(output);
    }

    process.exitCode = output.verification.violations.length > 0 ? 1 : 0;
}

const currentFilePath = fileURLToPath(import.meta.url);
const entryFilePath = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (entryFilePath === currentFilePath) {
    main();
}
