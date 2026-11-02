import * as React from 'react';

/**
 * Header projection only: a mounted body lends the one quiet fact that names what it shows ("Tokens by
 * agent · last 30 days") to its nearest shared frame. The placement still decides precedence (a
 * followed group value wins), and the body never renders a second header.
 */
export const WidgetFrameBodyCaptionContext = React.createContext<
  ((caption: string | null) => void) | null
>(null);

export function useWidgetFrameBodyCaption(caption: string | null): void {
  const lend = React.useContext(WidgetFrameBodyCaptionContext);
  React.useEffect(() => {
    lend?.(caption);
    return () => lend?.(null);
  }, [caption, lend]);
}

/**
 * The same lending for the header's meta slot: a mounted body's one live fact ("1 needs you",
 * "2 working"), at the frame's end. Pass an identity-stable node: a new one re-lends it.
 */
export const WidgetFrameBodyMetaContext = React.createContext<
  ((meta: React.ReactNode) => void) | null
>(null);

export function useWidgetFrameBodyMeta(meta: React.ReactNode): void {
  const lend = React.useContext(WidgetFrameBodyMetaContext);
  React.useEffect(() => {
    lend?.(meta);
    return () => lend?.(null);
  }, [meta, lend]);
}

/**
 * The same lending for the footer: a mounted body names the page it comes from and opens it ("Tasks"), so the
 * frame's one footer link reads "Open Tasks" and leads to everything the glance leaves out. The frame itself
 * provides it, on every placement, and keeps a failed refresh or a pending change in that row first. Pass an
 * identity-stable value: a new one re-lends it.
 */
export type WidgetFrameBodyOpen = Readonly<{ destination: string; onPress: () => void }>;
export const WidgetFrameBodyOpenContext = React.createContext<
  ((open: WidgetFrameBodyOpen | null) => void) | null
>(null);

export function useWidgetFrameBodyOpen(open: WidgetFrameBodyOpen | null): void {
  const lend = React.useContext(WidgetFrameBodyOpenContext);
  React.useEffect(() => {
    lend?.(open);
    return () => lend?.(null);
  }, [open, lend]);
}

/**
 * The host's one sentence (and, when no Machine exists, its next step) about a body that cannot reach the Machine it runs on ("This operation is
 * unavailable on Studio Mac. Reconnect it or choose another machine with Run on."). The mount that
 * was refused lends how to word it now (`undefined` once the Machine answers again), and the shared
 * widget surface says it once, whichever plugin the widget is.
 */
export type WidgetFrameBodyNotice = Readonly<{
  sentence: string;
  /** No Machine exists to run it, so retrying cannot help: the way forward is adding one. */
  addMachine?: true;
  /** Machines exist but none runs this plugin: retrying cannot help, so the way forward is the plugin's own page. */
  managePluginId?: string;
}>;
export type WidgetFrameBodyNoticeSource = () => WidgetFrameBodyNotice | undefined;
export const WidgetFrameBodyNoticeContext = React.createContext<
  ((notice: WidgetFrameBodyNoticeSource | null) => void) | null
>(null);
