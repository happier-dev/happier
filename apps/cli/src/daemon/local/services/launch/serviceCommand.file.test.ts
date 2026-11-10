import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { withTempDir } from '@/testkit/fs/tempDir';
import * as commands from './serviceCommand';
import { machineNativeEffectAdmission } from './machineNativeEffectAdmission';
import { createFileTransferPayloadSource } from '@/machines/transfer/transferPayloadSource';

describe('admitted service command finite file input', () => {
    it.each(['complete', 'earlyExit', 'cancel', 'readFailure'] as const)('settles the native reader and file custody: %s', async mode => {
        await withTempDir('happier-service-file-', async root => {
            // Larger than an OS pipe buffer, with bytes that cannot survive a text conversion.
            const bytes = Buffer.alloc(2 * 1024 * 1024);
            for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
            const filePath = join(root, 'admitted-upload');
            await writeFile(filePath, bytes);
            const controller = new AbortController();
            const redaction = createProviderRedactionLease({ values: [] });
            const keys = [{ kind: 'composeProject' as const, dockerEndpoint: 'finite-file-fixture', projectName: root }];
            let released = false;
            let ready!: () => void;
            const started = new Promise<void>(resolve => { ready = resolve; });
            const watcher = watch(root, (_event, name) => { if (String(name) === 'ready') ready(); });
            const script = mode === 'complete'
                ? 'const h=require("node:crypto").createHash("sha256");process.stdin.on("data",c=>h.update(c));process.stdin.on("end",()=>process.stdout.write(h.digest("hex")));'
                : mode === 'earlyExit'
                    ? 'process.stdin.once("data",()=>{process.stderr.write("invalid archive",()=>process.exit(1));});process.stdin.resume();'
                    : mode === 'cancel'
                        ? `require("node:fs").writeFileSync(${JSON.stringify(join(root, 'ready'))}, "ready");setInterval(()=>{},1000);`
                        : `process.stdin.resume();process.stdin.on("end",()=>require("node:fs").writeFileSync(${JSON.stringify(join(root, 'eof'))},"eof"));`;
            try {
                await machineNativeEffectAdmission.run({ operation: { operationId: root, kind: 'restore', signal: controller.signal }, keys }, async context => {
                    const command = commands.admitNativeServiceCommandForHost({ context, async assertCurrent() {},
                        async observeNativeSettlement() { return true; }, async launch() {
                            return { command: process.execPath, args: ['-e', script], env: {}, secretRedactionLease: redaction,
                                release() { released = true; } };
                        } });
                    const pending = commands.executeAdmittedServiceCommand(commands.admitServiceCommandInputForHost({ command,
                        source: mode === 'readFailure' ? { kind: 'native', sizeBytes: bytes.length,
                            manifestHash: 'sha256:retained-upload', async readChunk({ offset, length }) {
                                // A native filesystem transport can fail after lending its first chunk.
                                if (offset > 0) throw new Error('Requester filesystem transport closed');
                                return bytes.subarray(offset, offset + length);
                            } } : createFileTransferPayloadSource({ filePath, sizeBytes: bytes.length }) }));
                    if (mode === 'cancel') { await started; controller.abort(); }
                    const result = await pending;
                    if (mode === 'complete') expect(result).toMatchObject({ kind: 'completed', exitCode: 0,
                        stdout: createHash('sha256').update(bytes).digest('hex') });
                    else if (mode === 'earlyExit') expect(result).toMatchObject({ kind: 'completed', exitCode: 1, stderr: 'invalid archive' });
                    else expect(result).toEqual({ kind: 'outcome_unknown' });
                    if (mode === 'complete' || mode === 'earlyExit') expect(released).toBe(true);
                    if (mode === 'readFailure') await expect(access(join(root, 'eof'))).rejects.toThrow();
                });
            } finally {
                watcher.close();
                await machineNativeEffectAdmission.reconcileUnknown({ keys, async observeSettled() { return true; } });
                redaction.close();
            }
            expect(released).toBe(true);
        });
    });
});
