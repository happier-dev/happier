import type { SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

import { logger } from '@/ui/logger';

/** Observe native NDJSON before the Agent SDK queues it, forwarding the original bytes. */
export function observeClaudeSdkProcess(
    child: SpawnedProcess,
    onMessage: (message: unknown) => void,
): Readonly<{ process: SpawnedProcess; dispose: () => void }> {
    const decoder = new StringDecoder('utf8');
    let pendingLine = '';
    const observeLine = (line: string): void => {
        let message: unknown;
        try {
            message = JSON.parse(line);
        } catch {
            // The SDK retains authority over malformed transport input.
            return;
        }
        try {
            onMessage(message);
        } catch (error) {
            logger.warnFile('[claudeRemoteAgentSdk] Provider activity handler failed', error);
        }
    };
    const observeText = (text: string): void => {
        pendingLine += text;
        for (;;) {
            const newline = pendingLine.indexOf('\n');
            if (newline === -1) return;
            const line = pendingLine.slice(0, newline);
            pendingLine = pendingLine.slice(newline + 1);
            observeLine(line);
        }
    };
    const stdout = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            observeText(decoder.write(chunk));
            callback(null, chunk);
        },
        flush(callback) {
            observeText(decoder.end());
            if (pendingLine) observeLine(pendingLine);
            pendingLine = '';
            callback();
        },
    });
    const onError = (error: Error): void => { stdout.destroy(error); };
    const onClose = (): void => { if (!child.stdout.readableEnded) stdout.destroy(); };
    child.stdout.on('error', onError);
    child.stdout.on('close', onClose);
    child.stdout.pipe(stdout);
    return {
        process: {
            stdin: child.stdin,
            stdout,
            get killed() { return child.killed; },
            get exitCode() { return child.exitCode; },
            kill: child.kill.bind(child),
            on: child.on.bind(child),
            once: child.once.bind(child),
            off: child.off.bind(child),
        },
        dispose: () => {
            child.stdout.unpipe(stdout);
            child.stdout.off('error', onError);
            child.stdout.off('close', onClose);
            stdout.destroy();
            pendingLine = '';
        },
    };
}
