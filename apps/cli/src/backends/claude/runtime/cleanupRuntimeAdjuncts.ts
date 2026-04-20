import { stopCaffeinate } from '@/integrations/caffeinate';
import { cleanupHookPluginDir, cleanupHookSettingsFile } from '@/backends/claude/utils/generateHookSettings';

type ClaudeHookServerLike = Readonly<{
    stop: () => void;
}>;

export function cleanupClaudeRuntimeAdjuncts(params: Readonly<{
    hookServer: ClaudeHookServerLike | null | undefined;
    hookSettingsPath: string | null | undefined;
    hookPluginDir?: string | null | undefined;
}>): void {
    stopCaffeinate();
    params.hookServer?.stop();
    if (params.hookSettingsPath) {
        cleanupHookSettingsFile(params.hookSettingsPath);
    }
    cleanupHookPluginDir(params.hookPluginDir);
}
