import * as React from 'react';
import type { PluginUiActionBinding } from '@happier-dev/plugin-sdk/ui';
import { PropertyList, type PropertyEditor, type PropertyListProps } from '../components/PropertyList.js';
import { IconButton, type IconButtonProps } from '../components/Button.js';
import { Form, Toggle, type FormProps, type ToggleProps } from '../components/Form.js';
import type { PluginUiPresentationHost } from './context.js';

/** Host-only commit boundary. Author preparation receives only the committed value and cancellation signal. */
export type PluginUiActionBindingCommit = <Value>(binding: PluginUiActionBinding<Value>, value: Value,
    options?: Readonly<{ signal?: AbortSignal }>) => Promise<unknown>;

/** Withdrawal stops preparation; the Action owner keeps already-admitted effects independent. */
function useInlineActionPreparationSignal(): () => AbortSignal {
    const lifetime = React.useRef<AbortController | null>(null);
    React.useLayoutEffect(() => () => {
        lifetime.current?.abort();
        lifetime.current = null;
    }, []);
    return React.useCallback(() => {
        lifetime.current ??= new AbortController();
        return lifetime.current.signal;
    }, []);
}

/** The host creates the committing editors; author code declares input and consumes settlement only. */
function PluginInlineActionPropertyList({ properties, commit }: Readonly<{
    properties: PropertyListProps; commit: PluginUiActionBindingCommit;
}>): React.ReactElement {
    const getPreparationSignal = useInlineActionPreparationSignal();
    return <PropertyList {...properties} items={properties.items.map(item => {
        const editor = item.editor;
        if (!editor?.action) return item;
        const accessibility = editor.action.accessibilityLabel === undefined ? {} : { accessibilityLabel: editor.action.accessibilityLabel };
        let bound: PropertyEditor;
        if (editor.kind === 'number') {
            const { action, ...local } = editor;
            bound = { ...local, onCommit: (value: number | null) => commit(action, value, { signal: getPreparationSignal() }) };
        } else if (editor.kind === 'list' || editor.kind === 'choices') {
            const { action, ...local } = editor;
            bound = { ...local, onCommit: (value: readonly string[]) => commit(action, value, { signal: getPreparationSignal() }) };
        } else {
            const { action, ...local } = editor;
            bound = { ...local, onCommit: (value: string | null) => commit(action, value, { signal: getPreparationSignal() }) };
        }
        return { ...item, ...accessibility, editor: bound };
    })} />;
}

function PluginInlineActionIconButton({ button, commit }: Readonly<{
    button: IconButtonProps; commit: PluginUiActionBindingCommit;
}>): React.ReactElement {
    const getPreparationSignal = useInlineActionPreparationSignal();
    const { action, ...local } = button;
    return <IconButton {...local} accessibilityLabel={action?.accessibilityLabel ?? local.accessibilityLabel} onPress={() => action ? commit(action, undefined, { signal: getPreparationSignal() }) : undefined} />;
}

function PluginInlineActionForm({ form, commit }: Readonly<{
    form: FormProps; commit: PluginUiActionBindingCommit;
}>): React.ReactElement {
    const getPreparationSignal = useInlineActionPreparationSignal();
    const { action, ...local } = form;
    return <Form {...local} submitAccessibilityLabel={action?.accessibilityLabel ?? local.submitAccessibilityLabel} onSubmit={value => action ? commit(action, value, { signal: getPreparationSignal() }) : undefined} />;
}

function PluginInlineActionToggle({ toggle, commit }: Readonly<{
    toggle: ToggleProps; commit: PluginUiActionBindingCommit;
}>): React.ReactElement {
    const getPreparationSignal = useInlineActionPreparationSignal();
    const { action, ...local } = toggle;
    return <Toggle {...local} accessibilityLabel={action?.accessibilityLabel ?? local.accessibilityLabel}
        onChange={value => action ? commit(action, value, { signal: getPreparationSignal() }) : undefined} />;
}

/** One physical-control presentation shared by app hosts and public semantic test hosts. */
export function createPluginUiActionBindingPresentation(commit: PluginUiActionBindingCommit): Pick<PluginUiPresentationHost,
    'renderActionPropertyList' | 'renderActionIconButton' | 'renderActionForm' | 'renderActionToggle'> {
    return {
        renderActionPropertyList: properties => <PluginInlineActionPropertyList properties={properties} commit={commit} />,
        renderActionIconButton: button => <PluginInlineActionIconButton button={button} commit={commit} />,
        renderActionForm: form => <PluginInlineActionForm form={form} commit={commit} />,
        renderActionToggle: toggle => <PluginInlineActionToggle toggle={toggle} commit={commit} />,
    };
}
