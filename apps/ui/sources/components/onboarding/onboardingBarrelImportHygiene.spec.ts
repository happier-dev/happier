import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
            out.push(...walk(full));
            continue;
        }
        out.push(full);
    }
    return out;
}

describe('onboarding barrel import hygiene', () => {
    it('does not allow onboarding implementation files to import the onboarding barrel', () => {
        const onboardingRoot = resolve(__dirname);
        const implementationFiles = walk(onboardingRoot).filter((filePath) => {
            if (!/\.[tj]sx?$/.test(filePath)) return false;
            if (/\.d\.ts$/.test(filePath)) return false;
            if (/\.(?:spec|test)\.[tj]sx?$/.test(filePath)) return false;
            return !filePath.endsWith('/index.ts');
        });

        const offenders = implementationFiles.filter((filePath) => {
            const source = readFileSync(filePath, 'utf8');
            return source.includes("from '@/components/onboarding'") || source.includes('from "@/components/onboarding"');
        });

        expect(offenders).toEqual([]);
    });
});
