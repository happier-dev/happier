import * as React from 'react';
import { AccessibilityInfo } from 'react-native';
import type { WidgetInputBindingsV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import { useWorkBoards } from '@/components/boards/model/useWorkBoards';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';
import { WidgetFlowPanel, WidgetPreviewWell } from '@/components/widgets/flow/WidgetFlowPanel';

import { runWidgetDefinitionCommand } from './widgetDefinitionCommands';

/** A read the Session item makes from its own context, which becomes an input of the copy. */
export type SaveAsWidgetConvertedInput = Readonly<{ path: string; title: string; becomes: 'viewer' | 'context' }>;

type Destination = Readonly<{ key: string; label: string; surface: WidgetSurfaceRefV1 }>;

/**
 * Where the person can also put the new widget: Home and each of their WorkBoards — personal
 * surfaces of the same Account. Never another Home.
 */
export function useSaveAsWidgetDestinations(account: Readonly<{ serverId: string; accountId: string }>): readonly Destination[] {
    const boards = useWorkBoards().boards;
    return React.useMemo((): readonly Destination[] => [
        { key: 'home', label: t('widgetDefinition.placedOnHome'), surface: { ...account, owner: { kind: 'home' } } },
        ...boards.map((board): Destination => ({ key: `board:${board.id}`, label: board.name,
            surface: { ...account, owner: { kind: 'workBoard', boardId: board.id } } })),
    ], [account, boards]);
}

/**
 * Save as your widget (lab `dashboards` dagent G3): an explicit copy of a Session Board item into the
 * Account's own widgets. The Session keeps its item. Reads the item made from its Session become
 * inputs, each place filling them; the person names the copy and may also place it on Home or a
 * board. One primary action; Back and Cancel write nothing. Saving is `widgets.definition.saveFromSession`
 * and each placement `widgets.instance.add` — the same operations an agent uses.
 */
export function SaveAsWidgetPanel(props: Readonly<{
    account: Readonly<{ serverId: string; accountId: string }>;
    session: Readonly<{ serverId: string; sessionId: string }>;
    itemId: string;
    defaultName: string;
    converted: readonly SaveAsWidgetConvertedInput[];
    preview?: React.ReactNode;
    onBack?: () => void;
    onCancel: () => void;
    onDone: () => void;
    testID: string;
}>): React.ReactElement {
    const destinations = useSaveAsWidgetDestinations(props.account);
    const [name, setName] = React.useState(props.defaultName);
    const [chosen, setChosen] = React.useState<ReadonlySet<string>>(() => new Set());
    const [state, setState] = React.useState<'idle' | 'busy' | 'failed' | 'partial'>('idle');
    const trimmed = name.trim();

    const save = React.useCallback(async () => {
        if (trimmed.length === 0 || state === 'busy') return;
        setState('busy');
        const artifactId = randomUUID();
        const saved = await runWidgetDefinitionCommand('widgets.definition.saveFromSession', {
            account: props.account, session: props.session, itemId: props.itemId, artifactId, name: trimmed,
        }, props.account);
        if (saved.kind !== 'applied') { setState('failed'); return; }
        const bindings: WidgetInputBindingsV1 = saved.result.suggestedBindings;
        const adds = await Promise.all(destinations.filter((destination) => chosen.has(destination.key)).map((destination) => (
            runWidgetDefinitionCommand('widgets.instance.add', { surface: destination.surface,
                instance: { v: 1, id: randomUUID(), definition: { kind: 'artifact', artifactId }, bindings } }, props.account)
        )));
        if (adds.some((outcome) => outcome.kind === 'refused')) { setState('partial'); return; }
        AccessibilityInfo.announceForAccessibility?.(t('widgetDefinition.savedAsYours', { name: trimmed }));
        props.onDone();
    }, [chosen, destinations, props, state, trimmed]);

    return (
        <WidgetFlowPanel
            title={t('widgetDefinition.saveTitle')}
            hint={t('widgetDefinition.saveHint')}
            {...(props.onBack ? { onBack: props.onBack } : {})}
            note={state === 'partial' ? t('widgetDefinition.savedButNotPlaced') : t('widgetDefinition.saveNote')}
            error={state === 'failed' ? t('widgetDefinition.saveFailed') : null}
            onCancel={props.onCancel}
            primary={state === 'partial'
                ? { label: t('common.done'), onPress: props.onDone }
                : { label: t('widgetDefinition.saveWidget'), onPress: () => { void save(); }, busy: state === 'busy', disabled: trimmed.length === 0,
                    blockedReason: trimmed.length === 0 ? t('widgetDefinition.nameNeeded') : null }}
            testID={props.testID}
        >
            {props.preview ? (
                <WidgetPreviewWell testID={`${props.testID}.preview`} caption={t('widgetAdd.previewLive')}>
                    {props.preview}
                </WidgetPreviewWell>
            ) : null}
            <ListPresentationProvider value="page">
                <ItemGroup surface="none" density="compact">
                    <Item
                        testID={`${props.testID}.name`}
                        title={t('widgetDefinition.name')}
                        showChevron={false}
                        rightElement={(
                            <FieldTextInput testID={`${props.testID}.nameInput`} accessibilityLabel={t('widgetDefinition.name')}
                                value={name} onChangeText={setName} editable={state !== 'busy'} />
                        )}
                    />
                    {props.converted.map((input) => (
                        <Item
                            key={input.path}
                            testID={`${props.testID}.converted.${input.path}`}
                            title={input.title}
                            subtitle={input.becomes === 'viewer' ? t('widgetDefinition.becomesViewerInput') : t('widgetDefinition.becomesContextInput')}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
                <ItemGroup surface="none" density="compact" title={t('widgetDefinition.alsoAddTo')}>
                    {destinations.map((destination) => (
                        <Item
                            key={destination.key}
                            testID={`${props.testID}.destination.${destination.key}`}
                            title={destination.label}
                            showChevron={false}
                            rightElement={(
                                <Switch
                                    accessibilityLabel={t('widgetDefinition.alsoAddToNamed', { place: destination.label })}
                                    value={chosen.has(destination.key)}
                                    disabled={state === 'busy'}
                                    onValueChange={(on: boolean) => setChosen((previous) => {
                                        const next = new Set(previous);
                                        if (on) next.add(destination.key); else next.delete(destination.key);
                                        return next;
                                    })}
                                />
                            )}
                        />
                    ))}
                </ItemGroup>
            </ListPresentationProvider>
        </WidgetFlowPanel>
    );
}
