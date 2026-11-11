import type { BoundPluginSurfaceMountedHostApiHandlersFactory } from './boundPluginSurfaceController';

/**
 * One physical mount, several owners of its semantic handlers (a placement such as a Details tab, and the Composer
 * every mounted destination owns). Each owner's handlers stay installed; the later owner decides a method both
 * supply, and disposing the mount disposes every owner's bundle. Lifecycle hooks other than `dispose` are the
 * first owner's that has them, as a single-owner mount had them.
 */
export function composeMountedHostApiHandlerFactories(
  ...factories: readonly (
    | BoundPluginSurfaceMountedHostApiHandlersFactory
    | undefined
  )[]
): BoundPluginSurfaceMountedHostApiHandlersFactory | undefined {
  const present = factories.filter(
    (factory): factory is BoundPluginSurfaceMountedHostApiHandlersFactory =>
      factory !== undefined,
  );
  if (present.length <= 1) return present[0];
  return (input) => {
    const bundles = present.map((factory) => factory(input));
    const hooks = Object.assign(
      {},
      ...[...bundles].reverse(),
    ) as ReturnType<BoundPluginSurfaceMountedHostApiHandlersFactory>;
    return Object.freeze({
      ...hooks,
      handlers: Object.freeze(
        Object.assign({}, ...bundles.map((bundle) => bundle.handlers)),
      ),
      dispose: () => {
        for (const bundle of bundles) bundle.dispose?.();
      },
    });
  };
}
