import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { claudeCheckSession } from './claudeCheckSession';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    cleanupTempSessionDir,
    createTempSessionDir,
    writeSessionObjectLines,
} from './sessionFixtures.testHelpers';

// Mock getProjectPath to use test directory
vi.mock('./path', () => ({
    getProjectPath: (path: string) => path
}));

describe('claudeCheckSession', () => {
    let testDir: string;

    const writeRecords = (sessionId: string, records: Array<Record<string, unknown>>) =>
        writeSessionObjectLines(testDir, sessionId, records);

    beforeEach(() => {
        testDir = createTempSessionDir('test-session');
    });

    afterEach(() => {
        cleanupTempSessionDir(testDir);
    });

    describe('Claude Code 2.1.x sessions (uuid field)', () => {
        it('should accept session with valid uuid', () => {
            const sessionId = '12345678-1234-1234-1234-123456789abc';
            writeRecords(sessionId, [{ uuid: 'msg-123', type: 'user' }]);

            expect(claudeCheckSession(sessionId, testDir)).toBe(true);
        });

        it('should accept session with multiple messages, first has uuid', () => {
            const sessionId = '12345678-1234-1234-1234-123456789abc';
            const sessionFile = join(testDir, `${sessionId}.jsonl`);
            writeFileSync(sessionFile,
                JSON.stringify({ uuid: 'msg-1', type: 'user' }) + '\n' +
                JSON.stringify({ uuid: 'msg-2', type: 'assistant' }) + '\n'
            );

            expect(claudeCheckSession(sessionId, testDir)).toBe(true);
        });
    });

    describe('Older Claude Code sessions (messageId field)', () => {
        it('should accept session with valid messageId', () => {
            const sessionId = '87654321-4321-4321-4321-210987654321';
            writeRecords(sessionId, [{ messageId: 'msg-456', type: 'user' }]);

            expect(claudeCheckSession(sessionId, testDir)).toBe(true);
        });

        it('should accept session with messageId in second line', () => {
            const sessionId = '87654321-4321-4321-4321-210987654321';
            const sessionFile = join(testDir, `${sessionId}.jsonl`);
            writeFileSync(sessionFile,
                JSON.stringify({ type: 'summary' }) + '\n' +
                JSON.stringify({ messageId: 'msg-456', type: 'user' }) + '\n'
            );

            expect(claudeCheckSession(sessionId, testDir)).toBe(true);
        });
    });

    describe('Summary line sessions (leafUuid field)', () => {
        it('should accept session with valid leafUuid', () => {
            const sessionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
            writeRecords(sessionId, [{ leafUuid: 'leaf-789', type: 'summary' }]);

            expect(claudeCheckSession(sessionId, testDir)).toBe(true);
        });
    });

    describe('Edge cases - invalid sessions', () => {
        it('should reject session with empty uuid string', () => {
            const sessionId = '12345678-1234-1234-1234-123456789abc';
            writeRecords(sessionId, [{ uuid: '', type: 'user' }]);

            expect(claudeCheckSession(sessionId, testDir)).toBe(false);
        });

        it('should reject session with empty messageId string', () => {
            const sessionId = '12345678-1234-1234-1234-123456789abc';
            writeRecords(sessionId, [{ messageId: '', type: 'user' }]);

            expect(claudeCheckSession(sessionId, testDir)).toBe(false);
        });

        it('should reject session with null uuid', () => {
            const sessionId = '12345678-1234-1234-1234-123456789abc';
            writeRecords(sessionId, [{ uuid: null, type: 'user' }]);

            expect(claudeCheckSession(sessionId, testDir)).toBe(false);
        });

        it('should reject session with no ID fields', () => {
            const sessionId = '12345678-1234-1234-1234-123456789abc';
            writeRecords(sessionId, [{ type: 'user', content: 'test' }]);

            expect(claudeCheckSession(sessionId, testDir)).toBe(false);
        });

        it('should reject session with only other fields', () => {
            const sessionId = '12345678-1234-1234-1234-123456789abc';
            writeRecords(sessionId, [{ role: 'user', message: 'hello' }]);

            expect(claudeCheckSession(sessionId, testDir)).toBe(false);
        });
    });

    describe('File system edge cases', () => {
        it('should reject non-existent session', () => {
            expect(claudeCheckSession('nonexistent-uuid-1234', testDir)).toBe(false);
        });

        it('should reject session with malformed JSON', () => {
            const sessionId = '12345678-1234-1234-1234-123456789abc';
            const sessionFile = join(testDir, `${sessionId}.jsonl`);
            writeFileSync(sessionFile, '{invalid json}\n{also invalid\n');

            expect(claudeCheckSession(sessionId, testDir)).toBe(false);
        });

        it('should reject empty session file', () => {
            const sessionId = '12345678-1234-1234-1234-123456789abc';
            const sessionFile = join(testDir, `${sessionId}.jsonl`);
            writeFileSync(sessionFile, '');

            expect(claudeCheckSession(sessionId, testDir)).toBe(false);
        });

        it('should handle session with only whitespace', () => {
            const sessionId = '12345678-1234-1234-1234-123456789abc';
            const sessionFile = join(testDir, `${sessionId}.jsonl`);
            writeFileSync(sessionFile, '   \n  \n\t\n');

            expect(claudeCheckSession(sessionId, testDir)).toBe(false);
        });

        it('should handle large session file with valid message at end', () => {
            const sessionId = '12345678-1234-1234-1234-123456789abc';
            const sessionFile = join(testDir, `${sessionId}.jsonl`);

            // Create many invalid lines followed by one valid line
            const lines = [];
            for (let i = 0; i < 100; i++) {
                lines.push(JSON.stringify({ type: 'other', index: i }));
            }
            lines.push(JSON.stringify({ uuid: 'found-it', type: 'user' }));
            writeFileSync(sessionFile, lines.join('\n') + '\n');

            expect(claudeCheckSession(sessionId, testDir)).toBe(true);
        });

        it('should accept session when transcriptPath override points to valid file outside projectDir', () => {
            const sessionId = '33333333-3333-3333-3333-333333333333';

            const altDir = join(testDir, 'alt-project');
            mkdirSync(altDir, { recursive: true });

            const transcriptPath = join(altDir, `${sessionId}.jsonl`);
            writeFileSync(transcriptPath, JSON.stringify({ uuid: 'msg-override', type: 'user' }) + '\n');

            // RED: current implementation ignores transcriptPath and checks only `${getProjectPath(path)}/${sessionId}.jsonl`
            expect(claudeCheckSession(sessionId, testDir, transcriptPath)).toBe(true);
        });
    });

    describe('Mixed format sessions', () => {
        it('should accept session with both uuid and messageId (prefer first valid)', () => {
            const sessionId = '12345678-1234-1234-1234-123456789abc';
            const sessionFile = join(testDir, `${sessionId}.jsonl`);
            writeFileSync(sessionFile,
                JSON.stringify({ uuid: 'msg-1', messageId: 'msg-2', type: 'user' }) + '\n'
            );

            expect(claudeCheckSession(sessionId, testDir)).toBe(true);
        });

        it('should find valid message even if first lines are invalid', () => {
            const sessionId = '12345678-1234-1234-1234-123456789abc';
            const sessionFile = join(testDir, `${sessionId}.jsonl`);
            writeFileSync(sessionFile,
                '{}\n' +
                JSON.stringify({ type: 'other' }) + '\n' +
                JSON.stringify({ messageId: 'found-it', type: 'user' }) + '\n'
            );

            expect(claudeCheckSession(sessionId, testDir)).toBe(true);
        });
    });
});
