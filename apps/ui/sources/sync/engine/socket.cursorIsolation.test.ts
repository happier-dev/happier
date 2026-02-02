import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('socket update handling cursor isolation', () => {
    it('does not persist /v2/changes cursor from socket updates', () => {
        // Socket updates are best-effort hints. The durable cursor must only advance from `/v2/changes` responses.
        const file = join(__dirname, 'socket.ts');
        const source = readFileSync(file, 'utf8');

        expect(source).not.toContain('saveChangesCursor');
        expect(source).not.toContain('changesCursor');
    });
});

