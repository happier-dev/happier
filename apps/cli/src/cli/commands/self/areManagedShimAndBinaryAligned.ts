import { readFileSync, realpathSync } from 'node:fs';

export function areManagedShimAndBinaryAligned(params: Readonly<{
    shimPath: string;
    binaryPath: string;
    platform?: NodeJS.Platform;
}>): boolean {
    try {
        if (params.platform === 'win32') {
            return readFileSync(params.shimPath).equals(readFileSync(params.binaryPath));
        }
        return realpathSync(params.shimPath) === realpathSync(params.binaryPath);
    } catch {
        return false;
    }
}
