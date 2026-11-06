import * as React from 'react';
import {
  normalizeUsageQuery,
  type UsageQuery,
} from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageBuiltinWidgetIdV1 } from '@happier-dev/protocol/widgets';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { openSessionAuthoringAction } from '@/sync/ops/actions/sessionAuthoringActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { useWidgetFrameBodyActions } from '@/components/widgets/frame/widgetFrameBodyActions';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { t } from '@/text';
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
  /** One more entry a body owns for what it shows (Cost facts: its model prices). Identity-stable. */
  bodyAction: ItemAction | null = null,
): void {
  const key = query ? JSON.stringify(normalizeUsageQuery(query)) : null;
  const lifetime = query ? captureActiveServerAccountScopeLifetime() : null;
  const execution = useMountedActionExecution(lifetime?.scope);
  const actions = React.useMemo((): readonly ItemAction[] | null => {
    if (!query || !lifetime?.isCurrent()) return null;
    const base: ItemAction[] = [
      {
        id: 'usageAsk',
        title: t('usage.board.page.askAgent'),
        icon: 'chat-circle',
        onPress: async () => {
          if (!lifetime.isCurrent()) return;
          const outcome = await openSessionAuthoringAction({
            seed: {
              prompt: buildUsageAskPrompt({
                widget: t(`usage.widgets.${id}`),
                query,
              }),
            },
          }, lifetime, undefined, execution.execute);
          if (!lifetime.isCurrent()) return;
          if (outcome.kind !== 'opened')
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
        onPress: async () => {
          if (!lifetime.isCurrent()) return;
          let copied = false;
          try {
            copied = (await execution.execute('clipboard.write', {
              text: formatUsageQueryForHandoff(query),
            })).ok;
          } catch {
            // Failed clipboard admission/delivery uses the same failure notice as a typed refusal.
          }
          if (!lifetime.isCurrent()) return;
          publishPresentationNotice({
            key: `usage-copy-query:${id}`,
            severity: copied ? 'info' : 'error',
            message: copied
              ? t('usage.board.page.copyQueryDone')
              : t('usage.board.page.copyQueryFailed'),
          });
        },
      },
    ];
    return bodyAction ? [...base, bodyAction] : base;
    // The normalized key is the query's identity; a re-created equal object lends nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, key, lifetime, execution.execute, bodyAction]);
  useWidgetFrameBodyActions(actions);
}
