/**
 * Read-only view over a plugin-owned runtime object whose member values are
 * wrapped by the caller's guard at read time.
 *
 * Registration commit already owns method identity and static-data capture, so
 * a host-side guard must not clone descriptors, walk prototypes, bind receivers
 * or otherwise recapture author-owned structure. It must also not be a
 * structural lie: enumeration, spread, serialization and descriptor inspection
 * have to report exactly the members property access resolves, or two host
 * readers of the same runtime object disagree about what a plugin registered.
 *
 * Every structural trap therefore mirrors the owner instead of the proxy's
 * target. The target stays an empty extensible object so no proxy invariant can
 * be violated when the owner is frozen — registration commit freezes captured
 * runtime graphs, and a frozen target would force `get` to hand back the raw,
 * unguarded member. Reported descriptors are always `configurable: true` for
 * that same reason; that is the one deviation a lazy view cannot avoid.
 *
 * The view is read-only: mutation traps refuse rather than writing to the
 * throwaway target, where a write would be silently lost, and refusing
 * `preventExtensions` keeps the mirrored `ownKeys` result legal forever.
 */
export function createGuardedRuntimeView<T extends object>(params: Readonly<{
    owner: T;
    guard(value: unknown): unknown;
}>): T {
    const readGuarded = (property: PropertyKey): unknown => params.guard(
        Reflect.get(params.owner, property, params.owner),
    );

    return new Proxy({} as T, {
        get: (_target, property) => readGuarded(property),
        has: (_target, property) => Reflect.has(params.owner, property),
        ownKeys: () => Reflect.ownKeys(params.owner),
        getOwnPropertyDescriptor: (_target, property) => {
            const descriptor = Reflect.getOwnPropertyDescriptor(params.owner, property);
            if (!descriptor) return undefined;
            return {
                value: readGuarded(property),
                writable: false,
                enumerable: descriptor.enumerable,
                configurable: true,
            };
        },
        set: () => false,
        defineProperty: () => false,
        deleteProperty: () => false,
        setPrototypeOf: () => false,
        preventExtensions: () => false,
    });
}
