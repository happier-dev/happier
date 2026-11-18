import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { ServiceCheckWidgetSpecimen } from '@/components/dev/widgets/ServiceCheckWidgetSpecimen';

/** Dev-only: the Check widget on Home (lab `p7Surfaces` home/homep). `?phone=1`. */
export default function CheckWidgetDevScreen() {
  const params = useLocalSearchParams<{ phone?: string }>();
  return <ServiceCheckWidgetSpecimen phone={params.phone === '1'} />;
}
