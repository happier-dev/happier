import * as React from 'react';
import type { WorkspaceWorkerPreferenceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

/**
 * "Allow explicit ad-hoc commands" (plan 30 copy): the one checkout setting agents have. Workers
 * settings and Scripts › Agents both draw this row over the same observed preference and its one
 * semantic save; turning it on never approves a command, each still follows Action approval.
 */
export function WorkspaceAdHocCommandsItem(
  props: Readonly<{
    testID: string;
    preference: WorkspaceWorkerPreferenceV1 | null;
    disabled: boolean;
    onSave: (next: WorkspaceWorkerPreferenceV1) => void;
  }>,
) {
  const { preference } = props;
  const disabled = props.disabled || preference === null;
  return (
    <Item
      testID={props.testID}
      title={t('projectWorkers.adHoc')}
      subtitle={t('projectWorkers.adHocDetail')}
      showChevron={false}
      disabled={disabled}
      rightElement={
        <Switch
          testID={`${props.testID}.switch`}
          value={preference?.allowAdHoc === true}
          disabled={disabled}
          accessibilityLabel={t('projectWorkers.adHoc')}
          onValueChange={(allowAdHoc) => {
            if (preference) props.onSave({ ...preference, allowAdHoc });
          }}
        />
      }
    />
  );
}
