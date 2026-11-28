import * as React from 'react';

/**
 * The launch curtain: the one Loading planet a cold web start shows, from the HTML shell's Still frame until
 * the first destination has drawn. Every surface that is still loading at launch (boot, Account restore, a
 * pane or Home still coming, the opening still preparing) holds it while it is mounted; the curtain leaves
 * once nothing holds it across a painted frame, and never comes back for this page.
 *
 * The HTML shell starts it: `public/index.html` marks the document with `launch-planet` and paints the
 * Still frame on `#root` until the curtain has gone.
 */
export type LaunchCurtainState = 'up' | 'leaving' | 'gone';

const POSTER_CLASS = 'launch-planet';
// Read from the document on first use: the shell's class is the curtain's start.
let state: LaunchCurtainState | null = null;
let holds = 0;
let pendingRelease: number | null = null;
const listeners = new Set<() => void>();

function current(): LaunchCurtainState {
  state ??=
    typeof document !== 'undefined' &&
    document.documentElement.classList.contains(POSTER_CLASS)
      ? 'up'
      : 'gone';
  return state;
}

function publish(next: LaunchCurtainState) {
  state = next;
  for (const listener of listeners) listener();
}

/** The HTML shell's CSS breath (`public/index.html`), shared with the live Loading planet so both breathe as one. */
const SHELL_BREATH_ANIMATION = 'launch-planet-breath';

/**
 * How far the HTML shell's breath has run, in seconds: the live Loading planet starts its own clock there, so the
 * hand-off from the shell's still image to the live planet keeps the breath's phase. 0 without a running breath
 * (reduced motion, a host without Web Animations).
 */
export function readLaunchShellBreathS(): number {
  if (typeof document === 'undefined' || typeof document.getAnimations !== 'function') return 0;
  let elapsedMs = 0;
  for (const animation of document.getAnimations()) {
    if ((animation as Partial<CSSAnimation>).animationName !== SHELL_BREATH_ANIMATION) continue;
    elapsedMs = Math.max(elapsedMs, Number(animation.currentTime) || 0);
  }
  return elapsedMs / 1000;
}

/** Holds the curtain while the caller is still loading. A curtain that has started leaving is not held back. */
export function holdLaunchCurtain(): () => void {
  if (current() !== 'up') return () => {};
  holds++;
  if (pendingRelease !== null) {
    cancelAnimationFrame(pendingRelease);
    pendingRelease = null;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
    if (holds > 0 || current() !== 'up') return;
    // A loading surface hands over to the next one in the same commit, or in the commit its layout
    // effects schedule: leave only when no holder has taken over across the next painted frame.
    pendingRelease = requestAnimationFrame(() => {
      pendingRelease = requestAnimationFrame(() => {
        pendingRelease = null;
        if (holds === 0 && current() === 'up') publish('leaving');
      });
    });
  };
}

/** The curtain has faded out (or this window never shows one): the shell's Still frame goes with it. */
export function finishLaunchCurtain(): void {
  if (pendingRelease !== null) cancelAnimationFrame(pendingRelease);
  pendingRelease = null;
  if (typeof document !== 'undefined')
    document.documentElement.classList.remove(POSTER_CLASS);
  if (current() !== 'gone') publish('gone');
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let mountedBodyPathname: string | null | undefined;
/** The addressed destination is on screen and can own the remainder of its launch. */
export function markLaunchDestinationBodyMounted(pathname: string | null = null): void {
  if (state === 'leaving' || state === 'gone' || mountedBodyPathname === pathname) return;
  mountedBodyPathname = pathname;
  for (const listener of listeners) listener();
}
export function useMarkLaunchDestinationBodyMounted(presented: boolean, pathname?: string): void {
  React.useLayoutEffect(() => {
    if (presented) markLaunchDestinationBodyMounted(pathname);
  }, [pathname, presented]);
}
export function useLaunchDestinationBodyMounted(pathname?: string): boolean {
  const read = () => pathname === undefined ? mountedBodyPathname !== undefined : mountedBodyPathname === pathname;
  return React.useSyncExternalStore(subscribe, read, read);
}

export function useLaunchCurtainState(): LaunchCurtainState {
  return React.useSyncExternalStore(subscribe, current, current);
}

/** Holds the launch curtain while `active` (a surface that is still loading). */
export function useLaunchCurtainHold(active: boolean): void {
  React.useLayoutEffect(
    () => (active ? holdLaunchCurtain() : undefined),
    [active],
  );
}
