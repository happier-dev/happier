import { logger } from '@/ui/logger';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { run as runRipgrep } from '@/integrations/ripgrep/index';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { FilesystemAccessPolicy } from './fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from './fileSystem/accessPolicy/filesystemPathAuthorization';

interface RipgrepRequest {
    args: string[];
    cwd?: string;
}

interface RipgrepResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

export function registerRipgrepHandler(
    rpcHandlerManager: RpcHandlerRegistrar,
    workingDirectory: string,
    opts?: Readonly<{ accessPolicy?: FilesystemAccessPolicy }>,
): void {
    const accessPolicy = opts?.accessPolicy ?? { kind: 'osUser' };
    // Ripgrep handler - raw interface to ripgrep
    rpcHandlerManager.registerHandler<RipgrepRequest, RipgrepResponse>(RPC_METHODS.RIPGREP, async (data) => {
        logger.debug('Ripgrep request with args:', data.args, 'cwd:', data.cwd);

        let cwd = workingDirectory;
        if (data.cwd) {
            const validation = authorizeFilesystemPath({
                targetPath: data.cwd,
                defaultDirectory: workingDirectory,
                accessPolicy,
            });
            if (!validation.valid) return { success: false, error: validation.error };
            cwd = validation.resolvedPath;
        }

        try {
            const result = await runRipgrep(data.args, { cwd });
            return {
                success: true,
                exitCode: result.exitCode,
                stdout: result.stdout.toString(),
                stderr: result.stderr.toString()
            };
        } catch (error) {
            logger.debug('Failed to run ripgrep:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to run ripgrep'
            };
        }
    });
}
