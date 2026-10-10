import * as React from 'react';
import { resolveHappierSegmentedChoiceRow } from '@happier-dev/plugin-ui/presentation';

import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';

import { Item, type ItemProps } from './Item';

export type SegmentedChoiceOption<T extends string> = Readonly<{
    id: T;
    label: string;
    /** What choosing this option means. The row shows the chosen option's description under its label. */
    description?: string;
    /**
     * A glyph for the option. When every option has one, the segments show glyphs alone and each
     * label becomes its segment's accessible name (theme mode: system, light, dark).
     */
    icon?: React.ReactNode;
    /** This option cannot be chosen right now, and the row's own description already says why. */
    disabled?: boolean;
    /**
     * This option cannot be chosen right now, and why ("tmux is not detected on this machine."). The
     * segment announces it with the option's name and the row shows it under its label.
     */
    unavailableReason?: string;
}>;

export type SegmentedChoiceItemProps<T extends string> = Omit<ItemProps, 'rightElement' | 'onPress' | 'accessoryLayout'> & Readonly<{
    options: ReadonlyArray<SegmentedChoiceOption<T>>;
    value: T;
    onChange: (next: T) => void;
    /** Prefix for per-option test ids (`${testIDPrefix}:${id}`). */
    testIDPrefix?: string;
    accessoryLayout?: ItemProps['accessoryLayout'];
    labelSize?: 'default' | 'field';
}>;

/**
 * A row choosing between two to four short, always-visible options. On a configuration page the
 * control sits beside the label and moves beneath it when the row is too narrow for both.
 *
 * A value choice, so it announces a radio group whose chosen option is checked; the bar it draws is
 * the one segmented control, whose default tab semantics belong to view switches.
 */
export function SegmentedChoiceItem<T extends string>(props: SegmentedChoiceItemProps<T>) {
    const { options, value, onChange, testIDPrefix, disabled, accessoryLayout = 'adaptive', labelSize, ...itemProps } = props;
    // The shared row rule (plugin-ui): which segments are unavailable and what the row says about them.
    // Core keeps its own hosts (the page/menu `Item` and the sliding-thumb bar) over that one rule.
    const row = React.useMemo(() => resolveHappierSegmentedChoiceRow({ options, value }), [options, value]);
    const tabs = React.useMemo(() => row.segments.map((segment, index) => ({
        id: segment.id,
        label: segment.label,
        icon: options[index]?.icon,
        disabled: segment.disabled,
        unavailableReason: segment.unavailableReason,
    })), [options, row.segments]);
    const title = typeof itemProps.title === 'string' ? itemProps.title : undefined;
    const description = row.description ?? itemProps.subtitle;
    const unavailableReasons = row.unavailableReasons;
    const subtitle = unavailableReasons.length === 0
        ? description
        : typeof description === 'string' || description == null
            ? [description, ...unavailableReasons].filter(Boolean).join(' ')
            : <>{description}{` ${unavailableReasons.join(' ')}`}</>;
    return (
        <Item
            {...itemProps}
            subtitle={subtitle}
            disabled={disabled}
            showChevron={false}
            accessoryLayout={accessoryLayout}
            rightElement={
                <SegmentedTabBar<T>
                    tabs={tabs}
                    activeTabId={value}
                    onSelectTab={onChange}
                    slidingThumb
                    labelSize={labelSize}
                    segmentSizing={accessoryLayout === 'stacked' ? 'equal' : 'content'}
                    targetSize="platform"
                    disabled={disabled}
                    accessibilityLabel={title}
                    role="radiogroup"
                    testIDPrefix={testIDPrefix}
                />
            }
        />
    );
}
