import type { ReactElement } from 'react';

import { useHappierUiAccessibility } from '../environment/context.js';
import {
  HappierCountedDisclosure,
  type HappierCountedDisclosureContentProps,
  type HappierCountedDisclosureFrameProps,
} from '../presentation/collection/CountedDisclosure.js';
import { HappierDisclosure } from '../presentation/collection/Disclosure.js';
import { HAPPIER_INSTANT_DISCLOSURE_MOTION } from '../presentation/collection/collectionMotion.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { HappierDisclosureCaret } from './DisclosureCaret.js';
import { Item } from './List.js';
import { usePluginTheme } from './PluginUiProvider.js';

export type CountedDisclosureItemProps = HappierCountedDisclosureContentProps;

/** The disclosure with the host's motion, reduced motion and hairline; shared by this package's folded rows. */
export function CountedDisclosureFrame(props: HappierCountedDisclosureFrameProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  const theme = usePluginTheme();
  const { reducedMotion } = useHappierUiAccessibility();
  return (
    <HappierDisclosure
      {...props}
      motion={host?.disclosureMotion ?? HAPPIER_INSTANT_DISCLOSURE_MOTION}
      reducedMotion={reducedMotion || host?.disclosureMotion === undefined}
      separatorStyle={{ backgroundColor: theme.colors.border }}
    />
  );
}

/** A locally folded count or word summary; its details mount only when the reader opens it. */
export function CountedDisclosureItem(props: CountedDisclosureItemProps): ReactElement {
  return (
    <HappierCountedDisclosure
      {...props}
      Disclosure={CountedDisclosureFrame}
      renderHeader={(state) => (
        <Item
          testID={state.testID}
          title={state.title}
          subtitle={state.subtitle}
          subtitleNumberOfLines={state.subtitleNumberOfLines}
          icon={state.icon}
          detail={state.detail}
          onPress={state.headerProps.onPress}
          accessibilityRole={state.headerProps.accessibilityRole}
          accessibilityExpanded={state.expanded}
          accessory={<HappierDisclosureCaret expanded={state.expanded} />}
        />
      )}
    />
  );
}
