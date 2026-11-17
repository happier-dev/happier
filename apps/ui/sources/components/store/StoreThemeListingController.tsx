import * as React from 'react';
import { useColorScheme } from 'react-native';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import { ThemeInstallResultSchema, type ThemeActionOutput } from '@happier-dev/protocol/actions/themeActionFamily';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ThemeLibraryEntry } from '@happier-dev/protocol/account/settings/themeProfiles';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';
import { useThemeLibraryArtifactInventory } from '@/sync/store/useThemeProfiles';
import { useRegistrySources } from '@/registries/useRegistrySources';
import { getThemeRegistryLifecycle, getThemeTryOnOwner } from '@/theme/profiles/themeTryOnRuntime';
import { projectThemeLibraryEntry } from '@/theme/profiles/themeProfilePresentation';
import { resolveThemeRuntimeVisualTheme } from '@/theme/profiles/themeProfileRuntime';
import { t } from '@/text';
import { describeStoreThemeModes, groupInstalledStoreThemes, projectStoreThemeCoverageFacts, type InstalledStoreThemeEntry } from './catalog/storeThemes';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { Modal } from '@/modal';
import type { StoreThemeListingViewProps } from './storeThemeViewTypes';

type Opened = ThemeActionOutput<typeof THEME_ACTION_IDS.storeGet>;
type Listing = Readonly<{ sourceId: string; itemId: string }>;
const noInstalledEntries: readonly InstalledStoreThemeEntry[] = [];

/** Selected acquisition, Actions and the shared overlay feed the existing Store listing presentation. */
export function StoreThemeListingController(props: Readonly<{ listing: Listing;
    children(view: StoreThemeListingViewProps): React.ReactNode }>) {
    const presented = useLayoutPresentationActive();
    const scope = useAccountSettingsScope();
    const { execute, ready } = useMountedActionExecution(scope);
    const owner = getThemeTryOnOwner();
    const { sourceId, itemId } = props.listing;
    const subscribePreview = React.useCallback((listener: () => void) => presented ? owner.subscribe(listener) : () => {}, [presented, owner]);
    const readPreview = React.useCallback(() => {
        const current = owner.read();
        return current?.origin.kind === 'store' && current.origin.listing.sourceId === sourceId
            && current.origin.listing.itemId === itemId ? current : null;
    }, [owner, sourceId, itemId]);
    const matching = React.useSyncExternalStore(subscribePreview, readPreview, readPreview);
    const selectInstalledEntries = React.useCallback((entries: readonly ThemeLibraryEntry[]) => groupInstalledStoreThemes(entries)
        .find(group => group.listing.sourceId === sourceId && group.listing.itemId === itemId)?.entries ?? noInstalledEntries, [sourceId, itemId]);
    const library = useThemeLibraryArtifactInventory(presented, selectInstalledEntries);
    const sources = useRegistrySources('theme', presented);
    const preference = useLocalSetting('themePreference');
    const mode = resolveThemeRuntimeVisualTheme(preference, useColorScheme());
    const listing = React.useMemo(() => ({ sourceId, itemId }), [sourceId, itemId]);
    const [opened, setOpened] = React.useState<Opened | null>(null);
    const [failed, setFailed] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState<StoreThemeListingViewProps['busy']>(null);
    const [failures, setFailures] = React.useState<NonNullable<StoreThemeListingViewProps['installFailures']>>([]);
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
    const run = async (kind: NonNullable<StoreThemeListingViewProps['busy']>, actionId: ActionId, input: unknown) => {
        setBusy(kind);
        try {
            const result = await execute(actionId, input);
            if (!result.ok) {
                if (kind !== 'install') {
                    Modal.alert(t('common.error'), result.error);
                    return;
                }
                const partial = result.errorCode === 'theme_install_partial' ? ThemeInstallResultSchema.safeParse(result.details) : null;
                setFailures(partial?.success ? partial.data.faces.flatMap(face => face.status === 'failed'
                    ? [{ faceName: faces?.find(candidate => candidate.id === face.faceId)?.name ?? face.faceId, code: face.error.code }] : [])
                    : [{ faceName: matching?.document?.profile.name ?? opened?.listing.summary.title ?? '', code: result.errorCode ?? 'action_failed' }]);
            } else setFailures([]);
        } catch (error) {
            if (kind !== 'install') {
                Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.unknown'));
                return;
            }
            setFailures([{ faceName: matching?.document?.profile.name ?? opened?.listing.summary.title ?? '',
                code: readActionErrorCodeV1(error) ?? 'action_failed' }]);
        } finally { setBusy(null); }
    };
    const install = () => matching ? run('install', THEME_ACTION_IDS.keep, { previewRef: matching.previewRef })
        : run('install', THEME_ACTION_IDS.install, { listing });
    return props.children({
        name: opened?.listing.summary.title ?? '', kicker: [t('settingsAppearance.theme'), describeStoreThemeModes(faces?.map(face => face.mode) ?? [])].filter(Boolean).join(' · '),
        meta: opened ? [opened.listing.summary.publisher?.name, sources.sources.find(source => source.id === sourceId)?.title,
            opened.listing.pointer.version].filter(Boolean).join(' · ') : '',
        description: opened?.listing.summary.description ?? null,
        faces, facesState: opened ? 'ready' : failed ? 'error' : 'loading', facesError: failed, tryingFaceId,
        preferredFaceId: preferred?.id ?? null, here: t('themeDevices.here'), installed,
        facts: [
            { key: 'includes', value: opened?.listing.metadata.includes.map(face => face.label).join(' · ') ?? t('common.unknown') },
            { key: 'changes', value: coverageFacts?.changes ?? t('common.unknown') },
            { key: 'worksOn', ...(coverageFacts?.worksOn ?? { value: t('common.unknown') }) },
            { key: 'licence', value: opened?.listing.metadata.license ?? t('common.unknown') },
        ], busy, installFailures: failures,
        onTryFace: id => {
            const face = faces?.find(candidate => candidate.id === id);
            if (face) return run('try', THEME_ACTION_IDS.tryOn, { document: face.document, mode: face.mode, origin: { kind: 'store', listing } });
        },
        onRevert: () => matching ? run('revert', THEME_ACTION_IDS.revert, { previewRef: matching.previewRef }) : undefined,
        onInstall: install, onRetryFaces: install,
        onUninstall: hasInstalledFaces ? () => run('uninstall', THEME_ACTION_IDS.uninstall, { listing }) : undefined,
    });
}
