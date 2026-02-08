import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { claudeFindLastSession } from './claudeFindLastSession';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    cleanupTempSessionDir,
    createTempSessionDir,
    setSessionMtime,
    writeSessionObjectLines,
} from './sessionFixtures.testHelpers';

// Mock getProjectPath to use test directory
vi.mock('./path', () => ({
    getProjectPath: (path: string) => path
}));

describe('claudeFindLastSession', () => {
    let testDir: string;

    const writeRecords = (sessionId: string, records: Array<Record<string, unknown>>) =>
        writeSessionObjectLines(testDir, sessionId, records);

    beforeEach(() => {
        testDir = createTempSessionDir('test-sessions');
    });

    afterEach(() => {
        cleanupTempSessionDir(testDir);
    });

    describe('Basic session finding', () => {
        it('should find session with uuid field', () => {
            const sessionId = '12345678-1234-1234-1234-123456789abc';
            writeRecords(sessionId, [{ uuid: 'msg-1', type: 'user' }]);

            expect(claudeFindLastSession(testDir)).toBe(sessionId);
        });

        it('should find session with messageId field (older Claude Code)', () => {
            const sessionId = '87654321-4321-4321-4321-210987654321';
            writeRecords(sessionId, [{ messageId: 'msg-old', type: 'user' }]);

            expect(claudeFindLastSession(testDir)).toBe(sessionId);
        });

        it('should find session with leafUuid field', () => {
            const sessionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
            writeRecords(sessionId, [{ leafUuid: 'leaf-123', type: 'summary' }]);

            expect(claudeFindLastSession(testDir)).toBe(sessionId);
        });

        it('should return null when no valid sessions exist', () => {
            expect(claudeFindLastSession(testDir)).toBe(null);
        });

        it('should return null when directory does not exist', () => {
            const nonExistentDir = join(testDir, 'does-not-exist-' + Date.now());
            expect(claudeFindLastSession(nonExistentDir)).toBe(null);
        });
    });

    describe('Most recent session selection', () => {
        it('should find most recent session by mtime (uuid format)', async () => {
            // Create older session
            const oldSessionId = '11111111-1111-1111-1111-111111111111';
            const oldFile = writeRecords(oldSessionId, [{ uuid: 'msg-1', type: 'user' }]);

            // Set old mtime
            const oldTime = new Date('2025-01-01');
            setSessionMtime(oldFile, oldTime);

            // Create newer session
            const newSessionId = '22222222-2222-2222-2222-222222222222';
            const newFile = writeRecords(newSessionId, [{ uuid: 'msg-2', type: 'user' }]);

            // Set new mtime
            const newTime = new Date('2025-12-31');
            setSessionMtime(newFile, newTime);

            expect(claudeFindLastSession(testDir)).toBe(newSessionId);
        });

        it('should find most recent session regardless of ID field type', () => {
            // Create older session with uuid
            const oldSessionId = '11111111-1111-1111-1111-111111111111';
            const oldFile = writeRecords(oldSessionId, [{ uuid: 'msg-1', type: 'user' }]);
            setSessionMtime(oldFile, new Date('2025-01-01'));

            // Create newer session with messageId
            const newSessionId = '22222222-2222-2222-2222-222222222222';
            const newFile = writeRecords(newSessionId, [{ messageId: 'msg-2', type: 'user' }]);
            setSessionMtime(newFile, new Date('2025-12-31'));

            expect(claudeFindLastSession(testDir)).toBe(newSessionId);
        });
    });

    describe('Session file filtering', () => {
        it('should skip non-UUID session files (agent sessions)', () => {
            writeFileSync(
                join(testDir, 'agent-abc123.jsonl'),
                JSON.stringify({ uuid: 'msg-1', type: 'user' }) + '\n'
            );

            expect(claudeFindLastSession(testDir)).toBe(null);
        });

        it('should skip sessions without valid ID fields', () => {
            const sessionId = '12345678-1234-1234-1234-123456789abc';
            writeFileSync(
                join(testDir, `${sessionId}.jsonl`),
                JSON.stringify({ type: 'user', content: 'test' }) + '\n'
            );

            expect(claudeFindLastSession(testDir)).toBe(null);
        });

        it('should skip empty session files', () => {
            const sessionId = '12345678-1234-1234-1234-123456789abc';
            writeFileSync(join(testDir, `${sessionId}.jsonl`), '');

            expect(claudeFindLastSession(testDir)).toBe(null);
        });

        it('should skip files without .jsonl extension', () => {
            const sessionId = '12345678-1234-1234-1234-123456789abc';
            writeFileSync(
                join(testDir, `${sessionId}.txt`),
                JSON.stringify({ uuid: 'msg-1', type: 'user' }) + '\n'
            );

            expect(claudeFindLastSession(testDir)).toBe(null);
        });
    });

    describe('Multiple sessions scenario', () => {
        it('should find most recent valid session when mixed with invalid ones', () => {
            // Invalid: agent session
            writeFileSync(
                join(testDir, 'agent-xyz.jsonl'),
                JSON.stringify({ uuid: 'agent-msg', type: 'user' }) + '\n'
            );

            // Invalid: no ID fields
            const invalidId = '99999999-9999-9999-9999-999999999999';
            writeFileSync(
                join(testDir, `${invalidId}.jsonl`),
                JSON.stringify({ type: 'other' }) + '\n'
            );

            // Valid: old session with messageId
            const oldValidId = '11111111-1111-1111-1111-111111111111';
            const oldValidFile = writeRecords(oldValidId, [{ messageId: 'old-msg', type: 'user' }]);
            setSessionMtime(oldValidFile, new Date('2025-01-01'));

            // Valid: new session with uuid
            const newValidId = '22222222-2222-2222-2222-222222222222';
            const newValidFile = writeRecords(newValidId, [{ uuid: 'new-msg', type: 'user' }]);
            setSessionMtime(newValidFile, new Date('2025-12-31'));

            expect(claudeFindLastSession(testDir)).toBe(newValidId);
        });

        it('should handle directory with 50+ sessions efficiently', () => {
            // Create 50 sessions with messageId (older format)
            for (let i = 0; i < 50; i++) {
                const sessionId = `${i.toString().padStart(8, '0')}-1111-1111-1111-111111111111`;
                const sessionFile = writeRecords(sessionId, [{ messageId: `msg-${i}`, type: 'user' }]);

                // Set different mtimes
                const time = new Date(2025, 0, 1 + i);
                setSessionMtime(sessionFile, time);
            }

            // Most recent should be the last one created
            const mostRecent = '00000049-1111-1111-1111-111111111111';
            expect(claudeFindLastSession(testDir)).toBe(mostRecent);
        });
    });

    describe('UUID format validation', () => {
        it('should only accept properly formatted UUIDs', () => {
            // Valid UUID format
            const validId = '12345678-1234-1234-1234-123456789abc';
            writeFileSync(
                join(testDir, `${validId}.jsonl`),
                JSON.stringify({ uuid: 'msg', type: 'user' }) + '\n'
            );

            // Invalid UUID formats (should be skipped)
            writeFileSync(join(testDir, 'not-a-uuid.jsonl'), JSON.stringify({ uuid: 'msg', type: 'user' }) + '\n');
            writeFileSync(join(testDir, '12345678-12-12-12-123456789abc.jsonl'), JSON.stringify({ uuid: 'msg', type: 'user' }) + '\n');
            writeFileSync(join(testDir, 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX.jsonl'), JSON.stringify({ uuid: 'msg', type: 'user' }) + '\n');

            expect(claudeFindLastSession(testDir)).toBe(validId);
        });
    });
});
