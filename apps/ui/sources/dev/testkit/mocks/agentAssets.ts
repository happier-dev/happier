import { vi } from 'vitest';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';

/** Bridge Metro's lazy Agent asset require through the genuine Node loader boundary. */
export async function installAgentAssetLoader() {
    const registryUi = await import('@/agents/registry/registryUi');
    const moduleLoader = getVitestNodeBuiltin<{ _load: (id: string, ...args: unknown[]) => unknown }>('node:module');
    const nativeLoad = moduleLoader._load;
    vi.spyOn(moduleLoader, '_load').mockImplementation(function (this: unknown, id, ...args) {
        return id === '@/agents/registry/registryUi' ? registryUi : nativeLoad.call(this, id, ...args);
    });
    const nativeRequire = globalThis.require;
    vi.stubGlobal('require', (moduleId: string) => (
        moduleId === '@/agents/registry/registryUi' ? registryUi : nativeRequire(moduleId)
    ));
}
