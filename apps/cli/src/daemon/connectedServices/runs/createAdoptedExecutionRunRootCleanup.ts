import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type { CatalogAgentId } from '@/agent/catalog/ids';
import { resolveConnectedServiceMaterializedRootDir } from '../materialize/resolveConnectedServiceMaterializedRootDir';

export function createAdoptedExecutionRunRootCleanup(input: Readonly<{
    materializationBaseDir: string;
    materializedRoot: string;
    agentId: CatalogAgentId;
    materializationKey: string;
    removeRoot: (root: string) => Promise<void>;
}>): (() => Promise<void>) | null {
    const base = resolve(input.materializationBaseDir);
    const root = resolve(input.materializedRoot);
    const child = relative(base, root);
    if (!child || child.startsWith('..') || isAbsolute(child)) return null;
    const expectedRoot = resolve(resolveConnectedServiceMaterializedRootDir({
        baseDir: base,
        agentId: input.agentId,
        materializationKey: input.materializationKey,
    }));
    if (root !== expectedRoot) return null;
    return async () => {
        try {
            const [realBase, realRoot] = await Promise.all([realpath(base), realpath(root)]);
            if (relative(realBase, realRoot) !== relative(base, expectedRoot)) return;
        } catch {
            return;
        }
        await input.removeRoot(root);
    };
}
