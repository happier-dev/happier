import fs from 'node:fs';
import path from 'node:path';

import {
    collectResidualFileCounts,
    readResidualInventoryEntries,
    type ResidualFileSummary,
} from '../../sources/dev/testkit/inventory/residualFamilies';
import { collectInlineMockFamilyStats, type InlineMockFamilyName } from './inlineMockClassifier';

const repoRoot = path.resolve(__dirname, '../../../..');

function parseArgs(argv: readonly string[]): Readonly<{ scope: string; top: number; json: boolean }> {
    let scope = 'apps/ui/sources';
    let top = 20;
    let json = false;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--scope') {
            scope = argv[index + 1] ?? scope;
            index += 1;
            continue;
        }
        if (arg === '--top') {
            top = Number.parseInt(argv[index + 1] ?? '20', 10);
            index += 1;
            continue;
        }
        if (arg === '--json') {
            json = true;
        }
    }

    return {
        scope,
        top: Number.isFinite(top) ? top : 20,
        json,
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

function main(): void {
    const options = parseArgs(process.argv.slice(2));
    const rootDir = path.isAbsolute(options.scope) ? options.scope : path.resolve(repoRoot, options.scope);
    const entries = readResidualInventoryEntries(rootDir);
    const files = collectResidualFileCounts(entries);
    const directories = aggregateByDirectory(files).slice(0, options.top);
    const inlineShapeDirectories = aggregateInlineMockShapeByDirectory(files, rootDir).slice(0, options.top);

    const output = {
        scope: options.scope,
        fileCount: files.length,
        topDirectories: directories.map(([directory, counts]) => ({
            directory,
            ...counts,
        })),
        topInlineShapeDirectories: inlineShapeDirectories.map(([directory, counts]) => ({
            directory,
            ...counts,
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
    };

    if (options.json) {
        console.log(JSON.stringify(output, null, 2));
        return;
    }

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
}

main();
