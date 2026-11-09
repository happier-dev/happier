import * as React from 'react';

import { useAppShellPluginUiDeclarationProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { PlanChecklistCard } from '@/components/systemTasks/planChecklist';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { t } from '@/text';

import { projectMachineSetupStepChecklist, type MachineSetupOutputAttachment } from './actionOperationDetailPresentation';

/** A Setup operation's reviewed steps in the operation detail: the same checklist the Machine's Setup tab shows. */
export function MachineSetupStepsChecklist(props: Readonly<{ attachment: MachineSetupOutputAttachment }>) {
  const projection = useAppShellPluginUiDeclarationProjection();
  const localize = usePluginLocalizedTextResolver({ projection });
  const steps = React.useMemo(
    () => projectMachineSetupStepChecklist(props.attachment, (label) => localize('', label)),
    [props.attachment, localize],
  );
  const [expandedIds, setExpandedIds] = React.useState<readonly string[]>([]);
  const toggle = React.useCallback((id: string) => {
    setExpandedIds((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]));
  }, []);
  if (!steps) return null;
  return (
    <ItemGroup surface="none" title={t('managedMachines.creation.setup')}>
      <PlanChecklistCard
        testID="action-operation-setup-steps"
        phase="execute"
        items={steps.items}
        selectedIds={steps.selectedIds}
        executionById={steps.executionById}
        expandedIds={expandedIds}
        onToggleExpanded={toggle}
      />
    </ItemGroup>
  );
}
