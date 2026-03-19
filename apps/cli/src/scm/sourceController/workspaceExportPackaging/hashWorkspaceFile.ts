import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export async function hashWorkspaceFile(params: Readonly<{ filePath: string }>): Promise<string> {
    const hash = createHash('sha256');
    const stream = createReadStream(params.filePath);

    return await new Promise<string>((resolve, reject) => {
        stream.on('data', (chunk: Buffer | string) => {
            hash.update(chunk);
        });
        stream.on('error', reject);
        stream.on('end', () => {
            resolve(`sha256:${hash.digest('hex')}`);
        });
    });
}
