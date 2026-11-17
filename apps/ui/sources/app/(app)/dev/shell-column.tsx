import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { ShellColumnSpecimen } from '@/components/dev/shellColumn/ShellColumnSpecimen';

/** Dev-only: the shell column's header line, rail-step rhythm and header bands. `?only=<frame id>` renders one frame. */
export default function ShellColumnDevScreen() {
  const params = useLocalSearchParams<{ only?: string }>();
  return (
    <ShellColumnSpecimen
      only={typeof params.only === 'string' ? params.only : null}
    />
  );
}
