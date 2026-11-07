import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { TrashRestoreResultV1 } from '@happier-dev/protocol/storage/storageV1';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';

import { storageReasonLabel } from './storageReasonPresentation';

export type RestoreRecoveryOutcome = TrashRestoreResultV1['outcomes'][number];
export type RestoreRecoveryOutcomes = Readonly<
  Record<string, RestoreRecoveryOutcome>
>;
/** A Trash entry as the person knows it: what it was called and where it came from. */
export type RestoreRecoveryEntry = Readonly<{
  entryId: string;
  title: string;
  originalPath: string;
}>;

const unsettled = (outcome: RestoreRecoveryOutcome | undefined): boolean =>
  outcome?.status === 'refused' || outcome?.status === 'failed';

/** Entries as last listed: a restored entry leaves the owner's list, but its success line still names it. */
export function useRememberedRestoreEntries(entries: readonly RestoreRecoveryEntry[]): readonly RestoreRecoveryEntry[] {
  const known = React.useRef(new Map<string, RestoreRecoveryEntry>());
  for (const entry of entries) known.current.set(entry.entryId, entry);
  return [...known.current.values()];
}

/**
 * The entries whose Put back was refused or failed, kept by id so that a later success stays on screen with
 * where it went. The storage owner's per-entry outcomes are the only facts: `scope` narrows them to the
 * entries one receipt owns, and a new `resetKey` (a new receipt) starts over. `dismiss` closes what is shown;
 * a new attempt for the same entry reads as a new outcome and opens it again.
 */
export function useTrackedRestoreRefusals(
  outcomes: RestoreRecoveryOutcomes,
  options: Readonly<{
    scope?: readonly string[] | null;
    resetKey?: string | null;
    /** The entries the owner lists now. A restored entry leaves them, so what was seen is kept for its success line. */
    entries?: readonly RestoreRecoveryEntry[];
  }> = {},
): Readonly<{ ids: readonly string[]; entries: readonly RestoreRecoveryEntry[]; dismiss: () => void }> {
  const key = options.resetKey ?? null;
  const remembered = useRememberedRestoreEntries(options.entries ?? []);
  const dismissed = React.useRef(new WeakSet<RestoreRecoveryOutcome>());
  const [tracked, setTracked] = React.useState<
    Readonly<{ key: string | null; ids: readonly string[] }>
  >({ key, ids: [] });
  const base = tracked.key === key ? tracked.ids : [];
  const added = Object.values(outcomes)
    .filter((outcome) => unsettled(outcome) && !base.includes(outcome.entryId)
      && (!options.scope || options.scope.includes(outcome.entryId)) && !dismissed.current.has(outcome))
    .map((outcome) => outcome.entryId);
  const ids = added.length > 0 ? [...base, ...added] : base;
  if (tracked.key !== key || added.length > 0) setTracked({ key, ids });
  const dismiss = React.useCallback(() => {
    for (const outcome of Object.values(outcomes))
      dismissed.current.add(outcome);
    setTracked({ key, ids: [] });
  }, [key, outcomes]);
  return { ids, entries: remembered, dismiss };
}

function sentence(text: string): string {
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}.` : text;
}

/**
 * A refused Put back, said where the person asked for it (R42 / qa-fst F3): each entry by name, why the machine
 * did not put it back, and the one recovery the owner offers — Put back beside it, which never overwrites the
 * place's occupant. A success afterwards says where it went. Rows join the owner's outcomes to entries by entry
 * id; nothing here decides whether a restore may happen.
 */
export const StorageRestoreRecovery = React.memo(
  function StorageRestoreRecovery(
    props: Readonly<{
      ids: readonly string[];
      /** Entries the owner still lists; a restored entry leaves them, so names are kept once seen. */
      entries: readonly RestoreRecoveryEntry[];
      outcomes: RestoreRecoveryOutcomes;
      homeDir: string | undefined;
      onPutBackBeside: ((entryId: string) => unknown) | null;
      onDone: () => void;
      compact: boolean;
      /** `bar`: under a pile bar's line. `list`: the first thing in a list's sheet (the Trash page). */
      placement?: 'bar' | 'list';
      testID?: string;
    }>,
  ) {
    const { theme } = useUnistyles();
    const byId = new Map(props.entries.map((entry) => [entry.entryId, entry]));
    const [busy, setBusy] = React.useState<ReadonlySet<string>>(new Set());
    const putBeside = props.onPutBackBeside;
    const run = React.useCallback(
      (entryId: string) => {
        if (!putBeside) return;
        setBusy((current) => new Set(current).add(entryId));
        void Promise.resolve(putBeside(entryId)).finally(() =>
          setBusy((current) => {
            const next = new Set(current);
            next.delete(entryId);
            return next;
          }),
        );
      },
      [putBeside],
    );
    const rows = props.ids.flatMap((entryId) => {
      const entry = byId.get(entryId);
      const outcome = props.outcomes[entryId];
      return entry && outcome ? [{ entry, outcome }] : [];
    });
    if (rows.length === 0) return null;
    const testID = props.testID ?? 'machine-storage-restore-recovery';
    // Once everything is back, Done ends the last row's line instead of taking a line of its own.
    const settled = rows.every(({ outcome }) => outcome.status === 'restored');
    return (
      <View
        testID={testID}
        style={[styles.root, props.placement === 'list' ? styles.inList : null]}
        accessibilityLiveRegion="polite"
      >
        {rows.map(({ entry, outcome }, index) => {
          const occupied =
            outcome.status === 'refused' &&
            outcome.reason?.code === 'destination_occupied';
          return (
            <View
              key={entry.entryId}
              testID={`${testID}-${entry.entryId}`}
              style={[styles.row, props.compact ? styles.rowCompact : null]}
            >
              {outcome.status === 'restored' ? (
                <Icon
                  name="check-circle"
                  size={16}
                  color={theme.colors.state.success.textForeground}
                />
              ) : (
                <Icon
                  name="warning"
                  size={16}
                  color={theme.colors.text.secondary}
                />
              )}
              <View style={styles.copy}>
                <Text style={styles.title} numberOfLines={1}>
                  {entry.title}
                </Text>
                <Text style={styles.note}>
                  {outcome.status === 'restored'
                    ? t('machineStorage.page.putBackAs', {
                        path: formatPathRelativeToHome(
                          outcome.path ?? entry.originalPath,
                          props.homeDir,
                        ),
                      })
                    : occupied
                      ? t('machineStorage.page.putBackOccupied')
                      : sentence(
                          storageReasonLabel(
                            outcome.reason ?? { code: 'operation_failed' },
                          ),
                        )}
                </Text>
              </View>
              {occupied && putBeside ? (
                <TextLinkButton
                  testID={`${testID}-${entry.entryId}-beside`}
                  label={t('machineStorage.page.putBackBeside')}
                  tone="strong"
                  disabled={busy.has(entry.entryId)}
                  onPress={() => run(entry.entryId)}
                />
              ) : null}
              {settled && index === rows.length - 1 ? (
                <TextLinkButton
                  testID={`${testID}-done`}
                  label={t('machineStorage.pile.done')}
                  tone="strong"
                  onPress={props.onDone}
                />
              ) : null}
            </View>
          );
        })}
      </View>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  root: {
    gap: theme.space.s8,
  },
  inList: {
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s12,
    borderTopWidth: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border.surface,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s12,
  },
  rowCompact: {
    alignItems: 'flex-start',
    flexWrap: 'wrap',
  },
  copy: {
    flex: 1,
    minWidth: 0,
    gap: theme.space.s2,
  },
  title: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.primary,
  },
  note: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
  },
}));
