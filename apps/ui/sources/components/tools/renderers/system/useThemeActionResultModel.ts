import * as React from 'react';
import { themeSurfaceLabel } from '@/theme/css/themeSurfaceLabels';
import {
    THEME_ACTION_IDS, type ThemeActionOutput,
} from '@happier-dev/protocol/actions/themeActionFamily';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectThemeLibraryEntry, projectThemeMiniature } from '@/theme/profiles/themeProfilePresentation';
import type { ThemeLibraryEntry, ThemeProfileDocument } from '@/theme/profiles/themeProfileTypes';
import type { ThemeTryOnOwner } from '@/theme/profiles/themeTryOn';
import type { ThemeProfileCardRedo } from '@/theme/profiles/themeProfileLibrary';
import type { ThemeUiActionExecute } from '@/components/settings/appearance/themeProfiles/useThemeActionExecution';
import type { ThemeDevicePickerInput } from '@/components/settings/appearance/themeProfiles/useThemeDevicePicker';
import type { ThemeActionCardPresentation, TranscriptThemeTry } from '@/components/sessions/transcript/references/transcriptThemeAction';
import type { ThemeActionResultViewProps, ThemeResultOperation, ThemeResultOption, ThemeResultPhase, ThemeResultTheme } from '@/components/tools/renderers/system/themeActionResultViewTypes';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { usePreparedThemeCss } from '@/theme/css/usePreparedThemeCss';
import { getThemeCssWebOnlyRules } from '@/theme/css/prepareThemeCss';
import { resolveCustomThemeSourceLabel } from '@/components/settings/appearance/themeProfiles/themeProfilePresetOptions';
import { t } from '@/text';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';

type Kept = ThemeActionOutput<typeof THEME_ACTION_IDS.keep>;
type Applied = ThemeActionOutput<typeof THEME_ACTION_IDS.apply>;
type Preview = ThemeActionOutput<typeof THEME_ACTION_IDS.tryOn>;
type Outcome = Readonly<{ kind: 'preview'; output: Preview }>
    | Readonly<{ kind: 'kept'; output: Kept }>
    | Readonly<{ kind: 'applied'; output: Applied }>
    | Readonly<{ kind: 'undone'; previous: 'preview' | 'kept' | 'applied' }>;
export type ThemeActionCardEdit = Readonly<{ kind: 'document'; document: ThemeProfileDocument }>
    | Readonly<{ kind: 'entry'; entry: ThemeLibraryEntry }>;
export type ThemeActionCardFacts = Readonly<{
    preview: ThemeTryOnOwner;
    redo?: Readonly<{
        read(cardId: string): ThemeProfileCardRedo | null;
        retain(handle: Kept['undoHandle'], card: ThemeProfileCardRedo): void;
    }>;
    entry: ThemeLibraryEntry | null;
    /** Base selections have display facts from the miniature owner and no library entry. */
    appliedTheme?: Pick<ThemeResultTheme, 'name' | 'mode' | 'miniature'>;
    created: boolean;
    here: string;
    /** Facts of the prior selection from the existing opened/runtime owner, never persisted by the card. */
    before?: Readonly<{ miniature: ThemeResultTheme['miniature']; surfaceStyles?: ThemeResultTheme['surfaceStyles'] }>;
    onEdit?: (target: ThemeActionCardEdit) => void;
    onUseOtherDevices?: (theme: ThemeDevicePickerInput['theme']) => void;
}>;

const tryEntries = new WeakMap<TranscriptThemeTry['input'], ThemeLibraryEntry>();

/** A card previews the Action's chosen appearance without changing the library header. */
export function projectThemeActionTryEntry({ input }: TranscriptThemeTry) {
    if (!input.document) return null;
    let entry = tryEntries.get(input);
    if (!entry) {
        entry = projectThemeLibraryEntry({ ...input.document,
            profile: { ...input.document.profile, assetAppearance: input.mode },
        });
        tryEntries.set(input, entry);
    }
    return entry;
}

/** Card-local presentation and replay data; every effect goes through the existing Action front door. */
export function useThemeActionResultModel(input: ThemeActionCardPresentation, facts: ThemeActionCardFacts,
    execute: ThemeUiActionExecute): ThemeActionResultViewProps | null {
    const presented = useLayoutPresentationActive();
    const call = input.call;
    const [retainedRedo] = React.useState(() => {
        const redo = facts.redo?.read(input.cardId);
        return redo && (redo.optionId === null || input.options.some(option => option.id === redo.optionId)) ? redo : null;
    });
    const [localOutcome, setOutcome] = React.useState<Outcome>(() => {
        if (retainedRedo) return { kind: 'undone', previous: call.actionId === THEME_ACTION_IDS.apply ? 'applied' : 'kept' };
        if (call.actionId === THEME_ACTION_IDS.tryOn) return { kind: 'preview', output: call.output };
        if (call.actionId === THEME_ACTION_IDS.keep) return { kind: 'kept', output: call.output };
        return { kind: 'applied', output: call.output };
    });
    const previewRef = localOutcome.kind === 'preview' ? localOutcome.output.previewRef : null;
    const subscribePreview = React.useCallback((listener: () => void) => presented && previewRef !== null
        ? facts.preview.subscribe(listener) : () => {}, [presented, previewRef, facts.preview]);
    const readPreview = React.useCallback(() => {
        const current = facts.preview.read();
        return current && previewRef !== null && (current.previewRef === previewRef
            || input.options.some(option => option.call.output.previewRef === current.previewRef)) ? current : null;
    }, [facts.preview, input.options, previewRef]);
    const preview = React.useSyncExternalStore(subscribePreview, readPreview, readPreview);
    React.useLayoutEffect(() => presented && preview?.origin.kind === 'agent' ? facts.preview.present(preview.previewRef) : undefined,
        [facts.preview, presented, preview?.previewRef, preview?.origin.kind]);
    const [localOptionKey, setCurrentOptionKey] = React.useState(() => retainedRedo ? retainedRedo.optionId : input.options.at(-1)?.id ?? null);
    // An earlier grouped proposal can settle after the final row already mounted.
    const activeOption = preview ? input.options.find(option => option.call.output.previewRef === preview.previewRef) : undefined;
    const outcome: Outcome = activeOption ? { kind: 'preview', output: activeOption.call.output } : localOutcome;
    const currentOptionKey = activeOption?.id ?? localOptionKey;
    const selected = input.options.find(option => option.id === currentOptionKey)?.call ?? input.replayTry;
    const [revealedCssSource, setRevealedCssSource] = React.useState<string | null>(null);
    // Replaced transcript cards retain their authored input, while preparations share CSS identity.
    const cssSource = preview?.document?.profile.css ?? selected?.input.document?.profile.css ?? '';
    const revealWebOnly = revealedCssSource === cssSource;
    const preparedCss = usePreparedThemeCss(cssSource, presented && (preview !== null || revealWebOnly));
    const surfaceStyles = preview?.document ? preparedCss.prepared?.[preview.mode] : undefined;
    const webOnlyRules = React.useMemo(() => {
        const prepared = preparedCss.prepared;
        return revealWebOnly && prepared ? getThemeCssWebOnlyRules(prepared)
            .map(rule => prepared.source.slice(rule.range.start, rule.range.end)) : undefined;
    }, [revealWebOnly, preparedCss.prepared]);
    const onRevealWebOnly = React.useCallback(() => setRevealedCssSource(cssSource), [cssSource]);
    const [busy, setBusy] = React.useState<ThemeResultOperation | null>(null);
    const [failure, setFailure] = React.useState<Extract<ThemeResultPhase, { kind: 'failed' }> | null>(null);
    const retryOperation = React.useRef<(() => Promise<void>) | null>(null);
    const previewEntry = selected ? projectThemeActionTryEntry(selected) : null;
    const entry = outcome.kind === 'kept' ? outcome.output.entry : previewEntry ?? facts.entry;
    const sourceYours = t('settingsAppearance.themeProfiles.sourceYours');
    const sourceStore = t('settingsAppearance.themeProfiles.sourceStore');
    const sourcePlugin = t('settingsAppearance.themeProfiles.sourcePlugin');
    const defaultThemeName = t('settingsAppearance.themeProfiles.defaultTheme');
    const previousOptions = React.useRef<readonly ThemeResultOption[]>(undefined);
    const options = React.useMemo(() => {
        const rows = input.options.map(option => {
            const entry = projectThemeActionTryEntry(option.call);
            return { key: option.id, name: entry?.name ?? defaultThemeName,
                description: resolveCustomThemeSourceLabel(entry?.source ?? { kind: 'yours' }, { sourceYours, sourceStore, sourcePlugin }),
                miniature: entry?.miniature ?? projectThemeMiniature({ assetAppearance: option.call.input.mode, overrides: { light: {}, dark: {} } }) };
        });
        return previousOptions.current = retainKeyedRows(previousOptions.current, rows, row => row.key);
    }, [input.options, defaultThemeName, sourceYours, sourceStore, sourcePlugin]);
    const invoke = execute;
    const perform = React.useCallback((operation: ThemeResultOperation, effect: () => Promise<void>) => {
        setBusy(operation); setFailure(null); retryOperation.current = effect;
        void effect().catch((error: unknown) => {
            setFailure({ kind: 'failed', operation, code: readActionErrorCodeV1(error) });
        }).finally(() => setBusy(null));
    }, []);
    const tryOption = React.useCallback(async (option: TranscriptThemeTry) => {
        const output = await invoke(THEME_ACTION_IDS.tryOn, option.input);
        setOutcome({ kind: 'preview', output });
        return output;
    }, [invoke]);
    const onTryOption = React.useCallback((key: string) => {
        const option = input.options.find(option => option.id === key);
        if (!option) return;
        perform('try', async () => { await tryOption(option.call); setCurrentOptionKey(key); });
    }, [input.options, perform, tryOption]);
    const onKeep = React.useCallback(() => {
        if (outcome.kind !== 'preview') return;
        perform('keep', async () => {
            const output = await invoke(THEME_ACTION_IDS.keep, { previewRef: outcome.output.previewRef });
            setCurrentOptionKey(currentOptionKey);
            setOutcome({ kind: 'kept', output });
        });
    }, [outcome, currentOptionKey, perform, invoke]);
    const onUndo = React.useCallback(() => {
        if (outcome.kind === 'undone') return;
        perform('undo', async () => {
            if (outcome.kind === 'preview') await invoke(THEME_ACTION_IDS.revert, { previewRef: outcome.output.previewRef });
            else {
                const { undoHandle } = outcome.output;
                await invoke(THEME_ACTION_IDS.undo, { undoHandle });
                facts.redo?.retain(undoHandle, { cardId: input.cardId, optionId: currentOptionKey });
            }
            setCurrentOptionKey(currentOptionKey);
            setOutcome({ kind: 'undone', previous: outcome.kind });
        });
    }, [outcome, perform, invoke, facts.redo, input.cardId, currentOptionKey]);
    const replay = React.useCallback(async () => {
        if (call.actionId === THEME_ACTION_IDS.apply) {
            setOutcome({ kind: 'applied', output: await invoke(THEME_ACTION_IDS.apply, call.input) });
        } else if (selected) {
            const preview = await tryOption(selected);
            if (outcome.kind === 'undone' && outcome.previous === 'kept') {
                setOutcome({ kind: 'kept', output: await invoke(THEME_ACTION_IDS.keep, { previewRef: preview.previewRef }) });
            }
        }
    }, [call, selected, outcome, invoke, tryOption]);
    const onRedo = React.useCallback(() => perform('redo', replay), [perform, replay]);
    const onRetry = React.useCallback(() => {
        if (preparedCss.error) { preparedCss.retry(); return; }
        if (failure?.operation === 'keep' && failure.code === 'theme_preview_stale' && selected) {
            perform('keep', async () => {
                const preview = await tryOption(selected);
                setOutcome({ kind: 'kept', output: await invoke(THEME_ACTION_IDS.keep, { previewRef: preview.previewRef }) });
            });
        } else if (failure && retryOperation.current) perform(failure.operation, retryOperation.current);
        else perform('try', replay);
    }, [preparedCss.error, preparedCss.retry, failure, selected, perform, replay, tryOption, invoke]);
    const display = entry ?? (call.actionId === THEME_ACTION_IDS.apply ? facts.appliedTheme
        : selected?.input.document === null ? { name: defaultThemeName, mode: selected.input.mode,
            miniature: projectThemeMiniature({ assetAppearance: selected.input.mode, overrides: { light: {}, dark: {} } }) } : null);
    if (!display) return null;
    const editTarget: ThemeActionCardEdit | null = outcome.kind === 'preview' && selected?.input.document
        ? { kind: 'document', document: selected.input.document }
        : outcome.kind === 'kept' && outcome.output.entry ? { kind: 'entry', entry: outcome.output.entry }
            : outcome.kind === 'applied' && facts.entry ? { kind: 'entry', entry: facts.entry } : null;
    const deviceTarget: ThemeDevicePickerInput['theme'] | null = outcome.kind === 'kept'
        ? { reference: outcome.output.entry?.reference ?? null, mode: outcome.output.applied.mode, name: display.name }
        : outcome.kind === 'applied' && call.actionId === THEME_ACTION_IDS.apply
            ? { reference: call.input.ref, mode: outcome.output.applied.mode, name: display.name } : null;
    const phase: ThemeResultPhase = (preparedCss.error ? { kind: 'failed' as const, operation: 'try' as const,
        code: readActionErrorCodeV1(preparedCss.error) } : null) ?? failure ?? (outcome.kind === 'preview'
        ? { kind: preview ? 'trying' : 'replaced' }
        : outcome.kind === 'undone'
            ? outcome.previous === 'preview' ? { kind: 'reverted' } : { kind: 'undone', restoredName: null }
            : { kind: outcome.kind === 'kept' ? 'kept' : 'applied' });
    const coverage = outcome.kind === 'preview' ? outcome.output.coverage : null;
    return { theme: { name: display.name, mode: selected?.input.mode ?? display.mode,
        miniature: previewEntry?.miniature ?? display.miniature,
        surfaceStyles,
        created: facts.created }, phase, busy, here: facts.here,
        before: facts.before?.miniature, beforeSurfaceStyles: facts.before?.surfaceStyles,
        options, currentOptionKey, coverage,
        webOnlyRules: coverage ? webOnlyRules : undefined,
        onRevealWebOnly: coverage && coverage.webOnly > 0 ? onRevealWebOnly : undefined,
        reshapes: coverage?.affectedSurfaces.map(address => themeSurfaceLabel(address.surface)),
        hides: coverage?.hides.map(hidden => themeSurfaceLabel(hidden.address.surface)),
        onTryOption, onKeep, onUndo, onRedo, onRetry,
        onEdit: facts.onEdit && editTarget ? () => facts.onEdit!(editTarget) : undefined,
        onUseOtherDevices: facts.onUseOtherDevices && deviceTarget ? () => facts.onUseOtherDevices!(deviceTarget) : undefined,
    };
}
