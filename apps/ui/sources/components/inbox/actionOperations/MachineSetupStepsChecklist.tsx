import * as React from 'react';

import { useAppShellPluginUiDeclarationProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { PlanChecklistCard, type PlanChecklistItem } from '@/components/systemTasks/planChecklist';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { readActionOperationSudoPrompt, type ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { t } from '@/text';

import { ProjectCommandOutputPane } from './ProjectCommandOutputPane';
import { projectMachineSetupStepChecklist, type MachineSetupOutputAttachment } from './actionOperationDetailPresentation';

/**
 * A Setup operation's reviewed steps: the one run checklist the Machine's Setup tab and the operation
 * detail both show. The row the run waits on says "Needs you"; the question itself is asked once, above.
 * With `stepOutput`, a step with retained output opens it in place (the detail shows its own output pane).
 */
export function MachineSetupStepsChecklist(props: Readonly<{
  operation: ActionOperationProjection;
  attachment: MachineSetupOutputAttachment;
  title?: string | null;
  header?: React.ReactNode;
  stepOutput?: boolean;
  testID?: string;
}>) {
  const projection = useAppShellPluginUiDeclarationProjection();
  const localize = usePluginLocalizedTextResolver({ projection });
  const { operation, stepOutput } = props;
  const [expandedIds, setExpandedIds] = React.useState<readonly string[]>([]);
  const steps = React.useMemo(() => {
    const question = readActionOperationSudoPrompt(operation.snapshot);
    const projected = projectMachineSetupStepChecklist(props.attachment, (label) => localize('', label), question, operation.observation);
    if (!projected || !stepOutput) return projected;
    const items = projected.items.map((item): PlanChecklistItem => {
      const output = item.output;
      if (!output) return item;
      const title = typeof item.title === 'string' ? item.title : t('projects.scripts.output.title');
      const open = expandedIds.includes(item.id);
      const failed = projected.executionById[item.id]?.status === 'error';
      return {
        ...item,
        // A failed step's line is its output opener (lab L7-failed "› Output"): why it stopped is said once, at the head.
        ...(failed ? { subtitle: `${open ? '⌄' : '›'} ${t('projects.scripts.output.title')}` } : {}),
        renderDetails: () => (
          <ProjectCommandOutputPane operation={operation} terminalId={output.terminalId} title={title} height={240} ownerStatesExit />
        ),
      };
    });
    return { ...projected, items };
  }, [props.attachment, localize, operation, stepOutput, expandedIds]);
  const toggle = React.useCallback((id: string) => {
    setExpandedIds((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  }, []);
  if (!steps) return null;
  const card = (
    <PlanChecklistCard
      testID={props.testID ?? 'action-operation-setup-steps'}
      phase="execute"
      items={steps.items}
      selectedIds={steps.selectedIds}
      executionById={steps.executionById}
      expandedIds={expandedIds}
      onToggleExpanded={toggle}
      header={props.header}
    />
  );
  // `title: null` when the host already titles the run (the Setup tab's run region).
  return props.title === null ? card : (
    <ItemGroup surface="none" title={props.title ?? t('managedMachines.creation.setup')}>{card}</ItemGroup>
  );
}
