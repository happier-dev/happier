import * as React from 'react';
import { Platform } from 'react-native';

/**
 * Which transcript message has its timestamp and actions opened on a touch host (a phone or a
 * coarse-pointer browser), where there is no hover. One message is open at a time: opening another
 * closes the previous one. On web a tap outside the open message or a touch drag (a scroll) closes it;
 * native closes it when the transcript list starts a drag (`closeTranscriptRowTouchActions`).
 *
 * The document listeners exist only while a message is open, so an idle transcript pays nothing.
 */
type OpenRow = Readonly<{ key: string; host: unknown }>;

let openRow: OpenRow | null = null;
const listeners = new Set<() => void>();
let detachDocumentDismissal: (() => void) | null = null;

function publish(next: OpenRow | null): void {
  if (openRow?.key === next?.key && openRow?.host === next?.host) return;
  openRow = next;
  detachDocumentDismissal?.();
  detachDocumentDismissal = next ? attachDocumentDismissal(next.host) : null;
  for (const listener of [...listeners]) listener();
}

function isDomNode(value: unknown): value is Node {
  return typeof Node !== 'undefined' && value instanceof Node;
}

function attachDocumentDismissal(host: unknown): (() => void) | null {
  if (Platform.OS !== 'web' || typeof document === 'undefined') return null;
  const onPointerDown = (event: Event) => {
    if (
      isDomNode(host) &&
      isDomNode(event.target) &&
      host.contains(event.target)
    )
      return;
    publish(null);
  };
  const onTouchMove = () => publish(null);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('touchmove', onTouchMove, {
    capture: true,
    passive: true,
  });
  return () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('touchmove', onTouchMove, true);
  };
}

/** Opens `key`'s actions (closing any other message's). `host` is the message's web element, for outside-tap dismissal. */
export function openTranscriptRowTouchActions(
  key: string,
  host?: unknown,
): void {
  publish({ key, host });
}

/** A tap on an open message closes it; on another message it opens that one. */
export function toggleTranscriptRowTouchActions(
  key: string,
  host?: unknown,
): void {
  publish(openRow?.key === key ? null : { key, host });
}

export function closeTranscriptRowTouchActions(): void {
  if (openRow !== null) publish(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether this message's actions are opened by touch. Only the closing and the opening row re-render. */
export function useTranscriptRowTouchOpened(key: string): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => openRow?.key === key,
    () => false,
  );
}

/**
 * Whether a tap on the message body should toggle its actions: not when it lands on a control inside the
 * message (a link, a button, a field) and not when the person just selected text.
 */
export function isTranscriptRowBodyTap(
  target: unknown,
  host: unknown,
): boolean {
  if (
    typeof window !== 'undefined' &&
    (window.getSelection?.()?.toString() ?? '') !== ''
  )
    return false;
  if (typeof Element === 'undefined' || !(target instanceof Element))
    return true;
  const control = target.closest(
    'a,button,input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="switch"],[role="menuitem"],[contenteditable="true"]',
  );
  return (
    control === null ||
    (isDomNode(host) && !host.contains(control)) ||
    control === host
  );
}

/**
 * Native: a tap on the message itself toggles its actions; a tap that a control inside the message takes (a link,
 * a chip, a button) only presses that control. React Native asks this host whether it wants the touch only when no
 * view inside it claimed the touch first. The host answers no, so it never holds the responder and child scrolling
 * stays free, and it remembers that the touch was its own. The gesture-handler Tap then toggles only such a touch.
 */
export function useTranscriptRowNativeTap(key: string | null) {
  const bodyTouch = React.useRef(false);
  const hostProps = React.useMemo(() => ({
    onStartShouldSetResponderCapture: () => {
      bodyTouch.current = false;
      return false;
    },
    onStartShouldSetResponder: () => {
      bodyTouch.current = true;
      return false;
    },
  }), []);
  const onTapEnd = React.useCallback((success: boolean) => {
    if (success && key !== null && bodyTouch.current) toggleTranscriptRowTouchActions(key);
    bodyTouch.current = false;
  }, [key]);
  return { hostProps, onTapEnd };
}
