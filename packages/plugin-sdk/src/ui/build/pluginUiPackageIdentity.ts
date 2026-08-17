/** @moduleRealm build */
import { realpathSync } from 'node:fs';

/**
 * Any graph that consumes `@happier-dev/plugin-ui` may contain only one
 * physical package instance, so its providers and consumers share the same
 * React context identity. Client-only artifacts legitimately have no Plugin UI
 * participant at all.
 *
 * Bundlers report modules differently (Vite reports resolved ids while Rspack
 * reports module resources), so this owner accepts the small common shape and
 * applies the same physical-root check to both graphs.
 */
function resourceOf(module: unknown): string | null {
    if (typeof module !== 'object' || module === null) return null;
    const candidate = module as Readonly<{
        resource?: unknown;
        nameForCondition?: (() => unknown) | undefined;
    }>;
    const resource = candidate.resource ?? candidate.nameForCondition?.();
    return typeof resource === 'string' && resource.length > 0 ? resource : null;
}

function packageRootFromResource(resource: string): string | null {
    // Strip loader prefixes and resource queries before splitting, then use a
    // slash-neutral representation so Windows ids are evaluated correctly on
    // every host platform (including cross-platform CI fixtures).
    const filePath = resource.slice(resource.lastIndexOf('!') + 1).split('?')[0]?.replace(/\\/gu, '/') ?? '';
    if (!filePath) return null;
    const segments = filePath.split('/');
    const scopedPackageIndex = segments.findIndex((segment, index) => (
        segment === '@happier-dev' && segments[index + 1] === 'plugin-ui'
    ));
    if (scopedPackageIndex >= 0) {
        return segments.slice(0, scopedPackageIndex + 2).join('/') || '/';
    }
    const workspacePackageIndex = segments.findIndex((segment, index) => (
        segment === 'packages' && segments[index + 1] === 'plugin-ui'
    ));
    return workspacePackageIndex >= 0
        ? segments.slice(0, workspacePackageIndex + 2).join('/') || '/'
        : null;
}

function physicalRoot(root: string): string {
    try {
        return realpathSync.native(root);
    } catch {
        // A compiler can report a virtualized path after resolving a real
        // module. Preserve it as a distinct root rather than silently merging
        // it with an unrelated package instance.
        return root;
    }
}

/**
 * Validates the physical package roots represented by a completed bundle
 * graph. Zero roots are valid for a client-only artifact; more than one root
 * would split Plugin UI's React context identity.
 */
export function assertSinglePluginUiPackageInstance(
    modules: Iterable<unknown>,
): readonly string[] {
    const roots = new Set<string>();
    for (const module of modules) {
        const resource = resourceOf(module);
        if (!resource) continue;
        const root = packageRootFromResource(resource);
        if (root) roots.add(physicalRoot(root));
    }
    if (roots.size > 1) {
        throw new Error(
            `Plugin UI artifact must not bundle more than one physical @happier-dev/plugin-ui package; found ${roots.size}: ${[...roots].join(', ')}`,
        );
    }
    return Object.freeze([...roots]);
}

/**
 * Vite/Rollup phase: inspect all resolved module ids immediately before it
 * generates output. Throwing here stops the bundler before the artifact
 * stager observes or replaces any last-known-good tree.
 */
export function createPluginUiPackageInstanceVitePlugin() {
    return Object.freeze({
        name: 'happier-plugin-ui-package-instance' as const,
        enforce: 'post' as const,
        generateBundle(this: Readonly<{ getModuleIds(): Iterable<string> }>): void {
            assertSinglePluginUiPackageInstance(
                Array.from(this.getModuleIds(), (resource) => ({ resource })),
            );
        },
    });
}

/**
 * Re.Pack/Rspack phase: turn the same invariant into a compilation error,
 * which makes the managed Re.Pack command fail before artifact staging.
 */
export function createPluginUiPackageInstanceRepackPlugin() {
    return Object.freeze({
        apply(compiler: Readonly<{
            hooks: Readonly<{
                afterCompile: Readonly<{
                    tap(
                        name: string,
                        callback: (compilation: Readonly<{
                            modules?: Iterable<unknown>;
                            errors: Error[];
                        }>) => void,
                    ): void;
                }>;
            }>;
        }>): void {
            compiler.hooks.afterCompile.tap('HappierPluginUiPackageInstancePlugin', (compilation) => {
                try {
                    assertSinglePluginUiPackageInstance(compilation.modules ?? []);
                } catch (cause) {
                    compilation.errors.push(cause instanceof Error ? cause : new Error(String(cause)));
                }
            });
        },
    });
}
