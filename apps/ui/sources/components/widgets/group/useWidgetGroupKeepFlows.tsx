import * as React from 'react';
import type { View } from 'react-native';
import type {
  WidgetLayoutGroupV1,
  WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';

import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { runSaveWidgetGroupCommandV1 } from '@/components/widgets/definitions/widgetLayoutFragmentCommands';
import { WidgetFlowShell } from '@/components/widgets/flow/WidgetFlowShell';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { storage } from '@/sync/domains/state/storage';
import { readProjectWorkspaceRefs } from '@/sync/store/domains/projectAccountRows';
import { t } from '@/text';

import {
  SaveWidgetGroupPanel,
  type SaveWidgetGroupOutcome,
} from './SaveWidgetGroupPanel';
import { describeWidgetGroupOrigin, WidgetGroupCopyChooser } from './widgetGroupCopy';
import { buildWidgetGroupInputsCandidate } from './widgetGroupInputs';

/**
 * A group's keep-it entries (lab wgmenu M): Save group… asks for the name inline (starting from the
 * group's title) and saves a private copy to Your widgets; Add to… copies it onto another Home or
 * Project as a fragment. Both are copies with no live link. Their surfaces mount only while open.
 */
export function useWidgetGroupKeepFlows(
  input: Readonly<{
    group: WidgetLayoutGroupV1;
    name: string;
    scope: WidgetSurfaceRefV1 | null;
    candidates: readonly (WidgetCandidate | null)[];
    anchorRef: React.RefObject<View | null>;
    testID: string;
  }>,
): Readonly<{
  onSave: (() => void) | undefined;
  onAddTo: (() => void) | undefined;
  overlay: React.ReactElement | null;
}> {
  const [open, setOpen] = React.useState<'save' | 'addTo' | null>(null);
  const close = React.useCallback(() => setOpen(null), []);
  const latest = React.useRef(input);
  latest.current = input;
  const save = React.useCallback(
    async (name: string): Promise<SaveWidgetGroupOutcome> => {
      const { group, scope, candidates } = latest.current;
      if (!scope)
        return { ok: false, message: t('widgetFrame.groupSaveFailed') };
      const origin = describeWidgetGroupOrigin(scope, readProjectWorkspaceRefs(storage.getState()));
      const inputs = buildWidgetGroupInputsCandidate({
        title: name,
        candidates,
      });
      const outcome = await runSaveWidgetGroupCommandV1(
        group,
        {
          name,
          inputs: {
            fields: inputs?.inputs?.fields ? [...inputs.inputs.fields] : [],
          },
          inputSchema: inputs?.inputSchema ?? { type: 'object' },
          // Read when saving, so a closed menu holds no Project subscription.
          ...(origin ? { origin } : {}),
        },
        { serverId: scope.serverId, accountId: scope.accountId },
      );
      if (outcome.kind === 'refused')
        return { ok: false, message: t('widgetFrame.groupSaveFailed') };
      publishPresentationNotice({
        key: `widget-group-save:${group.id}`,
        severity: 'info',
        message:
          outcome.kind === 'approvalPending'
            ? t('widgetAdd.areaApprovalPending')
            : t('widgetFrame.groupSaved', { name }),
      });
      return outcome.kind === 'approvalPending'
        ? { ok: true, approvalPending: true }
        : { ok: true };
    },
    [],
  );
  const available = input.scope !== null;
  const onSave = React.useMemo(
    () => (available ? () => setOpen('save') : undefined),
    [available],
  );
  const onAddTo = React.useMemo(
    () => (available ? () => setOpen('addTo') : undefined),
    [available],
  );
  const { group, name, scope, anchorRef, testID } = input;
  const overlay = !scope ? null : open === 'save' ? (
    <WidgetFlowShell
      anchorRef={anchorRef}
      title={t('widgetFrame.groupSaveTitle')}
      onRequestClose={close}
      testID={`${testID}.saveGroup`}
    >
      <SaveWidgetGroupPanel
        defaultName={group.title ?? name}
        childCount={group.children.length}
        onSave={save}
        onCancel={close}
        onDone={close}
        testID={`${testID}.saveGroup.panel`}
      />
    </WidgetFlowShell>
  ) : open === 'addTo' ? (
    <WidgetGroupCopyChooser
      group={group}
      name={name}
      current={scope}
      anchorRef={anchorRef}
      onClose={close}
      testID={`${testID}.addTo`}
    />
  ) : null;
  return { onSave, onAddTo, overlay };
}
