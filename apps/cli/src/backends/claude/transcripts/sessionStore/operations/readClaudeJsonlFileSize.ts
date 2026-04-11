import { stat } from 'node:fs/promises';

export async function readClaudeJsonlFileSize(filePath: string): Promise<number> {
    return stat(filePath).then((entry) => entry.size).catch(() => 0);
}
