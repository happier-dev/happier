import * as React from 'react';
import { useColorScheme } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { getThemePresetSourceReferenceId } from '@/components/settings/appearance/themeProfiles/themeProfilePresetOptions';
import { useRegistryUpdateCheck } from '@/registries/useRegistryUpdateCheck';
import { buildStoreUpdates, captureStoreUpdateBasis } from './updates/storeUpdatesModel';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { ThemeInstallResultSchema, type ThemeActionOutput } from '@happier-dev/protocol/actions/themeActionFamily';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ThemeLibraryEntry } from '@happier-dev/protocol/account/settings/themeProfiles';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';
import { useThemeLibraryArtifactInventory } from '@/sync/store/useThemeProfiles';
import { useRegistrySourceDescriptor } from '@/registries/useRegistrySourceRevision';
import { getThemeRegistryLifecycle, getThemeTryOnOwner } from '@/theme/profiles/themeTryOnRuntime';
import { projectThemeLibraryEntry } from '@/theme/profiles/themeProfilePresentation';
import { resolveThemeRuntimeVisualTheme } from '@/theme/profiles/themeProfileRuntime';
import { t } from '@/text';
import { describeStoreThemeModes, groupInstalledStoreThemes, projectStoreThemeCoverageFacts, projectInstalledStoreThemeRows, type InstalledStoreThemeEntry } from './catalog/storeThemes';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { Modal } from '@/modal';
import type { StoreThemeListingViewProps } from './storeThemeViewTypes';

type Opened = ThemeActionOutput<typeof THEME_ACTION_IDS.storeGet>;
type Listing = Readonly<{ sourceId: string; itemId: string; version?: string }>;
const noInstalledEntries: readonly InstalledStoreThemeEntry[] = [];
const noRefresh = () => {};

/** Selected acquisition, Actions and the shared overlay feed the existing Store listing presentation. */
export function StoreThemeListingController(props: Readonly<{ listing: Listing;
    children(view: StoreThemeListingViewProps): React.ReactNode }>) {
    const presented = useLayoutPresentationActive();
    const scope = useAccountSettingsScope();
    const { execute, ready, isCurrent } = useMountedActionExecution(scope);
    const router = useRouter();
    const owner = getThemeTryOnOwner();
    const { sourceId, itemId, version } = props.listing;
    const subscribePreview = React.useCallback((listener: () => void) => presented ? owner.subscribe(listener) : () => {}, [presented, owner]);
    const readPreview = React.useCallback(() => {
        const current = owner.read();
        return current?.origin.kind === 'store' && current.origin.listing.sourceId === sourceId
            && current.origin.listing.itemId === itemId ? current : null;
    }, [owner, sourceId, itemId]);
    const matching = React.useSyncExternalStore(subscribePreview, readPreview, readPreview);
    React.useLayoutEffect(() => presented && matching ? owner.present(matching.previewRef) : undefined,
        [owner, presented, Boolean(matching), sourceId, itemId]);
    const selectInstalledEntries = React.useCallback((entries: readonly ThemeLibraryEntry[]) => groupInstalledStoreThemes(entries)
        .find(group => group.listing.sourceId === sourceId && group.listing.itemId === itemId)?.entries ?? noInstalledEntries, [sourceId, itemId]);
    const library = useThemeLibraryArtifactInventory(presented, selectInstalledEntries);
    const source = useRegistrySourceDescriptor(sourceId, presented);
    const preference = useLocalSetting('themePreference');
    const mode = resolveThemeRuntimeVisualTheme(preference, useColorScheme());
    const listing = React.useMemo(() => ({ sourceId, itemId, ...(version ? { version } : {}) }), [sourceId, itemId, version]);
    const [opened, setOpened] = React.useState<Opened | null>(null);
    const [failed, setFailed] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState<StoreThemeListingViewProps['busy']>(null);
    const [failedInstall, setFailedInstall] = React.useState<Readonly<{
        kind: 'install' | 'update'; faces: NonNullable<StoreThemeListingViewProps['installFailures']>;
    }> | null>(null);
    React.useEffect(() => {
        if (!ready) return;
        const interest = new AbortController();
        setOpened(null);
        setFailed(null);
        void execute(THEME_ACTION_IDS.storeGet, { listing }, { signal: interest.signal }).then(result => {
            if (interest.signal.aborted) return;
            // The front door settles the published output schema before returning success.
            if (result.ok) setOpened(result.result as Opened);
            else setFailed(result.error);
        }).catch(error => { if (!interest.signal.aborted) setFailed(error instanceof Error ? error.message : t('common.unknown')); });
        return () => {
            interest.abort();
            getThemeRegistryLifecycle().releaseOpened(listing, { expectedScope: scope });
        };
    }, [execute, ready, listing, scope]);
    const faces = React.useMemo(() => opened?.faces.flatMap(document => {
        const source = document.profile.source;
        if (source?.kind !== 'store') return [];
        const entry = projectThemeLibraryEntry(document);
        const metadata = opened.listing.metadata.includes.find(face => face.key === source.contributionId);
        return [{ id: source.contributionId, name: entry.name, mode: metadata?.mode ?? entry.mode,
            miniature: entry.miniature, document }];
    }) ?? null, [opened]);
    const preferred = faces?.find(face => face.mode === mode) ?? faces?.[0];
    const tryingSource = matching?.document?.profile.source;
    const tryingFaceId = tryingSource?.kind === 'store' ? tryingSource.contributionId : null;
    const coverage = opened?.coverage.find(row => row.faceId === (tryingFaceId ?? preferred?.id))?.coverage;
    const coverageFacts = coverage ? projectStoreThemeCoverageFacts(coverage) : null;
    const installed = Boolean(faces?.length && faces.every(face => library.entries.some(entry => entry.source.contributionId === face.id)));
    const hasInstalledFaces = library.entries.length > 0;
    const installedRows = React.useMemo(() => scope ? projectInstalledStoreThemeRows(library.entries, scope) : [], [library.entries, scope]);
    const checkKeys = React.useMemo(() => library.entries.map(entry => entry.id), [library.entries]);
    const captureBasis = React.useCallback(() => captureStoreUpdateBasis(installedRows), [installedRows]);
    const { check, checkNow } = useRegistryUpdateCheck({ scopeKey: JSON.stringify(scope), execute, isCurrent,
        kind: 'theme', keys: checkKeys, retry: noRefresh, enabled: presented && hasInstalledFaces, captureBasis });
    const updates = React.useMemo(() => buildStoreUpdates(installedRows, check.results, check), [installedRows, check]);
    const updateAvailable = updates.sections.some(section => section.entries.some(entry => entry.state === 'available'));
    const duplicateEntry = library.entries.find(entry => entry.source.contributionId === (tryingFaceId ?? preferred?.id)) ?? library.entries[0];
    const run = async (kind: NonNullable<StoreThemeListingViewProps['busy']>, actionId: ActionId, input: unknown) => {
        setBusy(kind);
        try {
            const result = await execute(actionId, input);
            if (!result.ok) {
                if (kind === 'acquire') { setFailed(result.error); return; }
                if (kind !== 'install' && kind !== 'update') {
                    Modal.alert(t('common.error'), result.error);
                    return;
                }
                const partial = result.errorCode === 'theme_install_partial' ? ThemeInstallResultSchema.safeParse(result.details) : null;
                setFailedInstall({ kind, faces: partial?.success ? partial.data.faces.flatMap(face => face.status === 'failed'
                    ? [{ faceName: faces?.find(candidate => candidate.id === face.faceId)?.name ?? face.faceId, code: face.error.code }] : [])
                    : [{ faceName: matching?.document?.profile.name ?? opened?.listing.summary.title ?? '', code: result.errorCode ?? 'action_failed' }] });
            } else {
                setFailedInstall(null);
                if (kind === 'acquire') { setOpened(result.result as Opened); setFailed(null); }
                if (kind === 'duplicate') {
                    const { entry } = result.result as ThemeActionOutput<typeof THEME_ACTION_IDS.duplicate>;
                    router.push({ pathname: '/settings/appearance/themes/[profileId]', params: { profileId: getThemePresetSourceReferenceId(entry.reference) } });
                }
            }
        } catch (error) {
            if (kind === 'acquire') { setFailed(error instanceof Error ? error.message : t('common.unknown')); return; }
            if (kind !== 'install' && kind !== 'update') {
                Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.unknown'));
                return;
            }
            setFailedInstall({ kind, faces: [{ faceName: matching?.document?.profile.name ?? opened?.listing.summary.title ?? '',
                code: readActionErrorCodeV1(error) ?? 'action_failed' }] });
        } finally { setBusy(null); }
    };
    const install = () => matching ? run('install', THEME_ACTION_IDS.keep, { previewRef: matching.previewRef })
        : run('install', THEME_ACTION_IDS.install, { listing: { sourceId, itemId } });
    const update = () => run('update', THEME_ACTION_IDS.install, { listing: { sourceId, itemId } });
    return props.children({
        name: opened?.listing.summary.title ?? '', kicker: [t('settingsAppearance.theme'), describeStoreThemeModes(faces?.map(face => face.mode) ?? [])].filter(Boolean).join(' · '),
        meta: opened ? [opened.listing.summary.publisher?.name, source?.title,
            opened.listing.pointer.version].filter(Boolean).join(' · ') : '',
        description: opened?.listing.summary.description ?? null,
        faces, facesState: opened ? 'ready' : failed ? 'error' : 'loading', facesError: failed, tryingFaceId,
        preferredFaceId: preferred?.id ?? null, here: t('themeDevices.here'), installed,
        facts: [
            { key: 'includes', value: opened?.listing.metadata.includes.map(face => face.label).join(' · ') ?? t('common.unknown') },
            { key: 'changes', value: coverageFacts?.changes ?? t('common.unknown') },
            { key: 'worksOn', ...(coverageFacts?.worksOn ?? { value: t('common.unknown') }) },
            { key: 'licence', value: opened?.listing.metadata.license ?? t('common.unknown') },
        ], busy: check.checking ? 'check' : busy, installFailures: failedInstall?.faces ?? [],
        updateAvailable, checkError: check.failed ? check.code : null,
        onTryFace: id => {
            const face = faces?.find(candidate => candidate.id === id);
            if (face) return run('try', THEME_ACTION_IDS.tryOn, { document: face.document, mode: face.mode, origin: { kind: 'store', listing: { sourceId, itemId } } });
        },
        onRevert: () => matching ? run('revert', THEME_ACTION_IDS.revert, { previewRef: matching.previewRef }) : undefined,
        onInstall: install, onRetryFaces: failedInstall?.kind === 'update' ? update : install,
        onRetryAcquisition: () => run('acquire', THEME_ACTION_IDS.storeGet, { listing }),
        onCheckUpdates: hasInstalledFaces ? checkNow : undefined,
        onUpdate: updateAvailable ? update : undefined,
        onDuplicate: duplicateEntry ? () => run('duplicate', THEME_ACTION_IDS.duplicate, { ref: duplicateEntry.reference }) : undefined,
        onUninstall: hasInstalledFaces ? () => run('uninstall', THEME_ACTION_IDS.uninstall, { listing: { sourceId, itemId } }) : undefined,
    });
}
