import * as React from 'react';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';

import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import type { WidgetSetupSubmitResult } from '@/components/widgets/add/widgetSetupModel';
import { WidgetFlowPanel } from '@/components/widgets/flow/WidgetFlowPanel';
import { t } from '@/text';

import { parseSessionVisualNetworkOrigins, type SessionVisualNetworkChoice } from './sessionBoardVisualNetwork';

/**
 * Network access for an existing HTML visual (a Board item, a saved HTML document, a placed widget):
 * none, exact sites, or any site, each with what it means for the viewer. Saving is the owner's
 * ordinary update, so it asks for approval like any other change to what a visual may reach.
 */
export function SessionVisualNetworkPanel(props: Readonly<{
    /** The network the visual holds now; `null` when its stored policy cannot be read. */
    current: SessionVisualNetworkChoice | null;
    onSave: (choice: SessionVisualNetworkChoice) => Promise<WidgetSetupSubmitResult>;
    onClose: () => void;
    testID: string;
}>): React.ReactElement {
    const current = props.current;
    const [mode, setMode] = React.useState<SessionVisualNetworkChoice['mode']>(current?.mode ?? 'none');
    const [sitesText, setSitesText] = React.useState((current?.origins ?? []).join('\n'));
    const [state, setState] = React.useState<'idle' | 'busy' | 'pending' | 'failed'>('idle');
    const [failure, setFailure] = React.useState<string | null>(null);
    const inFlight = React.useRef(false);
    const sites = React.useMemo(() => parseSessionVisualNetworkOrigins(sitesText), [sitesText]);
    const blocked = mode !== 'origins' ? null
        : sites.invalid.length > 0 ? t('sessionBoard.item.network.sitesInvalid', { sites: sites.invalid.join(', ') })
            : sites.origins.length === 0 ? t('sessionBoard.item.network.sitesNeeded') : null;
    const unchanged = current !== null && current.mode === mode
        && (mode !== 'origins' || [...current.origins].sort().join('\n') === [...sites.origins].sort().join('\n'));
    const modes = [
        { id: 'none' as const, label: t('sessionBoard.item.network.none'), description: t('sessionBoard.item.network.noneConsequence') },
        { id: 'origins' as const, label: t('sessionBoard.item.network.sites'), description: t('sessionBoard.item.network.sitesConsequence') },
        { id: 'open' as const, label: t('sessionBoard.item.network.open'), description: t('sessionBoard.item.network.openConsequence') },
    ];
    const commands = useCurrentUiContextLocalCommands(state === 'busy' || state === 'pending' ? [] : [
        { key: 'mode', title: t('sessionBoard.item.network.reach'), invoke: value => {
            const next = modes.find(option => option.id === value);
            if (next) { setMode(next.id); if (state === 'failed') setState('idle'); }
        } },
        ...(mode === 'origins' ? [{ key: 'sites', title: t('sessionBoard.item.network.sitesLabel'), invoke: (value: unknown) => {
            if (typeof value === 'string') setSitesText(value);
        } }] : []),
    ], { unbound: 'local' });
    const save = async () => {
        if (inFlight.current || blocked !== null || state === 'pending') return;
        inFlight.current = true;
        setState('busy');
        const result = await props.onSave({ mode, origins: mode === 'origins' ? sites.origins : [] });
        inFlight.current = false;
        if (result.ok) {
            if (result.approvalPending) { setState('pending'); return; }
            props.onClose();
            return;
        }
        setFailure(result.message);
        setState('failed');
    };
    return (
        <WidgetFlowPanel
            title={t('sessionBoard.item.network.title')}
            hint={t('sessionBoard.item.network.hint')}
            testID={props.testID}
            onCancel={props.onClose}
            // Sharing a public link stays possible with None; beside chosen sites the same line would misread.
            note={state === 'pending' ? t('widgetAdd.areaApprovalPending') : mode === 'none' ? t('sessionBoard.item.network.shareOffNote') : null}
            error={state === 'failed' ? failure ?? t('sessionBoard.item.network.failed') : null}
            primary={state === 'pending'
                ? { label: t('common.done'), onPress: props.onClose }
                // Save is filled only when there is a change it can save; otherwise it recedes, saying why when blocked.
                : { label: t('common.save'), testID: `${props.testID}.save`, onPress: () => { void save(); },
                    busy: state === 'busy', disabled: unchanged || blocked !== null, blockedReason: blocked }}
        >
            <ListPresentationProvider value="page" pageInsets="contained">
                {/* The panel's own header leads straight into the choice; no section spacer between them. */}
                <ItemGroup surface="none" density="compact" header="none">
                    <SegmentedChoiceItem<SessionVisualNetworkChoice['mode']>
                        testID={`${props.testID}.mode`}
                        testIDPrefix={`${props.testID}.mode`}
                        title={t('sessionBoard.item.network.reach')}
                        options={modes}
                        value={mode}
                        onChange={next => { void commands.invoke('mode', next); }}
                    />
                    {mode === 'origins' ? (
                        <Item
                            testID={`${props.testID}.sites`}
                            title={t('sessionBoard.item.network.sitesLabel')}
                            showChevron={false}
                            // A list of addresses is wider than a short value: it sits beneath its label at the
                            // panel's full width, one address per line, rather than wrapping one URL in a side box.
                            accessoryLayout="stacked"
                            rightElement={(
                                <FieldTextInput testID={`${props.testID}.sitesInput`} accessibilityLabel={t('sessionBoard.item.network.sitesLabel')}
                                    value={sitesText} onChangeText={next => { void commands.invoke('sites', next); }} multiline growWithText monospace minLines={1}
                                    placeholder={t('sessionBoard.item.network.sitesPlaceholder')} />
                            )}
                        />
                    ) : null}
                </ItemGroup>
            </ListPresentationProvider>
        </WidgetFlowPanel>
    );
}
