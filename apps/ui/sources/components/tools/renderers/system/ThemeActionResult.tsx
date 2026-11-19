import * as React from 'react';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ThemeDevicePickerHost } from '@/components/settings/appearance/themeProfiles/ThemeDevicePickerHost';
import { getThemePresetSourceReferenceId } from '@/components/settings/appearance/themeProfiles/themeProfilePresetOptions';
import { useThemeActionExecution } from '@/components/settings/appearance/themeProfiles/useThemeActionExecution';
import type { ThemeDevicePickerInput } from '@/components/settings/appearance/themeProfiles/useThemeDevicePicker';
import type { ThemeActionCardPresentation } from '@/components/sessions/transcript/references/transcriptThemeAction';
import { useThemeLibraryEntry, useThemeProfileDocument, useThemeProfileReferenceSelection } from '@/sync/store/useThemeProfiles';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { t } from '@/text';
import { alertActionFailure } from '@/utils/errors/alertActionFailure';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { usePreparedThemeCss } from '@/theme/css/usePreparedThemeCss';
import { projectThemeMiniature } from '@/theme/profiles/themeProfilePresentation';
import { getThemeTryOnOwner } from '@/theme/profiles/themeTryOnRuntime';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { ThemeActionResultView } from './ThemeActionResultView';
import { projectThemeActionTryEntry, useThemeActionResultModel, type ThemeActionCardEdit } from './useThemeActionResultModel';
import type { ThemeResultDistribution } from './themeActionResultViewTypes';

/** Only the visible typed result mounts domain subscriptions; ordinary tool arrivals do no theme work. */
export const ThemeActionResult = React.memo(function ThemeActionResult({ presentation, fallback }: Readonly<{ presentation: ThemeActionCardPresentation; fallback?: React.ReactNode }>) {
    const execute = useThemeActionExecution();
    const router = useRouter();
    const owner = getThemeTryOnOwner();
    const presented = useLayoutPresentationActive();
    const call = presentation.call;
    const mode = call.actionId === THEME_ACTION_IDS.tryOn ? call.input.mode : call.output.applied.mode;
    const reference = call.actionId === THEME_ACTION_IDS.apply ? call.input.ref
        : presentation.replayTry ? projectThemeActionTryEntry(presentation.replayTry)?.reference ?? null : null;
    const entry = useThemeLibraryEntry(reference, presented);
    const [created] = React.useState(() => call.actionId === THEME_ACTION_IDS.tryOn && call.input.document !== null && entry === null);
    const selected = useThemeProfileReferenceSelection(presented)[mode];
    const selectedDocument = useThemeProfileDocument(selected, presented).document;
    const selectedPreparation = usePreparedThemeCss(selectedDocument?.profile.css ?? '', presented);
    const selectedCss = selectedPreparation.prepared;
    React.useEffect(() => {
        if (selectedPreparation.error) alertActionFailure({ code: readActionErrorCodeV1(selectedPreparation.error),
            reason: resolveActionExecutionErrorMessage(selectedPreparation.error, t('common.unavailable')) });
    }, [selectedPreparation.error]);
    const currentSelection = React.useMemo(() => (selected && !selectedDocument)
        || (selectedDocument?.profile.css && !selectedCss) ? undefined : ({
        miniature: projectThemeMiniature(selectedDocument ? { ...selectedDocument.profile, assetAppearance: mode }
            : { assetAppearance: mode, overrides: { light: {}, dark: {} } }),
        surfaceStyles: selectedDocument ? selectedCss?.[mode] : undefined,
    }), [selected, selectedDocument, mode, selectedCss]);
    // One card retains its initial comparison facts while Keep changes the selected appearance.
    const before = React.useRef(currentSelection);
    if (!before.current && currentSelection) before.current = currentSelection;
    const [target, setTarget] = React.useState<ThemeDevicePickerInput['theme'] | null>(null);
    const [distribution, setDistribution] = React.useState<ThemeResultDistribution | null>(null);
    const anchorRef = React.useRef<unknown>(null);
    const dismiss = React.useCallback(() => setTarget(null), []);
    const onEdit = React.useCallback((target: ThemeActionCardEdit) => {
        if (target.kind === 'entry') {
            router.push({ pathname: '/settings/appearance/themes/[profileId]', params: { profileId: getThemePresetSourceReferenceId(target.entry.reference) } });
            return;
        }
        void execute(THEME_ACTION_IDS.tryOn, { document: target.document, mode, origin: { kind: 'agent' } })
            .then(result => router.push({ pathname: '/settings/appearance/themes/[profileId]',
                params: { profileId: 'new', previewRef: result.previewRef } }))
            .catch((error: unknown) => alertActionFailure({ code: readActionErrorCodeV1(error),
                reason: resolveActionExecutionErrorMessage(error, t('common.unavailable')) }));
    }, [router, execute, mode]);
    const facts = useThemeActionResultModel(presentation, { preview: owner, entry, redo: getSyncSingleton().themeProfileCardRedo,
        appliedTheme: reference === null ? { name: t('settingsAppearance.themeProfiles.defaultTheme'), mode,
            miniature: projectThemeMiniature({ assetAppearance: mode, overrides: { light: {}, dark: {} } }) } : undefined,
        created,
        here: t('themeDevices.here'), before: presentation.replayTry ? before.current : undefined,
        onEdit,
        onUseOtherDevices: setTarget }, execute);
    if (!facts) return fallback ?? null;
    return <>
        <ThemeActionResultView {...facts} testID="theme-action-result" devicesAnchorRef={anchorRef} distribution={distribution} />
        {target ? <ThemeDevicePickerHost theme={target} anchorRef={anchorRef} execute={execute}
            onDismiss={dismiss} onDistribution={setDistribution} /> : null}
    </>;
});
