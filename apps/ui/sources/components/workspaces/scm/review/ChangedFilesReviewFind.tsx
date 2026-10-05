import * as React from 'react';
import { Platform, TextInput, View } from 'react-native';
import type { FindController } from '@happier-dev/plugin-ui/presentation';
import { FindBar } from '@/components/ui/find/FindBar';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Text } from '@/components/ui/text/Text';
import { useUnistyles } from 'react-native-unistyles';
import { useFindSurfaceRegistration, useFindSurfaceRuntime } from '@/keyboard/KeyboardShortcutProvider';
import { readDocumentFocusReturnTarget, restoreFocusToBestTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { ComposerKeyboardFloatingInset } from '@/components/sessions/keyboardAvoidance';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';
import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';
import { Typography } from '@/constants/Typography';
import type { ChangedFilesReviewFindModel } from './useChangedFilesReviewFind';

export function ChangedFilesReviewFindButton(props: Readonly<{ surfaceId: string }>) {
    const runtime = useFindSurfaceRuntime();
    return <IconButton testID="scm-review-find" iconName="magnifying-glass" variant="plain"
        minimumInteractiveTargetSize={resolveTouchTargetFloorPx() ?? undefined}
        accessibilityLabel={t('find.surface.changes')} tooltip={t('find.surface.changes')}
        onPress={() => { runtime.open(props.surfaceId); }} />;
}

export function ChangedFilesReviewFindCount(props: Readonly<{ model?: ChangedFilesReviewFindModel; path: string }>) {
    const { theme } = useUnistyles();
    const model = props.model;
    const count = React.useSyncExternalStore(
        React.useCallback((listener) => model?.subscribeFile(props.path, listener) ?? (() => {}), [model, props.path]),
        () => model?.getFileSnapshot(props.path).count ?? 0,
    );
    // The count wears the match tint (Find lab `.fd-fc`), so the index reads as where the marks are.
    return count ? <View style={{ minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.find.matchAll }}>
        <Text testID={`scm-review-find-count:${props.path}`} accessibilityLabel={t('find.count', { current: null, total: count })}
            style={{ color: theme.colors.text.primary, fontSize: 11, lineHeight: 14, ...Typography.default('semiBold'), ...Typography.tabular() }}>{String(count)}</Text>
    </View> : null;
}

export function ChangedFilesReviewFindSurface(props: Readonly<{
    model: ChangedFilesReviewFindModel;
    surfaceId: string;
    surfaceRef: React.RefObject<View | null>;
    presented: boolean;
}>) {
    const { model } = props;
    const snapshot = React.useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
    const eligible = usePluginSurfaceFocusEligibility() && props.presented;
    const input = React.useRef<TextInput | null>(null);
    const [inputFocused, setInputFocused] = React.useState(false);
    const returnFocus = React.useRef<FocusReturnTarget>(null);
    const device = useDeviceType();
    const close = () => {
        model.close(); setInputFocused(false); restoreFocusToBestTarget(returnFocus); returnFocus.current = null;
    };
    const controller: FindController = {
        get query() { return model.query; }, get options() { return model.options; }, get status() { return model.status; },
        capabilities: model.capabilities, setQuery: model.setQuery, setOptions: model.setOptions, step: model.step, stop: model.stop, close,
    };
    const open = () => {
        if (!model.getSnapshot().open) returnFocus.current = Platform.OS === 'web' && typeof document !== 'undefined'
            ? readDocumentFocusReturnTarget(document) : TextInput.State.currentlyFocusedInput();
        model.open(); input.current?.focus();
    };
    useFindSurfaceRegistration(eligible ? { surfaceId: props.surfaceId, open, controller,
        isOpen: () => snapshot.open, isInputFocused: () => inputFocused,
        containsFocus: () => {
            if (!eligible) return false;
            if (Platform.OS !== 'web') return true;
            const root = props.surfaceRef.current as unknown as HTMLElement | null;
            return !!root && typeof document !== 'undefined' && root.contains(document.activeElement);
        } } : null);
    if (!snapshot.open || !eligible) return null;
    const bar = <FindBar testID="scm-review-find-field" autoFocus surfaceLabel={t('find.surface.changes')} query={snapshot.query} options={snapshot.options}
        status={snapshot.status} capabilities={model.capabilities} onQueryChange={model.setQuery} onOptionsChange={model.setOptions}
        onStep={model.step} onClose={close} onStop={model.stop} inputRef={input}
        onInputFocus={() => setInputFocused(true)} onInputBlur={() => setInputFocused(false)}
        presentation={device === 'phone' ? 'keyboardSeated' : 'inline'} />;
    return device === 'phone'
        ? <ComposerKeyboardFloatingInset testID="scm-review-find-bar" style={{ position: 'absolute', left: 0, right: 0, zIndex: 2 }}>{bar}</ComposerKeyboardFloatingInset>
        : <View testID="scm-review-find-bar" pointerEvents="box-none" style={{ position: 'absolute', top: 10, left: 14, right: 14, zIndex: 2 }}>{bar}</View>;
}
