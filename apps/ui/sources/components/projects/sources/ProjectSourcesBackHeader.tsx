import * as React from 'react';

import { NavigationBackChromeProvider } from '@/components/ui/layout/NavigationBackChrome';
import type { NavigationBackControl } from '@/components/ui/layout/NavigationBackChrome';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { t } from '@/text';

/**
 * The Sources page's header for a state that stands alone (a phone: loading, unavailable, empty): titled as
 * the page it leaves, with the page's Back (`usePageBackControl`) on the title line.
 */
export function ProjectSourcesBackHeader(props: Readonly<{ testID: string; control: NavigationBackControl }>) {
  return (
    <NavigationBackChromeProvider control={props.control}>
      <PageHeader testID={props.testID} title={t('projects.sources.title')} alwaysShowTitle />
    </NavigationBackChromeProvider>
  );
}
