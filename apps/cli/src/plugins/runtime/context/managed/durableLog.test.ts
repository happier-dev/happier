import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createManagedServerDiagnosticSanitizer } from './diagnostics';
import {
    createManagedServerDurableLogCapture,
    pruneManagedServerDurableLogs,
    resolveManagedServerDurableLogDir,
} from './durableLog';

const tempRoots: string[] = [];

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'happier-managed-log-'));
    tempRoots.push(dir);
    return dir;
}

function neutralSanitizer() {
    return createManagedServerDiagnosticSanitizer({
        credential: { envKey: 'TOKEN', value: 'super-secret-token' },
        healthCheck: { kind: 'http', url: 'http://127.0.0.1:1/health', headers: {} },
        launch: null,
    });
}

afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

describe('createManagedServerDurableLogCapture', () => {
    it('writes a header without secret values and persists prefixed stdout/stderr lines', async () => {
        const logsDir = makeTempDir();
        const capture = createManagedServerDurableLogCapture({
            logsDir,
            id: 'opencode-server',
            commandBasename: 'opencode',
            args: ['serve', '--hostname', '127.0.0.1', '--port', '43111'],
            port: 43111,
            baseUrl: 'http://127.0.0.1:43111',
            spawnPid: 4242,
            launchFingerprint: 'fingerprint-hash-abc',
            sanitizer: neutralSanitizer(),
        });
        capture.write('stdout', Buffer.from('listening on 43111\n'));
        capture.write('stderr', 'warn: something\n');
        capture.write('stdout', 'TOKEN=super-secret-token\n');
        await capture.close();

        const contents = readFileSync(capture.logPath, 'utf8');
        expect(contents).toContain('# managed server log');
        expect(contents).toContain('opencode serve --hostname 127.0.0.1 --port 43111');
        expect(contents).toContain('fingerprint-hash-abc');
        expect(contents).toContain('[stdout] listening on 43111');
        expect(contents).toContain('[stderr] warn: something');
        // Secret value must be redacted in persisted output (reuse the diagnostic sanitizer).
        expect(contents).not.toContain('super-secret-token');
    });

    it('keeps draining and degrades to a no-op when the log directory cannot be created', () => {
        const fileAsDir = join(makeTempDir(), 'not-a-dir');
        writeFileSync(fileAsDir, 'x');
        const capture = createManagedServerDurableLogCapture({
            logsDir: fileAsDir, // a file, so mkdir of the managed-servers subdir will fail
            id: 'opencode-server',
            commandBasename: 'opencode',
            args: ['serve'],
            port: 1,
            baseUrl: 'http://127.0.0.1:1',
            spawnPid: 1,
            sanitizer: neutralSanitizer(),
        });
        // Must not throw even though the stream could not be created.
        expect(() => capture.write('stdout', 'data\n')).not.toThrow();
        expect(typeof capture.logPath).toBe('string');
    });
});

describe('pruneManagedServerDurableLogs', () => {
    it('keeps the newest N logs and always retains the current log', async () => {
        const logsDir = makeTempDir();
        const dir = resolveManagedServerDurableLogDir(logsDir);
        const { mkdirSync } = await import('node:fs');
        mkdirSync(dir, { recursive: true });
        const names = [
            '2026-06-20-10-00-00-port-1-pid-1.log',
            '2026-06-21-10-00-00-port-2-pid-2.log',
            '2026-06-22-10-00-00-port-3-pid-3.log',
            '2026-06-23-10-00-00-port-4-pid-4.log',
        ];
        for (const name of names) writeFileSync(join(dir, name), 'x');
        const currentPath = join(dir, names[0]); // oldest, but it is "current"

        await pruneManagedServerDurableLogs({ logsDir, keepCount: 2, keepPath: currentPath });

        const remaining = readdirSync(dir).sort();
        // newest 2 kept + the current (oldest) kept => 3 retained, 1 pruned.
        expect(remaining).toContain(names[0]); // current, always kept
        expect(remaining).toContain(names[3]); // newest
        expect(remaining).toContain(names[2]); // 2nd newest
        expect(remaining).not.toContain(names[1]); // pruned
    });
});
