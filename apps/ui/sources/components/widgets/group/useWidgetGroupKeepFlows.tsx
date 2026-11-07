import * as React from 'react';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import type { View } from 'react-native';
import type {
  WidgetLayoutGroupV1,
  WidgetSurfaceRefV1,
} from '@happier-dev/protocol/widgets';

import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { createSaveWidgetGroupAttemptV1 } from '@/components/widgets/definitions/widgetLayoutFragmentCommands';
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
import { readWidgetGroupTitle } from './widgetGroupTitle';

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
  const latest = React.useRef(input);
  latest.current = input;
  const saveAttempt = React.useRef<Readonly<{
    serverId: string;
    accountId: string;
    attempt: ReturnType<typeof createSaveWidgetGroupAttemptV1>;
  }> | null>(null);
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
      if (saveAttempt.current?.serverId !== scope.serverId || saveAttempt.current.accountId !== scope.accountId) {
        saveAttempt.current = { serverId: scope.serverId, accountId: scope.accountId,
          attempt: createSaveWidgetGroupAttemptV1({ serverId: scope.serverId, accountId: scope.accountId }) };
      }
      const { attempt } = saveAttempt.current;
      const outcome = await attempt.run(
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
      );
      if (outcome.kind === 'refused')
        return { ok: false, message: t('widgetFrame.groupSaveFailed') };
      if (outcome.kind === 'applied' && saveAttempt.current?.attempt === attempt) saveAttempt.current = null;
      publishPresentationNotice({
        key: `widget-group-save:${group.id}`,
        severity: 'info',
        message:
          outcome.kind === 'approvalPending'
            ? t('widgetAdd.areaApprovalPending')
            : t('widgetFrame.groupSaved', { name: outcome.result.fragment.name }),
      });
      return outcome.kind === 'approvalPending'
        ? { ok: true, approvalPending: true }
        : { ok: true };
    },
    [],
  );
  const available = input.scope !== null;
  const commands = useCurrentUiContextLocalCommands(available ? [
    { key: 'save', title: `${t('widgetFrame.groupSave')}: ${input.name}`, description: `${input.testID}.groupKeep.save`,
      invoke: () => { saveAttempt.current = null; setOpen('save'); } },
    { key: 'addTo', title: `${t('widgetFrame.groupAddTo')}: ${input.name}`, description: `${input.testID}.groupKeep.addTo`,
      invoke: () => setOpen('addTo') },
    ...(open ? [{ key: 'close', title: `${t('common.close')}: ${input.name}`, description: `${input.testID}.groupKeep.close`,
      invoke: () => setOpen(null) }] : []),
  ] : [], { contextKey: `${input.testID}.groupKeep`, unbound: 'local' });
  const close = React.useCallback(() => { void commands.invoke('close'); }, [commands]);
  const onSave = React.useMemo(
    () => (available ? () => { void commands.invoke('save'); } : undefined),
    [available, commands],
  );
  const onAddTo = React.useMemo(
    () => (available ? () => { void commands.invoke('addTo'); } : undefined),
    [available, commands],
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
        defaultName={readWidgetGroupTitle(group) ?? name}
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
