import * as React from 'react';
import { Button, CollectionAddMenu } from '@happier-dev/plugin-ui/components';

export type CollectionAddMenuExampleProps = Readonly<{
  onSelect(id: string): void;
  customTrigger?: boolean;
  disabled?: boolean;
}>;

/** Held choices and an author-owned intent handler; no host inventory or setup imports. */
export function CollectionAddMenuExample(props: CollectionAddMenuExampleProps) {
  return <CollectionAddMenu
    testID="author-add-menu"
    triggerTestID="author-add-trigger"
    label="Add a source"
    disabled={props.disabled}
    searchPlaceholder="Find sources"
    notice="Some sources need setup before they can be added."
    items={Array.from({ length: props.customTrigger ? 2 : 10 }, (_, index) => ({
      id: `source-${index}`,
      testID: `author-source-${index}`,
      title: `Source ${index}`,
      subtitle: index === 9 ? 'Local inference' : 'Hosted inference',
      category: index < 5 ? 'Cloud' : 'On this computer',
      disabled: index === 8,
    }))}
    renderTrigger={props.customTrigger ? (toggle) => <Button
      testID="author-custom-add-trigger" title="Choose a source" onPress={toggle}
    /> : undefined}
    onSelect={props.onSelect}
  />;
}
