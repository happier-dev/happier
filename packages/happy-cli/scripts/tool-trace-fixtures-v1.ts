import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { curateToolTraceFixturesFromJsonlLines } from '../src/agent/tools/trace/curateToolTraceFixtures';

function parseArgs(argv: string[]) {
    const out: Record<string, string | boolean> = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const [k, v] = arg.slice(2).split('=');
        if (v !== undefined) {
            out[k] = v;
            continue;
        }
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
            out[k] = next;
            i++;
        } else {
            out[k] = true;
        }
    }
    return out;
}

function readJsonlFiles(filePaths: string[]): string[] {
    const all: string[] = [];
    for (const filePath of filePaths) {
        const text = readFileSync(filePath, 'utf8');
        for (const line of text.split(/\r?\n/)) {
            const t = line.trim();
            if (t.length === 0) continue;
            all.push(t);
        }
    }
    return all;
}

function resolveDefaultTracePaths(stack: string): string[] {
    const dir = path.join(os.homedir(), '.happy', 'stacks', stack, 'cli', 'tool-traces');
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
    return files.map((f) => path.join(dir, f));
}

function readAllowlistKeys(filePath: string): Set<string> {
    const text = readFileSync(filePath, 'utf8');
    const keys = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'));
    return new Set(keys);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const stack = (args.stack as string | undefined) ?? 'leeroy-wip';
    const limitPerKeyRaw = args['limit-per-key'] as string | undefined;
    const limitPerKey =
        typeof limitPerKeyRaw === 'string' && limitPerKeyRaw.trim().length > 0
            ? Number(limitPerKeyRaw)
            : 3;
    const allowlistPath = (() => {
        const explicit = args.allowlist as string | undefined;
        if (explicit && explicit.trim().length > 0) return explicit;
        const defaultPath = path.join(process.cwd(), 'scripts', 'tool-trace-fixtures.v1.allowlist.txt');
        try {
            readFileSync(defaultPath, 'utf8');
            return defaultPath;
        } catch {
            return undefined;
        }
    })();
    const allowlistKeys = allowlistPath ? readAllowlistKeys(allowlistPath) : undefined;

    const inPath = args.in as string | undefined;
    const outPath = (args.out as string | undefined) ?? '/tmp/tool-trace-fixtures.candidate.v1.json';
    const write = args.write === true;

    const inputs: string[] = (() => {
        if (typeof inPath === 'string' && inPath.trim().length > 0) {
            return [inPath];
        }
        return resolveDefaultTracePaths(stack);
    })();

    const lines = readJsonlFiles(inputs);
    const fixtures = curateToolTraceFixturesFromJsonlLines(lines, {
        maxExamplesPerKey: Number.isFinite(limitPerKey) && limitPerKey > 0 ? limitPerKey : 3,
        allowlistKeys,
    });

    writeFileSync(outPath, JSON.stringify(fixtures, null, 2));
    // eslint-disable-next-line no-console
    console.log(`[tool-trace-fixtures-v1] wrote candidate: ${outPath}`);
    // eslint-disable-next-line no-console
    console.log(`[tool-trace-fixtures-v1] keys=${Object.keys(fixtures.examples).length} lines=${lines.length}`);
    // eslint-disable-next-line no-console
    console.log(`[tool-trace-fixtures-v1] allowlist=${allowlistPath ?? '(none)'}`);

    if (write) {
        const repoPath = path.join(
            process.cwd(),
            'src',
            'agent',
            'tools',
            'normalization',
            '__fixtures__',
            'tool-trace-fixtures.v1.json',
        );
        writeFileSync(repoPath, JSON.stringify(fixtures, null, 2));
        // eslint-disable-next-line no-console
        console.log(`[tool-trace-fixtures-v1] wrote repo fixture: ${repoPath}`);
    }
}

main();
