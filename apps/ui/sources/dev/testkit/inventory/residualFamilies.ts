import * as fs from 'node:fs';
import * as path from 'node:path';

import { collectInlineMockFamilyStats, type InlineMockFamilyName } from '../../../../tools/migrations/inlineMockClassifier';

export type ResidualInventoryEntry = Readonly<{
    path: string;
    text: string;
}>;

type ResidualCounterKey =
    | 'files'
    | 'rendererCreate'
    | 'renderScreen'
    | 'standardCleanup'
    | 'testkitImports'
    | 'useFakeTimers'
    | 'advanceTimers'
    | 'microtaskFlush'
    | 'requestAnimationFrame'
    | 'toJSON'
    | 'onPressTreeWalk'
    | 'rootTreeWalk';

type InlineMockKey = 'reactNative' | 'unistyles' | 'text' | 'modal' | 'router' | 'storage';

export type ResidualCounterBucket = Record<ResidualCounterKey, number> & Readonly<{
    inlineMocks: Record<InlineMockKey, number>;
}>;

export type ResidualFamilySummary = Readonly<{
    totals: ResidualCounterBucket;
    areas: Record<string, ResidualCounterBucket>;
}>;

export type ResidualFileSummary = Readonly<{
    path: string;
    directory: string;
    family: string;
    area: string;
    counts: ResidualCounterBucket;
    inlineMockShapes: Readonly<{
        total: number;
        canonical: number;
        adHoc: number;
    }>;
    hotspotScore: number;
    codemodEligible: boolean;
    codemodBlockers: readonly ResidualCodemodBlocker[];
}>;

export type ResidualCodemodBlocker =
    | 'timerChoreography'
    | 'selectorDrift'
    | 'requestAnimationFrame';

export type FormatResidualFileHotspotsOptions = Readonly<{
    limit?: number;
}>;

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx)$/;

function createBucket(): ResidualCounterBucket {
    return {
        files: 0,
        rendererCreate: 0,
        renderScreen: 0,
        standardCleanup: 0,
        testkitImports: 0,
        useFakeTimers: 0,
        advanceTimers: 0,
        microtaskFlush: 0,
        requestAnimationFrame: 0,
        toJSON: 0,
        onPressTreeWalk: 0,
        rootTreeWalk: 0,
        inlineMocks: {
            reactNative: 0,
            unistyles: 0,
            text: 0,
            modal: 0,
            router: 0,
            storage: 0,
        },
    };
}

function collectInlineMockShapeCounts(text: string, filePath: string) {
    const familyStats = collectInlineMockFamilyStats(text, { filePath });
    return (Object.keys(familyStats) as InlineMockFamilyName[]).reduce(
        (summary, family) => ({
            total: summary.total + familyStats[family].total,
            canonical: summary.canonical + familyStats[family].canonical,
            adHoc: summary.adHoc + familyStats[family].adHoc,
        }),
        {
            total: 0,
            canonical: 0,
            adHoc: 0,
        },
    );
}

function detectArea(filePath: string): string {
    if (filePath.includes('/components/sessions/transcript/')) return 'transcript';
    if (filePath.includes('/components/sessions/shell/')) return 'sessionShell';
    if (filePath.includes('/components/tools/shell/views/')) return 'toolShell';
    if (filePath.includes('/__tests__/app/new/pick/')) return 'picker';
    if (filePath.includes('/__tests__/routes/')) return 'routes';
    return 'other';
}

function normalizeInventoryPath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function describeInventoryFile(filePath: string): Readonly<{ directory: string; family: string }> {
    const normalizedPath = normalizeInventoryPath(filePath);
    const directory = path.posix.dirname(normalizedPath);
    const basename = path.posix.basename(normalizedPath);
    const family = basename.replace(/\.(test|spec)\.(ts|tsx)$/, '');

    return {
        directory,
        family,
    };
}

function bump(bucket: ResidualCounterBucket, key: ResidualCounterKey, value: number): void {
    bucket[key] += value;
}

function count(text: string, pattern: RegExp): number {
    return text.match(pattern)?.length ?? 0;
}

function collectCountsForText(text: string): ResidualCounterBucket {
    const bucket = createBucket();
    bump(bucket, 'files', 1);
    bump(bucket, 'rendererCreate', count(text, /renderer\.create\(/g));
    bump(bucket, 'renderScreen', count(text, /\brenderScreen\(/g));
    bump(bucket, 'standardCleanup', count(text, /\bstandardCleanup\(/g));
    bump(bucket, 'testkitImports', count(text, /@\/dev\/testkit(?:\/|['"])/g));
    bump(bucket, 'useFakeTimers', count(text, /vi\.useFakeTimers\(/g));
    bump(bucket, 'advanceTimers', count(text, /vi\.(?:advanceTimersByTime|runAllTimers|runOnlyPendingTimers)\(/g));
    bump(bucket, 'microtaskFlush', count(text, /await Promise\.resolve\(\)/g));
    bump(bucket, 'requestAnimationFrame', count(text, /\brequestAnimationFrame\b|flushAnimationFrame\(/g));
    bump(bucket, 'toJSON', count(text, /\.toJSON\(/g));
    bump(bucket, 'onPressTreeWalk', count(text, /\.props\.onPress\(|findAllByType\((?:'|")Pressable|findByType\((?:'|")Pressable/g));
    bump(
        bucket,
        'rootTreeWalk',
        count(text, /\.root\.(?:findAllByType|findByType|findAllByProps|findByProps|findAll|find)\(/g),
    );
    bucket.inlineMocks.reactNative += count(text, /vi\.mock\('react-native'/g);
    bucket.inlineMocks.unistyles += count(text, /vi\.mock\('react-native-unistyles'/g);
    bucket.inlineMocks.text += count(text, /vi\.mock\('@\/text'/g);
    bucket.inlineMocks.modal += count(text, /vi\.mock\('@\/modal'/g);
    bucket.inlineMocks.router += count(text, /vi\.mock\('expo-router'/g);
    bucket.inlineMocks.storage += count(text, /vi\.mock\('@\/sync\/domains\/state\/storage'/g);
    return bucket;
}

function calculateHotspotScore(bucket: ResidualCounterBucket): number {
    const inlineMockCount = Object.values(bucket.inlineMocks).reduce((sum, value) => sum + value, 0);
    return (
        (bucket.rendererCreate * 3) +
        (bucket.useFakeTimers * 3) +
        (bucket.advanceTimers * 2) +
        bucket.microtaskFlush +
        (bucket.requestAnimationFrame * 3) +
        (bucket.onPressTreeWalk * 2) +
        (bucket.rootTreeWalk * 2) +
        inlineMockCount
    );
}

function collectCodemodBlockers(bucket: ResidualCounterBucket): ResidualCodemodBlocker[] {
    const blockers: ResidualCodemodBlocker[] = [];
    if (bucket.useFakeTimers > 0 || bucket.advanceTimers > 0) {
        blockers.push('timerChoreography');
    }
    if (bucket.onPressTreeWalk > 0 || bucket.rootTreeWalk > 0) {
        blockers.push('selectorDrift');
    }
    if (bucket.requestAnimationFrame > 0) {
        blockers.push('requestAnimationFrame');
    }
    return blockers;
}

export function collectResidualFamilyCounts(entries: readonly ResidualInventoryEntry[]): ResidualFamilySummary {
    const totals = createBucket();
    const areas: Record<string, ResidualCounterBucket> = {};

    for (const entry of entries) {
        const area = detectArea(entry.path);
        const areaBucket = (areas[area] ??= createBucket());
        const entryCounts = collectCountsForText(entry.text);
        const buckets = [totals, areaBucket];

        for (const bucket of buckets) {
            for (const key of [
                'files',
                'rendererCreate',
                'renderScreen',
                'standardCleanup',
                'testkitImports',
                'useFakeTimers',
                'advanceTimers',
                'microtaskFlush',
                'requestAnimationFrame',
                'toJSON',
                'onPressTreeWalk',
                'rootTreeWalk',
            ] satisfies ResidualCounterKey[]) {
                bucket[key] += entryCounts[key];
            }
            for (const inlineMockKey of Object.keys(entryCounts.inlineMocks) as InlineMockKey[]) {
                bucket.inlineMocks[inlineMockKey] += entryCounts.inlineMocks[inlineMockKey];
            }
        }
    }

    return {
        totals,
        areas,
    };
}

export function collectResidualFileCounts(entries: readonly ResidualInventoryEntry[]): ResidualFileSummary[] {
    return entries
        .map((entry) => {
            const counts = collectCountsForText(entry.text);
            const inlineMockShapes = collectInlineMockShapeCounts(entry.text, entry.path);
            const { directory, family } = describeInventoryFile(entry.path);
            const codemodBlockers = collectCodemodBlockers(counts);
            return {
                path: entry.path,
                directory,
                family,
                area: detectArea(entry.path),
                counts,
                inlineMockShapes,
                hotspotScore: calculateHotspotScore(counts),
                codemodEligible: codemodBlockers.length === 0 && inlineMockShapes.adHoc > 0,
                codemodBlockers,
            } satisfies ResidualFileSummary;
        })
        .sort((left, right) => (
            Number(right.codemodEligible) - Number(left.codemodEligible) ||
            right.inlineMockShapes.adHoc - left.inlineMockShapes.adHoc ||
            right.hotspotScore - left.hotspotScore ||
            right.counts.rendererCreate - left.counts.rendererCreate ||
            right.counts.requestAnimationFrame - left.counts.requestAnimationFrame ||
            right.counts.useFakeTimers - left.counts.useFakeTimers ||
            left.path.localeCompare(right.path)
        ));
}

export function readResidualInventoryEntries(rootDir: string): ResidualInventoryEntry[] {
    const entries: ResidualInventoryEntry[] = [];

    function walk(currentPath: string): void {
        const stat = fs.statSync(currentPath);
        if (stat.isDirectory()) {
            for (const child of fs.readdirSync(currentPath)) {
                walk(path.join(currentPath, child));
            }
            return;
        }
        if (!TEST_FILE_RE.test(currentPath)) return;
        entries.push({
            path: currentPath,
            text: fs.readFileSync(currentPath, 'utf8'),
        });
    }

    walk(rootDir);
    return entries;
}

export function formatResidualFamilySummary(summary: ResidualFamilySummary): string {
    const lines: string[] = [];
    const orderedAreas = Object.keys(summary.areas).sort();
    const appendBucket = (label: string, bucket: ResidualCounterBucket) => {
        lines.push(`${label}:`);
        lines.push(`  files=${bucket.files}`);
        lines.push(`  rendererCreate=${bucket.rendererCreate}`);
        lines.push(`  renderScreen=${bucket.renderScreen}`);
        lines.push(`  standardCleanup=${bucket.standardCleanup}`);
        lines.push(`  testkitImports=${bucket.testkitImports}`);
        lines.push(`  useFakeTimers=${bucket.useFakeTimers}`);
        lines.push(`  advanceTimers=${bucket.advanceTimers}`);
        lines.push(`  microtaskFlush=${bucket.microtaskFlush}`);
        lines.push(`  requestAnimationFrame=${bucket.requestAnimationFrame}`);
        lines.push(`  toJSON=${bucket.toJSON}`);
        lines.push(`  onPressTreeWalk=${bucket.onPressTreeWalk}`);
        lines.push(`  rootTreeWalk=${bucket.rootTreeWalk}`);
        lines.push(`  inlineMocks.reactNative=${bucket.inlineMocks.reactNative}`);
        lines.push(`  inlineMocks.unistyles=${bucket.inlineMocks.unistyles}`);
        lines.push(`  inlineMocks.text=${bucket.inlineMocks.text}`);
        lines.push(`  inlineMocks.modal=${bucket.inlineMocks.modal}`);
        lines.push(`  inlineMocks.router=${bucket.inlineMocks.router}`);
        lines.push(`  inlineMocks.storage=${bucket.inlineMocks.storage}`);
    };

    appendBucket('totals', summary.totals);
    for (const area of orderedAreas) {
        appendBucket(`area.${area}`, summary.areas[area]);
    }
    return lines.join('\n');
}

export function formatResidualFileHotspots(
    summaries: readonly ResidualFileSummary[],
    options: FormatResidualFileHotspotsOptions = {},
): string {
    const limit = Math.max(1, options.limit ?? 10);
    const lines = ['topFiles:'];
    for (const summary of summaries.slice(0, limit)) {
        lines.push(`  - path=${summary.path}`);
        lines.push(`    directory=${summary.directory}`);
        lines.push(`    family=${summary.family}`);
        lines.push(`    area=${summary.area}`);
        lines.push(`    hotspotScore=${summary.hotspotScore}`);
        lines.push(`    codemodEligible=${summary.codemodEligible}`);
        lines.push(`    codemodBlockers=${summary.codemodBlockers.length > 0 ? summary.codemodBlockers.join(',') : 'none'}`);
        lines.push(`    inlineMockShapes.total=${summary.inlineMockShapes.total}`);
        lines.push(`    inlineMockShapes.canonical=${summary.inlineMockShapes.canonical}`);
        lines.push(`    inlineMockShapes.adHoc=${summary.inlineMockShapes.adHoc}`);
        lines.push(`    rendererCreate=${summary.counts.rendererCreate}`);
        lines.push(`    useFakeTimers=${summary.counts.useFakeTimers}`);
        lines.push(`    advanceTimers=${summary.counts.advanceTimers}`);
        lines.push(`    microtaskFlush=${summary.counts.microtaskFlush}`);
        lines.push(`    requestAnimationFrame=${summary.counts.requestAnimationFrame}`);
        lines.push(`    onPressTreeWalk=${summary.counts.onPressTreeWalk}`);
        lines.push(`    rootTreeWalk=${summary.counts.rootTreeWalk}`);
        lines.push(`    inlineMocks.reactNative=${summary.counts.inlineMocks.reactNative}`);
        lines.push(`    inlineMocks.unistyles=${summary.counts.inlineMocks.unistyles}`);
        lines.push(`    inlineMocks.text=${summary.counts.inlineMocks.text}`);
        lines.push(`    inlineMocks.modal=${summary.counts.inlineMocks.modal}`);
        lines.push(`    inlineMocks.router=${summary.counts.inlineMocks.router}`);
        lines.push(`    inlineMocks.storage=${summary.counts.inlineMocks.storage}`);
    }
    return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2);
    let rootDir: string | null = null;
    let topLimit: number | null = null;

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--top') {
            const rawLimit = args[index + 1];
            if (typeof rawLimit === 'string') {
                topLimit = Number.parseInt(rawLimit, 10);
                index += 1;
            }
            continue;
        }
        if (!arg.startsWith('--') && rootDir == null) {
            rootDir = arg;
        }
    }

    const resolvedRootDir = rootDir ?? path.resolve(process.cwd(), 'apps/ui/sources');
    const entries = readResidualInventoryEntries(resolvedRootDir);
    const summary = collectResidualFamilyCounts(entries);
    const output = [formatResidualFamilySummary(summary)];
    if (typeof topLimit === 'number' && Number.isFinite(topLimit) && topLimit > 0) {
        output.push(formatResidualFileHotspots(collectResidualFileCounts(entries), { limit: topLimit }));
    }
    process.stdout.write(`${output.join('\n')}\n`);
}
