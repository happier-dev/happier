import { useMemo, type ReactElement } from 'react';

import { useOptionalHappierUiPalette } from '../environment/context.js';
import {
  HappierApprovalFields,
  type HappierApprovalFieldRow,
  type HappierApprovalFieldsColors,
} from '../presentation/interaction/ApprovalFields.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import {
  TechnicalDetailsDisclosure,
  type TechnicalDetailsLine,
} from './TechnicalDetailsDisclosure.js';

export type ApprovalFieldRow = HappierApprovalFieldRow;

export type ApprovalFieldsProps = Readonly<{
  /** The request's arguments in the words people read: names, choices and values; exact ids go in `technicalDetails`. */
  rows: readonly ApprovalFieldRow[];
  /**
   * `table` (default): label beside value in one quiet inset table, inside an `ApprovalPrompt`. `stack`: each
   * label over its value.
   */
  anatomy?: 'table' | 'stack';
  /** Exact ids, codes and raw values, folded one tap away as the fields' last line. */
  technicalDetails?: readonly TechnicalDetailsLine[];
  testID?: string;
}>;

/**
 * The arguments an approval would run with, drawn exactly as Happier draws its own approval cards. Put it in an
 * `ApprovalPrompt` body; the decision and what it does stay with the request's owner.
 */
export function ApprovalFields(
  props: ApprovalFieldsProps,
): ReactElement | null {
  const theme = usePluginTheme();
  const translate = usePluginTranslation();
  const palette = useOptionalHappierUiPalette(theme);
  const colors = useMemo(
    (): HappierApprovalFieldsColors => ({
      text: theme.colors.text,
      secondaryText: theme.colors.secondaryText,
      mutedText: theme.colors.mutedText,
      danger: theme.colors.danger,
      inset: palette?.inset ?? theme.colors.control,
    }),
    [palette?.inset, theme],
  );
  const technical = props.technicalDetails ?? [];
  if (props.rows.length === 0 && technical.length === 0) return null;
  return (
    <HappierApprovalFields
      rows={props.rows}
      anatomy={props.anatomy}
      colors={colors}
      radius={theme.radii.control}
      testID={props.testID}
      footer={
        technical.length > 0 ? (
          <TechnicalDetailsDisclosure
            title={translate(
              'happier.plugin-ui.approvalFields.technicalDetails',
              'Technical details',
            )}
            lines={technical}
            testID={
              props.testID ? `${props.testID}.technical-details` : undefined
            }
          />
        ) : null
      }
    />
  );
}
