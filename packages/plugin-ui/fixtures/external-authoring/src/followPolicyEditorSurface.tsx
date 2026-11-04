import { useState } from 'react';
import { FollowPolicyEditor, Text, type FollowPolicyEditorDelivery, type FollowPolicyEditorEvent } from '@happier-dev/plugin-ui/components';

const PRESETS = ['everything', 'important', 'quiet', 'custom'] as const;

/** A controlled Follow policy: the author keeps the draft and saves it; Happier draws the editor. */
export function FollowPolicyEditorExample() {
  const [preset, setPreset] = useState<string>('important');
  const [events, setEvents] = useState<readonly FollowPolicyEditorEvent[]>([
    { id: 'needs_you', delivery: 'interrupt' },
    { id: 'finished', delivery: 'quiet' },
    { id: 'message', delivery: 'off' },
  ]);
  const setDelivery = (eventId: string, delivery: FollowPolicyEditorDelivery) =>
    setEvents(current => current.map(event => event.id === eventId ? { ...event, delivery } : event));
  return <>
    <FollowPolicyEditor testID="author-follow-editor" preset={preset} presets={PRESETS} events={events}
      onSelectPreset={setPreset} onSetDelivery={setDelivery} />
    <Text testID="author-follow-draft" tone="secondary"
      value={`${preset}: ${events.map(event => `${event.id}=${event.delivery}`).join(', ')}`} />
  </>;
}
