import { describe, expect, it } from 'vitest';
import { createNativeComposeProgressOutput } from './nativeComposeProgress';

function capture() {
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const progress = createNativeComposeProgressOutput((stream, chunk) => output[stream].push(Buffer.from(chunk)));
    return { progress, read: (stream: 'stdout' | 'stderr') => Buffer.concat(output[stream]) };
}

describe('native Compose resource progress', () => {
    it('records interleaved duplicate Volume and Network notifications once across arbitrary chunk boundaries', () => {
        // Event ordering captured directly from nl3 Compose 5.6.0 dry-run stderr.
        const lines = [
            ' Volume project_data Creating ', ' Network project_default Creating ',
            ' Volume project_data Creating ', ' Volume project_data Created ',
            ' Volume project_data Created ', ' Network project_default Creating ',
            ' Network project_default Created ', ' Network project_default Created ',
            ' Container project-app-1 Creating ', ' Container project-app-1 Created ',
        ];
        const captured = capture();
        for (const byte of Buffer.from(lines.join('\n') + '\n')) captured.progress.onChunk('stderr', Uint8Array.of(byte));
        captured.progress.finish();
        expect(captured.read('stderr').toString()).toBe([
            lines[0], lines[1], lines[3], lines[6], lines[8], lines[9], '',
        ].join('\n'));
    });

    it('preserves repeated stdout, diagnostics, container output and UTF-8 bytes', () => {
        const captured = capture();
        const stdout = Buffer.from(' Volume project_data Creating \n'.repeat(2));
        captured.progress.onChunk('stdout', stdout);
        const stderr = Buffer.from([
            'Materializing exact source', 'Materializing exact source',
            ' Container project-app-1 Created ', ' Container project-app-1 Created ',
            ' Volume project_data Error permission denied', ' Volume project_data Error permission denied',
            'diagnostic café 🌍', 'diagnostic café 🌍',
        ].join('\r\n'));
        for (const byte of stderr) captured.progress.onChunk('stderr', Uint8Array.of(byte));
        captured.progress.finish();
        expect(captured.read('stdout')).toEqual(stdout);
        expect(captured.read('stderr')).toEqual(stderr);
    });

    it('keeps genuine subsequent transitions for the same resource and scopes state to one command', () => {
        const captured = capture();
        const cycle = ['Creating', 'Created', 'Removing', 'Removed', 'Creating', 'Created']
            .map(state => ` Volume project_data ${state} \n`).join('');
        captured.progress.onChunk('stderr', Buffer.from(cycle));
        captured.progress.finish();
        expect(captured.read('stderr').toString()).toBe(cycle);
        const another = capture();
        another.progress.onChunk('stderr', Buffer.from(cycle));
        another.progress.finish();
        expect(another.read('stderr').toString()).toBe(cycle);
    });

    it('flushes unterminated final progress or diagnostics when the command settles', () => {
        for (const line of [' Network project_default Created ', ' Volume partial', ' V']) {
            const captured = capture();
            captured.progress.onChunk('stderr', Buffer.from(line));
            captured.progress.finish();
            captured.progress.finish();
            expect(captured.read('stderr').toString()).toBe(line);
        }
        const captured = capture();
        captured.progress.onChunk('stderr', Buffer.from(' Network project_default Created \r\n Network project_default Created '));
        captured.progress.finish();
        expect(captured.read('stderr').toString()).toBe(' Network project_default Created \r\n');
    });

    it('forwards ordinary newline-free diagnostics before command settlement', () => {
        const captured = capture();
        const diagnostic = Buffer.from('a long-running diagnostic without a newline');
        captured.progress.onChunk('stderr', diagnostic);
        expect(captured.read('stderr')).toEqual(diagnostic);
    });
});
