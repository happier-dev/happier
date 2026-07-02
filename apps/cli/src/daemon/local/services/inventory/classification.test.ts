import { describe, expect, it } from 'vitest';

import { classifyLocalServiceProcess } from './classification';

describe('classifyLocalServiceProcess', () => {
    it('recognizes common dev server commands', () => {
        expect(classifyLocalServiceProcess({ command: 'npm run dev -- --host 127.0.0.1', cwd: '/repo' })).toMatchObject({
            kind: 'npm-dev',
            displayName: 'NPM dev server',
            confidence: 'medium',
        });
        expect(classifyLocalServiceProcess({ command: 'node ./node_modules/vite/bin/vite.js', cwd: '/repo' })).toMatchObject({
            kind: 'vite',
            displayName: 'Vite',
            confidence: 'high',
        });
        expect(classifyLocalServiceProcess({ command: 'python -m http.server 8000', cwd: '/repo' })).toMatchObject({
            kind: 'python-http-server',
            displayName: 'Python HTTP server',
            confidence: 'high',
        });
    });

    it('marks Chromium helpers and database/system listeners as low-signal without deleting facts', () => {
        expect(classifyLocalServiceProcess({ command: 'Google Chrome Helper --type=renderer', cwd: '/tmp' })).toMatchObject({
            lowSignal: true,
            signals: expect.arrayContaining(['noise:chromium-child']),
        });
        expect(classifyLocalServiceProcess({ command: 'redis-server *:6379', cwd: '/var' })).toMatchObject({
            lowSignal: true,
            signals: expect.arrayContaining(['noise:system-listener']),
        });
    });
});
