import * as React from 'react';

/**
 * Cross-copy identity for the Triage seams a source detail reads from its
 * mounted Triage parent (evidence disclosure, post-mutation completion, panel
 * navigation).
 *
 * Both halves of those seams are ordinary React contexts, and both sides sit in
 * ONE React tree: the aggregate renders `TargetedSurface`, whose host bridge
 * returns the source's element inline. What is not one is the module graph.
 * `PLUGIN_UI_HOST_RUNTIME_EXTERNAL_SPECIFIERS` host-provides only React, its JSX
 * runtimes, `react-native-web` and the SDK UI client, so every plugin artifact
 * carries its OWN bundled copy of this package. `React.createContext` called in
 * the Triage copy and `React.useContext` called in the Sentry copy therefore
 * name different context objects, and the reader silently gets the default:
 * an evidence control that hides itself, and a mutation whose aggregate re-read
 * never runs.
 *
 * The repair is identity, not topology. The seams keep their exact shape, the
 * value still travels through the mounted parent's React tree, and unmounting
 * that parent still returns the source to the inert default — nothing is stored
 * here. Only the context OBJECT is agreed on, through the same cooperative
 * `Symbol.for` marker the SDK bootstrap and bundled Plugin UI already use to
 * meet across copies. Making the host provide this package instead would need a
 * Triage-specific runtime external, which is a host branch for one feature's
 * benefit; carrying the interaction through the public mounted contract would
 * change an approved contract to fix a build-shape defect.
 *
 * Keys are versioned with the value contract they carry: a later incompatible
 * disclosure or completion shape takes a new key rather than reinterpreting
 * this one, so two artifacts built against different releases cannot meet on a
 * context whose value they read differently.
 */

const globalScope = globalThis as typeof globalThis & Record<symbol, unknown>;

/**
 * Read from the running React rather than hard-coding `react.context`: the
 * marker is only a rendezvous, and a React whose brand this copy cannot confirm
 * must fall back to a module-local context instead of trusting a foreign value.
 */
const REACT_CONTEXT_BRAND: unknown = Reflect.get(
  React.createContext<null>(null) as unknown as object,
  '$$typeof',
);

function isReactContext(value: unknown): value is React.Context<unknown> {
  return typeof value === 'object'
    && value !== null
    && Reflect.get(value, '$$typeof') === REACT_CONTEXT_BRAND;
}

/**
 * The one context instance every loaded copy of this package agrees on for
 * `key`. The first copy to ask publishes it; every later copy adopts it.
 */
export function resolveTriageCrossCopyContext<T>(key: symbol, defaultValue: T): React.Context<T> {
  const published = globalScope[key];
  if (isReactContext(published)) return published as React.Context<T>;

  const context = React.createContext(defaultValue);
  globalScope[key] = context;
  return context;
}
