import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const sourcesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function readSource(relativePath: string): string {
    return readFileSync(join(sourcesDir, relativePath), 'utf8');
}

function walkTypeScriptFiles(relativeDir: string): string[] {
    const root = join(sourcesDir, relativeDir);
    if (!existsSync(root)) return [];

    const files: string[] = [];
    const visit = (dir: string) => {
        for (const entry of readdirSync(dir)) {
            const fullPath = join(dir, entry);
            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
                visit(fullPath);
                continue;
            }
            if (/\.(ts|tsx)$/.test(entry)) {
                files.push(relative(sourcesDir, fullPath));
            }
        }
    };

    visit(root);
    return files;
}

describe('native crypto worker central routing architecture', () => {
    it('does not leave the obsolete crypto Worklet probe in production sync code', () => {
        const obsoleteProbeFiles = [
            'sync/encryption/sessionCryptoWorkletProbe.ts',
            'sync/encryption/sessionCryptoWorkletProbe.native.ts',
        ];

        expect(obsoleteProbeFiles.filter((file) => existsSync(join(sourcesDir, file)))).toEqual([]);
        expect(readSource('sync/sync.ts')).not.toContain('sessionCryptoWorkletProbe');
    });

    it('keeps worker imports out of session read and rendering seams', () => {
        const callerSeamFiles = [
            'sync/engine/sessions/sessionSnapshot.ts',
            'sync/engine/sessions/sessionSocketUpdate.ts',
            'sync/engine/sessions/syncSessions.ts',
            'sync/engine/sessions/handleTranscriptStreamSegmentEphemeralUpdate.ts',
            'sync/engine/socket/socket.ts',
            ...walkTypeScriptFiles('components/sessions'),
            ...walkTypeScriptFiles('app/(app)/session'),
        ];
        const forbiddenWorkerImport = /from\s+['"][^'"]*(?:nativeCryptoWorker|sessionCryptoWorkletProbe)|require\([^)]*(?:nativeCryptoWorker|sessionCryptoWorkletProbe)/;
        const violations = callerSeamFiles.filter((file) => forbiddenWorkerImport.test(readSource(file)));

        expect(violations).toEqual([]);
    });

    it('keeps native worker types behind the encryption facade for session data-key hydration', () => {
        const sessionDataKeyHydrationPath = 'sync/encryption/sessionDataKeyHydration.ts';
        if (!existsSync(join(sourcesDir, sessionDataKeyHydrationPath))) return;

        expect(readSource(sessionDataKeyHydrationPath)).not.toContain('nativeCryptoWorker');
    });
});
