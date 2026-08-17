import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const v1SourceFiles = [
    './diagnostics.ts',
    './identity.ts',
    './json.ts',
    './core/ingress.ts',
    './core/transportFacts.ts',
    './management/bindings.ts',
    './management/connections.ts',
    './management/pairing.ts',
    './management/pollRetry.ts',
    './management/prepare.ts',
    './management/recovery.ts',
    './management/targets.ts',
    './provider/connection.ts',
    './provider/delivery.ts',
    './provider/lifecycle.ts',
    './provider/observations.ts',
    './provider/resolution.ts',
    './provider/setup.ts',
] as const;

describe('Channels V1 protocol-authoring consumer boundary', () => {
    it('uses direct composable schemas without the retired root wrapper or validator imports', async () => {
        const sources = await Promise.all(v1SourceFiles.map(async (relativePath) => ({
            relativePath,
            source: await readFile(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8'),
        })));

        for (const { relativePath, source } of sources) {
            expect(source, relativePath).not.toMatch(/\bdefineProtocolSchema\b/u);
            expect(source, relativePath).not.toMatch(/\bfrom\s+['"]zod(?:\/[^'"]*)?['"]/u);
            expect(source, relativePath).not.toMatch(/\b(?:protocolSchema|_zod|~standard)\b/u);
        }
    });
});
