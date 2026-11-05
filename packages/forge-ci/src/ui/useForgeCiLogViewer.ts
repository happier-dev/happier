import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { FindSurfaceRegistration } from '@happier-dev/plugin-ui/components';
import { useFindSurfaceRegistration, usePluginSurfaceActivity } from '@happier-dev/plugin-ui/hostApi';
import type { ForgeCiLogIndexV1, ForgeCiLogLineV1, LogIndexV1 } from '../runtime/logs/index.js';
import { selectLogLinesV1 } from '../runtime/logs/selection.js';
import { createLogFindControllerV1, type ForgeCiLogFindControllerV1, type ForgeCiLogFindSnapshotV1,
  type LogFindControllerV1, type LogFindSnapshotV1 } from './findController.js';
import { adaptForgeCiLogViewV1, type ForgeCiMountedViewStateV1, type ForgeCiMountedViewV1,
  type LogViewStateV1, type LogViewV1 } from './mountedCiIntent.js';

export type LogViewerControlsV1 = Readonly<{
  view: LogViewV1; surfaceId: string; containsFocus(): boolean; isInputFocused(): boolean;
  onRevealLine?: (line: ForgeCiLogLineV1) => void; onCloseFind?: () => void;
}>;
export type LogViewerInputV1<Index extends LogIndexV1 = LogIndexV1> = LogViewerControlsV1 & Readonly<{
  index: Index; active: boolean; partialErrors?: boolean;
}>;
export type LogViewerModelV1<Index extends LogIndexV1 = LogIndexV1> = Readonly<{
  index: Index; lines: readonly ForgeCiLogLineV1[]; viewState: LogViewStateV1 | null;
  timestampsVisible: boolean | null; available: boolean;
  find: LogFindControllerV1<Index>; findSnapshot: LogFindSnapshotV1<Index>;
  findRegistration: FindSurfaceRegistration | null;
  getLineRanges: LogFindControllerV1<Index>['getLineRanges']; revealLine: LogFindControllerV1<Index>['revealLine'];
}>;
const EMPTY_LINES: readonly ForgeCiLogLineV1[] = Object.freeze([]);
const noSubscription = () => () => {};
const noSnapshot = () => null;

export type ForgeCiLogViewerInputV1 = Readonly<{
  index: ForgeCiLogIndexV1;
  view: ForgeCiMountedViewV1;
  surfaceId: string;
  containsFocus(): boolean;
  isInputFocused(): boolean;
  onRevealLine?: (line: ForgeCiLogLineV1) => void;
  onCloseFind?: () => void;
  partialErrors?: boolean;
}>;

export type ForgeCiLogViewerModelV1 = Readonly<{
  index: ForgeCiLogIndexV1;
  lines: readonly ForgeCiLogLineV1[];
  viewState: ForgeCiMountedViewStateV1 | null;
  timestampsVisible: boolean | null;
  available: boolean;
  find: ForgeCiLogFindControllerV1;
  findSnapshot: ForgeCiLogFindSnapshotV1;
  findRegistered: boolean;
  getLineRanges: ForgeCiLogFindControllerV1['getLineRanges'];
  revealLine: ForgeCiLogFindControllerV1['revealLine'];
}>;

/** Controlled data only: the host owns Find registration and the UI lane owns rendering/virtualization. */
export function useForgeCiLogViewerV1(input: ForgeCiLogViewerInputV1): ForgeCiLogViewerModelV1 {
  const { active } = usePluginSurfaceActivity();
  const view = useMemo(() => adaptForgeCiLogViewV1(input.view, () => input.index.job), [input.view, input.index.sourceKey]);
  const model = useLogViewerV1({ ...input, active, view });
  const findRegistered = useFindSurfaceRegistration(model.findRegistration);
  return { ...model, viewState: input.view.getSnapshot(), findRegistered };
}

export function useLogViewerV1<Index extends LogIndexV1>(input: LogViewerInputV1<Index>): LogViewerModelV1<Index>;
export function useLogViewerV1<Index extends LogIndexV1>(input: Omit<LogViewerInputV1<Index>, 'index'> & Readonly<{ index: Index | null }>): LogViewerModelV1<Index> | null;
/** Native and plugin hosts supply activity and register Find with their incumbent physical host. */
export function useLogViewerV1<Index extends LogIndexV1>(input: Omit<LogViewerInputV1<Index>, 'index'> & Readonly<{ index: Index | null }>): LogViewerModelV1<Index> | null {
  const latest = useRef(input);
  latest.current = input;
  const find = useMemo(() => input.index === null ? null : createLogFindControllerV1({
    index: input.index, view: input.view,
    onRevealLine: line => latest.current.onRevealLine?.(line),
    onClose: () => latest.current.onCloseFind?.(),
  }), [input.view, input.index?.logId, input.index?.sourceKey, input.index?.positionBasis]);
  const findSnapshot = useSyncExternalStore(find?.subscribe ?? noSubscription, find?.getSnapshot ?? noSnapshot, find?.getSnapshot ?? noSnapshot);
  const viewState = useSyncExternalStore(input.view.subscribe, input.view.getSnapshot, input.view.getSnapshot);
  const lines = useMemo(() => {
    if (!findSnapshot) return EMPTY_LINES;
    const projection = selectLogLinesV1(findSnapshot.index, viewState?.selection ?? { kind: 'all' });
    return projection.kind === 'value' ? projection.lines : EMPTY_LINES;
  }, [findSnapshot?.index, viewState?.selection]);
  useEffect(() => {
    if (input.index) find?.setIndex(input.index, { partialErrors: input.partialErrors === true });
  }, [find, input.index, input.partialErrors]);
  useEffect(() => () => { find?.refold(); }, [find]);
  const available = input.active && viewState !== null && find !== null && input.view.isAvailable?.() !== false;
  const registration = useMemo<FindSurfaceRegistration | null>(() => available && find ? {
    surfaceId: input.surfaceId,
    controller: find,
    containsFocus: () => latest.current.containsFocus(),
    isInputFocused: () => latest.current.isInputFocused(),
    open: () => find.open(),
    isOpen: () => find.getSnapshot().isOpen,
    isAvailable: () => latest.current.active && latest.current.view.getSnapshot() !== null
      && latest.current.view.isAvailable?.() !== false && latest.current.index !== null,
  } : null, [find, input.surfaceId, available]);
  if (!find || !findSnapshot) return null;
  return {
    index: findSnapshot.index,
    lines,
    viewState,
    timestampsVisible: viewState?.timestampsVisible ?? null,
    available,
    find,
    findSnapshot,
    findRegistration: registration,
    getLineRanges: find.getLineRanges,
    revealLine: find.revealLine,
  };
}
