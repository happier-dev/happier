import { describe, expect, it } from 'vitest';
import { execFileWithDeadline } from './execFileWithDeadline.js';

describe('native process transient stdin', () => {
    it.each([undefined, 100])('delivers exact bytes and EOF through the existing process owner (output suffix %s)', async outputTailMaxBytes => {
        const inputBytes = Buffer.from([0, 1, 58, 10, 255]);
        const output = await execFileWithDeadline(process.execPath, ['-e',
            "const chunks=[];process.stdin.on('data',x=>chunks.push(x));process.stdin.on('end',()=>process.stdout.write(Buffer.concat(chunks).toString('hex')));"],
        { inputBytes, encoding: 'utf8', timeout: 1000, ...(outputTailMaxBytes === undefined ? {} : { outputTailMaxBytes }) });
        expect(output.stdout).toBe(inputBytes.toString('hex'));
    });

    it('settles an early native exit even if its stdin pipe closes before delivery', async () => {
        await expect(execFileWithDeadline(process.execPath, ['-e', 'process.exit(7)'],
            { inputBytes: Buffer.alloc(1024 * 1024), encoding: 'utf8', timeout: 1000 })).rejects.toMatchObject({ code: 7 });
    });
});
