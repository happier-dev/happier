/**
 * Lazy undici for runtime paths that must not pay its load cost at startup.
 *
 * The shipped bundle wraps undici as CommonJS, so a bundled `import('undici')` exposes
 * only `default`; Node source also exposes named exports. `default` carries every export
 * in both shapes, and a named export wins when a runtime provides one.
 *
 * The specifier names the declared package's physical entry. Bun maps a bare `undici`
 * to its builtin even when this package is installed; that builtin's Agent has no
 * close/destroy and its fetch ignores the dispatcher (socket path, timeouts, connector).
 * Bundlers inline the same file, and Node resolves it identically (undici has no
 * `exports` map).
 */
export async function loadUndici() {
  const namespace = await import('undici/index.js');
  return { ...namespace.default, ...namespace };
}
