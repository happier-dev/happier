import type { ComponentType, ReactNode } from 'react';
import { View } from 'react-native';

import { HappierText } from '../presentation/text/Text.js';
import { resolveHappierPageTextStyle } from '../presentation/layout/pageText.js';
import { useOptionalHappierUiTypography } from '../environment/context.js';

/** Formatted disclosure facts. Identity, custody, retention and localization belong to the caller. */
export type HappierRequesterDisclosureModel = Readonly<{
  title: string;
  description: string;
  learnMore?: Readonly<{ label: string; onPress: () => void }>;
}>;

type DisclosureTextProps = Readonly<{ children?: ReactNode; accessibilityRole?: 'link'; onPress?: () => void }>;

/** Same-realm hosts bind their scaled text; the disclosure anatomy has one owner. */
export type HappierRequesterDisclosureHost = Readonly<{
  Title: ComponentType<DisclosureTextProps>;
  Description: ComponentType<DisclosureTextProps>;
  Link: ComponentType<DisclosureTextProps>;
}>;

export type HappierRequesterDisclosureContentProps = Readonly<{
  model: HappierRequesterDisclosureModel;
  /** The caller's Machine mark, sized and tinted by its existing icon owner. */
  icon?: ReactNode;
  host?: HappierRequesterDisclosureHost;
}>;

function Title(props: DisclosureTextProps) {
  const typography = useOptionalHappierUiTypography();
  return <HappierText {...props} style={{ ...resolveHappierPageTextStyle('rowTitle', typography), flex: 1 }} />;
}
function Description(props: DisclosureTextProps) {
  const typography = useOptionalHappierUiTypography();
  return <HappierText {...props} tone="secondary" style={resolveHappierPageTextStyle('rowDescription', typography)} />;
}
function Link(props: DisclosureTextProps) {
  const typography = useOptionalHappierUiTypography();
  return <HappierText {...props} tone="accent" style={resolveHappierPageTextStyle('rowDescription', typography)} />;
}
const defaultHost: HappierRequesterDisclosureHost = { Title, Description, Link };

/** Controlled shared-Machine disclosure, without Account readers or admission decisions. */
export function HappierRequesterDisclosureContent({ model, icon, host = defaultHost }: HappierRequesterDisclosureContentProps) {
  const { Title, Description, Link } = host;
  return <View style={{ padding: 14, gap: 8 }}>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {icon}
      <Title>{model.title}</Title>
    </View>
    <Description>{model.description}</Description>
    {model.learnMore ? <Link accessibilityRole="link" onPress={model.learnMore.onPress}>{model.learnMore.label}</Link> : null}
  </View>;
}
