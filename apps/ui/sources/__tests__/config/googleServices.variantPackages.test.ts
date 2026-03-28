import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function getUiDir(): string {
    return join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
}

function readGoogleServicesJson(): any {
    const raw = readFileSync(join(getUiDir(), 'google-services.json'), 'utf-8');
    return JSON.parse(raw);
}

describe('google-services.json', () => {
    it('keeps Firebase Android clients aligned with production, internal, public dev, and preview package ids', () => {
        const config = readGoogleServicesJson();
        const packageNames = new Set(
            (config?.client ?? [])
                .map((client: any) => client?.client_info?.android_client_info?.package_name)
                .filter((value: unknown) => typeof value === 'string'),
        );

        expect(packageNames.has('dev.happier.app')).toBe(true);
        expect(packageNames.has('dev.happier.app.internaldev')).toBe(true);
        expect(packageNames.has('dev.happier.app.internalpreview')).toBe(true);
        expect(packageNames.has('dev.happier.app.publicdev')).toBe(true);
        expect(packageNames.has('dev.happier.app.preview')).toBe(true);
    });
});
