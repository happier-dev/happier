import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { observeDockerEngine, openDockerEngineEvents } from './dockerEngineObservation';

describe('Docker engine observation failure diagnostics', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each(['connect', 'inspect'] as const)('keeps %s failures observable while publishing unknown state', async phase => {
        const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        const failure = Object.assign(new Error('private engine observation text'), { code: 'EIO' });
        const rows: unknown[] = [];
        // These ports are the external native Docker subscription and inspection IO.
        const observer = observeDockerEngine(`diagnostic-${phase}`, {
            ids: ['a'.repeat(64)],
            async events() { if (phase === 'connect') throw failure; return { async dispose() {} }; },
            async inspect() { throw failure; }, changed(value) { rows.push(value); },
        });
        try {
            await observer.ready;
            expect(rows).toEqual([null]);
            expect(diagnostic).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
                phase: `native_compose.events.${phase}`, errorClass: 'Error', errorCode: 'EIO', httpStatus: null,
            }));
            expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private engine observation text');
        } finally { await observer.dispose(); }
    });

    it('retains malformed pushed event causes without retaining the event payload', async () => {
        const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        // The real child mimics Docker dial-stdio; HTTP framing and event parsing stay real.
        const script = `process.stdin.once('data', () => {
            process.stdout.write('HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n');
            const event = '{"private engine event":\\n';
            process.stdout.write(Buffer.byteLength(event).toString(16)+'\\r\\n'+event+'\\r\\n');
        }); process.stdin.resume();`;
        const controller = new AbortController();
        let disconnected!: () => void;
        const down = new Promise<void>(resolve => { disconnected = resolve; });
        const open = openDockerEngineEvents({ command: process.execPath, args: [], cwd: process.cwd(), env: {}, release() {} }, ['-e', script, '--']);
        const subscription = await open({ signal: controller.signal, disconnected, event() { throw new Error('Malformed JSON cannot publish an event'); } });
        try {
            await down;
            expect(diagnostic).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
                phase: 'native_compose.events.parse', errorClass: 'SyntaxError', errorCode: null,
            }));
            expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private engine event');
        } finally { controller.abort(); await subscription.dispose(); }
    });

});

describe('Docker subscribed stream failure diagnostics', () => {
    afterEach(() => vi.restoreAllMocks());

    it('retains a broken subscribed HTTP stream cause before publishing disconnection', async () => {
        const diagnostic = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        const script = `process.stdin.once('data', () => {
            process.stdout.write('HTTP/1.1 200 OK\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\nprivate-invalid-chunk\\r\\n');
        }); process.stdin.resume();`;
        const controller = new AbortController();
        let disconnected!: () => void;
        const down = new Promise<void>(resolve => { disconnected = resolve; });
        const open = openDockerEngineEvents({ command: process.execPath, args: [], cwd: process.cwd(), env: {}, release() {} }, ['-e', script, '--']);
        const subscription = await open({ signal: controller.signal, disconnected, event() {} });
        try {
            await down;
            expect(diagnostic).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
                phase: 'native_compose.events.stream', errorClass: 'Error',
            }));
            expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-invalid-chunk');
        } finally { controller.abort(); await subscription.dispose(); }
    });
});
