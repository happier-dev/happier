import * as React from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';

import { HappierColumnEdgeContext } from '@happier-dev/plugin-ui/presentation';

import { PageFrame } from '@/components/ui/layout/PageFrame';

/**
 * The page's content column for content that does not size itself: a page-sized `Collection`'s table or
 * grid, a widget area, a dashboard. Inside an `ItemList` it takes the page column's width (`reading` or
 * `wide`, under the person's content-width preference) and centres it, so that content shares one edge
 * with the `PageHeader` and every `ItemGroup` on the page. Owners that already size themselves to the
 * column (`PageHeader`, `ItemGroup`) are unaffected inside it.
 *
 * The column draws no edge of its own, so it resets the column edge an enclosing page told its public sections
 * (`CoreCollectionScope` on a settings page): a Collection whose page scroller opens this column insets its header
 * and sections from here, never cancelling an inset nobody drew. A scope mounted inside the column states its own.
 */
const PageContentColumnContext = React.createContext(false);

/** Inside a page content column: it draws no edge, so a scope mounted in it has no column edge to state. */
export function useInPageContentColumn(): boolean {
  return React.useContext(PageContentColumnContext);
}

export function PageContentColumn(
  props: Readonly<{
    children?: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    testID?: string;
  }>,
) {
  return (
    <PageFrame
      content="column"
      testID={props.testID}
      style={props.style}
    >
      <PageContentColumnContext.Provider value>
        <HappierColumnEdgeContext.Provider value={0}>{props.children}</HappierColumnEdgeContext.Provider>
      </PageContentColumnContext.Provider>
    </PageFrame>
  );
}

