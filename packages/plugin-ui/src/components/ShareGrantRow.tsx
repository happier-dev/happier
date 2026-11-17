import * as React from 'react';
import { HappierShareGrantRow, HappierShareLevelControl, HappierShareRowAction,
    type HappierShareGrantRemoval, type HappierShareRowActionProps, type HappierShareHost } from '../presentation/sharing/ShareGrantRow.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { SHARE_ACCESS_LEVEL_ORDER, type ShareAccessLevel, type ShareGrantRowModel, type ShareSheetActions,
    type ShareGrantRowAdapter, type ShareSheetSectionContext } from './shareGrantModels.js';

/** Typography, translated words and glyphs supplied by the mounted host, without sharing policy. */
export type ShareGrantRowPresentation = Readonly<{
    host: HappierShareHost;
    accessLevel: string; remove: string; confirmRemove: string; cancel: string; retry: string;
    accessibleControl(name: string, value: string): string;
    lock(testID: string): React.ReactNode;
    caret(): React.ReactNode;
}>;
export type ShareGrantRowHostProps = Readonly<{ useHost?: () => ShareGrantRowPresentation }>;
function useGrantPresentation(useHost: ShareGrantRowHostProps['useHost']) {
    const mounted = useOptionalPluginUiPresentationHost();
    const binding = useHost ?? mounted?.useShareGrantRowPresentation;
    if (!binding) throw new Error('Share grant controls require a host presentation binding.');
    return binding();
}

/** Domain level order stays with the sharing adapter, not the neutral presenter. */
export function orderShareAccessLevels(levels: readonly ShareAccessLevel[]): readonly ShareAccessLevel[] {
    return SHARE_ACCESS_LEVEL_ORDER.filter(level => levels.includes(level));
}

export function ShareRowAction(props: Omit<HappierShareRowActionProps, 'host'> & ShareGrantRowHostProps): React.ReactElement {
    const { useHost, ...action } = props;
    return <HappierShareRowAction {...action} host={useGrantPresentation(useHost).host} />;
}

function isBusy(row: ShareGrantRowModel): boolean {
    return row.operation.kind === 'saving' || row.operation.kind === 'removing';
}

export function ShareLevelControl<TRow extends ShareGrantRowModel>(props: Readonly<{
    row: TRow; adapter: ShareGrantRowAdapter<TRow>; actions: ShareSheetActions; onExpand(): void; testID: string; editable: boolean;
}> & ShareGrantRowHostProps): React.ReactElement {
    const { row, actions } = props;
    const presentation = useGrantPresentation(props.useHost);
    const { host } = presentation;
    const label = props.adapter.levels[row.level.value]?.label ?? presentation.accessLevel;
    return <HappierShareLevelControl host={host} label={label} testID={props.testID}
        // A quiet mark at the row's trailing-glyph step, in the one icon family, beside the level it locks.
        // In a sheet the viewer manages, a level they cannot change here is marked too, so it reads as a held
        // level rather than as fixed role text like Owner; pressing it says why.
        lock={props.adapter.showsLevelLock?.(row) || (props.editable && row.level.kind === 'locked')
            ? presentation.lock(`${props.testID}:lock`) : undefined}
        accessibilityLabel={presentation.accessibleControl(row.principal.accessibilityLabel, label)}
        disabled={isBusy(row)}
        // The same caret, at the same size, as every other select trigger (the dropdown trigger's own glyph).
        trailing={props.editable && row.level.kind === 'editable' ? presentation.caret() : undefined}
        onPress={() => row.level.kind === 'locked' ? actions.explain(row.level.reason) : props.onExpand()} />;
}

/** Qualify capabilities and bind exact grant callbacks; shared presentation draws every control. */
export function ShareGrantRow<TRow extends ShareGrantRowModel>(props: Readonly<{
    row: TRow; adapter: ShareGrantRowAdapter<TRow>; actions: ShareSheetActions; context: ShareSheetSectionContext;
}> & ShareGrantRowHostProps): React.ReactElement {
    const { row, actions, adapter, context } = props;
    const presentation = useGrantPresentation(props.useHost);
    const { host } = presentation;
    const { editable } = context;
    const removalLabels = adapter.removalLabels?.(row);
    const id = (kind: string) => `${context.idPrefix}${adapter.namespace}-${kind}:${row.principal.key}`;
    const levels = editable && row.level.kind === 'editable' ? orderShareAccessLevels(row.level.options).flatMap(level => {
        const presentation = adapter.levels[level];
        return presentation ? [{ id: level, label: presentation.label, testID: `${id('level')}:${level}`,
            selected: row.level.value === level, accessibilityLabel: `${row.principal.accessibilityLabel}, ${presentation.label}`,
            onPress: () => actions.setAccessLevel(row.grant, level) }] : [];
    }) : undefined;
    let removal: HappierShareGrantRemoval | undefined;
    if (editable && row.removal.kind === 'allowed') removal = { kind: 'allowed', request: {
        testID: id('remove'), label: removalLabels?.request ?? presentation.remove, onPress: () => actions.requestRemove(row.grant),
    } };
    if (editable && row.removal.kind === 'confirming') removal = { kind: 'confirming', consequences: row.removal.consequences,
        consequenceTestID: id('remove-consequence'), confirm: { testID: id('remove-confirm'),
            label: removalLabels?.confirm ?? presentation.confirmRemove, onPress: () => actions.confirmRemove(row.grant) },
        cancel: { testID: id('remove-cancel'), label: presentation.cancel, onPress: () => actions.cancelRemove(row.grant) } };
    if (row.removal.kind === 'blocked') { const reason = row.removal.reason; removal = { kind: 'blocked', explain: {
        testID: id('remove-reason'), label: reason.message, onPress: () => actions.explain(reason),
    } }; }
    return <HappierShareGrantRow host={host} busy={isBusy(row)} levels={levels} removal={removal}
        levelsAccessibilityLabel={`${row.principal.accessibilityLabel}, ${presentation.accessLevel}`}
        lockedReason={row.level.kind === 'locked' ? row.level.reason.message : undefined}
        details={adapter.renderGrantDetails?.(row, context)}
        error={row.operation.kind === 'error' ? row.operation.error.message : undefined}
        retry={editable && row.operation.kind === 'error' && row.operation.error.retryable ? {
            testID: id('retry'), label: presentation.retry, accessibilityLabel: `${row.principal.accessibilityLabel}, ${presentation.retry}`,
            onPress: () => actions.retryMutation(row.grant),
        } : undefined} />;
}
