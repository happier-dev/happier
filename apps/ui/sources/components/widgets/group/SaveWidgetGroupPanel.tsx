import * as React from 'react';

import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { WidgetFlowPanel } from '@/components/widgets/flow/WidgetFlowPanel';
import { t } from '@/text';

/** What a save came to: kept, waiting for someone's approval, or refused with the reason to show. */
export type SaveWidgetGroupOutcome = Readonly<{ ok: true; approvalPending?: true }> | Readonly<{ ok: false; message: string }>;

/**
 * Save group… (lab wgsaved G): the group's name, asked inline and starting from the group's title, then
 * one Save. The copy lands in Your widgets with the group's options, widgets and the inputs they can
 * follow; the group on the page is unchanged and stays unlinked from it. Cancel writes nothing.
 */
export function SaveWidgetGroupPanel(props: Readonly<{
    defaultName: string;
    childCount: number;
    onSave: (name: string) => Promise<SaveWidgetGroupOutcome>;
    onCancel: () => void;
    onDone: () => void;
    testID: string;
}>): React.ReactElement {
    const [name, setName] = React.useState(props.defaultName);
    const [state, setState] = React.useState<Readonly<{ kind: 'idle' | 'busy' }> | Readonly<{ kind: 'failed'; message: string }>>({ kind: 'idle' });
    const trimmed = name.trim();
    const { onSave, onDone } = props;
    const save = React.useCallback(async () => {
        if (trimmed.length === 0 || state.kind === 'busy') return;
        setState({ kind: 'busy' });
        const outcome = await onSave(trimmed);
        if (!outcome.ok) { setState({ kind: 'failed', message: outcome.message }); return; }
        onDone();
    }, [onDone, onSave, state.kind, trimmed]);
    return (
        <WidgetFlowPanel
            title={t('widgetFrame.groupSaveTitle')}
            hint={t('widgetFrame.groupSaveHint', { count: props.childCount })}
            note={t('widgetFrame.groupSaveNote')}
            error={state.kind === 'failed' ? state.message : null}
            onCancel={props.onCancel}
            primary={{ testID: `${props.testID}.submit`, label: t('widgetFrame.groupSaveTitle'), onPress: () => { void save(); },
                busy: state.kind === 'busy', disabled: trimmed.length === 0,
                blockedReason: trimmed.length === 0 ? t('widgetDefinition.nameNeeded') : null }}
            testID={props.testID}
        >
            <ListPresentationProvider value="page">
                <ItemGroup surface="none" density="compact">
                    <Item
                        testID={`${props.testID}.name`}
                        title={t('widgetDefinition.name')}
                        showChevron={false}
                        rightElement={(
                            <FieldTextInput testID={`${props.testID}.nameInput`} accessibilityLabel={t('widgetDefinition.name')}
                                value={name} onChangeText={setName} editable={state.kind !== 'busy'} autoFocus selectTextOnFocus
                                onSubmitEditing={() => { void save(); }} />
                        )}
                    />
                </ItemGroup>
            </ListPresentationProvider>
        </WidgetFlowPanel>
    );
}
