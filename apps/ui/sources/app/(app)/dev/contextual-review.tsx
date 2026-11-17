import * as React from 'react';
import { prepareApprovalRequest } from '@happier-dev/protocol/actions/executor/approvalPreparation';
import { ActionDefinitionSummaryV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';

import { confirmActionReview } from '@/components/approvals/ActionConfirmationReview';
import { presentActionApproval } from '@/components/approvals/actionApprovalPresentation';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { t } from '@/text';

/**
 * Dev-only: a contextual Triage press ("Change Work Item status") whose receiving executor needs the person's
 * review. The daemon would refuse the bare press with `action_interactive_review_required` and carry back its
 * review; the originating UI presents it (`confirmOwnUiRefusal` → `createActionConfirmationPresenter` →
 * `confirmActionReview`). Here the carried review is built by the same protocol preparation and shown through the
 * same presenter; Confirm reaches no Machine.
 */
/** The receiving daemon's catalog entry for this press, with the bundled Triage manifest's own title and description. */
const TRIAGE_TRANSITION = ActionDefinitionSummaryV1Schema.parse({
  id: 'happier.triage/actions/work-items/transition-v1',
  title: 'Change Work Item status',
  description: 'Uses the task source’s declared native transition.',
  safety: 'safe', placements: [], slash: null, bindings: null, examples: null, surfaces: { ui: true }, inputHints: null,
});

export default function ContextualReviewDevScreen() {
  const scope = useActiveServerAccountScope();
  const [answer, setAnswer] = React.useState<string | null>(null);
  const press = React.useCallback(async () => {
    if (!scope) return;
    const actionId = 'action.invoke' as const;
    const input = {
      action: {
        pluginId: 'happier.triage',
        localId: 'work-items/transition-v1',
      },
      input: {
        serverId: scope.serverId,
        itemId: 'LIN-482',
        transitionId: 'done',
      },
    };
    const prepared = await prepareApprovalRequest({
      actionId,
      input,
      actionArgs: input,
      context: { surface: 'ui' },
      deps: { listContributedActionDefinitions: () => [TRIAGE_TRANSITION] },
    });
    if (!prepared || 'errorCode' in prepared) {
      setAnswer(
        prepared && 'errorCode' in prepared
          ? String(prepared.errorCode)
          : 'not prepared',
      );
      return;
    }
    const presentation = presentActionApproval({
      actionId,
      actionArgs: prepared.actionArgs,
      preview: prepared.preview,
      kind: 'confirmation',
    });
    const confirmed = await confirmActionReview({
      actionId,
      actionArgs: prepared.actionArgs,
      preview: prepared.preview,
      summaryPlacement: 'host',
      title: presentation.title ?? t('approvals.untitled'),
      summary: presentation.summary || null,
      confirmLabel: presentation.confirmLabel ?? t('approvals.approve'),
      irreversible: false,
      destructive: presentation.destructive === true,
      serverId: scope.serverId,
    });
    setAnswer(confirmed ? 'confirmed' : 'declined');
  }, [scope]);
  React.useEffect(() => {
    void press();
  }, [press]);
  return (
    <ItemList>
      <ItemGroup
        title="Contextual press"
        description="A Triage task's status change that needs your review first."
      >
        <Item
          testID="dev-contextual-review-press"
          title="Change Work Item status"
          subtitle={answer ?? undefined}
          onPress={() => void press()}
        />
      </ItemGroup>
    </ItemList>
  );
}
