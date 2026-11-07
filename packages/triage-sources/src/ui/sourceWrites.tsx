import * as React from 'react';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';
import type {
  PluginUiActionControlController,
  PluginUiActionControlExecution,
  PluginUiActionReference,
} from '@happier-dev/plugin-sdk/ui';
import {
  Action,
  Banner,
  Button,
  Stack,
  Text,
  TextField,
  usePluginHostApi,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import {
  TriageTaskWriteResultV1Schema,
  describeTriageSourceFailureV1,
  type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';

import { useTriagePostMutationCompletion } from './postMutation.js';

/**
 * A person's native source writes in a source detail panel (Sentry resolve, a Linear comment, …).
 *
 * Every write is the source's own declared Action. Buttons use the host-rendered `Action.Control`;
 * property controls use the public Action hook and return its execution to this same group.
 * The host runs each Action as the present user under its declared confirmation and approval
 * policy. This file prepares button inputs and projects every settlement once. It never replays:
 * an outcome that may already have reached the provider withholds every write in the group until
 * the entry is read again.
 */

/** What a settled write means to the person who pressed it. */
export type TriageSourceWriteSettlementV1 =
  /** `result` is the Action's own result, for a source that shows what it confirmed (the posted comment). */
  | Readonly<{ kind: 'applied'; result?: unknown }>
  | Readonly<{ kind: 'refused' }>
  | Readonly<{ kind: 'uncertain' }>
  | Readonly<{
      kind: 'failed';
      failure?: TriageSourceFailureV1;
      message?: string;
    }>
  | Readonly<{ kind: 'approval' }>;

const OUTCOME_UNKNOWN_CODES: ReadonlySet<string> = new Set([
  'outcome_unknown',
  'action_outcome_unknown',
  'approval_execution_outcome_unknown',
]);

/** A declined confirmation, a cancelled preparation or a retired mount ran nothing. */
function ranNothing(code: string): boolean {
  return (
    code === 'stale_surface' ||
    code === 'cancelled' ||
    code === 'canceled' ||
    code.endsWith('_declined') ||
    code === 'plugin_action_current_intent_rejected' ||
    code === 'action_not_admitted'
  );
}

/**
 * Reads the canonical Action envelope a host control settles with. `null` means nothing ran and
 * nothing needs saying. Anything that may have dispatched without a readable answer is uncertain.
 */
export function projectTriageSourceWriteSettlementV1(
  execution: PluginUiActionControlExecution,
  readResult?: TriageSourceWriteResultReaderV1,
): TriageSourceWriteSettlementV1 | null {
  if (execution.ok) {
    if (isPluginActionApprovalRequestCreated(execution.result))
      return { kind: 'approval' };
    if (readResult !== undefined) return readResult(execution.result);
    const result = TriageTaskWriteResultV1Schema.safeParse(execution.result);
    if (!result.success) return { kind: 'uncertain' };
    switch (result.data.kind) {
      case 'applied':
        return { kind: 'applied' };
      case 'refused':
        return { kind: 'refused' };
      case 'uncertain':
        return { kind: 'uncertain' };
      case 'failed':
        return { kind: 'failed', failure: result.data.failure };
    }
  }
  if (
    OUTCOME_UNKNOWN_CODES.has(execution.errorCode) ||
    execution.effectAttempted === true
  )
    return { kind: 'uncertain' };
  if (ranNothing(execution.errorCode)) return null;
  return { kind: 'failed', message: execution.error };
}

/** Applied and unreadable outcomes may have changed the provider, so the aggregate reads the entry again. */
function mayHaveChangedProvider(
  settlement: TriageSourceWriteSettlementV1,
): boolean {
  return settlement.kind === 'applied' || settlement.kind === 'uncertain';
}

/**
 * A source whose write Action publishes its own result vocabulary (not the shared task-write result) reads it here.
 * An unreadable result is `uncertain`: it may already have reached the provider.
 */
export type TriageSourceWriteResultReaderV1 = (result: unknown) => TriageSourceWriteSettlementV1;

export type TriageSourceWriteV1 = Readonly<{
  /** Stable within the group; it keys the host control. */
  id: string;
  action: PluginUiActionReference;
  /** The exact Action input for this press, or `null` while the write cannot be formed. */
  input: JsonValue | null;
  title: string;
  titleKey?: string;
  variant?: 'primary' | 'secondary' | 'plain' | 'destructive';
  /** The sentence for a confirmed result, when the changed entry does not already say it. */
  appliedTitle?: string;
  appliedTitleKey?: string;
  /** The source's own result vocabulary; omitted, the shared task-write result. */
  readResult?: TriageSourceWriteResultReaderV1;
}>;

type Settled = Readonly<{
  id: string;
  settlement: TriageSourceWriteSettlementV1;
}>;

/**
 * One group of writes on one entry: their host controls and the one line their last outcome
 * earns. Remount the group (key it by the entry's observation) to lift an uncertain hold.
 */
export function TriageSourceWrites({
  writes,
  sourceName,
  sourceUrl,
  onSettled,
  children,
}: Readonly<{
  writes: readonly TriageSourceWriteV1[];
  /** The provider's name, as the outcome line names it ("Sentry"). */
  sourceName: string;
  /** Where to check an uncertain outcome. */
  sourceUrl?: string;
  onSettled?: (id: string, settlement: TriageSourceWriteSettlementV1) => void;
  /** Property controls share this group's settlement, notice and uncertain hold.
   * `settle` reconciles the aggregate once; children only refresh source-native facts.
   */
  children?: (group: Readonly<{
    held: boolean;
    settle: (id: string, execution: PluginUiActionControlExecution) => TriageSourceWriteSettlementV1 | null;
  }>) => React.ReactNode;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const host = usePluginHostApi();
  const completePostMutation = useTriagePostMutationCompletion();
  const [last, setLast] = React.useState<Settled | null>(null);
  const [held, setHeld] = React.useState(false);
  const heldRef = React.useRef(false);
  const latest = React.useRef({ writes, onSettled, completePostMutation });
  React.useLayoutEffect(() => {
    latest.current = { writes, onSettled, completePostMutation };
  });

  const settle = React.useCallback((id: string, execution: PluginUiActionControlExecution) => {
    const settlement = projectTriageSourceWriteSettlementV1(
      execution,
      latest.current.writes.find((write) => write.id === id)?.readResult,
    );
    if (settlement === null) return null;
    if (settlement.kind === 'uncertain') {
      heldRef.current = true;
      setHeld(true);
    }
    setLast({ id, settlement });
    latest.current.onSettled?.(id, settlement);
    if (mayHaveChangedProvider(settlement))
      void latest.current.completePostMutation().catch(() => undefined);
    return settlement;
  }, []);

  const controllers = React.useMemo(() => {
    const byId = new Map<string, PluginUiActionControlController>();
    for (const { id } of writes) {
      byId.set(id, {
        prepare: () => {
          const input =
            latest.current.writes.find((write) => write.id === id)?.input ??
            null;
          return heldRef.current || input === null ? null : { input };
        },
        onSettled: (execution) => {
          settle(id, execution);
        },
      });
    }
    return byId;
    // A controller is per write id; its input is read at preparation, never captured.
  }, [writes.map((write) => write.id).join('\u001f'), settle]);

  const values = { source: sourceName };
  let notice: React.ReactNode = null;
  const settlement = last?.settlement;
  const lastWrite =
    last === null ? undefined : writes.find((write) => write.id === last.id);
  if (settlement?.kind === 'applied') {
    notice = (
      <Banner
        tone="info"
        title={
          lastWrite?.appliedTitle === undefined
            ? text(
                'plugins.triage.sourceWrite.applied',
                '{source} confirmed the change.',
                values,
              )
            : lastWrite.appliedTitleKey === undefined
              ? lastWrite.appliedTitle
              : text(lastWrite.appliedTitleKey, lastWrite.appliedTitle)
        }
      />
    );
  } else if (settlement?.kind === 'approval') {
    notice = (
      <Banner
        tone="neutral"
        title={text(
          'plugins.triage.sourceWrite.approval',
          'Waiting for approval',
        )}
      />
    );
  } else if (settlement?.kind === 'refused') {
    notice = (
      <Banner
        tone="warning"
        title={text(
          'plugins.triage.sourceWrite.refused',
          '{source} did not accept this change.',
          values,
        )}
      />
    );
  } else if (settlement?.kind === 'failed') {
    const fallback = text(
      'plugins.triage.sourceWrite.failed',
      '{source} could not make this change.',
      values,
    );
    notice = (
      <Banner
        tone="danger"
        title={
          settlement.failure === undefined
            ? fallback
            : describeTriageSourceFailureV1(settlement.failure, fallback, text)
        }
        {...(settlement.message === undefined
          ? {}
          : { description: settlement.message })}
      />
    );
  } else if (settlement?.kind === 'uncertain') {
    notice = (
      <Banner
        tone="warning"
        title={text(
          'plugins.triage.sourceWrite.uncertain',
          '{source} may already have made this change.',
          values,
        )}
        description={text(
          'plugins.triage.sourceWrite.uncertain.description',
          'Check it there before trying again.',
        )}
        {...(sourceUrl === undefined
          ? {}
          : {
              action: (
                <Button
                  variant="secondary"
                  size="small"
                  title={text(
                    'plugins.triage.sourceWrite.open',
                    'Open in {source}',
                    values,
                  )}
                  onPress={() => {
                    void host.openExternalLink(sourceUrl);
                  }}
                />
              ),
            })}
      />
    );
  }

  return (
    <>
      {children?.({ held, settle })}
      {writes.map((write) => (
        <Action.Control
          key={write.id}
          action={write.action}
          controller={controllers.get(write.id)!}
          title={write.title}
          {...(write.titleKey === undefined
            ? {}
            : { titleKey: write.titleKey })}
          {...(write.variant === undefined ? {} : { variant: write.variant })}
          disabled={held || write.input === null}
        />
      ))}
      {notice}
    </>
  );
}

/**
 * A comment on the entry, published by the source's own comment Action through the host control: the one comment
 * box every source ends its Activity with (lab c7: one line that grows as the comment does). The field is the
 * author's; the Publish button is the host's, so a draft is never sent without a person's press. A published
 * comment clears the draft; any other outcome keeps it.
 */
export function TriageSourceCommentComposer({
  action,
  buildInput,
  sourceName,
  sourceUrl,
  readResult,
  unavailableReason,
  onPublished,
}: Readonly<{
  action: PluginUiActionReference;
  /** The source's exact comment input for this body, or `null` when it cannot be formed. */
  buildInput: (body: string) => JsonValue | null;
  sourceName: string;
  sourceUrl?: string;
  /** The source's own comment-result vocabulary, when it is not the shared task-write result. */
  readResult?: TriageSourceWriteResultReaderV1;
  /** Why this viewer cannot comment here, as the source states it; the box is replaced by that sentence. */
  unavailableReason?: string | null;
  /** The confirmed comment, with the Action's own result, so the source can show it before the next read. */
  onPublished?: (result: unknown) => void;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const [draft, setDraft] = React.useState('');
  const body = draft.trim();
  const writes = React.useMemo(
    (): readonly TriageSourceWriteV1[] => [
      {
        id: 'comment',
        action,
        input: body === '' ? null : buildInput(draft),
        title: 'Publish comment',
        titleKey: 'plugins.triage.sourceWrite.comment.publish',
        variant: 'secondary',
        appliedTitle: 'Comment published',
        appliedTitleKey: 'plugins.triage.sourceWrite.comment.published',
        ...(readResult === undefined ? {} : { readResult }),
      },
    ],
    [action, body, buildInput, draft, readResult],
  );
  const onSettled = React.useCallback(
    (_id: string, settlement: TriageSourceWriteSettlementV1) => {
      if (settlement.kind !== 'applied') return;
      setDraft('');
      onPublished?.(settlement.result);
    },
    [onPublished],
  );
  if (unavailableReason !== undefined && unavailableReason !== null) {
    return <Text variant="micro" tone="neutral" value={unavailableReason} />;
  }
  return (
    <Stack gap="small">
      <TextField
        presentation="field"
        multiline
        minLines={1}
        label={text('plugins.triage.sourceWrite.comment.label', 'Comment')}
        value={draft}
        onChange={setDraft}
        placeholder={text(
          'plugins.triage.sourceWrite.comment.placeholder',
          'Write a comment',
        )}
      />
      <TriageSourceWrites
        writes={writes}
        sourceName={sourceName}
        {...(sourceUrl === undefined ? {} : { sourceUrl })}
        onSettled={onSettled}
      />
    </Stack>
  );
}
