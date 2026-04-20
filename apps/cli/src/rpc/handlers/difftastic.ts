import { logger } from '@/ui/logger';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { run as runDifftastic } from '@/integrations/difftastic/index';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { FilesystemAccessPolicy } from './fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from './fileSystem/accessPolicy/filesystemPathAuthorization';

interface DifftasticRequest {
    args: string[];
    cwd?: string;
}

interface DifftasticResponse {
    success: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
}

export function registerDifftasticHandler(
    rpcHandlerManager: RpcHandlerRegistrar,
    workingDirectory: string,
    opts?: Readonly<{ accessPolicy?: FilesystemAccessPolicy }>,
): void {
    const accessPolicy = opts?.accessPolicy ?? { kind: 'osUser' };
    // Difftastic handler - raw interface to difftastic
    rpcHandlerManager.registerHandler<DifftasticRequest, DifftasticResponse>(RPC_METHODS.DIFFTASTIC, async (data) => {
        logger.debug('Difftastic request with args:', data.args, 'cwd:', data.cwd);

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
            const result = await runDifftastic(data.args, { cwd });
            return {
                success: true,
                exitCode: result.exitCode,
                stdout: result.stdout.toString(),
                stderr: result.stderr.toString()
            };
        } catch (error) {
            logger.debug('Failed to run difftastic:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Failed to run difftastic'
            };
        }
    });
}
