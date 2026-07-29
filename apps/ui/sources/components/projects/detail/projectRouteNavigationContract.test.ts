import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const projectDetailDirectory = fileURLToPath(new URL('.', import.meta.url));
const routerRefOwnerFile = 'useProjectRouteRouterRef.ts';

describe('project route navigation contract', () => {
    it('keeps direct expo-router useRouter calls centralized in the router-ref owner', () => {
        const offenders = readdirSync(projectDetailDirectory)
            .filter((fileName) => /\.(?:ts|tsx)$/.test(fileName))
            .filter((fileName) => !fileName.endsWith('.test.ts') && !fileName.endsWith('.test.tsx'))
            .filter((fileName) => fileName !== routerRefOwnerFile)
            .filter((fileName) => {
                const source = readFileSync(new URL(fileName, import.meta.url), 'utf8');
                return /\buseRouter\s*\(/.test(source);
            });

        expect(offenders).toEqual([]);
    });
});
