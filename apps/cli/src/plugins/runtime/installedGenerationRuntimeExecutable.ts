import {
    resolveManagedProviderRuntimeExecutable,
    resolvePackagedRuntimeBinaryRelativePath,
    type PackagedRuntimeBinaryExecutableRef,
} from '@/providers/lifecycle/resolveManagedProviderRuntimeLaunch';
import {
    assertContainedRegularGenerationFile,
} from '@/plugins/store/registry/generationStore';

export type CurrentInstalledPluginGenerationRuntimeResolution = Readonly<{
    executable: PackagedRuntimeBinaryExecutableRef;
    rootPath: string;
    files: readonly Readonly<{
        relativePath: string;
        byteLength: number;
    }>[];
    isCurrent(): Promise<boolean>;
}>;

/**
 * Resolves a daemon-selected installed generation's declared runtime binary.
 * The generation owner supplies its currentness authority; this helper keeps
 * immutable inventory and filesystem containment validation in one place.
 */
export async function resolveCurrentInstalledPluginGenerationRuntimeExecutable(
    input: CurrentInstalledPluginGenerationRuntimeResolution,
): Promise<string | null> {
    const relativePath = resolvePackagedRuntimeBinaryRelativePath(
        input.executable,
    );
    if (!relativePath) return null;
    const inventoryFile = input.files.find((file) => (
        file.relativePath === relativePath
    ));
    if (!inventoryFile) return null;
    const isCurrent = async (): Promise<boolean> => {
        try {
            return await input.isCurrent();
        } catch {
            return false;
        }
    };
    if (!await isCurrent()) return null;

    try {
        await assertContainedRegularGenerationFile(
            input.rootPath,
            relativePath,
            'Installed plugin managed runtime binary',
            { expectedByteLength: inventoryFile.byteLength },
        );
    } catch {
        return null;
    }
    if (!await isCurrent()) return null;

    const command = await resolveManagedProviderRuntimeExecutable(
        input.executable,
        {
            installedPluginGenerationRuntimeRoot: input.rootPath,
        },
    );
    if (!command || !await isCurrent()) return null;

    try {
        await assertContainedRegularGenerationFile(
            input.rootPath,
            relativePath,
            'Installed plugin managed runtime binary',
            { expectedByteLength: inventoryFile.byteLength },
        );
    } catch {
        return null;
    }
    return await isCurrent() ? command : null;
}
