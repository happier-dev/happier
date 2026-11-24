import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { ServiceCheckWidgetSpecimen } from '@/components/dev/widgets/ServiceCheckWidgetSpecimen';

/** Dev-only: the Check widget on Home (lab `p7Surfaces` home/homep). `?phone=1`; `?loading=1` while its Checks are read. */
export default function CheckWidgetDevScreen() {
  const params = useLocalSearchParams<{ phone?: string; loading?: string }>();
  return <ServiceCheckWidgetSpecimen phone={params.phone === '1'} loading={params.loading === '1'} />;
}
