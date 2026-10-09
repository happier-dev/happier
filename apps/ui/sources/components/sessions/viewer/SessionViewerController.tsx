import * as React from 'react';
import type { CurrentSessionPresentationIntentResultV1 } from '@happier-dev/protocol/sessions';
import type { FrameRect } from '@happier-dev/plugin-ui/presentation';

import {
  CLOSED_SESSION_VIEWER,
  resolveSessionViewerPresentation,
  type SessionViewerLocalIntent,
  type SessionViewerPresentationPort,
  type SessionViewerPresentationState,
  type SessionViewerSource,
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
  chooseTarget?: () => void;
  stopSharing?: () => void;
}>;

export type SessionViewerController = Readonly<{
  state: SessionViewerPresentationState;
  phone: boolean;
  /** The Session's Home as its shell resolved it; every presentation qualifies the same slot. */
  serverId: string | null;
  /** Semantic intents (the public Action subset) and host-local geometry intents. */
  apply: (
    intent: SessionViewerLocalIntent,
  ) => CurrentSessionPresentationIntentResultV1;
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
  /** How far the reading column yields to a settled floating viewer, per side. */
  setReadingInset: (inset: Readonly<{ left: number; right: number }>) => void;
}>;

const NO_INSET = Object.freeze({ left: 0, right: 0 });
const SessionViewerControllerContext =
  React.createContext<SessionViewerController | null>(null);
/** Separate, so the transcript layer re-renders only when its yield changes, never on viewer facts. */
const SessionViewerReadingInsetContext =
  React.createContext<Readonly<{ left: number; right: number }>>(NO_INSET);

/**
 * The one mounted viewer presentation owner for a Session: which source is presented and how
 * (floating, expanded, docked, closed), plus the local geometry. It lives for the mounted Session
 * and is retired with it; target selection, control and stream lifetime stay with their owners.
 */
export function SessionViewerControllerProvider(
  props: React.PropsWithChildren<
    Readonly<{
      phone: boolean;
      serverId: string | null;
      canPresentSource: (source: SessionViewerSource) => boolean;
      /** Desktop dock: the pane presentation of the same retained body. */
      openDocked: (source: SessionViewerSource) => void;
    }>
  >,
): React.ReactElement {
  const [state, setState] = React.useState<SessionViewerPresentationState>(
    CLOSED_SESSION_VIEWER,
  );
  const [facts, setFacts] = React.useState<SessionViewerController['facts']>(
    {},
  );
  const [readingInset, setReadingInsetState] =
    React.useState<Readonly<{ left: number; right: number }>>(NO_INSET);
  const stateRef = React.useRef(state);
  const inputRef = React.useRef(props);
  inputRef.current = props;

  const apply = React.useCallback((intent: SessionViewerLocalIntent) => {
    const { phone, canPresentSource, openDocked } = inputRef.current;
    const next = resolveSessionViewerPresentation(stateRef.current, intent, {
      phone,
      canPresentSource,
    });
    if (next.result.status === 'applied') {
      stateRef.current = next.state;
      setState(next.state);
      if (!phone && intent.kind === 'viewer.dock' && next.state.source)
        openDocked(next.state.source);
    } else if (
      next.result.status === 'unchanged' &&
      !phone &&
      intent.kind === 'viewer.open' &&
      next.state.mode === 'docked'
    ) {
      // Docked on desktop means its pane presents it: reopening reveals that pane again.
      openDocked(intent.source);
    }
    return next.result;
  }, []);
  const setRect = React.useCallback((rect: FrameRect | null) => {
    const current = stateRef.current;
    if (current.rect === rect) return;
    stateRef.current = {
      ...current,
      rect,
      width: rect?.width ?? current.width,
    };
    setState(stateRef.current);
  }, []);
  const publishFacts = React.useCallback(
    (source: SessionViewerSource, next: SessionViewerSourceFacts | null) => {
      setFacts((current) => {
        if (!next) {
          if (!current[source]) return current;
          const { [source]: _removed, ...rest } = current;
          return rest;
        }
        const previous = current[source];
        if (
          previous &&
          previous.machineName === next.machineName &&
          previous.personInControl === next.personInControl &&
          previous.chooseTarget === next.chooseTarget &&
          previous.stopSharing === next.stopSharing
        )
          return current;
        return { ...current, [source]: next };
      });
    },
    [],
  );
  const setReadingInset = React.useCallback(
    (inset: Readonly<{ left: number; right: number }>) => {
      setReadingInsetState((current) =>
        current.left === inset.left && current.right === inset.right
          ? current
          : inset,
      );
    },
    [],
  );
  const port = React.useMemo<SessionViewerPresentationPort>(
    () => ({ apply }),
    [apply],
  );
  const canPresentSource = props.canPresentSource;
  const value = React.useMemo<SessionViewerController>(
    () => ({
      state,
      phone: props.phone,
      serverId: props.serverId,
      apply,
      port,
      canPresentSource,
      setRect,
      facts,
      publishFacts,
      setReadingInset,
    }),
    [
      apply,
      canPresentSource,
      facts,
      port,
      props.phone,
      props.serverId,
      publishFacts,
      setReadingInset,
      setRect,
      state,
    ],
  );
  const effectiveInset = state.mode === 'floating' ? readingInset : NO_INSET;
  return (
    <SessionViewerControllerContext.Provider value={value}>
      <SessionViewerReadingInsetContext.Provider value={effectiveInset}>
        {props.children}
      </SessionViewerReadingInsetContext.Provider>
    </SessionViewerControllerContext.Provider>
  );
}

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
  const chooseTarget = facts?.chooseTarget;
  const stopSharing = facts?.stopSharing;
  const present = facts !== null;
  React.useEffect(() => {
    if (!publish) return undefined;
    publish(
      source,
      present
        ? { machineName, personInControl, chooseTarget, stopSharing }
        : null,
    );
    return undefined;
  }, [
    chooseTarget,
    machineName,
    personInControl,
    present,
    publish,
    source,
    stopSharing,
  ]);
  React.useEffect(() => () => publish?.(source, null), [publish, source]);
}
