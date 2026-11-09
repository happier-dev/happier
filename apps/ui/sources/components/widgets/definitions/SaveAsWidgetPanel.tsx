import * as React from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { WidgetDefinitionV1, WidgetInstanceV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { HappierPageRowFieldLayoutContext } from '@happier-dev/plugin-ui/presentation';

import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import type { IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SelectionListFilterChip } from '@/components/ui/selectionList/SelectionListFilterChips';
import { WidgetFlowPanel, WidgetPreviewWell } from '@/components/widgets/flow/WidgetFlowPanel';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import type { WidgetGroupCopyDestination } from '@/components/widgets/group/widgetGroupCopy';
import { describeAuthoredWidgetDefinitionV1 } from '@/components/widgets/widgetCatalog';
import { randomUUID } from '@/platform/randomUUID';
import { findWorkspaceRefByScope } from '@/sync/domains/workspaces/workspaceRefs';
import { useWorkspaceRefs } from '@/sync/domains/state/storage';
import { useSessionMetadata } from '@/sync/store/hooks';
import { t } from '@/text';

import { createWidgetArtifactWriteAttempt } from './widgetDefinitionCommands';
import { buildWidgetCopySetup, placeWidgetCopyWhenReady, useWidgetCopyTarget, type WidgetCopyAttempt } from './WidgetCopyPanel';

/** A read the Session item makes from its own context, which becomes an input of the copy. */
export type SaveAsWidgetConvertedInput = Readonly<{ path: string; title: string; becomes: 'viewer' | 'context' }>;

/**
 * Save as your widget (lab `dashboards` dagent G3): an explicit copy of a Session Board item into the
 * Account's own widgets. The Session keeps its item. Reads the item made from its Session become
 * inputs, each place filling them; the person names the copy and may also place it, in the same step:
 * Home and this Session's project are offered at once, every other board or project behind
 * "Another place…". One primary action; Back and Cancel write nothing.
 *
 * Saving is `widgets.definition.saveFromSession`. The places offered are exactly Add to…'s. A chosen
 * place whose setup already has every value it needs is placed at once through that place's own setup
 * (`widgets.item.add`, the operation an agent uses); a place that still needs an input continues in its
 * setup step (`onSaved`). The saved copy stays whatever placement does.
 */
export function SaveAsWidgetPanel(props: Readonly<{
    account: Readonly<{ serverId: string; accountId: string }>;
    session: Readonly<{ serverId: string; sessionId: string }>;
    /** The widget being saved, which destinations are projected from; null for content that declares no inputs. */
    instance: WidgetInstanceV1 | null;
    itemId: string;
    defaultName: string;
    converted: readonly SaveAsWidgetConvertedInput[];
    /** The item's body as it shows on the board; the panel draws it in the card it will be. */
    preview?: React.ReactNode;
    mark?: IconName;
    sourceLabel?: string;
    providedContext?: Readonly<Record<string, readonly JsonValue[]>>;
    onBack?: () => void;
    onCancel: () => void;
    /** The copy is saved, and placed wherever the person chose. */
    onDone: () => void;
    /** The copy is saved and these places still need their setup, each in turn. */
    onSaved: (saved: WidgetDefinitionV1, destinationKeys: readonly string[], attempts: ReadonlyMap<string, WidgetCopyAttempt>) => void;
    testID: string;
}>): React.ReactElement {
    const { account, session } = props;
    const current = React.useMemo((): WidgetSurfaceRefV1 => ({ ...account, owner: { kind: 'sessionBoard', sessionId: session.sessionId } }), [account, session.sessionId]);
    const { candidate, destinations, boardsLoading } = useWidgetCopyTarget(props.instance, current);
    const projectKey = useSessionProjectKey(session);
    const [name, setName] = React.useState(props.defaultName);
    // Home starts chosen (lab G3): the copy is for Home unless the person says otherwise.
    const [chosen, setChosen] = React.useState<ReadonlySet<string>>(() => new Set(['home']));
    const [state, setState] = React.useState<'idle' | 'busy' | 'failed' | 'pending'>('idle');
    const inFlight = React.useRef(false);
    const attempt = React.useMemo(() => createWidgetArtifactWriteAttempt('widgets.definition.saveFromSession', account),
        [account.serverId, account.accountId, session.serverId, session.sessionId, props.itemId]);
    const placementAttempts = React.useMemo(() => new Map<string, WidgetCopyAttempt>(), [attempt]);
    const trimmed = name.trim();

    // The places offered at once: Home and the project this Session works in. Everything else is one chooser away.
    const suggested = React.useMemo(() => destinations.filter((destination) => destination.key === 'home'
        || (projectKey !== null && destination.key === `project:${projectKey}`)), [destinations, projectKey]);
    const others = React.useMemo(() => destinations.filter((destination) => !suggested.includes(destination)), [destinations, suggested]);
    const toggle = React.useCallback((key: string) => setChosen((previous) => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    }), []);

    const save = React.useCallback(async () => {
        if (trimmed.length === 0 || inFlight.current || state === 'pending') return;
        inFlight.current = true;
        setState('busy');
        const saved = await attempt.run(() => ({
            account, session, itemId: props.itemId, artifactId: randomUUID(), name: trimmed,
        }));
        if (saved.kind !== 'applied') { inFlight.current = false; setState(saved.kind === 'approvalPending' ? 'pending' : 'failed'); return; }
        const definition = saved.result.definition;
        const places = destinations.filter((destination) => chosen.has(destination.key));
        const remaining = await placeWhereReady({ places, definition, instance: props.instance, itemId: props.itemId, candidate,
            current, providedContext: props.providedContext ?? {}, attempts: placementAttempts, testID: props.testID });
        inFlight.current = false;
        AccessibilityInfo.announceForAccessibility?.(t('widgetDefinition.savedAsYours', { name: trimmed }));
        if (remaining.needsSetup.length > 0) { props.onSaved(definition, remaining.needsSetup, placementAttempts); return; }
        if (places.length > 0) {
            publishPresentationNotice({ key: `widget-save:${props.itemId}`, severity: 'info', message: remaining.approvalPending
                ? `${t('widgetDefinition.savedButNotPlaced')} ${t('widgetAdd.areaApprovalPending')}`
                : t('widgetAdd.justAdded', { widget: trimmed }) });
        }
        props.onDone();
    }, [account, attempt, candidate, chosen, current, destinations, placementAttempts, props, session, state, trimmed]);

    const busy = state === 'busy';
    const otherChosen = others.filter((destination) => chosen.has(destination.key));
    return (
        <WidgetFlowPanel
            title={t('widgetDefinition.saveTitle')}
            hint={t('widgetDefinition.saveHint')}
            {...(props.onBack ? { onBack: props.onBack } : {})}
            note={state === 'pending' ? t('widgetAdd.areaApprovalPending') : t('widgetDefinition.saveNote')}
            error={state === 'failed' ? t('widgetDefinition.saveFailed') : null}
            onCancel={props.onCancel}
            primary={state === 'pending'
                ? { label: t('common.done'), onPress: props.onDone }
                : { label: t('widgetDefinition.saveWidget'), onPress: () => { void save(); }, busy, disabled: trimmed.length === 0,
                    blockedReason: trimmed.length === 0 ? t('widgetDefinition.nameNeeded') : null }}
            testID={props.testID}
        >
            {props.preview ? (
                <WidgetPreviewWell testID={`${props.testID}.preview`} caption={t('widgetAdd.preview')} framed>
                    {/* The card the copy will be: its mark, its name as typed, and where it reads from. */}
                    <WidgetFrame
                        testID={`${props.testID}.card`}
                        frameStyle="card"
                        placement="board"
                        mark={props.mark ?? 'squares-four'}
                        title={trimmed.length > 0 ? trimmed : props.defaultName}
                        {...(props.sourceLabel ? { source: props.sourceLabel } : {})}
                        body={{ kind: 'content', children: props.preview }}
                    />
                </WidgetPreviewWell>
            ) : null}
            <ListPresentationProvider value="page" pageInsets="contained">
                <ItemGroup surface="none" density="compact">
                    <Item
                        testID={`${props.testID}.name`}
                        title={t('widgetDefinition.name')}
                        showChevron={false}
                        accessoryLayout="adaptive"
                        rightElement={(
                            <FieldTextInput testID={`${props.testID}.nameInput`} accessibilityLabel={t('widgetDefinition.name')}
                                value={name} onChangeText={setName} editable={!busy} />
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
                    {destinations.length > 0 || boardsLoading ? (
                        <Item
                            testID={`${props.testID}.places`}
                            title={t('widgetDefinition.alsoAddTo')}
                            showChevron={false}
                            accessoryLayout="adaptive"
                            rightElement={(
                                <PlaceChips>
                                    {suggested.map((destination) => (
                                        <SelectionListFilterChip key={destination.key} filter={{
                                            id: destination.key,
                                            label: t('widgetDefinition.alsoAddTo'),
                                            valueLabel: destination.label,
                                            selected: chosen.has(destination.key),
                                            onToggle: () => toggle(destination.key),
                                            disabled: busy,
                                            testID: `${props.testID}.destination.${destination.key}`,
                                        }} />
                                    ))}
                                    {/* Every other board and project, chosen in one list; the chip names what was chosen. */}
                                    {others.length > 0 || boardsLoading ? (
                                        <SelectionListFilterChip filter={placesFilter({ others, otherChosen, chosen, toggle, busy,
                                            testID: `${props.testID}.anotherPlace` })} />
                                    ) : null}
                                </PlaceChips>
                            )}
                        />
                    ) : null}
                </ItemGroup>
            </ListPresentationProvider>
        </WidgetFlowPanel>
    );
}

/** The chips trail their label beside it, and start at its edge once a narrow row moves them beneath it. */
function PlaceChips(props: React.PropsWithChildren): React.ReactElement {
    const stacked = React.useContext(HappierPageRowFieldLayoutContext)?.stacked === true;
    return <View style={[styles.chips, stacked ? styles.chipsStacked : null]}>{props.children}</View>;
}

function placesFilter(input: Readonly<{
    others: readonly WidgetGroupCopyDestination[];
    otherChosen: readonly WidgetGroupCopyDestination[];
    chosen: ReadonlySet<string>;
    toggle: (key: string) => void;
    busy: boolean;
    testID: string;
}>): React.ComponentProps<typeof SelectionListFilterChip>['filter'] {
    return {
        id: 'anotherPlace',
        label: t('widgetDefinition.alsoAddTo'),
        valueLabel: input.otherChosen.length > 0 ? input.otherChosen.map((destination) => destination.label).join(', ') : t('widgetDefinition.anotherPlace'),
        muted: input.otherChosen.length === 0,
        options: input.others.map((destination) => ({ id: destination.key, label: destination.label })),
        selectedIds: new Set(input.others.filter((destination) => input.chosen.has(destination.key)).map((destination) => destination.key)),
        onChange: input.toggle,
        disabled: input.busy || input.others.length === 0,
        testID: input.testID,
    };
}

/** The project this Session works in, as the copy chooser keys it; null when it has none. */
function useSessionProjectKey(session: Readonly<{ serverId: string; sessionId: string }>): string | null {
    const metadata = useSessionMetadata(session.sessionId, session.serverId);
    const refs = useWorkspaceRefs();
    const machineId = metadata?.machineId ?? null;
    const rootPath = metadata?.path ?? null;
    return React.useMemo(() => {
        if (!machineId || !rootPath || !Array.isArray(refs)) return null;
        const ref = findWorkspaceRefByScope(refs, { serverId: session.serverId, machineId, rootPath });
        return ref ? projectWorkspaceRefV1(ref).projectKey : null;
    }, [machineId, refs, rootPath, session.serverId]);
}

/**
 * Places the saved copy at each chosen place whose setup already has every value it needs, through that
 * place's own setup; returns the places that still need their step (and any whose placement was refused,
 * so the step can say why and retry).
 */
async function placeWhereReady(input: Readonly<{
    places: readonly WidgetGroupCopyDestination[];
    definition: WidgetDefinitionV1;
    instance: WidgetInstanceV1 | null;
    itemId: string;
    candidate: ReturnType<typeof useWidgetCopyTarget>['candidate'];
    current: WidgetSurfaceRefV1;
    providedContext: Readonly<Record<string, readonly JsonValue[]>>;
    attempts: Map<string, WidgetCopyAttempt>;
    testID: string;
}>): Promise<Readonly<{ needsSetup: readonly string[]; approvalPending: boolean }>> {
    // Content that declares no inputs is placed as its own saved definition.
    const instance = input.instance ?? { v: 1, id: input.itemId, definition: { kind: 'inline', definition: input.definition }, bindings: {} } satisfies WidgetInstanceV1;
    const candidate = input.instance ? input.candidate
        : describeAuthoredWidgetDefinitionV1(input.definition, { kind: 'inline', definition: input.definition }, null);
    const needsSetup: string[] = [];
    let approvalPending = false;
    const promoted = { current: input.definition };
    for (const destination of input.places) {
        if (!candidate) { needsSetup.push(destination.key); continue; }
        let attempt = input.attempts.get(destination.key);
        if (!attempt) { attempt = {}; input.attempts.set(destination.key, attempt); }
        const setup = buildWidgetCopySetup({ candidate, destination, instance, current: input.current,
            providedContext: input.providedContext, promoted, attempt, testID: `${input.testID}.${destination.key}` });
        const placed = await placeWidgetCopyWhenReady(setup).catch(() => null);
        if (!placed || !placed.ok) { needsSetup.push(destination.key); continue; }
        if (placed.approvalPending) approvalPending = true;
    }
    return { needsSetup, approvalPending };
}

const styles = StyleSheet.create((theme) => ({
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s6, justifyContent: 'flex-end' },
    chipsStacked: { justifyContent: 'flex-start' },
}));
