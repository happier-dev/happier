import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const appRoot = process.cwd();

function readAppFile(relativePath: string): string {
    return readFileSync(join(appRoot, relativePath), 'utf8');
}

function collectFiles(relativePath: string): string[] {
    const absolutePath = join(appRoot, relativePath);
    if (!existsSync(absolutePath)) {
        return [];
    }
    const stat = statSync(absolutePath);
    if (stat.isFile()) {
        return [relativePath];
    }
    return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
        const childPath = `${relativePath}/${entry.name}`;
        if (entry.isDirectory()) {
            return collectFiles(childPath);
        }
        return entry.isFile() ? [childPath] : [];
    });
}

describe('Dev activity overlay forward-port guards', () => {
    it('does not add a remote-dev pet overlay native stack or route', () => {
        expect(existsSync(join(appRoot, 'src-tauri/src/pet_overlay.rs'))).toBe(false);
        expect(existsSync(join(appRoot, 'src-tauri/src/pet_overlay'))).toBe(false);
        expect(existsSync(join(appRoot, 'sources/app/(app)/desktop/pet-overlay.tsx'))).toBe(false);

        const scannedFiles = [
            'src-tauri/src/lib.rs',
            'src-tauri/src/activity_overlay.rs',
            ...collectFiles('src-tauri/src/activity_overlay'),
            ...collectFiles('sources/activity/adapters/desktop'),
        ].filter((file) => file !== 'sources/activity/adapters/desktop/devForwardPortGuards.test.ts');
        const offenders = scannedFiles.filter((file) => {
            const contents = readAppFile(file);
            return /\bpet_overlay\b|pet-overlay|desktop_pet_overlay/.test(contents);
        });

        expect(offenders).toEqual([]);
    });

    it('keeps companion source and activity resolution out of the desktop adapter', () => {
        const contents = readAppFile(
            'sources/activity/adapters/desktop/presentation/snapshot/buildDesktopActivityOverlayCompanionSnapshot.ts',
        );

        expect(contents).not.toContain('BLINK_COMPANION_PET');
        expect(contents).not.toContain('switch (candidate.attentionState)');
        expect(contents).not.toContain('function sessionHasFailure');
    });
});
