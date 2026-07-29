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
    it('keeps Firebase Android clients aligned with production, internal, public dev, dev clients, and preview package ids', () => {
        const config = readGoogleServicesJson();
        const androidClients = (config?.client ?? [])
            .map((client: any) => ({
                packageName: client?.client_info?.android_client_info?.package_name,
                mobileSdkAppId: client?.client_info?.mobilesdk_app_id,
            }))
            .filter(
                (client: any) => typeof client?.packageName === 'string' && typeof client?.mobileSdkAppId === 'string'
            );
        const packageNames = new Set(
            androidClients.map((client: any) => client.packageName),
        );
        const mobileSdkAppIdsByPackage = new Map(
            androidClients.map((client: any) => [client.packageName, client.mobileSdkAppId]),
        );

        expect(packageNames.has('dev.happier.app')).toBe(true);
        expect(packageNames.has('dev.happier.app.internaldev')).toBe(true);
        expect(packageNames.has('dev.happier.app.internaldev.devclient')).toBe(true);
        expect(packageNames.has('dev.happier.app.internalpreview')).toBe(true);
        expect(packageNames.has('dev.happier.app.publicdev')).toBe(true);
        expect(packageNames.has('dev.happier.app.publicdev.devclient')).toBe(true);
        expect(packageNames.has('dev.happier.app.preview')).toBe(true);

        expect(mobileSdkAppIdsByPackage.get('dev.happier.app')).toBe('1:427065718939:android:4f30a784735abfe97aee3e');
        expect(mobileSdkAppIdsByPackage.get('dev.happier.app.internaldev')).toBe('1:427065718939:android:d95397b56dcecbe17aee3e');
        expect(mobileSdkAppIdsByPackage.get('dev.happier.app.internaldev.devclient')).toBe('1:427065718939:android:d95397b56dcecbe17aee3e');
        expect(mobileSdkAppIdsByPackage.get('dev.happier.app.preview')).toBe('1:427065718939:android:fc6fcb803976fb987aee3e');
        expect(mobileSdkAppIdsByPackage.get('dev.happier.app.internalpreview')).toBe('1:427065718939:android:fc6fcb803976fb987aee3e');
        expect(mobileSdkAppIdsByPackage.get('dev.happier.app.publicdev')).toBe('1:427065718939:android:c44eecd728ca4f997aee3e');
        expect(mobileSdkAppIdsByPackage.get('dev.happier.app.publicdev.devclient')).toBe('1:427065718939:android:fc6fcb803976fb987aee3e');
    });
});
