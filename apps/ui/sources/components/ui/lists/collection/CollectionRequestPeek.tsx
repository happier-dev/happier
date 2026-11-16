import * as React from 'react';
import { Platform, View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { useHoverPreviewPopover } from '@/components/ui/popover/useHoverPreviewPopover';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import {
  readPressFocusReturnTarget,
  type FocusReturnTarget,
} from '@/keyboard/focusReturn';
import { t } from '@/text';

import { CollectionRequestPeekBody } from './CollectionRequestPeekBody';
import type { CollectionSessionRequestPeekState } from './CollectionSessionRequestPeekData';
import { collectionRequestRefKey, type CollectionRequestRef } from './collectionRequestRef';
import { useCollectionRequestPeek } from './useCollectionRequestPeek';

const PEEK_WIDTH_PX = 360;
const PEEK_MAX_HEIGHT_PX = 520;

/**
 * The request peek (lab `clstatus` "the slot answers"): a row's amber status slot opens the request itself,
 * anchored to the slot, so it can be answered without leaving the list. The pointer resting on the slot
 * previews it after the popover rest delay (without taking focus); a click, a key or a long-press opens it
 * with focus inside. On a phone the same body opens in the sheet. The body is the request's own presenter
 * (`CollectionRequestPeekBody`), mounted only while open; this owns the overlay, never the answer.
 */
export function CollectionRequestPeek(
  props: Readonly<{
    request: CollectionRequestRef;
    /** The slot is on screen (a hidden or recycled row retires its disclosure). */
    presented?: boolean;
    /** What the request is about, for the mounted command's description (the row's title). */
    description?: string;
    testID: string;
    /** The status glyph the slot draws. */
    children: React.ReactNode;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const presented = useLayoutPresentationActive() && props.presented !== false;
  const sourceKey = collectionRequestRefKey(props.request);
  const [replacement, setReplacement] =
    React.useState<CollectionRequestRef | null>(null);
  // A row whose request changes starts fresh: a replacement never inherits an earlier review.
  React.useLayoutEffect(() => {
    setReplacement(null);
  }, [sourceKey]);
  const request = replacement ?? props.request;
  const requestKey = collectionRequestRefKey(request);
  const peek = useCollectionRequestPeek(
    request,
    presented,
    props.description,
  );
  const {
    mode: hoverMode,
    open: openHover,
    close: closeHover,
    hoverProps,
    panelHoverProps,
    popoverLayer,
  } = useHoverPreviewPopover({ enabled: Platform.OS === 'web' && presented });
  const anchorRef = React.useRef<View>(null);
  const focusReturnRef = React.useRef<FocusReturnTarget>(null);
  const open = peek.open;

  // Pointer intent never grants disclosure. Recycling/hiding the request also cancels pending intent.
  React.useLayoutEffect(() => { closeHover(); }, [closeHover, requestKey, presented]);
  React.useLayoutEffect(() => { if (!open) closeHover(); }, [closeHover, open]);

  // Hover only times the pointer's intent; the request's own disclosure (and its mounted command) stays
  // with `useCollectionRequestPeek`, so an agent or a key opening it shows the same peek. A preview the
  // pointer leaves closes that disclosure with it.
  const { show, dismiss } = peek;
  const previousHoverModeRef = React.useRef({ requestKey, mode: hoverMode });
  React.useEffect(() => {
    const previous = previousHoverModeRef.current;
    previousHoverModeRef.current = { requestKey, mode: hoverMode };
    if (previous.requestKey !== requestKey || previous.mode === hoverMode) return;
    if (hoverMode === 'preview') void show().then(admitted => { if (!admitted) closeHover(); });
    else if (hoverMode === 'closed' && previous.mode === 'preview') void dismiss();
  }, [closeHover, dismiss, hoverMode, requestKey, show]);
  const close = React.useCallback(() => {
    closeHover();
    void dismiss();
  }, [closeHover, dismiss]);
  const retire = React.useCallback(() => {
    closeHover();
    peek.onRetire();
  }, [closeHover, peek.onRetire]);
  const onPress = React.useCallback(
    (event?: unknown) => {
      focusReturnRef.current = readPressFocusReturnTarget(event);
      if (open && hoverMode !== 'preview') {
        close();
        return;
      }
      openHover();
      void show().then(admitted => { if (!admitted) closeHover(); });
    },
    [close, closeHover, hoverMode, open, openHover, show],
  );

  const renderState = React.useCallback(
    (
      state: Exclude<CollectionSessionRequestPeekState, { kind: 'current' }>,
    ) => <PeekState state={state} onReviewReplacement={setReplacement} />,
    [],
  );

  return (
    <View
      ref={anchorRef}
      collapsable={false}
      style={styles.anchor}
      {...(!open || hoverMode === 'preview' ? hoverProps : null)}
    >
      <HappierPressable
        testID={props.testID}
        accessibilityRole="button"
        accessibilityLabel={t('sessionsList.reviewRequest')}
        expanded={open}
        hasPopup="dialog"
        onPress={onPress}
        onLongPress={onPress}
        // The glyph keeps its drawn size; the shared pressable owns the hit area around it.
        style={styles.trigger}
      >
        {props.children}
      </HappierPressable>
      {open ? (
        <Popover
          open
          anchorRef={anchorRef}
          focusReturnRef={focusReturnRef}
          autoFocusOnOpen={hoverMode !== 'preview'}
          layer={popoverLayer}
          // Beside the row, from its trailing slot (lab `clicon` peek): the peek opens into the pane next to
          // the list, top-aligned with its row, so it never lies over the rows and group labels above it.
          placement="right"
          // The window, not the list's pane, bounds the peek: it belongs beside the column.
          boundaryRef={null}
          gap={6}
          edgePadding={{ horizontal: 8, vertical: 8 }}
          portal={{
            web: true,
            native: true,
            matchAnchorWidth: false,
            anchorAlign: 'start',
            anchorAlignVertical: 'start',
          }}
          maxWidthCap={PEEK_WIDTH_PX}
          maxHeightCap={PEEK_MAX_HEIGHT_PX}
          phonePresentation="sheet"
          accessibilityLabel={t('sessionsList.reviewRequest')}
          onRequestClose={close}
        >
          {({ maxHeight, maxWidth }) => (
            <View testID={`${props.testID}:peek`} {...panelHoverProps}>
              <FloatingOverlay
                maxHeight={Math.min(maxHeight, PEEK_MAX_HEIGHT_PX)}
                edgeFades={{ top: true, bottom: true, size: 18 }}
                edgeIndicators
                surfaceChrome="theme"
                keyboardShouldPersistTaps="always"
                containerStyle={{ width: Math.min(maxWidth, PEEK_WIDTH_PX) }}
              >
                <View style={[styles.body, { padding: theme.space.s8 }]}>
                  <CollectionRequestPeekBody
                    request={request}
                    open
                    onDismiss={close}
                    onRetire={retire}
                    renderState={renderState}
                  />
                </View>
              </FloatingOverlay>
            </View>
          )}
        </Popover>
      ) : null}
    </View>
  );
}

/** A request that is not answerable here says why, once, and offers the one next step. */
export function PeekState(
  props: Readonly<{
    state: Exclude<CollectionSessionRequestPeekState, { kind: 'current' }>;
    onReviewReplacement: (ref: CollectionRequestRef) => void;
  }>,
): React.ReactElement {
  const state = props.state;
  const replaced = state.kind === 'replaced' ? state.replacement : null;
  const reviewKey = replaced ? `request.reviewReplacement:${collectionRequestRefKey(replaced)}` : '';
  const commands = useCurrentUiContextLocalCommands(React.useMemo(() => replaced ? [{
    key: reviewKey, title: t('sessionsList.requestPeekReviewNew'),
    invoke: () => { props.onReviewReplacement(replaced); },
  }] : [], [props.onReviewReplacement, replaced, reviewKey]));
  // Every state is the one shared inline notice (OWNER-UI-1115B A2): its sentence, with the one next step inline.
  if (state.kind === 'loading') {
    return (
      <SurfaceStateCard
        testID="collection-request-peek.loading"
        size="line"
        kind="loading"
        title={t('sessionsList.requestPeekLoading')}
      />
    );
  }
  const retry = 'retry' in state ? state.retry : undefined;
  if (replaced) {
    return (
      <SurfaceStateCard
        testID="collection-request-peek.replaced"
        size="line"
        kind="warning"
        title={t('sessionsList.requestPeekReplaced')}
        action={{
          label: t('sessionsList.requestPeekReviewNew'),
          invitation: true,
          onPress: () => { void commands.invoke(reviewKey); },
        }}
      />
    );
  }
  if (state.kind === 'settled') {
    return (
      <SurfaceStateCard
        testID="collection-request-peek.settled"
        size="line"
        kind="empty"
        title={t('sessionsList.requestPeekAnswered')}
      />
    );
  }
  return (
    <SurfaceStateCard
      testID={`collection-request-peek.${state.kind}`}
      size="line"
      kind="unavailable"
      title={t('sessionsList.requestPeekUnavailable')}
      {...(state.kind === 'unavailable' && retry ? { action: {
        label: t('common.retry'),
        onPress: () => retry(),
        testID: 'collection-request-peek.retry',
      } } : {})}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  anchor: {
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trigger: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.borderRadius.sm,
  },
  body: {
    minWidth: 0,
  },
}));
