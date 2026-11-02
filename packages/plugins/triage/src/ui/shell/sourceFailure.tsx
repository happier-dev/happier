import * as React from 'react';
import { Stack, Status, TechnicalDetailsDisclosure, usePluginTranslation, useSurfaceContext } from '@happier-dev/plugin-ui';

import { readTriageListFailureNotice, type TriageListShellFailureV1 } from './windowState.js';

/** One named failure beside retained rows, with its typed cause available on demand. */
export function TriageListFailureStatus(props: Readonly<{
  failure: TriageListShellFailureV1;
  action: React.ReactNode;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const notice = readTriageListFailureNotice(props.failure, text, locale);
  return <Stack gap="small">
    <Status tone="warning" label={notice.title} value={notice.description} action={props.action} />
    {notice.details === undefined ? null : <TechnicalDetailsDisclosure
      title={text('plugins.triage.surface.detail.tab.details', 'Details')}
      lines={[{ key: 'source-invocation', label: notice.title, value: notice.details }]}
    />}
  </Stack>;
}
