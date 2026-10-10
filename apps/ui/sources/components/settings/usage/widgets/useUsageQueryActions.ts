import * as React from 'react';
import {
  normalizeUsageQuery,
  type UsageQuery,
} from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageBuiltinWidgetIdV1 } from '@happier-dev/protocol/widgets';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { buildNewSessionLaunchRouteParams } from '@/components/sessions/new/navigation/newSessionRouteParams';
import { seedAndOpenNewSession } from '@/components/sessions/new/newSessionSeedComposer';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { useWidgetFrameBodyActions } from '@/components/widgets/frame/widgetFrameBodyActions';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { usagePeriodPhrase } from './usageBodyKit';

/** The query as an agent or a person reads it: the canonical input, nothing rendered. */
export function formatUsageQueryForHandoff(query: UsageQuery): string {
  return JSON.stringify(normalizeUsageQuery(query), null, 2);
}

/**
 * What "Ask an agent about this" puts in the composer (lab `kitstates` ask): the widget's own query,
 * never a picture or its numbers. The agent reads the same facts through `usage.query`; the person
 * writes the question and sends it themselves.
 */
export function buildUsageAskPrompt(
  input: Readonly<{ widget: string; query: UsageQuery }>,
): string {
  return t('usage.board.page.askPrompt', {
    widget: input.widget,
    period: usagePeriodPhrase(input.query),
    query: formatUsageQueryForHandoff(input.query),
  });
}

/**
 * Lends "Ask an agent about this" and "Copy query" to the widget's own ⋯ (lab `kitstates` pin/ask).
 * Asking seeds the New Session composer through its one seeding owner and opens it; nothing is sent
 * or launched from here. Both act on the query the body is showing.
 */
export function useUsageQueryActions(
  id: UsageBuiltinWidgetIdV1,
  query: UsageQuery | null,
): void {
  const router = useRouter();
  const key = query ? JSON.stringify(normalizeUsageQuery(query)) : null;
  const actions = React.useMemo((): readonly ItemAction[] | null => {
    if (!query) return null;
    return [
      {
        id: 'usageAsk',
        title: t('usage.board.page.askAgent'),
        icon: 'chat-circle',
        onPress: () => {
          const lifetime = captureActiveServerAccountScopeLifetime();
          if (!lifetime?.isCurrent()) return;
          const outcome = seedAndOpenNewSession({
            seed: {
              prompt: buildUsageAskPrompt({
                widget: t(`usage.widgets.${id}`),
                query,
              }),
            },
            scope: lifetime.scope,
            isCurrent: lifetime.isCurrent,
            navigateToNewSession: ({
              draftId,
              machineId,
              directory,
              spawnServerId,
              worktree,
            }) => {
              router.push({
                pathname: '/new',
                params: buildNewSessionLaunchRouteParams({
                  draftId,
                  machineId,
                  directory,
                  targetServerId: spawnServerId,
                  worktree,
                }),
              } as Parameters<typeof router.push>[0]);
            },
          });
          if (outcome.kind !== 'routed')
            publishPresentationNotice({
              key: `usage-ask:${id}`,
              severity: 'error',
              message: t('usage.board.page.askUnavailable'),
            });
        },
      },
      {
        id: 'usageCopyQuery',
        title: t('usage.board.page.copyQuery'),
        icon: 'copy',
        onPress: () => {
          void setClipboardStringSafe(formatUsageQueryForHandoff(query)).then(
            (copied) => {
              publishPresentationNotice({
                key: `usage-copy-query:${id}`,
                severity: copied ? 'info' : 'error',
                message: copied
                  ? t('usage.board.page.copyQueryDone')
                  : t('usage.board.page.copyQueryFailed'),
              });
            },
          );
        },
      },
    ];
    // The normalized key is the query's identity; a re-created equal object lends nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, key, router]);
  useWidgetFrameBodyActions(actions);
}
