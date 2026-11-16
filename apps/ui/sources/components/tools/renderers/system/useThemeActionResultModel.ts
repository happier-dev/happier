import * as React from 'react';
import {
    THEME_ACTION_IDS, type ThemeActionOutput,
} from '@happier-dev/protocol/actions/themeActionFamily';
import { readRpcFailureCode } from '@/sync/ops/actions/rpcFailureCode';
import { projectThemeLibraryEntry } from '@/theme/profiles/themeProfilePresentation';
import type { ThemeLibraryEntry } from '@/theme/profiles/themeProfileTypes';
import type { ThemeTryOnOwner } from '@/theme/profiles/themeTryOn';
import type { ThemeUiActionExecute } from '@/components/settings/appearance/themeProfiles/useThemeActionExecution';
import type { ThemeActionCardPresentation, TranscriptThemeTry } from '@/components/sessions/transcript/references/transcriptThemeAction';
import type { ThemeActionResultViewProps, ThemeResultOperation, ThemeResultPhase } from '@/components/tools/renderers/system/themeActionResultViewTypes';

type Kept = ThemeActionOutput<typeof THEME_ACTION_IDS.keep>;
type Applied = ThemeActionOutput<typeof THEME_ACTION_IDS.apply>;
type Preview = ThemeActionOutput<typeof THEME_ACTION_IDS.tryOn>;
type Outcome = Readonly<{ kind: 'preview'; output: Preview }>
    | Readonly<{ kind: 'kept'; output: Kept }>
    | Readonly<{ kind: 'applied'; output: Applied }>
    | Readonly<{ kind: 'undone'; previous: 'preview' | 'kept' | 'applied' }>;
export type ThemeActionCardFacts = Readonly<{
    preview: ThemeTryOnOwner;
    entry: ThemeLibraryEntry | null;
    created: boolean;
    here: string;
    onEdit?: () => void;
    onUseOtherDevices?: () => void;
}>;

/** Card-local presentation and replay data; every effect goes through the existing Action front door. */
export function useThemeActionResultModel(input: ThemeActionCardPresentation, facts: ThemeActionCardFacts,
    execute: ThemeUiActionExecute): ThemeActionResultViewProps | null {
    const preview = React.useSyncExternalStore(facts.preview.subscribe, facts.preview.read, facts.preview.read);
    const call = input.call;
    const [outcome, setOutcome] = React.useState<Outcome>(() => {
        if (call.actionId === THEME_ACTION_IDS.tryOn) return { kind: 'preview', output: call.output };
        if (call.actionId === THEME_ACTION_IDS.keep) return { kind: 'kept', output: call.output };
        return { kind: 'applied', output: call.output };
    });
    const [currentOptionKey, setCurrentOptionKey] = React.useState(() => input.options.at(-1)?.id ?? null);
    const [busy, setBusy] = React.useState<ThemeResultOperation | null>(null);
    const [failure, setFailure] = React.useState<Extract<ThemeResultPhase, { kind: 'failed' }> | null>(null);
    const retryOperation = React.useRef<(() => Promise<void>) | null>(null);
    const selected = input.options.find(option => option.id === currentOptionKey)?.call ?? input.replayTry;
    const previewEntry = React.useMemo(() => selected ? projectThemeLibraryEntry(selected.input.document) : null, [selected]);
    const entry = outcome.kind === 'kept' ? outcome.output.entry : previewEntry ?? facts.entry;
    const options = React.useMemo(() => input.options.map(option => ({
        key: option.id, name: option.call.input.document.profile.name, description: '',
        miniature: projectThemeLibraryEntry(option.call.input.document).miniature,
    })), [input.options]);
    const invoke = execute;
    const perform = React.useCallback((operation: ThemeResultOperation, effect: () => Promise<void>) => {
        setBusy(operation); setFailure(null); retryOperation.current = effect;
        void effect().catch((error: unknown) => {
            setFailure({ kind: 'failed', operation, code: readRpcFailureCode(error) ?? null });
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
        perform('keep', async () => setOutcome({ kind: 'kept', output: await invoke(THEME_ACTION_IDS.keep, { previewRef: outcome.output.previewRef }) }));
    }, [outcome, perform, invoke]);
    const onUndo = React.useCallback(() => {
        if (outcome.kind === 'undone') return;
        perform('undo', async () => {
            if (outcome.kind === 'preview') await invoke(THEME_ACTION_IDS.revert, { previewRef: outcome.output.previewRef });
            else await invoke(THEME_ACTION_IDS.undo, { undoHandle: outcome.output.undoHandle });
            setOutcome({ kind: 'undone', previous: outcome.kind });
        });
    }, [outcome, perform, invoke]);
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
        if (failure?.operation === 'keep' && failure.code === 'theme_preview_stale' && selected) {
            perform('keep', async () => {
                const preview = await tryOption(selected);
                setOutcome({ kind: 'kept', output: await invoke(THEME_ACTION_IDS.keep, { previewRef: preview.previewRef }) });
            });
        } else if (failure && retryOperation.current) perform(failure.operation, retryOperation.current);
        else perform('try', replay);
    }, [failure, selected, perform, replay, tryOption, invoke]);
    if (!entry) return null;
    const phase: ThemeResultPhase = failure ?? (outcome.kind === 'preview'
        ? { kind: preview?.previewRef === outcome.output.previewRef ? 'trying' : 'replaced' }
        : outcome.kind === 'undone'
            ? outcome.previous === 'preview' ? { kind: 'reverted' } : { kind: 'undone', restoredName: null }
            : { kind: outcome.kind === 'kept' ? 'kept' : 'applied' });
    const coverage = outcome.kind === 'preview' ? outcome.output.coverage : null;
    return { theme: { name: entry.name, mode: entry.mode, miniature: entry.miniature,
        created: facts.created }, phase, busy, here: facts.here,
        options, currentOptionKey, coverage,
        reshapes: coverage?.affectedSurfaces.map(address => address.surface),
        hides: coverage?.hides.map(hidden => hidden.address.surface),
        onTryOption, onKeep, onUndo, onRedo, onRetry,
        onEdit: facts.onEdit,
        onUseOtherDevices: outcome.kind === 'kept' || outcome.kind === 'applied' ? facts.onUseOtherDevices : undefined,
    };
}
