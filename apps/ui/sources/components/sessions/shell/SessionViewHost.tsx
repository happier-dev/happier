// Native presentation remains synchronous and shares the incumbent component identity.
export { SessionView } from './SessionView';

/** Native bundles the view synchronously, so a route has nothing to start early. */
export function preloadSessionView(): void {}
