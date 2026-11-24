import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import {
  DatabaseWorkbenchSpecimen,
  type DatabaseWorkbenchSpecimenSurface,
} from '@/components/dev/databaseWorkbench/DatabaseWorkbenchSpecimen';

/**
 * Dev-only: the Database workbench surfaces on the lab's billing database (`.happier/design-lab/database-workbench`).
 * `?surface=page|panel|rail`, `?sub=overview|data/public/invoices|structure/public/active_subscriptions|console`,
 * `?width=` the content column the surface gets (default: the whole screen), `?state=loading|empty|failed` the rows'
 * answer, `?console=error|cancelled` what Run answers, `?stats=off` statement statistics off (Insights setup),
 * `?review=unverified` a writable database with the trust notice in its staged changes review,
 * `?review=read-setup` a Railway database that needs a read-only login.
 */
export default function DatabaseWorkbenchDevScreen() {
  const params = useLocalSearchParams<{
    surface?: string;
    sub?: string;
    width?: string;
    state?: string;
    console?: string;
    stats?: string;
    review?: string;
  }>();
  const surface: DatabaseWorkbenchSpecimenSurface =
    params.surface === 'panel' || params.surface === 'rail'
      ? params.surface
      : 'page';
  const width = Number(params.width);
  return (
    <DatabaseWorkbenchSpecimen
      surface={surface}
      subPath={typeof params.sub === 'string' ? params.sub : null}
      width={Number.isFinite(width) && width > 0 ? width : null}
      state={{
        ...(params.state === 'loading' || params.state === 'empty' || params.state === 'failed' ? { rows: params.state } : {}),
        ...(params.console === 'error' || params.console === 'cancelled' ? { console: params.console } : {}),
        ...(params.stats === 'off' ? { stats: 'off' as const } : {}),
        ...(params.review === 'unverified' || params.review === 'read-setup' ? { review: params.review } : {}),
      }}
    />
  );
}
