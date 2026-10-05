// A real Vite-evaluated module: Node's strip-only TypeScript loader cannot evaluate
// the parameter property, and a second evaluation would create another singleton.
class TypedSingleton {
    constructor(readonly value: string) {}
}

export const singleton = new TypedSingleton('shared');
