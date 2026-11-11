import * as React from 'react';
import { View } from 'react-native';

import { sessionListStyles } from '@/components/sessions/shell/sessionListStyles';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';

/**
 * The phone tab shell's line for a column that is the whole page (calm-shell `clviews:recentP`): instead of
 * a separate bar above it, the shell hands the column its Home line (`leading`) and its glyphs (`trailing`),
 * and the column draws one nav row — the Home line, its own controls, the shell glyphs — above its large title.
 * Only the phone tab shell provides it; every other host keeps the column's own title row.
 */
export type PhoneTabNavRow = Readonly<{
  leading: React.ReactNode;
  trailing: React.ReactNode;
}>;

const PhoneTabNavRowContext = React.createContext<PhoneTabNavRow | null>(null);

/** The head's left edge in the phone tab shell: the page edge, where every tab's large title stands. */
const PHONE_TAB_HEAD_EDGE_STYLE = { paddingLeft: PAGE_LIST_METRICS.pageTextInsetPx } as const;

export function PhoneTabNavRowProvider(
  props: Readonly<PhoneTabNavRow & { children: React.ReactNode }>,
) {
  const { leading, trailing, children } = props;
  const value = React.useMemo(
    (): PhoneTabNavRow => ({ leading, trailing }),
    [leading, trailing],
  );
  return (
    <PhoneTabNavRowContext.Provider value={value}>
      {children}
    </PhoneTabNavRowContext.Provider>
  );
}

export function usePhoneTabNavRow(): PhoneTabNavRow | null {
  return React.useContext(PhoneTabNavRowContext);
}

/**
 * The one nav row a whole-page column draws for the phone tab shell: the Home line, the column's own
 * controls, then the shell glyphs. Null outside the phone tab shell.
 */
export function PhoneTabNavRowLine(props: Readonly<{ testID: string; controls?: React.ReactNode }>) {
  const navRow = usePhoneTabNavRow();
  if (!navRow) return null;
  return (
    <View style={[sessionListStyles.searchChrome, PHONE_TAB_HEAD_EDGE_STYLE]}>
      <View testID={props.testID} style={sessionListStyles.searchChromeControlsRow}>
        <View style={sessionListStyles.searchChromeTitleSlot}>{navRow.leading}</View>
        {props.controls}
        {navRow.trailing}
      </View>
    </View>
  );
}
