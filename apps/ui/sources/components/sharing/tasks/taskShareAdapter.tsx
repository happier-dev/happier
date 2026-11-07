import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { TaskRecipientReadinessV1 } from '@happier-dev/protocol/actions/internalTaskActions';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import type { SelectionListOption } from '@/components/ui/selectionList';
import { t } from '@/text';
import type {
  ShareSheetAdapter,
  ShareUiError,
  ShareUiReason,
} from '../shareSheetTypes';

/** The parts of a task record that travel with it: sharing grants the whole stored task. */
type TaskShareSource = Readonly<{
  title: string;
  notes?: string;
  links?: readonly Readonly<{ url: string; title?: string }>[];
  linkedSessions?: Readonly<
    Record<string, Readonly<{ title: string; linkedAt: number }>>
  >;
  blockedBy?: readonly unknown[];
}>;

/** What the people added will read, in the words the review shows. Empty parts are absent. */
export type TaskShareDisclosure = Readonly<{
  notes: string | null;
  links: readonly string[];
  linkedSessionTitles: readonly string[];
  blockedByCount: number;
}>;

/**
 * Whether one grantee can open an encrypted task yet. Keyless reasons are the Account readiness
 * owner's; a Team counts its members still waiting for an envelope.
 */
export type TaskShareRecipientState = TaskRecipientReadinessV1;

function linkLabel(link: Readonly<{ url: string; title?: string }>): string {
  if (link.title?.trim()) return link.title.trim();
  return link.url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '');
}

export function readTaskShareDisclosure(
  task: TaskShareSource,
): TaskShareDisclosure {
  const firstLine =
    task.notes
      ?.split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? null;
  return {
    notes: firstLine,
    links: (task.links ?? []).map(linkLabel),
    linkedSessionTitles: Object.values(task.linkedSessions ?? {})
      .slice()
      .sort((a, b) => b.linkedAt - a.linkedAt)
      .map((entry) => entry.title.trim())
      .filter(Boolean),
    blockedByCount: task.blockedBy?.length ?? 0,
  };
}

/** Preserve mixed collective readiness; missing and empty summaries never imply ready. */
function readinessLabels(
  state: TaskShareRecipientState,
  collective: boolean,
): string[] {
  const labels: string[] = [];
  if (state.readyCount > 0) labels.push(t('status.ready'));
  if (state.pendingCount > 0) labels.push(collective
    ? t('shareSheet.tasks.readiness.membersKeysPending', { count: state.pendingCount })
    : t('shareSheet.tasks.readiness.keysPending'));
  if (state.unavailableCounts.plain_account > 0) labels.push(t('shareSheet.tasks.readiness.homeManaged'));
  if (state.unavailableCounts.encryption_setup_required > 0) labels.push(t('shareSheet.tasks.readiness.setupRequired'));
  if (state.unavailableCounts.encryption_inconsistent > 0) labels.push(t('shareSheet.tasks.readiness.repairRequired'));
  return labels;
}

function DisclosureIcon(
  props: Readonly<{ name: 'note' | 'link' | 'chat-circle' | 'minus-circle' }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  return (
    <Icon
      name={props.name}
      size={ICON_SIZE.md}
      color={theme.colors.text.secondary}
    />
  );
}

function disclosureOptions(
  disclosure: TaskShareDisclosure,
  idPrefix: string,
): SelectionListOption[] {
  const row = (
    id: string,
    label: string,
    subtitle: string,
    icon: 'note' | 'link' | 'chat-circle' | 'minus-circle',
  ): SelectionListOption => ({
    id: `disclosure:${id}`,
    testID: `${idPrefix}task-share-disclosure:${id}`,
    label,
    subtitle,
    subtitleLines: 2,
    icon: () => <DisclosureIcon name={icon} />,
  });
  return [
    ...(disclosure.notes
      ? [
          row(
            'notes',
            t('shareSheet.tasks.disclosure.notes'),
            disclosure.notes,
            'note',
          ),
        ]
      : []),
    ...(disclosure.links.length
      ? [
          row(
            'links',
            t('shareSheet.tasks.disclosure.links'),
            disclosure.links.join(' · '),
            'link',
          ),
        ]
      : []),
    ...(disclosure.linkedSessionTitles.length
      ? [
          row(
            'sessions',
            t('shareSheet.tasks.disclosure.linkedSessions'),
            disclosure.linkedSessionTitles.join(' · '),
            'chat-circle',
          ),
        ]
      : []),
    ...(disclosure.blockedByCount
      ? [
          row(
            'blocked-by',
            t('shareSheet.tasks.disclosure.blockedBy'),
            t('shareSheet.tasks.disclosure.tasks', {
              count: disclosure.blockedByCount,
            }),
            'minus-circle',
          ),
        ]
      : []),
  ];
}

/**
 * The task meaning of the one share sheet: "Can view" / "Can edit" over explicit Account, Team and
 * Group grants, the disclosed content reviewed above the roster, and each grantee's readiness when
 * the owner's tasks are end-to-end encrypted.
 */
export function createTaskShareAdapter(
  input: Readonly<{
    disclosure: TaskShareDisclosure | null;
    /** The owner's persisted Account mode decides this, never key presence. */
    encrypted: boolean;
    readiness: ReadonlyMap<string, TaskShareRecipientState>;
    /** Prepares envelopes for admitted recipients still waiting; absent when the viewer can't. */
    sendKeys?: () => void;
    sendingKeys?: boolean;
    loading: boolean;
    issue?: ShareUiError;
    notice?: ShareUiReason;
    readOnly: boolean;
    retryContent(): void;
  }>,
): ShareSheetAdapter {
  const pendingKeys = [...input.readiness.values()].some(
    (state) => state.pendingCount > 0,
  );
  return {
    namespace: 'task-share',
    title: t('shareSheet.tasks.title'),
    levels: {
      view: {
        label: t('shareSheet.tasks.levels.canView'),
        help: t('shareSheet.tasks.help.view'),
      },
      edit: {
        label: t('shareSheet.tasks.levels.canEdit'),
        help: t('shareSheet.tasks.help.edit'),
      },
    },
    notes: [
      t('shareSheet.tasks.notes.linkedAccess'),
      ...(input.encrypted ? [t('shareSheet.tasks.notes.encrypted')] : []),
    ],
    principalTags: (principal) => {
      const state = input.readiness.get(principal.key);
      return state
        ? readinessLabels(state, principal.ref.kind !== 'account')
        : [];
    },
    sections: (context) => {
      const options = input.disclosure
        ? disclosureOptions(input.disclosure, context.idPrefix)
        : [];
      const leading = options.length
        ? [
            {
              kind: 'static' as const,
              id: 'disclosure',
              title: t('shareSheet.tasks.disclosure.title'),
              options,
            },
          ]
        : undefined;
      const notices: SelectionListOption[] = [];
      if (input.loading)
        notices.push({
          id: 'loading',
          label: t('common.loading'),
          loading: true,
          disabled: true,
        });
      const issue = input.issue;
      if (issue)
        notices.push({
          id: 'issue',
          label: issue.message,
          onSelect: issue.retryable ? input.retryContent : undefined,
          ...(issue.retryable ? { subtitle: t('common.retry') } : {}),
        });
      if (input.notice)
        notices.push({
          id: 'notice',
          label: input.notice.message,
          disabled: true,
        });
      if (input.readOnly)
        notices.push({
          id: 'read-only',
          label: t('shareSheet.tasks.errors.ownerOnly'),
          disabled: true,
        });
      if (pendingKeys && input.sendKeys && !input.readOnly)
        notices.push({
          id: 'send-keys',
          testID: `${context.idPrefix}task-share-send-keys`,
          label: t('shareSheet.tasks.readiness.sendKeys'),
          loading: input.sendingKeys === true,
          onSelect: input.sendKeys,
        });
      return {
        ...(leading ? { leading } : {}),
        ...(notices.length
          ? {
              trailing: [
                { kind: 'static' as const, id: 'status', options: notices },
              ],
            }
          : {}),
      };
    },
  };
}
