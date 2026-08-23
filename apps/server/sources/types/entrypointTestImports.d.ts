/**
 * Vitest uses this query only to give executable-entrypoint imports a fresh Vite
 * module identity. Vite resolves it at runtime; TypeScript needs the matching
 * declaration while typechecking those tests.
 */
declare module '*?entrypoint-test' {}
