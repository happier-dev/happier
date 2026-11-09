import { useState } from 'react';
import { Button, Status } from '@happier-dev/plugin-ui/components';
import { usePluginHostApi } from '@happier-dev/plugin-ui/hostApi';

/**
 * A notice the plugin sends to the person: the button runs the plugin's own Action, whose daemon
 * handler calls `context.services.notifications.send`; Happier routes it to their channels.
 */
export function ReviewReadyNoticeExample() {
  const host = usePluginHostApi();
  const [state, setState] = useState<'idle' | 'sent' | 'failed'>('idle');
  return <>
    <Button testID="author-notice-send" title="Notify me when ready" variant="secondary" onPress={async () => {
      try {
        await host.executeAction('send-review-ready-notice', {});
        setState('sent');
      } catch {
        setState('failed');
      }
    }} />
    {state === 'sent' ? <Status testID="author-notice-status" tone="success" label="Notice sent" /> : null}
    {state === 'failed' ? <Status testID="author-notice-status" tone="danger" label="Couldn’t send the notice" /> : null}
  </>;
}
