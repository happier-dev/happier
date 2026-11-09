import { useState } from 'react';
import { Button, HappierWorkUpdateCard, Icon, Text } from '@happier-dev/plugin-ui/components';

/** What came back from work the plugin started, in Happier's Work update anatomy; the author owns the facts. */
export function WorkUpdateCardExample() {
  const [opened, setOpened] = useState(false);
  return <>
    <HappierWorkUpdateCard testID="author-work-update" tone="attention" mark={<Icon name="review" size="small" tone="secondary" />}
      title="Release review" state="needs you" meta="Review · 2m"
      facts={[{ id: 'files', label: '4 files' }, { id: 'checks', label: 'Checks passed' }]}
      actions={<Button title="Open review" variant="primary" size="small" onPress={() => setOpened(true)} />}>
      <Text value="Two comments need an answer before the release can go out." />
    </HappierWorkUpdateCard>
    {opened ? <Text value="Opened review" /> : null}
  </>;
}
