import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { WidgetFrameBodyCaptionContext } from '@/components/widgets/frame/widgetFrameBodyCaption';

/**
 * One card of an Environment's Telemetry tab (LLM calls, Metrics), in the shared widget frame on the page's sheet edge,
 * so the tabs share one material. A Usage body inside names its period and price basis beneath the title.
 */
export function TelemetryCard(props: Readonly<{ testID: string; title: string | null; children: React.ReactNode }>) {
  const [caption, setCaption] = React.useState<string | null>(null);
  const body = React.useMemo(() => ({ kind: 'content' as const, children: (
    <WidgetFrameBodyCaptionContext.Provider value={setCaption}>{props.children}</WidgetFrameBodyCaptionContext.Provider>
  ) }), [props.children]);
  return <View style={styles.card}>
    <WidgetFrame testID={props.testID} frameStyle="card" placement="home" rows={0} title={props.title}
      {...(caption ? { source: caption } : {})} body={body} />
  </View>;
}

const styles = StyleSheet.create(() => ({
  // Cards stand on the sheets' edge, like the groups and lists around them.
  card: { marginHorizontal: PAGE_LIST_METRICS.sheetInsetPx },
}));
