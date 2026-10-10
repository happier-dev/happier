import * as React from 'react';

import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';

export type SchemaFieldKind = 'switch' | 'text' | 'number' | 'select' | 'segmented' | 'multiSelect';

/** An explicit presentation wins; automatic registry enums expose up to four choices inline. */
export function resolveSchemaFieldKind(declaration: Readonly<{
    type?: 'boolean' | 'int' | 'float' | 'string' | 'url' | 'email' | 'list' | 'enum' | 'json';
    control?: 'auto' | 'text' | 'password' | 'textarea' | 'switch' | 'select' | 'multiSelect' | 'number' | 'json';
    optionCount?: number;
}>): SchemaFieldKind | null {
    if (declaration.control && declaration.control !== 'auto') {
        switch (declaration.control) {
            case 'switch': case 'select': case 'multiSelect': case 'number': return declaration.control;
            default: return 'text';
        }
    }
    switch (declaration.type) {
        case 'boolean': return 'switch';
        case 'int': case 'float': return 'number';
        case 'string': case 'url': case 'email': case 'list': return 'text';
        case 'enum': {
            const optionCount = declaration.optionCount ?? 0;
            return optionCount === 0 ? null : optionCount <= 4 ? 'segmented' : 'select';
        }
        default: return null;
    }
}

/**
 * Domain adapters supply their declared control and keep validation, drafts and writes. A
 * `segmented` kind has no control here: two to four choices are the one `SegmentedChoiceItem` row.
 */
export type SchemaFieldControlProps =
    | Readonly<{ control: 'switch'; inputProps: React.ComponentProps<typeof Switch> }>
    | Readonly<{ control: 'text'; inputProps: React.ComponentProps<typeof FieldTextInput> }>
    | Readonly<{ control: 'select'; inputProps: React.ComponentProps<typeof DropdownMenu> }>
    | Readonly<{
        control: 'multiSelect';
        options: readonly Readonly<{ id: string; title: string; subtitle?: string; accessibilityLabel: string }>[];
        selectedIds: ReadonlySet<string>;
        disabled: boolean;
        disabledReason?: string | null;
        onToggle: (id: string) => void;
    }>;

/** The ordinary schema-field renderer shared by Home registry and plugin settings. */
export function SchemaFieldControl(props: SchemaFieldControlProps): React.ReactNode {
    switch (props.control) {
        case 'switch': return <Switch {...props.inputProps} />;
        case 'text': return <FieldTextInput {...props.inputProps} />;
        case 'select': return <DropdownMenu {...props.inputProps} />;
        case 'multiSelect': return props.options.map((option) => {
            const toggle = () => props.onToggle(option.id);
            return (
                <Item
                    key={option.id}
                    title={option.title}
                    subtitle={[option.subtitle, props.disabledReason].filter(Boolean).join('\n') || undefined}
                    accessibilityLabel={option.accessibilityLabel}
                    accessibilityHint={props.disabledReason ?? undefined}
                    rightElement={(
                        <Switch
                            value={props.selectedIds.has(option.id)}
                            disabled={props.disabled}
                            accessibilityLabel={option.accessibilityLabel}
                            accessibilityHint={props.disabledReason ?? undefined}
                            onValueChange={toggle}
                        />
                    )}
                    rightElementOutsidePressable
                    showChevron={false}
                    disabled={props.disabled}
                    onPress={toggle}
                />
            );
        });
    }
}
