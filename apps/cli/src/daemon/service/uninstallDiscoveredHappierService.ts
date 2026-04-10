import {
    uninstallHappierService,
    type HappierServiceBackend,
} from '@happier-dev/cli-common/happierRuntime';

export async function uninstallDiscoveredHappierService(params: Readonly<{
    platform: 'darwin' | 'linux' | 'win32';
    backend: HappierServiceBackend;
    scope: 'user' | 'system';
    label: string;
    definitionPath: string;
    runCommands?: boolean;
}>): Promise<void> {
    await uninstallHappierService(params);
}
