import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export async function hashWorkspaceFile(params: Readonly<{
    filePath: string;
    assertCanContinue?: () => void | Promise<void>;
}>): Promise<string> {
    const hash = createHash('sha256');
    const stream = createReadStream(params.filePath);

    try {
        await params.assertCanContinue?.();
        for await (const chunk of stream) {
            await params.assertCanContinue?.();
            hash.update(chunk);
        }
    } catch (error) {
        stream.destroy();
        throw error;
    }

    return `sha256:${hash.digest('hex')}`;
}
