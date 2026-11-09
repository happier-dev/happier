import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { LeftBehindRowV1 } from '@happier-dev/protocol/machines/processes/machineProcessesV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { selectMachineProcessesLeftBehind } from '@/sync/domains/machines/processes/selectMachineProcessesLeftBehind';
import { t } from '@/text';

import { describeProcessTitle } from './processOwnerIdentity';
import { formatProcessMemory } from './processesCollectionAnatomy';

export type LeftBehindReviewRow = Readonly<{
  row: LeftBehindRowV1;
  ownerTitle: string;
  when: string;
}>;

type ReviewProps = CustomModalInjectedProps &
  Readonly<{
    machineName: string;
    rows: readonly LeftBehindReviewRow[];
    onResolve: (selectedRefs: ReadonlySet<string> | null) => void;
  }>;

/**
 * The Left behind review (lab `rp` L / Lp): exactly the rows the group shows, all selected; unticking one
 * updates the count, the size and the button in place. Its count and size come from the one selector, so
 * what the button says is what the cleanup sends.
 */
function LeftBehindReviewSheet(props: ReviewProps) {
  const { rows, onResolve, onClose } = props;
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(
    () => new Set(rows.map((entry) => entry.row.ref)),
  );
  const selection = React.useMemo(
    () =>
      selectMachineProcessesLeftBehind(
        rows.map((entry) => entry.row),
        { selectedRefs: selected },
      ),
    [rows, selected],
  );
  const toggle = React.useCallback(
    (ref: string) =>
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(ref)) next.delete(ref);
        else next.add(ref);
        return next;
      }),
    [],
  );
  const amount = formatProcessMemory(selection.memoryBytes);
  const resolve = (refs: ReadonlySet<string> | null) => {
    onResolve(refs);
    onClose();
  };
  return (
    <View testID="machine-processes-review" style={styles.body}>
      <Text style={styles.paragraph}>
        {t('machineProcesses.review.body', { machine: props.machineName })}
      </Text>
      <View
        accessibilityRole="list"
        accessibilityLabel={t('machineProcesses.review.rowsLabel')}
      >
        <ItemGroup header="none">
          {rows.map((entry) => {
            const on = selected.has(entry.row.ref);
            const name = describeProcessTitle(entry.row);
            return (
              <Item
                key={entry.row.ref}
                testID={`machine-processes-review-row-${entry.row.ref}`}
                accessibilityRole="checkbox"
                selected={on}
                accessibilityLabel={t('machineProcesses.a11y.select', { name })}
                leftElement={
                  <SelectionCheckGlyph state={on ? 'checked' : 'unchecked'} />
                }
                title={
                  entry.row.command ? `${name}  ${entry.row.command}` : name
                }
                subtitle={t('machineProcesses.leftBehindRow', {
                  owner: entry.ownerTitle,
                  when: entry.when,
                })}
                detail={formatProcessMemory(entry.row.memoryBytes)}
                showChevron={false}
                onPress={() => toggle(entry.row.ref)}
              />
            );
          })}
          <Item
            testID="machine-processes-review-summary"
            mode="info"
            showChevron={false}
            title={t('machineProcesses.review.selected', {
              count: selection.count,
              total: rows.length,
            })}
            detail={amount}
          />
        </ItemGroup>
      </View>
      <View style={styles.footer}>
        <Text style={[styles.note, styles.footerLead]}>
          {t('machineProcesses.review.note')}
        </Text>
        <RoundButton
          testID="machine-processes-review-cancel"
          size="normal"
          display="secondary"
          title={t('common.cancel')}
          onPress={() => resolve(null)}
        />
        <RoundButton
          testID="machine-processes-review-confirm"
          size="normal"
          display="default"
          title={t('machineProcesses.cleanUp', {
            count: selection.count,
            amount,
          })}
          disabled={selection.count === 0}
          onPress={() => resolve(selected)}
        />
      </View>
    </View>
  );
}

/** Open the review over the page (a bottom sheet on a phone); resolves to the chosen refs, or `null`. */
export function showLeftBehindReview(
  input: Readonly<{
    machineName: string;
    rows: readonly LeftBehindReviewRow[];
  }>,
): Promise<ReadonlySet<string> | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: ReadonlySet<string> | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    Modal.show({
      component: LeftBehindReviewSheet,
      props: {
        machineName: input.machineName,
        rows: input.rows,
        onResolve: settle,
      },
      onRequestClose: () => settle(null),
      chrome: {
        kind: 'card',
        title: t('machineProcesses.review.title', { count: input.rows.length }),
        testID: 'machine-processes-review-modal',
        phonePresentation: 'sheet',
        bodyScroll: 'auto',
        dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.86, size: 'md' },
      },
      closeOnBackdrop: true,
    });
  });
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.space.s12,
    paddingBottom: theme.space.s4,
  },
  paragraph: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  footerLead: {
    flex: 1,
    minWidth: 0,
  },
  note: {
    ...Typography.variant('meta'),
    color: theme.colors.text.tertiary,
  },
}));
