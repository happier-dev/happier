import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';

import {
  useSessionComposerInputCaps,
  type SessionComposerInputExpansionState,
} from './useSessionComposerInputCaps';

type SessionComposerColumnValue = Readonly<{
  caps: ReturnType<typeof useSessionComposerInputCaps>;
  reportCardsContentHeight: (height: number) => void;
  reportTextlessHeight: (height: number) => void;
}>;

const SessionComposerColumnContext =
  React.createContext<SessionComposerColumnValue | null>(null);

/** The Session's own notices (a failed start, access) join the composer's card stack when a composer is shown. */
export const SessionComposerNoticesContext =
  React.createContext<React.ReactNode>(null);

function useReportedHeight(): readonly [number, (height: number) => void] {
  const [height, setHeight] = React.useState(0);
  const report = React.useCallback((next: number) => {
    const rounded = Number.isFinite(next) ? Math.max(0, Math.round(next)) : 0;
    setHeight((current) =>
      Math.abs(current - rounded) > 1 ? rounded : current,
    );
  }, []);
  return [height, report] as const;
}

/**
 * One owner for the Session composer column: the card stack above the input and the input share its room through
 * `useSessionComposerInputCaps`, derived once here under the keyboard scaffold.
 */
export function SessionComposerColumn(
  props: Readonly<{
    expansion: SessionComposerInputExpansionState;
    children: React.ReactNode;
  }>,
) {
  const [cardsContentHeight, reportCardsContentHeight] = useReportedHeight();
  const [textlessHeight, reportTextlessHeight] = useReportedHeight();
  const caps = useSessionComposerInputCaps({
    cardsContentHeight,
    textlessHeight,
    expansion: props.expansion,
  });
  const value = React.useMemo(
    () => ({ caps, reportCardsContentHeight, reportTextlessHeight }),
    [caps, reportCardsContentHeight, reportTextlessHeight],
  );
  return (
    <SessionComposerColumnContext.Provider value={value}>
      {props.children}
    </SessionComposerColumnContext.Provider>
  );
}

export function useSessionComposerColumn(): SessionComposerColumnValue | null {
  return React.useContext(SessionComposerColumnContext);
}

/**
 * The cards above the input (the Session's notices, a draft conflict, banners). They stand whole while the input
 * keeps its floor; past that they get the remaining room as a max height and scroll inside it, top edge first, with
 * a soft fade where more waits.
 */
export function SessionComposerCardStack(
  props: Readonly<{ testID?: string; children: React.ReactNode }>,
) {
  const column = useSessionComposerColumn();
  const notices = React.useContext(SessionComposerNoticesContext);
  const { theme } = useUnistyles();
  const fades = useScrollEdgeFades({
    enabledEdges: { top: true, bottom: true },
  });
  const report = column?.reportCardsContentHeight;
  const onFadesContentSizeChange = fades.onContentSizeChange;
  const handleContentSizeChange = React.useCallback(
    (width: number, height: number) => {
      onFadesContentSizeChange(width, height);
      report?.(height);
    },
    [onFadesContentSizeChange, report],
  );
  const maxHeight = column?.caps.cardsMaxHeight;
  return (
    <View style={{ position: 'relative' }}>
      <ScrollView
        testID={props.testID}
        style={[{ flexGrow: 0 }, typeof maxHeight === 'number' && Number.isFinite(maxHeight) ? { maxHeight } : null]}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        alwaysBounceVertical={false}
        showsVerticalScrollIndicator={false}
        onLayout={fades.onViewportLayout}
        onContentSizeChange={handleContentSizeChange}
        onScroll={fades.onScroll}
        scrollEventThrottle={16}
      >
        {notices}
        {props.children}
      </ScrollView>
      <ScrollEdgeFades color={theme.colors.surface.base} edges={fades.visibility} />
    </View>
  );
}
