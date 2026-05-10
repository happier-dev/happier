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

function isProductionSourceFile(relativePath: string): boolean {
    return !/\.(test|spec)\.[cm]?[tj]sx?$/.test(relativePath);
}

describe('Dev activity overlay forward-port guards', () => {
    it('keeps the pet overlay as a standalone native stack and route', () => {
        expect(existsSync(join(appRoot, 'src-tauri/src/pet_overlay.rs'))).toBe(true);
        expect(existsSync(join(appRoot, 'src-tauri/src/pet_overlay'))).toBe(true);
        expect(existsSync(join(appRoot, 'sources/app/(app)/desktop/pet-overlay.tsx'))).toBe(true);
        expect(existsSync(join(appRoot, 'sources/components/pets/desktop/route/DesktopPetOverlayRoute.tsx'))).toBe(true);

        const scannedFiles = [
            'src-tauri/src/activity_overlay.rs',
            ...collectFiles('src-tauri/src/activity_overlay'),
            ...collectFiles('sources/activity/adapters/desktop'),
        ].filter(isProductionSourceFile);
        const offenders = scannedFiles.filter((file) => {
            const contents = readAppFile(file);
            return /\bpet_overlay\b|pet-overlay|desktop_pet_overlay|PetCompanion|pets\/desktop|pets\/render|pets\/tray|pets\/interaction/.test(contents);
        });

        expect(offenders).toEqual([]);
    });

    it('does not let pet desktop overlay settings host or expand the activity overlay', () => {
        const scannedFiles = [
            ...collectFiles('sources/activity/adapters/desktop/runtime'),
            ...collectFiles('sources/activity/adapters/desktop/presentation'),
        ].filter(isProductionSourceFile);
        const offenders = scannedFiles.filter((file) => {
            const contents = readAppFile(file);
            return /petsDesktopOverlayDefaultEnabled|desktopPetOverlayEnabledOverride|resolveDesktopOverlayPolicyWithCompanion/.test(contents);
        });

        expect(offenders).toEqual([]);
    });
});
