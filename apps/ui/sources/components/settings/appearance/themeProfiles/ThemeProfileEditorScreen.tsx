import { useThemeLibraryEntries, useThemeProfileDocument, useThemeProfileReferenceSelection } from '@/sync/store/useThemeProfiles';
import { mergeThemeProfileDocumentEdit, parseThemeProfileDocument, type ThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { alertActionFailure } from '@/utils/errors/alertActionFailure';
import { resolveActionExecutionErrorMessage, resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import * as React from 'react';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { BUNDLED_THEME_TYPEFACES } from '@/constants/bundledFonts';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { PageHeader, type PageHeaderMetaFact } from '@/components/ui/layout/PageHeader';
import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';
import { isActionApprovalDeclinedErrorCode, readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveThemeProfile } from '@/theme/profiles/resolveThemeProfile';
import { Modal } from '@/modal';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { BUILT_IN_THEME_PROFILES } from '@/theme/profiles/builtInThemeProfiles';
import { createThemeProfileDraft, resetThemeProfileDraftMode, resetThemeProfileDraftToken, updateThemeProfileDraftColor } from '@/theme/profiles/createThemeProfileDraft';
import { sanitizeThemeProfileName } from '@/theme/profiles/themeProfileImportExport';
import { isThemeProfileAssetAppearance, resolveThemeProfileAssetAppearance } from '@/theme/profiles/themeProfileAssetAppearance';
import { readSystemTheme } from '@/theme/profiles/themeProfileRuntime';
import { getThemeTryOnOwner } from '@/theme/profiles/themeTryOnRuntime';
import type { ThemeProfileMode, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import type { ThemeRadiusScaleName, ThemeReference } from '@happier-dev/protocol/account/settings/themeProfiles';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { prepareThemeCss } from '@/theme/css/prepareThemeCss';
import { ThemeProfileEditorView } from './ThemeProfileEditorView';
import { useThemeActionExecution } from './useThemeActionExecution';
import { createThemeProfileEditorActions } from './themeProfileEditorActions';
import { useThemeProfileEditorPreview } from './useThemeProfileEditorPreview';
import { useThemePluginShare } from './useThemePluginShare';
import type { ThemeEditorView, ThemeProfileEditorViewProps } from './themeProfileEditorViewTypes';
import { buildThemeProfileTokenGroups, getThemeProfileRecentColors } from './themeProfileEditorModel';
import {
    buildThemePresetSourceOptions,
    getThemePresetSourceReferenceId,
    readThemePresetSourceReferenceId,
    replaceThemeProfileDraftFromPresetSource,
    resolveThemePresetSourcePreferredMode,
    themeProfileDraftMatchesPresetSource,
} from './themeProfilePresetOptions';
import {
    createThemeProfileId,
    nowThemeProfileTimestamp,
} from './themeProfileScreenUtils';

const groupTitleKeys = {
    background: 'settingsAppearance.themeProfiles.groups.background',
    surface: 'settingsAppearance.themeProfiles.groups.surface',
    border: 'settingsAppearance.themeProfiles.groups.border',
    effect: 'settingsAppearance.themeProfiles.groups.effect',
    chrome: 'settingsAppearance.themeProfiles.groups.chrome',
    text: 'settingsAppearance.themeProfiles.groups.text',
    state: 'settingsAppearance.themeProfiles.groups.state',
    control: 'settingsAppearance.themeProfiles.groups.control',
    composer: 'settingsAppearance.themeProfiles.groups.composer',
    message: 'settingsAppearance.themeProfiles.groups.message',
    syntax: 'settingsAppearance.themeProfiles.groups.syntax',
    versionControl: 'settingsAppearance.themeProfiles.groups.versionControl',
    diff: 'settingsAppearance.themeProfiles.groups.diff',
    find: 'settingsAppearance.themeProfiles.groups.find',
    permission: 'settingsAppearance.themeProfiles.groups.permission',
    overlay: 'settingsAppearance.themeProfiles.groups.overlay',
} as const;

const getProfileIdParam = (value: string | string[] | undefined): string | null => {
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
};

const resolveInitialEditorMode = (themePreference: 'adaptive' | 'light' | 'dark'): ThemeProfileMode => {
    if (themePreference === 'adaptive') {
        return readSystemTheme();
    }
    return themePreference;
};

const profileHasAnyColorOverrides = (profile: ThemeProfileV1): boolean => (
    Object.keys(profile.overrides.light).length > 0 || Object.keys(profile.overrides.dark).length > 0
);

const profileEditorRoute = (profileId: string) => ({
    pathname: '/settings/appearance/themes/[profileId]' as const,
    params: { profileId },
});

const profileExportRoute = (profileId: string) => ({
    pathname: '/settings/appearance/themes/export' as const,
    params: { profileId },
});

const createProfileName = (count: number): string => t('settingsAppearance.themeProfiles.newProfileName', { count });

const createNewProfileRouteId = 'new';

const themesListRoute = '/settings/appearance/themes' as const;

export const ThemeProfileEditorScreen = React.memo(function ThemeProfileEditorScreen() {
    const presented = useLayoutPresentationActive();
    const router = useRouter();
    const params = useLocalSearchParams();
    const themePreference = useLocalSetting('themePreference');
    const entries = useThemeLibraryEntries(presented);
    const selection = useThemeProfileReferenceSelection(presented);
    const scope = useAccountSettingsScope();
    const { execute } = useMountedActionExecution(scope);
    const executeTheme = useThemeActionExecution();
    const share = useThemePluginShare(executeTheme);
    const editorActions = React.useMemo(() => createThemeProfileEditorActions(executeTheme), [executeTheme]);
    const profileId = getProfileIdParam(params.profileId);
    const isNewProfile = profileId === createNewProfileRouteId;
    const previewRef = isNewProfile ? getProfileIdParam(params.previewRef) : null;
    const previewSource = React.useMemo(() => {
        try { return { snapshot: previewRef ? getThemeTryOnOwner().read(previewRef) : null, error: null }; }
        catch (error) { return { snapshot: null, error }; }
    }, [previewRef]);
    const routeKey = previewRef ? `${profileId}:${previewRef}` : profileId;
    const startFromParam = isNewProfile ? getProfileIdParam(params.from) : null;
    const initialMode = resolveInitialEditorMode(themePreference);
    const reference = previewRef ? null : isNewProfile
        ? startFromParam ? readThemePresetSourceReferenceId(startFromParam) : selection[initialMode]
        : readThemePresetSourceReferenceId(profileId);
    const initialSource = React.useRef({ routeId: routeKey, reference });
    const savedReference = React.useRef<ThemeReference | null>(null);
    if (initialSource.current.routeId !== routeKey) {
        initialSource.current = { routeId: routeKey, reference };
        savedReference.current = null;
    }
    const sourceRead = useThemeProfileDocument(initialSource.current.reference, presented);
    const sourceDocument = previewSource.snapshot?.document ?? sourceRead.document;
    const sourceProfile = sourceDocument?.profile ?? null;
    const builtInPresetId = initialSource.current.reference?.kind === 'built-in' ? initialSource.current.reference.presetId : null;
    const builtInDefinition = BUILT_IN_THEME_PROFILES.find(definition => definition.presetId === builtInPresetId);
    const readonly = !isNewProfile && sourceProfile?.source !== undefined && sourceProfile.source.kind !== 'yours';
    const persisted = !isNewProfile && sourceDocument !== null;
    const presetOptions = React.useMemo(() => buildThemePresetSourceOptions(entries), [entries]);
    const initialPresetId = initialSource.current.reference ? getThemePresetSourceReferenceId(initialSource.current.reference) : initialMode;
    const [selectedPresetId, setSelectedPresetId] = React.useState(initialPresetId);
    const selectedPreset = React.useMemo(() => presetOptions.find(option => option.id === selectedPresetId) ?? null,
        [presetOptions, selectedPresetId]);
    const [mode, setMode] = React.useState<ThemeProfileMode>(() => sourceProfile && (sourceProfile.assetAppearance !== undefined || profileHasAnyColorOverrides(sourceProfile))
        ? resolveThemePresetSourcePreferredMode(sourceProfile) : initialMode);
    const [draft, setDraft] = React.useState<ThemeProfileV1 | null>(null);
    const retainedDocument = React.useRef<ThemeProfileDocument | null>(null);
    const initializedRoute = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!presented) return;
        if (initializedRoute.current === routeKey) return;
        if (previewRef && !previewSource.snapshot?.document) return;
        if (initialSource.current.reference && !sourceDocument && (!isNewProfile || sourceRead.state !== 'missing')) return;
        initializedRoute.current = routeKey;
        retainedDocument.current = sourceDocument;
        if (previewSource.snapshot?.document) {
            setDraft({ ...previewSource.snapshot.document.profile, assetAppearance: previewSource.snapshot.mode });
            setMode(previewSource.snapshot.mode);
            return;
        }
        if (!isNewProfile) {
            setDraft(sourceProfile);
            if (sourceProfile && (sourceProfile.assetAppearance !== undefined || profileHasAnyColorOverrides(sourceProfile)))
                setMode(resolveThemePresetSourcePreferredMode(sourceProfile));
            return;
        }
        const profile = createThemeProfileDraft({ id: createThemeProfileId(),
            name: createProfileName(entries.filter(entry => entry.source.kind === 'yours').length + 1),
            now: nowThemeProfileTimestamp() });
        const next = sourceDocument ? mergeThemeProfileDocumentEdit(sourceDocument, {
            id: profile.id, name: profile.name, createdAt: profile.createdAt, updatedAt: profile.updatedAt, source: { kind: 'yours' },
        }).profile : { ...profile, assetAppearance: initialMode };
        setDraft(next);
        if (sourceDocument) setMode(resolveThemePresetSourcePreferredMode(sourceDocument.profile));
    }, [presented, entries, initialMode, isNewProfile, routeKey, previewRef, previewSource, sourceDocument, sourceProfile, sourceRead.state]);
    const draftDocument = React.useCallback((profile: ThemeProfileV1): ThemeProfileDocument => {
        const retained = retainedDocument.current;
        if (retained) {
            // A full editor draft replaces supported optional fields; canonical merge retains unknown children.
            const cleared = mergeThemeProfileDocumentEdit(retained, { id: profile.id }, { removeKnownFields: ['seeds', 'style', 'css'] });
            return mergeThemeProfileDocumentEdit(cleared, profile, { retainedPresentation: retained });
        }
        const parsed = parseThemeProfileDocument(profile);
        if (!parsed.ok) throw new Error(parsed.error);
        return parsed.document;
    }, []);
    const [view, setView] = React.useState<ThemeEditorView>(() => getProfileIdParam(params.view) === 'css' ? 'css' : 'colors');
    const [colorQuery, setColorQuery] = React.useState('');
    const codeEditorRef = React.useRef<CodeEditorHandle>(null);
    const [invalidByToken, setInvalidByToken] = React.useState<Readonly<Record<string, boolean>>>({});

    const profileDisplayName = builtInDefinition ? t(builtInDefinition.translationKey) : draft?.name;
    const assetAppearance = React.useMemo(() => (
        draft ? resolveThemeProfileAssetAppearance(draft) : mode
    ), [draft, mode]);
    const groups = React.useMemo(() => buildThemeProfileTokenGroups(), []);
    const recentColors = React.useMemo(() => (draft ? getThemeProfileRecentColors(draft) : []), [draft]);
    const hasInvalidColor = Object.values(invalidByToken).some(Boolean);
    const hasInvalidProfileName = !readonly && draft ? sanitizeThemeProfileName(draft.name) === null : false;
    const saveDisabled = hasInvalidColor || hasInvalidProfileName;

    const selectPreset = React.useCallback(async (presetId: string) => {
        if (!draft || readonly) return;
        const option = presetOptions.find(candidate => candidate.id === presetId);
        if (!option) return;
        const currentSource = selectedPreset ? { ...selectedPreset,
            profile: selectedPreset.profile ?? retainedDocument.current?.profile ?? null } : null;
        if (currentSource && !themeProfileDraftMatchesPresetSource(draft, currentSource)) {
            if (!await Modal.confirm(t('settingsAppearance.themeProfiles.replacePresetTitle'),
                t('settingsAppearance.themeProfiles.replacePresetSubtitle'),
                { confirmText: t('common.continue'), destructive: true })) return;
        }
        let document: ThemeProfileDocument | null = null;
        try {
            const reference = option.reference;
            document = reference ? await getSyncSingleton().withThemeProfileLibrary(library => library.get(reference)) : null;
            if (reference && !document) { Modal.alert(t('common.error'), t('settingsAppearance.themeProfiles.missingProfileDescription')); return; }
        } catch (error) {
            Modal.alert(t('common.error'), resolveActionExecutionErrorMessage(error, t('common.requestFailed')));
            return;
        }
        const source = { ...option, profile: document?.profile ?? option.profile };
        const next = replaceThemeProfileDraftFromPresetSource(draft, source, nowThemeProfileTimestamp());
        // Starts from takes the chosen theme's presentation while retaining this draft's identity.
        const { seeds: _seeds, style: _style, css: _css, ...envelope } = next;
        const replacement = { ...envelope, ...(source.profile?.seeds ? { seeds: source.profile.seeds } : {}),
            ...(source.profile?.style ? { style: source.profile.style } : {}),
            ...(source.profile?.css !== undefined ? { css: source.profile.css } : {}) };
        retainedDocument.current = document ? mergeThemeProfileDocumentEdit(document, {
            id: draft.id, name: draft.name, createdAt: draft.createdAt, updatedAt: replacement.updatedAt, source: { kind: 'yours' },
        }) : null;
        setDraft(replacement);
        setSelectedPresetId(option.id);
        setMode(option.preferredMode);
        setInvalidByToken({});
    }, [draft, presetOptions, readonly, selectedPreset]);

    const cloneProfile = React.useCallback(async () => {
        if (!draft) return;
        const now = nowThemeProfileTimestamp();
        const document = draftDocument({ ...draft, id: createThemeProfileId(),
            name: t('settingsAppearance.themeProfiles.cloneName', { name: profileDisplayName ?? draft.name }),
            createdAt: now, updatedAt: now, source: { kind: 'yours' } });
        try {
            const saved = await executeTheme(THEME_ACTION_IDS.save, { document });
            router.push(profileEditorRoute(getThemePresetSourceReferenceId(saved.entry.reference)));
        } catch (error) {
            if (isActionApprovalDeclinedErrorCode(readActionErrorCodeV1(error))) return;
            alertActionFailure({ code: readActionErrorCodeV1(error), reason: resolveActionExecutionErrorMessage(error, t('common.requestFailed')) });
        }
    }, [draft, draftDocument, executeTheme, profileDisplayName, router]);

    const exportProfile = React.useCallback(() => {
        if (!initialSource.current.reference) return;
        router.push(profileExportRoute(getThemePresetSourceReferenceId(initialSource.current.reference)));
    }, [router]);

    const updateColor = React.useCallback((tokenId: string, value: string) => {
        if (readonly) return;
        setDraft((current) => current ? updateThemeProfileDraftColor(current, mode, tokenId, value, nowThemeProfileTimestamp()) : current);
    }, [mode, readonly]);

    const updateInvalid = React.useCallback((tokenId: string, invalid: boolean) => {
        if (readonly) return;
        setInvalidByToken((current) => ({ ...current, [`${mode}:${tokenId}`]: invalid }));
    }, [mode, readonly]);

    const resetToken = React.useCallback((tokenId: string) => {
        if (readonly) return;
        setInvalidByToken((current) => ({ ...current, [`${mode}:${tokenId}`]: false }));
        setDraft((current) => current ? resetThemeProfileDraftToken(current, mode, tokenId, nowThemeProfileTimestamp()) : current);
    }, [mode, readonly]);

    const resetMode = React.useCallback(() => {
        if (readonly || !draft) return;
        const cleared = mergeThemeProfileDocumentEdit(draftDocument(draft), {}, { removeKnownFields: ['seeds', 'style', 'css'] });
        retainedDocument.current = cleared;
        setInvalidByToken((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${mode}:`))));
        setDraft(resetThemeProfileDraftMode(cleared.profile, mode, nowThemeProfileTimestamp()));
    }, [draft, draftDocument, mode, readonly]);

    const updateAssetAppearance = React.useCallback((nextAssetAppearance: string) => {
        if (readonly || !isThemeProfileAssetAppearance(nextAssetAppearance)) return;
        setMode(nextAssetAppearance);
        setDraft((current) => current ? {
            ...current,
            assetAppearance: nextAssetAppearance,
            updatedAt: nowThemeProfileTimestamp(),
        } : current);
    }, [readonly]);

    const saveAndActivate = React.useCallback(async () => {
        if (!draft || readonly || saveDisabled) return;
        // The code field's latest bytes, even when its debounced change has not reached the draft yet.
        await codeEditorRef.current?.flushPendingChange();
        const css = codeEditorRef.current?.getValue() ?? draft.css;
        const profile = { ...draft, ...(css !== undefined ? { css } : {}), assetAppearance };
        const document = draftDocument(profile);
        try {
            const reference = savedReference.current ?? (!isNewProfile ? initialSource.current.reference : null);
            const saved = await editorActions.saveAndUse({ document, draft: profile, mode: assetAppearance,
                ...(reference ? { reference } : {}) });
            savedReference.current = saved.entry.reference;
        } catch (error) {
            if (isActionApprovalDeclinedErrorCode(readActionErrorCodeV1(error))) return;
            alertActionFailure({ code: readActionErrorCodeV1(error), reason: resolveActionExecutionErrorMessage(error, t('common.requestFailed')) });
            return;
        }
        // From the list, not "back": an Ask-first review opened above this editor would otherwise land here again.
        router.dismissTo(themesListRoute);
    }, [assetAppearance, draft, draftDocument, editorActions, isNewProfile, readonly, router, saveDisabled]);

    const deactivate = React.useCallback(async () => {
        if (!draft) return;
        try {
            for (const slotMode of ['light', 'dark'] as const) {
                if (selection[slotMode]?.kind !== 'artifact' || selection[slotMode]?.id !== draft.id) continue;
                await executeTheme(THEME_ACTION_IDS.apply, { ref: null, mode: slotMode });
            }
            router.back();
        } catch (error) {
            if (isActionApprovalDeclinedErrorCode(readActionErrorCodeV1(error))) return;
            alertActionFailure({ code: readActionErrorCodeV1(error), reason: resolveActionExecutionErrorMessage(error, t('common.requestFailed')) });
        }
    }, [draft, executeTheme, router, selection]);

    const deleteProfile = React.useCallback(async () => {
        if (!draft || readonly) return;
        // A theme a mode uses says which mode loses it; that mode returns to its default theme.
        const assignedSlots = (['light', 'dark'] as const).filter((mode) => selection[mode]?.kind === 'artifact' && selection[mode]?.id === draft.id);
        const slotNames = assignedSlots.map((mode) => t(mode === 'light'
            ? 'settingsAppearance.themeProfiles.lightModeSection'
            : 'settingsAppearance.themeProfiles.darkModeSection'));
        const confirmed = await Modal.confirm(
            t('settingsAppearance.themeProfiles.deleteProfile'),
            assignedSlots.length > 0
                ? t('settingsAppearance.themeProfiles.deleteAssignedThemeBody', { slots: slotNames.join(' · ') })
                : t('settingsAppearance.themeProfiles.deleteProfileSubtitle'),
            { confirmText: t('common.delete'), destructive: true },
        );
        if (!confirmed) return;
        const result = await execute(THEME_ACTION_IDS.delete, { ref: { kind: 'artifact', id: draft.id } });
        if (!result.ok) {
            alertActionFailure({ reason: resolveActionExecutionFailureMessage(result, t('common.requestFailed')) ?? t('common.requestFailed'),
                code: result.errorCode, requestId: result.requestId });
            return;
        }
        router.back();
    }, [draft, execute, readonly, router, selection]);

    const previewDraft = React.useMemo(() => draft && !readonly && !hasInvalidColor && !hasInvalidProfileName
        ? { document: draftDocument(draft), draft, mode: assetAppearance } : null,
    [assetAppearance, draft, draftDocument, hasInvalidColor, hasInvalidProfileName, readonly]);
    const reportPreviewFailure = React.useCallback((error: unknown) => {
        Modal.alert(t('common.error'), resolveActionExecutionErrorMessage(error, t('common.requestFailed')));
    }, []);
    useThemeProfileEditorPreview({ owner: getThemeTryOnOwner(), draft: previewDraft,
        preview: editorActions.preview, onFailure: reportPreviewFailure });

    const inUse = persisted && initialSource.current.reference !== null
        && (['light', 'dark'] as const).some(mode => sameStrictJsonValue(selection[mode], initialSource.current.reference));
    const menuActions = React.useMemo((): readonly PageHeaderMenuAction[] => [
        ...(!readonly ? [{ id: 'reset', title: t('settingsAppearance.themeProfiles.resetMode'), onSelect: resetMode }] : []),
        // Duplicating and exporting work on a saved or built-in theme, never an unsaved draft.
        ...(!isNewProfile ? [
            {
                id: 'duplicate',
                title: t('settingsAppearance.themeProfiles.duplicateTheme'),
                onSelect: cloneProfile,
            },
            { id: 'export', title: t('settingsAppearance.themeProfiles.exportFile'), onSelect: exportProfile },
        ] : []),
        ...(inUse && !readonly ? [{ id: 'deactivate', title: t('settingsAppearance.themeProfiles.deactivateProfile'), onSelect: deactivate }] : []),
        ...(persisted && !readonly ? [{ id: 'delete', title: t('settingsAppearance.themeProfiles.deleteTheme'), onSelect: deleteProfile }] : []),
    ], [cloneProfile, deactivate, deleteProfile, exportProfile, inUse, isNewProfile, persisted, readonly, resetMode]);
    const markPalette = React.useMemo(() => resolveThemeProfile({ mode: assetAppearance, profile: draft }), [assetAppearance, draft]);

    const updateSeed = React.useCallback((seed: 'canvas' | 'accent', value: string) => {
        if (readonly) return;
        setDraft((current) => {
            if (!current) return current;
            const base = resolveThemeProfile({ mode: assetAppearance, profile: { ...current, seeds: undefined } }).colors;
            const seeds = current.seeds ?? { canvas: base.background.canvas, accent: base.button.primary.background };
            return { ...current, seeds: { ...seeds, [seed]: value }, updatedAt: nowThemeProfileTimestamp() };
        });
    }, [assetAppearance, readonly]);
    const resetSeed = React.useCallback((seed: 'canvas' | 'accent') => {
        if (readonly) return;
        setInvalidByToken((current) => ({ ...current, [`${mode}:seed:${seed}`]: false }));
        setDraft((current) => {
            if (!current?.seeds) return current;
            const base = resolveThemeProfile({ mode: assetAppearance, profile: { ...current, seeds: undefined } }).colors;
            const seeds = { ...current.seeds, [seed]: seed === 'canvas' ? base.background.canvas : base.button.primary.background };
            const baseSeeds = { canvas: base.background.canvas, accent: base.button.primary.background };
            const unchanged = seeds.canvas === baseSeeds.canvas && seeds.accent === baseSeeds.accent;
            const { seeds: _previous, ...rest } = current;
            return unchanged ? { ...rest, updatedAt: nowThemeProfileTimestamp() } : { ...current, seeds, updatedAt: nowThemeProfileTimestamp() };
        });
    }, [assetAppearance, mode, readonly]);
    const updateRadius = React.useCallback((radius: ThemeRadiusScaleName) => {
        if (readonly) return;
        setDraft((current) => current ? { ...current, style: { ...current.style, radius }, updatedAt: nowThemeProfileTimestamp() } : current);
    }, [readonly]);
    const updateTypeface = React.useCallback((fontFamily: string | null) => {
        if (readonly || !draft) return;
        const { fontFamily: _previous, ...style } = draft.style ?? {};
        const next = { ...draft, style: { ...style, ...(fontFamily ? { fontFamily } : {}) }, updatedAt: nowThemeProfileTimestamp() };
        if (fontFamily === null) {
            const cleared = mergeThemeProfileDocumentEdit(draftDocument(next), {}, { removeKnownFields: ['style'] });
            retainedDocument.current = mergeThemeProfileDocumentEdit(cleared, { style });
        }
        setDraft(next);
    }, [draft, draftDocument, readonly]);
    const updateCss = React.useCallback((css: string) => {
        if (readonly) return;
        setDraft((current) => current && (current.css ?? '') !== css ? { ...current, css, updatedAt: nowThemeProfileTimestamp() } : current);
    }, [readonly]);
    const updateName = React.useCallback((name: string) => {
        setDraft((current) => current ? { ...current, name, updatedAt: nowThemeProfileTimestamp() } : current);
    }, []);
    const startOptions = React.useMemo(() => presetOptions
        .filter((option) => option.preferredMode === assetAppearance)
        .map((option) => ({
            key: option.id,
            name: option.kind === 'base' ? t('settingsAppearance.themeProfiles.defaultTheme') : option.title,
            sourceLabel: option.kind === 'custom' ? option.subtitle : t('settingsAppearance.themeProfiles.builtInTheme'),
            preview: option.miniature ? { kind: 'miniature' as const, miniature: option.miniature }
                : { kind: 'palette' as const, palette: resolveThemeProfile({ mode: assetAppearance, profile: option.profile }) },
        })), [assetAppearance, presetOptions]);
    const tokenGroups = React.useMemo(() => groups.map((group) => ({
        id: group.group,
        title: t(groupTitleKeys[group.group as keyof typeof groupTitleKeys] ?? 'settingsAppearance.themeProfiles.groups.background'),
        tokens: group.tokens,
    })), [groups]);

    // CSS coverage for the CSS view: compiled once per changed draft CSS, and only while that view is open.
    const draftCss = draft?.css ?? '';
    const cssCoverage = React.useMemo(() => {
        if (view !== 'css' || draftCss.trim().length === 0) return null;
        const prepared = prepareThemeCss(draftCss);
        return {
            counts: { total: prepared.coverage.total, native: prepared.coverage.native, webOnly: prepared.coverage.webOnly },
            webOnlyRules: prepared.detailedCoverage.rules.filter(rule => !rule.native)
                .map(rule => ({ line: rule.range.line, selector: rule.selector })),
        };
    }, [draftCss, view]);
    const revealCssLine = React.useCallback((line: number) => {
        codeEditorRef.current?.revealLine(line, { focus: true, select: true });
    }, []);

    if (!draft) {
        return (
            <ItemList testID="settings-theme-profile-editor" style={{ paddingTop: 0 }}>
                <PageHeader
                    alwaysShowTitle
                    title={t(sourceRead.state === 'loading' ? 'common.loading' : 'settingsAppearance.themeProfiles.missingProfile')}
                    description={sourceRead.state === 'loading' ? undefined : t('settingsAppearance.themeProfiles.missingProfileDescription')}
                />
                {previewSource.error || sourceRead.state === 'failed' ? <SurfaceStateCard kind="error"
                    reason={resolveActionExecutionErrorMessage(previewSource.error ?? sourceRead.failure, t('artifacts.browser.loadFailedBody'), { safeToRetry: true })}
                    {...(!previewSource.error ? { action: { label: t('common.retry'), onPress: sourceRead.retry } } : {})}
                    accessibilitySemantics="alert" /> : null}
            </ItemList>
        );
    }

    const title = profileDisplayName?.trim() || t('settingsAppearance.themeProfiles.newTheme');
    const meta: PageHeaderMetaFact[] = [
        { key: 'mode', text: t(assetAppearance === 'dark' ? 'settingsAppearance.themeOptions.dark' : 'settingsAppearance.themeOptions.light') },
        { key: 'kind', text: t(readonly ? 'settingsAppearance.themeProfiles.builtInTheme' : 'settingsAppearance.themeProfiles.customTheme') },
        ...(inUse ? [{ key: 'inUse', text: t('settingsAppearance.themeProfiles.inUse') }] : []),
    ];
    const radius = draft.style?.radius ?? 'soft';
    const preview = { kind: 'palette' as const, palette: markPalette, radius };
    const viewProps: ThemeProfileEditorViewProps = {
        header: {
            title,
            description: t(readonly
                ? 'settingsAppearance.themeProfiles.builtInThemeDescription'
                : 'settingsAppearance.themeProfiles.editorDescription'),
            meta,
            mark: preview,
            ...(!readonly ? { save: { disabled: saveDisabled, onPress: () => { void saveAndActivate(); } } } : {}),
            menu: menuActions,
            ...(persisted && !readonly && reference ? { onShare: () => share([reference]) } : {}),
        },
        readonly,
        view,
        onViewChange: setView,
        ...(!readonly ? {
            details: {
                name: draft.name,
                nameInvalid: hasInvalidProfileName,
                autoFocus: isNewProfile,
                onNameChange: updateName,
                appearance: assetAppearance,
                onAppearanceChange: updateAssetAppearance,
            },
            startFrom: { options: startOptions, selectedKey: selectedPreset?.id ?? null, onChoose: (key: string) => { void selectPreset(key); } },
        } : {}),
        seeds: {
            canvas: draft.seeds?.canvas ?? markPalette.colors.background.canvas,
            accent: draft.seeds?.accent ?? markPalette.colors.button.primary.background,
            canvasChanged: draft.seeds !== undefined,
            accentChanged: draft.seeds !== undefined,
            onChange: updateSeed,
            onReset: resetSeed,
        },
        colors: {
            draft,
            mode,
            groups: tokenGroups,
            invalidByToken,
            recentColors,
            query: colorQuery,
            onQueryChange: setColorQuery,
            onChange: updateColor,
            onInvalidChange: updateInvalid,
            onReset: resetToken,
        },
        preview,
        style: {
            radius,
            onRadiusChange: updateRadius,
            radiusPreview: (choice) => ({ kind: 'palette', palette: markPalette, radius: choice }),
            typefaces: BUNDLED_THEME_TYPEFACES,
            typeface: BUNDLED_THEME_TYPEFACES.find(face => face.id === draft.style?.fontFamily)?.id ?? null,
            onTypefaceChange: updateTypeface,
        },
        css: {
            value: draft.css ?? '',
            resetKey: draft.id,
            onChange: updateCss,
            editorRef: codeEditorRef,
            ...(cssCoverage ? { coverage: cssCoverage.counts, webOnlyRules: cssCoverage.webOnlyRules, onRevealLine: revealCssLine } : {}),
        },
    };
    return <ThemeProfileEditorView {...viewProps} />;
});
