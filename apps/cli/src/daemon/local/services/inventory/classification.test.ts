import { describe, expect, it } from 'vitest';

import { classifyProcessRole as classifyLocalServiceProcess } from '@/processes/classification/classifyProcessRole';

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

    it.each([
        'python3 -u -m http.server 39997',
        String.raw`C:\Python\python.exe -u -m http.server 39997`,
        `python3 -c 'import http.server;http.server.HTTPServer(("127.0.0.1",39997),http.server.SimpleHTTPRequestHandler).serve_forever()'`,
        `python3 -u -c 'import http.server;http.server.ThreadingHTTPServer(("127.0.0.1",39997),http.server.SimpleHTTPRequestHandler).serve_forever()'`,
    ])('recognizes the Python HTTP server command %s', command => {
        expect(classifyLocalServiceProcess({ command })).toMatchObject({
            kind: 'python-http-server', role: 'dev_server', confidence: 'high',
        });
    });

    it.each([
        'python3 worker.py',
        `python3 -c 'import http.server;print(http.server.__file__)'`,
    ])('does not infer a server from the Python runtime or module import: %s', command => {
        expect(classifyLocalServiceProcess({ command }).kind).toBeUndefined();
    });
});
