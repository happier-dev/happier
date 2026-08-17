import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    fixtureCommandMaxOutputBytes,
    runBoundedFixtureCommand,
} from './boundedFixtureCommand.js';

describe('bounded external-fixture subprocesses', () => {
    it('terminates a timed-out child tree instead of leaving its descendant behind', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-plugin-sdk-bounded-child-'));
        const readyPath = join(root, 'ready');
        const descendantReadyPath = join(root, 'descendant-ready');
        const continuedPath = join(root, 'continued');
        const descendantSource = [
            "const fs = require('node:fs');",
            'const [continuedPath, descendantReadyPath] = process.argv.slice(1);',
            "fs.writeFileSync(descendantReadyPath, 'ready');",
            "process.on('SIGTERM', () => undefined);",
            "setTimeout(() => { fs.writeFileSync(continuedPath, 'continued'); process.exit(0); }, 1_500);",
        ].join(' ');
        try {
            const startedAt = Date.now();
            await expect(runBoundedFixtureCommand(
                'intentional hung fixture child',
                root,
                [
                    '--eval',
                    [
                        "const fs = require('node:fs');",
                        "const { spawn } = require('node:child_process');",
                        'const [readyPath, continuedPath, descendantReadyPath] = process.argv.slice(1);',
                        "fs.writeFileSync(readyPath, 'ready');",
                        `spawn(process.execPath, ['--eval', ${JSON.stringify(descendantSource)}, continuedPath, descendantReadyPath], { stdio: 'ignore' });`,
                        'setInterval(() => undefined, 50);',
                    ].join(' '),
                    readyPath,
                    continuedPath,
                    descendantReadyPath,
                ],
                { timeoutMs: 1_000 },
            )).rejects.toThrow(/timeout=true/u);
            expect(existsSync(readyPath)).toBe(true);
            expect(existsSync(descendantReadyPath)).toBe(true);
            await new Promise<void>((resolvePromise) => {
                setTimeout(resolvePromise, 1_750);
            });
            expect(existsSync(continuedPath)).toBe(false);
            expect(Date.now() - startedAt).toBeLessThan(10_000);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }, 10_000);

    it('terminates a fixture command that exceeds bounded captured output', async () => {
        await expect(runBoundedFixtureCommand(
            'intentional verbose fixture child',
            tmpdir(),
            [
                '--eval',
                `process.stdout.write('x'.repeat(${fixtureCommandMaxOutputBytes + 1})); setInterval(() => undefined, 50);`,
            ],
            { timeoutMs: 10_000 },
        )).rejects.toThrow(/outputLimit=true/u);
    }, 10_000);

    it('includes both child output streams when a fixture command fails', async () => {
        await expect(runBoundedFixtureCommand(
            'intentional failed fixture child',
            tmpdir(),
            [
                '--eval',
                "process.stdout.write('fixture stdout'); process.stderr.write('fixture stderr'); process.exit(23);",
            ],
        )).rejects.toThrow(
            /status=23[\s\S]*stdout:\nfixture stdout[\s\S]*stderr:\nfixture stderr/u,
        );
    });
});
