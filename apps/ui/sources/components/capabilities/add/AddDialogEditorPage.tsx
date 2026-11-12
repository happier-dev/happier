import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierCapabilityAddFooter } from '@happier-dev/plugin-ui/presentation';

import { ItemList } from '@/components/ui/lists/ItemList';
import {
  PageHeader,
  PageHeaderActionButton,
  type PageHeaderProps,
} from '@/components/ui/layout/PageHeader';

/**
 * Whether the content stands inside an Add dialog (Add an agent → From a command, Add a provider → Custom endpoint).
 * The dialog owner (`CapabilityAddModalBody`) provides it; an editor page reads it through `AddDialogEditorPage`.
 */
export const AddDialogHostContext = React.createContext(false);

/**
 * An editor page that can also stand inside an Add dialog. On its own route it is a page: its header (title,
 * description, Save) and its sections. Inside an Add dialog the dialog already names the task, so the page draws no
 * header of its own: its sections fill the body, and the dialog's pinned footer carries the header's note or error
 * at the start and its Save at the end. The dialog's close is its Cancel.
 */
export function AddDialogEditorPage(
  props: Readonly<{
    header: PageHeaderProps;
    /** What stands above the header on the page (a context bar). */
    before?: React.ReactNode;
    /** Inside the dialog, the controls that sit before Save in its footer (a connection test). */
    hostedActions?: React.ReactNode;
    footerTestID?: string;
    testID?: string;
    keyboardShouldPersistTaps?: 'always' | 'never' | 'handled';
    children: React.ReactNode;
  }>,
): React.ReactElement {
  const hosted = React.useContext(AddDialogHostContext);
  const list = (header: React.ReactNode) => (
    <ItemList
      {...(props.testID === undefined ? {} : { testID: props.testID })}
      {...(props.keyboardShouldPersistTaps === undefined
        ? {}
        : { keyboardShouldPersistTaps: props.keyboardShouldPersistTaps })}
    >
      {props.before}
      {header}
      {props.children}
    </ItemList>
  );
  if (!hosted) return list(<PageHeader {...props.header} />);
  const primary = props.header.primaryAction;
  return (
    <View style={styles.fill}>
      {list(null)}
      <HappierCapabilityAddFooter
        start={props.header.details ?? null}
        {...(props.footerTestID === undefined
          ? {}
          : { testID: props.footerTestID })}
      >
        {props.hostedActions ?? null}
        {primary ? <PageHeaderActionButton action={primary} /> : null}
      </HappierCapabilityAddFooter>
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  fill: {
    flex: 1,
    minHeight: 0,
  },
}));
