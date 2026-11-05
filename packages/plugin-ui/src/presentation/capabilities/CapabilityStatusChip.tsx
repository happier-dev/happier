import { memo, type ComponentType, type ReactElement } from 'react';
import { View } from 'react-native';

import { HAPPIER_SPACE_STEPS } from '../../environment/spacing.js';
import {
  presentHappierCapabilityStatus,
  type HappierCapabilityStatus,
  type HappierCapabilityStatusLabels,
  type HappierCapabilityStatusPlacement,
  type HappierCapabilityStatusVariant,
} from './capabilityStatus.js';

export type HappierCapabilityStatusPillProps = Readonly<{
  placement?: HappierCapabilityStatusPlacement;
  variant: HappierCapabilityStatusVariant;
  chrome: 'pill' | 'plain';
  label: string;
  detail?: string;
}>;

export type HappierCapabilityStatusFixProps = Readonly<{
  title: string;
  onPress: () => void;
  testID?: string;
}>;

export type HappierCapabilityStatusChipProps = Readonly<{
  status: HappierCapabilityStatus;
  placement?: HappierCapabilityStatusPlacement;
  /** Catalog rows keep the fix in their independent action slot; the chip alone is drawn. */
  showFix?: boolean;
  testID?: string;
  labels: HappierCapabilityStatusLabels;
  /** The caller's status words, plain in catalog rows and otherwise using the table's chrome. */
  Pill: ComponentType<HappierCapabilityStatusPillProps>;
  /** The caller's small secondary button for the status's one fix. */
  Fix: ComponentType<HappierCapabilityStatusFixProps>;
  /** The caller's quiet meta text for the reason line. */
  Reason: ComponentType<Readonly<{ children: string }>>;
  /** The caller's spacing steps (a compact density tightens them). */
  space?: Readonly<Record<'s2' | 's8', number>>;
}>;

/**
 * A capability status where it speaks: the pill, its one fix beside it, and a reason (why it stopped) wrapping
 * whole under it. Silent statuses (ready, and `off` in rows) draw nothing.
 */
export const HappierCapabilityStatusChip = memo(
  function HappierCapabilityStatusChip(
    props: HappierCapabilityStatusChipProps,
  ): ReactElement | null {
    const { Pill, Fix, Reason } = props;
    const presentation = presentHappierCapabilityStatus(
      props.status,
      props.placement ?? 'row',
      props.labels,
    );
    const pill = presentation.pill;
    if (pill === null) return null;
    const fix = props.status.fix;
    const space = props.space ?? HAPPIER_SPACE_STEPS;
    return (
      <View style={[ROOT, props.placement === 'catalog' ? CATALOG_ROOT : null, { gap: space.s2 }]} testID={props.testID}>
        <View style={[ROW, { gap: space.s8 }]}>
          <Pill
            placement={props.placement ?? 'row'}
            variant={pill.variant}
            chrome={pill.chrome}
            label={pill.label}
            {...(pill.detail === undefined ? {} : { detail: pill.detail })}
          />
          {props.showFix === true &&
          fix !== undefined &&
          presentation.fixLabel !== undefined ? (
            <Fix
              title={presentation.fixLabel}
              onPress={fix.onPress}
              {...(props.testID === undefined
                ? {}
                : { testID: `${props.testID}:fix` })}
            />
          ) : null}
        </View>
        {presentation.reason === undefined ? null : (
          <Reason>{presentation.reason}</Reason>
        )}
      </View>
    );
  },
);

// The pill says the state short; a reason (why it stopped) wraps under it, whole.
const ROOT = {
  minWidth: 0,
  flexShrink: 1,
} as const;
// A catalog row's status word leads its line 2 whole: the description beside it yields first (ST-5).
const CATALOG_ROOT = { flexShrink: 0 } as const;
const ROW = {
  flexDirection: 'row',
  alignItems: 'center',
  minWidth: 0,
  flexShrink: 1,
} as const;
