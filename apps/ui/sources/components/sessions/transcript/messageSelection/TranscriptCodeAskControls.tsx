import * as React from 'react';
import { Platform } from 'react-native';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { usePaneMainColumn } from '@/components/appShell/panes/mainColumn/usePaneMainColumn';
import { AskSelectionControls } from '@/components/ui/code/selection/AskSelectionControls';
import type { AskSelection } from '@/components/ui/code/selection/useAskSelection';
import { normalizeExclusiveRangeEnd } from '@/components/ui/code/selection/domSelectionRange';
import { useWorkspaceScopeForSession } from '@/sync/domains/session/resolveWorkspaceScopeForSession';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { Modal } from '@/modal';
import { t } from '@/text';
import { readTranscriptPassageSelection, type TranscriptPassageSelection } from './transcriptPassageSelection';
import { annotateTranscriptPassage, captureTranscriptPassage, quoteTranscriptPassage, type CapturedTranscriptPassage } from './transcriptPassageActions';
import { TranscriptAnnotationPopover } from './TranscriptAnnotationPopover';

import { buildChatListNativeId } from '../chatListNativeId';

type DomNode = Readonly<{
  parentElement?: DomElement | null;
  nodeType?: number;
}>;
type DomElement = DomNode &
  Readonly<{
    id?: string;
    dataset?: Readonly<Record<string, string | undefined>>;
  }>;

function closestElement(
  node: DomNode | null | undefined,
  matches: (element: DomElement) => boolean,
): DomElement | null {
  let element: DomElement | null | undefined =
    node && node.nodeType === 1 ? (node as DomElement) : node?.parentElement;
  while (element) {
    if (matches(element)) return element;
    element = element.parentElement;
  }
  return null;
}

/**
 * The sole web selection owner for a Session: code keeps Ask, completed prose offers Quote/Annotate.
 * Both append through the mounted composer owner. One instance per Session view.
 */
export function TranscriptCodeAskControls(
  props: Readonly<{
    sessionId: string;
    serverId: string | null;
    scopeId: string;
    active: boolean;
  }>,
): React.ReactElement | null {
  const workspaceScope = useWorkspaceScopeForSession(
    Platform.OS === 'web' ? props.sessionId : '',
    props.serverId,
  );
  if (Platform.OS !== 'web' || typeof document === 'undefined') return null;
  return (
    <TranscriptCodeAskControlsContent
      {...props}
      workspaceScope={workspaceScope}
    />
  );
}

function TranscriptCodeAskControlsContent(
  props: Readonly<{
    sessionId: string;
    scopeId: string;
    active: boolean;
    workspaceScope: ReturnType<typeof useWorkspaceScopeForSession>;
  }>,
): React.ReactElement {
  const pane = useAppPaneScope(props.scopeId);
  const mainColumn = usePaneMainColumn();
  const accountLifetime = captureActiveServerAccountScopeLifetime();
  const [annotation, setAnnotation] = React.useState<Readonly<{ passage: CapturedTranscriptPassage;
    rect: AskSelection['rect'] }> | null>(null);
  // The transcript list's DOM id starts with this prefix (`buildChatListNativeId`).
  const listIdPrefix = buildChatListNativeId(props.sessionId, '').replace(
    /instance$/u,
    '',
  );
  const getSelection = React.useCallback((): AskSelection | null => {
    if (typeof window === 'undefined') return null;
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed)
      return null;
    const range = normalizeExclusiveRangeEnd(selection.getRangeAt(0));
    const isBlock = (element: DomElement) =>
      element.dataset?.happierCodeBlock === 'true';
    const block = closestElement(range.startContainer as DomNode, isBlock);
    if (
      !block ||
      block !== closestElement(range.endContainer as DomNode, isBlock)
    )
      return readTranscriptPassageSelection(selection, listIdPrefix);
    if (!props.workspaceScope) return null;
    if (
      !closestElement(
        block,
        (element) =>
          typeof element.id === 'string' && element.id.startsWith(listIdPrefix),
      )
    )
      return null;
    const text = selection.toString();
    if (text.trim().length === 0) return null;
    const start =
      Array.from(range.getClientRects()).find(
        (box) => box.width > 0 && box.height > 0,
      ) ?? range.getBoundingClientRect();
    return {
      startLine: 1,
      endLine: text.split('\n').length,
      text,
      rect: {
        x: start.left,
        y: start.top,
        width: start.width,
        height: start.height,
      },
    };
  }, [listIdPrefix, props.workspaceScope]);
  const subscribeSelection = React.useCallback((listener: () => void) => {
    document.addEventListener('selectionchange', listener);
    return () => document.removeEventListener('selectionchange', listener);
  }, []);
  const revealSessionColumn = React.useCallback(() => {
    if (mainColumn?.hidden) mainColumn.setHidden(false);
  }, [mainColumn]);
  const sessionTarget = React.useMemo(
    () => ({ sessionId: props.sessionId, revealSessionColumn }),
    [props.sessionId, revealSessionColumn],
  );
  const captured = React.useCallback((selection: AskSelection) => {
    if (!('source' in selection) || !accountLifetime?.isCurrent()) return null;
    return captureTranscriptPassage(selection.text, (selection as TranscriptPassageSelection).source,
      { kind: 'session', sessionId: props.sessionId });
  }, [accountLifetime, props.sessionId]);
  const quote = React.useCallback(async (selection: AskSelection) => {
    const passage = captured(selection);
    const ok = passage ? await quoteTranscriptPassage(passage) : false;
    if (ok) revealSessionColumn();
    else Modal.alert(t('common.error'), t('transcriptPassage.quoteError'));
    return ok;
  }, [captured, revealSessionColumn]);
  const actionsForSelection = React.useCallback((selection: AskSelection) => 'source' in selection ? [
    // Quote is what the selection's Ask shortcut runs on prose (`onAskSelection` below).
    { id: 'quote', label: t('transcriptPassage.quote'), icon: 'quotes' as const, primary: true, onPress: () => quote(selection) },
    { id: 'annotate', label: t('transcriptPassage.annotate'), icon: 'chat' as const, onPress: () => {
      const passage = captured(selection);
      if (passage) setAnnotation({ passage, rect: selection.rect });
      else Modal.alert(t('common.error'), t('transcriptPassage.quoteError'));
    } },
  ] : null, [captured, quote]);
  return (
    <>
    <AskSelectionControls
      scopeId={props.scopeId}
      workspaceScope={props.workspaceScope}
      source="transcript"
      getSelection={getSelection}
      subscribeSelection={subscribeSelection}
      sessionTarget={sessionTarget}
      openDetailsTab={pane.openDetailsTab}
      active={props.active}
      accountLifetime={accountLifetime}
      onAskSelection={(selection) => 'source' in selection ? quote(selection) : null}
      actionsForSelection={actionsForSelection}
      testID="transcript-code-selection-toolbar"
    />
    {annotation ? <TranscriptAnnotationPopover quote={annotation.passage.quote} anchor={annotation.rect}
      onSave={async (note) => {
        if (!props.active) return false;
        const ok = await annotateTranscriptPassage(annotation.passage, note);
        if (ok) revealSessionColumn();
        return ok;
      }} onCancel={() => setAnnotation(null)} /> : null}
    </>
  );
}
