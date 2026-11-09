import type { ReactNode } from 'react';
import {
  ApprovalFields,
  ApprovalPrompt,
  type ApprovalFieldsProps,
} from '@happier-dev/plugin-ui/components';

/** The author supplies reviewed arguments and decision controls; these components only present them. */
export function ApprovalFieldsExample(props: ApprovalFieldsProps & Readonly<{
  title: string;
  footer: ReactNode;
}>) {
  return <ApprovalPrompt title={props.title} footer={props.footer}>
    <ApprovalFields rows={props.rows} anatomy={props.anatomy}
      technicalDetails={props.technicalDetails} testID={props.testID} />
  </ApprovalPrompt>;
}
