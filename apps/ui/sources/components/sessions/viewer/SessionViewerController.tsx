import * as React from 'react';
import type { CurrentSessionPresentationIntentResultV1 } from '@happier-dev/protocol/sessions';
import type { FrameRect } from '@happier-dev/plugin-ui/presentation';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { BrowserPresenceCapsuleProps } from '@/components/browser/copresence/BrowserPresenceCapsule';
import type { ComputerTargetPickerRequest } from '@/components/computer/showComputerTargetPicker';

import type {
  SessionViewerLocalIntent,
  SessionViewerSemanticIntent,
  SessionViewerPresentationPort,
  SessionViewerPresentationState,
  SessionViewerSource,
} from './sessionViewerPresentation';

/**
 * What a mounted source body tells its presentation: identity for the floating controls and the
 * source's own operations, which stay the source owner's (picker, stop sharing). Never control,
 * capture or stream authority.
 */
export type SessionViewerSourceFacts = Readonly<{
  machineName: string | null;
  /** The person, not the Agent, holds input (the picture's ring says who drives). */
  personInControl: boolean;
  /**
   * The picture is only being watched (the Agent drives, or the person may not use it): it takes no
   * input from the person, so dragging it moves the viewer. Otherwise the picture's input is the
   * content's own and the viewer moves by its controls and grip.
   */
  watching?: boolean;
  /** The live picture's own width ÷ height, once the source reports it. */
  aspectRatio?: number | null;
  chooseTarget?: () => void;
  /** The same picker, read at the person's intent, for the viewer to anchor to its source switch. */
  resolveTargetPicker?: () => ComputerTargetPickerRequest | null;
  stopSharing?: () => void;
  /** The source's own navigation (the Browser's Back, Forward and Reload), offered in the view menu. */
  navigation?: SessionViewerSourceNavigation | null;
}>;

export type SessionViewerSourceNavigation = Readonly<{
  back: (() => void) | null;
  forward: (() => void) | null;
  reload: (() => void) | null;
}>;

/**
 * Who acts on the presented source and the one control that changes it, as the source's presence
 * owner states it. The viewer draws it below the picture; the owner keeps the takeover.
 */
export type SessionViewerPresence = Omit<BrowserPresenceCapsuleProps, 'testID' | 'compact' | 'placement'>;

/** Presence changes with every Agent step; only the leaf that draws it subscribes. */
export type SessionViewerPresenceStore = Readonly<{
  get: (source: SessionViewerSource) => SessionViewerPresence | null;
  set: (source: SessionViewerSource, presence: SessionViewerPresence | null) => void;
  subscribe: (listener: () => void) => () => void;
}>;

export function createSessionViewerPresenceStore(): SessionViewerPresenceStore {
  const bySource = new Map<SessionViewerSource, SessionViewerPresence>();
  const listeners = new Set<() => void>();
  return {
    get: (source) => bySource.get(source) ?? null,
    set(source, presence) {
      if ((bySource.get(source) ?? null) === presence) return;
      if (presence) bySource.set(source, presence);
      else bySource.delete(source);
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type SessionViewerController = Readonly<{
  state: SessionViewerPresentationState;
  phone: boolean;
  /** The Session's Home as its shell resolved it; every presentation qualifies the same slot. */
  serverId: string | null;
  /** Host-local dock, corner and size only; semantic UI choices use the Action front door. */
  apply: (
    intent: Exclude<SessionViewerLocalIntent, SessionViewerSemanticIntent>,
  ) => CurrentSessionPresentationIntentResultV1;
  requestSemantic: (intent: SessionViewerSemanticIntent) => Promise<ActionExecuteResult>;
  /** The exact mounted port the current-Session presentation bridge publishes. */
  port: SessionViewerPresentationPort;
  canPresentSource: (source: SessionViewerSource) => boolean;
  /** Settled local geometry; never transported or stored. */
  setRect: (rect: FrameRect | null) => void;
  facts: Readonly<
    Partial<Record<SessionViewerSource, SessionViewerSourceFacts>>
  >;
  publishFacts: (
    source: SessionViewerSource,
    facts: SessionViewerSourceFacts | null,
  ) => void;
  presence: SessionViewerPresenceStore;
  /** How far the reading column yields to a settled floating viewer, per side. */
  setReadingInset: (inset: Readonly<{ left: number; right: number }>) => void;
}>;

export const NO_SESSION_VIEWER_INSET = Object.freeze({ left: 0, right: 0 });
/** The mounted owner lives in `SessionViewerControllerProvider`; consumers read it through these hooks. */
export const SessionViewerControllerContext =
  React.createContext<SessionViewerController | null>(null);
/** Separate, so the transcript layer re-renders only when its yield changes, never on viewer facts. */
export const SessionViewerReadingInsetContext =
  React.createContext<Readonly<{ left: number; right: number }>>(NO_SESSION_VIEWER_INSET);


/** The reading column's yield to a settled floating viewer (zero when none). */
export function useSessionViewerReadingInset(): Readonly<{
  left: number;
  right: number;
}> {
  return React.useContext(SessionViewerReadingInsetContext);
}

/** Re-provides a captured controller where a retained body renders outside the Session tree. */
export function SessionViewerControllerScope(
  props: React.PropsWithChildren<
    Readonly<{ controller: SessionViewerController | null }>
  >,
) {
  return (
    <SessionViewerControllerContext.Provider value={props.controller}>
      {props.children}
    </SessionViewerControllerContext.Provider>
  );
}

export function useOptionalSessionViewerController(): SessionViewerController | null {
  return React.useContext(SessionViewerControllerContext);
}

/** Whether the viewer currently presents `source` itself (so a pane must not bind the same body). */
export function isSessionViewerPresenting(
  controller: SessionViewerController | null,
  source: SessionViewerSource,
): boolean {
  if (!controller || controller.state.source !== source) return false;
  const mode = controller.state.mode;
  return (
    mode === 'floating' ||
    mode === 'expanded' ||
    (controller.phone && mode === 'docked')
  );
}

/** A mounted body publishes its identity and owner operations while it is mounted. */
export function usePublishSessionViewerSourceFacts(
  source: SessionViewerSource,
  facts: SessionViewerSourceFacts | null,
): void {
  const controller = useOptionalSessionViewerController();
  const publish = controller?.publishFacts;
  const machineName = facts?.machineName ?? null;
  const personInControl = facts?.personInControl ?? false;
  const watching = facts?.watching ?? false;
  const aspectRatio = facts?.aspectRatio ?? null;
  const chooseTarget = facts?.chooseTarget;
  const resolveTargetPicker = facts?.resolveTargetPicker;
  const stopSharing = facts?.stopSharing;
  const navigation = facts?.navigation ?? null;
  const present = facts !== null;
  // A body that is not a viewer source (`null`) publishes nothing and never clears another's facts.
  React.useEffect(() => {
    if (!publish || !present) return undefined;
    publish(source, { machineName, personInControl, watching, aspectRatio, chooseTarget, resolveTargetPicker, stopSharing, navigation });
    return undefined;
  }, [
    aspectRatio,
    chooseTarget,
    resolveTargetPicker,
    machineName,
    navigation,
    personInControl,
    present,
    publish,
    source,
    stopSharing,
    watching,
  ]);
  React.useEffect(() => {
    if (!publish || !present) return undefined;
    return () => publish(source, null);
  }, [present, publish, source]);
}

/**
 * A presence owner hands the viewer what it would otherwise draw on the picture. `null`: this owner
 * is not the viewer's source and leaves the viewer's presence alone.
 */
export function usePublishSessionViewerPresence(
  source: SessionViewerSource,
  presence: SessionViewerPresence | null,
): void {
  const store = useOptionalSessionViewerController()?.presence;
  const present = presence !== null;
  React.useEffect(() => {
    if (presence) store?.set(source, presence);
  }, [presence, source, store]);
  React.useEffect(() => {
    if (!store || !present) return undefined;
    return () => store.set(source, null);
  }, [present, source, store]);
}

/** The presence the viewer draws below the picture, re-rendering only this leaf. */
export function useSessionViewerPresence(
  source: SessionViewerSource,
): SessionViewerPresence | null {
  const store = useOptionalSessionViewerController()?.presence ?? null;
  const subscribe = React.useCallback(
    (listener: () => void) => store?.subscribe(listener) ?? (() => {}),
    [store],
  );
  const read = React.useCallback(() => store?.get(source) ?? null, [source, store]);
  return React.useSyncExternalStore(subscribe, read, read);
}

/** Whether the source has a presence to draw, re-rendering only when that answer flips. */
export function useSessionViewerHasPresence(source: SessionViewerSource): boolean {
  const store = useOptionalSessionViewerController()?.presence ?? null;
  const subscribe = React.useCallback(
    (listener: () => void) => store?.subscribe(listener) ?? (() => {}),
    [store],
  );
  const read = React.useCallback(() => (store?.get(source) ?? null) !== null, [source, store]);
  return React.useSyncExternalStore(subscribe, read, read);
}

/**
 * Which presentation binds a retained source body: its pane, or the Session viewer (floating,
 * expanded or the phone's sticky slot). A body draws its own chrome and capsules only in its pane.
 */
const SessionViewerBodyPresentationContext = React.createContext<'pane' | 'viewer' | null>(null);

export function SessionViewerBodyPresentation(
  props: React.PropsWithChildren<Readonly<{ presentation: 'pane' | 'viewer' }>>,
): React.ReactElement {
  return (
    <SessionViewerBodyPresentationContext.Provider value={props.presentation}>
      {props.children}
    </SessionViewerBodyPresentationContext.Provider>
  );
}

export function useSessionViewerBodyPresentation(): 'pane' | 'viewer' | null {
  return React.useContext(SessionViewerBodyPresentationContext);
}
