import * as React from 'react';
import { THEME_ACTION_IDS } from '@happier-dev/protocol/actions/themeActionIdsV1';
import type { ThemeActionOutput } from '@happier-dev/protocol/actions/themeActionFamily';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { StorePluginThemeListingReference } from '@/components/settings/plugins/model/storeListingSelection';
import { buildPluginDetailRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { getThemePresetSourceReferenceId } from '@/components/settings/appearance/themeProfiles/themeProfilePresetOptions';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useThemeLibraryEntry, useThemeProfileDocument, useThemeProfileReferenceSelection } from '@/sync/store/useThemeProfiles';
import { usePluginThemeList } from '@/theme/profiles/usePluginThemeList';
import { getThemeTryOnOwner } from '@/theme/profiles/themeTryOnRuntime';
import { prepareThemeProfileCssAsync } from '@/theme/css/prepareThemeCss';
import type { ThemeCssCoverage } from '@/theme/css/types';
import { Modal } from '@/modal';
import { t } from '@/text';
import { describeStoreThemeModes, projectStoreThemeCoverageFacts } from './catalog/storeThemes';
import type { StoreThemeListingViewProps } from './storeThemeViewTypes';

/** Plugin contributions retain the library's admitted reference through preview, Apply and duplication. */
export function StorePluginThemeListingController(props: Readonly<{ reference: StorePluginThemeListingReference['reference'];
    children(view: StoreThemeListingViewProps): React.ReactNode }>) {
    const presented = useLayoutPresentationActive();
    const scope = useAccountSettingsScope();
    const { execute, ready } = useMountedActionExecution(scope);
    const router = useRouter();
    const entry = useThemeLibraryEntry(props.reference, presented);
    const document = useThemeProfileDocument(props.reference, presented);
    const plugin = usePluginThemeList(props.reference, presented);
    const selection = useThemeProfileReferenceSelection(presented);
    const owner = getThemeTryOnOwner();
    const { pluginId, contributionId } = props.reference;
    const subscribe = React.useCallback((listener: () => void) => presented ? owner.subscribe(listener) : () => {}, [owner, presented]);
    const read = React.useCallback(() => {
        const current = owner.read();
        const ref = current?.selection;
        return ref?.kind === 'plugin' && ref.pluginId === pluginId && ref.contributionId === contributionId ? current : null;
    }, [owner, pluginId, contributionId]);
    const matching = React.useSyncExternalStore(subscribe, read, read);
    React.useLayoutEffect(() => presented && matching ? owner.present(matching.previewRef) : undefined,
        [owner, presented, Boolean(matching), pluginId, contributionId]);
    const [busy, setBusy] = React.useState<StoreThemeListingViewProps['busy']>(null);
    const [coverage, setCoverage] = React.useState<ThemeCssCoverage | null>(null);
    React.useEffect(() => {
        if (!presented || !document.document) return;
        let active = true;
        void prepareThemeProfileCssAsync(document.document.profile).then(prepared => {
            if (active) setCoverage(prepared.coverage);
        }).catch(() => { if (active) setCoverage(null); });
        return () => { active = false; };
    }, [presented, document.document]);
    const run = async (kind: NonNullable<StoreThemeListingViewProps['busy']>, action: ActionId, input: unknown) => {
        if (!ready) return;
        setBusy(kind);
        try {
            const result = await execute(action, input);
            if (!result.ok) Modal.alert(t('common.error'), result.error);
            else if (kind === 'duplicate') {
                const { entry: duplicate } = result.result as ThemeActionOutput<typeof THEME_ACTION_IDS.duplicate>;
                router.push({ pathname: '/settings/appearance/themes/[profileId]', params: { profileId: getThemePresetSourceReferenceId(duplicate.reference) } });
            }
        } catch (error) { Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.unknown')); }
        finally { setBusy(null); }
    };
    const selected = entry ? selection[entry.mode] : null;
    const installed = selected?.kind === 'plugin' && selected.pluginId === pluginId && selected.contributionId === contributionId;
    const here = t('themeDevices.here');
    const coverageFacts = coverage ? projectStoreThemeCoverageFacts(coverage) : null;
    const apply = () => matching ? run('install', THEME_ACTION_IDS.keep, { previewRef: matching.previewRef })
        : entry ? run('install', THEME_ACTION_IDS.apply, { ref: props.reference, mode: entry.mode }) : undefined;
    return props.children({ name: entry?.name ?? '', kicker: entry ? describeStoreThemeModes([entry.mode]) : '',
        meta: [plugin?.pluginName, plugin?.pluginVersion].filter(Boolean).join(' · '), description: null,
        faces: entry && document.document ? [{ id: contributionId, name: entry.name, mode: entry.mode, miniature: entry.miniature }] : null,
        facesState: document.state === 'ready' ? 'ready' : document.state === 'loading' ? 'loading' : 'error',
        facesError: document.state === 'missing' ? t('common.unavailable') : null,
        tryingFaceId: matching ? contributionId : null, preferredFaceId: entry ? contributionId : null, here, installed,
        installLabel: t('common.apply'), installedLabel: t('themeCard.applied', { here }),
        ...(matching ? { decisionHelp: t('themeCard.trying', { here }) } : installed ? { decisionHelp: t('themeCard.applied', { here }) } : {}),
        facts: [{ key: 'includes', value: entry ? t('themeStore.includesCount', { count: 1 }) : t('common.unknown') },
            { key: 'changes', value: coverageFacts?.changes ?? t('common.unknown') },
            { key: 'worksOn', ...(coverageFacts?.worksOn ?? { value: t('common.unknown') }) },
            { key: 'licence', value: t('common.unknown') }], busy,
        onTryFace: id => id === contributionId && document.document && entry
            ? run('try', THEME_ACTION_IDS.tryOn, { document: document.document, mode: entry.mode, origin: { kind: 'editor' } }) : undefined,
        onRevert: () => matching ? run('revert', THEME_ACTION_IDS.revert, { previewRef: matching.previewRef }) : undefined,
        onInstall: apply, onRetryFaces: document.retry, onRetryAcquisition: document.retry,
        onDuplicate: entry ? () => run('duplicate', THEME_ACTION_IDS.duplicate, { ref: props.reference }) : undefined,
        onManageSource: () => router.push(buildPluginDetailRoute('app', pluginId)),
    });
}
