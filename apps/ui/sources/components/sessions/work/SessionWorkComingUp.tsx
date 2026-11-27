import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';
import { readWorkflowRunWorkStatusFacts } from '@/components/work/status/workflowWorkStatusFacts';
import type { AccountTriggerRow } from '@/components/workflows/triggers/accountTriggerRows';
import { useResourceAutomationsSection } from '@/components/workflows/triggers/useResourceAutomationsSection';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { t } from '@/text';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';

/** How many healthy automations the preview lists before pointing at Info; a failed one is always listed. */
const COMING_UP_HEALTHY_ROWS = 3;

type ComingUpProps = Readonly<{ sessionId: string; serverId: string }>;

/**
 * Work › Coming up (merged Session lab, OQ10/C1 Y5): a read-only preview of the automations that will run here, with
 * the one editable place, Info › Automations, a press away. It reads the same Automations owner Info's section reads
 * (`useResourceAutomationsSection`) and edits nothing. A row whose last Run failed stays listed even when the rest is
 * cut, and opens that Run directly; any other row opens its automation in Info. Nothing to show draws nothing.
 */
export const SessionWorkComingUp = React.memo(function SessionWorkComingUp(
  props: ComingUpProps,
) {
  const scope = useActiveServerAccountScope(props.serverId);
  // The section reads one Session of one Home: its canonical subject names that Home's portable identity.
  const homeId = resolvePortableServerIdentityForRoutingId(props.serverId);
  return scope &&
    homeId &&
    areServerProfileIdentifiersEquivalent(scope.serverId, props.serverId) ? (
    <SessionWorkComingUpContent {...props} homeId={homeId} />
  ) : null;
});

function SessionWorkComingUpContent(
  props: ComingUpProps & Readonly<{ homeId: string }>,
) {
  const { sessionId, serverId } = props;
  const { theme } = useUnistyles();
  const router = useRouter();
  const [title] = useSessionDisplayTitles([{ sessionId, serverId }]);
  const subject = React.useMemo(
    () => ({ kind: 'session' as const, serverId: props.homeId, sessionId }),
    [props.homeId, sessionId],
  );
  const automations = useResourceAutomationsSection({
    subject,
    subjectName: title ?? '',
  });
  const { rows, also } = automations;
  const preview = React.useMemo(
    () => projectComingUp([...rows, ...also]),
    [rows, also],
  );
  const openInfo = React.useCallback(
    (automationId?: string) => {
      router.push({
        pathname: '/session/[id]/triggers',
        params: {
          id: sessionId,
          serverId,
          ...(automationId === undefined ? {} : { trigger: automationId }),
        },
      } as never);
    },
    [router, serverId, sessionId],
  );
  if (preview.listed.length === 0) return null;
  return (
    <ItemGroup
      testID="session-work-coming-up"
      title={t('sessionWork.comingUp.title')}
    >
      {preview.listed.map(({ row, failedRunId, statusWord }) => (
        <Item
          key={`${row.automationId}:${row.triggerId ?? 'manual'}`}
          testID={`session-work-coming-up:${row.automationId}`}
          icon={
            <Icon
              name={row.glyph}
              color={
                failedRunId
                  ? theme.colors.status.danger
                  : theme.colors.text.secondary
              }
            />
          }
          title={row.subtitle}
          subtitle={joinHappierFacts(statusWord, row.title)}
          onPress={
            failedRunId
              ? () =>
                  router.push(
                    createWorkflowRunRoute(failedRunId, serverId) as never,
                  )
              : () => openInfo(row.automationId)
          }
        />
      ))}
      <Item
        testID="session-work-coming-up:all"
        icon={
          <Icon name="tree-structure" color={theme.colors.text.secondary} />
        }
        title={
          preview.hidden > 0
            ? t('sessionWork.comingUp.more', { count: preview.hidden })
            : t('sessionWork.comingUp.openAll')
        }
        onPress={() => openInfo()}
      />
    </ItemGroup>
  );
}

type ComingUpRow = Readonly<{
  row: AccountTriggerRow;
  failedRunId: string | null;
  statusWord: string | null;
}>;

/**
 * The preview's rows: automations that are on and still runnable, failed ones first and never cut, then the first
 * healthy ones. A row's failure is its last Run's Work status state (the Run lifecycle owner's), never re-derived here; a failure that
 * still needs the person reads as failed too.
 */
export function projectComingUp(
  candidates: readonly AccountTriggerRow[],
): Readonly<{ listed: readonly ComingUpRow[]; hidden: number }> {
  const failed: ComingUpRow[] = [];
  const healthy: ComingUpRow[] = [];
  for (const row of candidates) {
    if (row.off || row.sourceGone || row.subtitlePending) continue;
    const lastRun = row.attachment?.lastRun ?? null;
    const status = lastRun
      ? resolveWorkStatusTone({
          kind: 'workflow_run',
          facts: readWorkflowRunWorkStatusFacts(lastRun),
        })
      : null;
    if (lastRun && status?.state === 'failed')
      failed.push({ row, failedRunId: lastRun.id, statusWord: status.word });
    else healthy.push({ row, failedRunId: null, statusWord: null });
  }
  const shown = healthy.slice(0, COMING_UP_HEALTHY_ROWS);
  return {
    listed: [...failed, ...shown],
    hidden: healthy.length - shown.length,
  };
}
