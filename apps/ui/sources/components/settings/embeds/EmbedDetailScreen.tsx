import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AccountApiTokenSummaryV1 } from '@happier-dev/protocol';
import { deriveEmbedAccessFromGrantV1 } from '@happier-dev/protocol/embed';
import { HAPPIER_PAGE_METRICS, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import { useGlobalSearchParams, useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { ApiTokenGrantModelsPicker } from '@/components/settings/apiTokens/grant/ApiTokenGrantEditor';
import { showApiTokenCreateModal } from '@/components/settings/apiTokens/showApiTokenCreateModal';
import type { ApiTokenExpiryPreset, ApiTokenSettingsController, ApiTokenSettingsState } from '@/components/settings/apiTokens/apiTokenSettingsController';
import {
    buildApiTokenCreateRestorePath,
    isApiTokenCreateResumeForActiveAccount,
    readApiTokenCreateResume,
} from '@/components/settings/apiTokens/apiTokenCreateResume';
import { ApiTokenExpiryChoiceItem } from '@/components/settings/apiTokens/ApiTokenExpiryChoiceItem';
import { resolveApiTokenOperationErrorMessageKey } from '@/components/settings/apiTokens/apiTokenSettingsPresentation';
import { useApiTokenSettingsScopeController } from '@/components/settings/apiTokens/collection/ApiTokenSettingsScope';
import { confirmForCapturedAccount } from '@/components/settings/apiTokens/confirmForCapturedAccount';
import { useApiTokenSettingsControllerState } from '@/components/settings/apiTokens/useApiTokenSettingsControllerState';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { StepTransitionFrame } from '@/components/ui/motion';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { Modal } from '@/modal';
import { getServerUrl } from '@/sync/domains/server/serverConfig';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveWebappUrlFromServerUrl } from '@/sync/domains/server/url/resolveWebappUrlFromServerUrl';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { useInPlaceFocusReturn } from '@/utils/navigation/useNavigationFocusReturn';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    DEFAULT_EMBED_DRAFT,
    buildEmbedGrant,
    buildEmbedUpdateInput,
    isEmbedEnforcedEdit,
    readEmbedDraftIssue,
    listEmbedSummaryParts,
    readEmbedDraft,
    type EmbedDraft,
} from './embedDraft';
import { formatEmbedSummary } from './embedPresentation';
import { EMBED_DETAIL_TWO_COLUMN_MIN_WIDTH_PX, EMBEDS_COLLECTION_ROOT, embedDetailPath, isEmbedToken } from './embedsCollection';
import { EmbedLivePreview } from './EmbedLivePreview';
import { EmbedPermissionModesPicker } from './sections/EmbedPermissionModesPicker';
import { summarizeApiTokenGrantPermissionModes, useApiTokenGrantModeAgentType } from '@/components/settings/apiTokens/grant/apiTokenGrantPermissionModes';
import {
    EmbedCapabilitiesSection,
    EmbedComposerSection,
    EmbedModelsSection,
    EmbedSitesSection,
    useEmbedGrantPart,
} from './sections/EmbedAccessSections';
import { EmbedAppearanceSection } from './sections/EmbedAppearanceSection';
import { EmbedOrganizationSection, EmbedSessionsSection } from './sections/EmbedPlacementSections';
import { EmbedSnippetsSection } from './sections/EmbedSnippetsSection';
import { useEmbedOrganizationNames } from './useEmbedOrganizationNames';
import { useEmbedSummaryNames } from './useEmbedSummaryNames';

const PREVIEW_COLUMN_WIDTH_PX = 344;
/** The preview column starts level with the page header and mirrors that space on its outer edge. */
const PREVIEW_COLUMN_GUTTER_PX = HAPPIER_PAGE_METRICS.pageHeaderPaddingTopPx;

type Step = 'settings' | 'models' | 'modes' | 'preview';
type RouteParam = string | string[] | undefined;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        flexDirection: 'row',
        backgroundColor: theme.colors.surface.base,
    },
    settings: {
        flex: 1,
        minWidth: 0,
    },
    previewColumn: {
        width: PREVIEW_COLUMN_WIDTH_PX + PREVIEW_COLUMN_GUTTER_PX,
        paddingTop: PREVIEW_COLUMN_GUTTER_PX,
        paddingRight: PREVIEW_COLUMN_GUTTER_PX,
    },
    reconnect: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    footer: {
        gap: theme.margins.md,
        paddingTop: theme.margins.sm,
    },
    review: {
        ...Typography.default(),
        ...happierPageTextMetrics('pageDescription'),
        color: theme.colors.text.primary,
    },
    reviewNote: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    error: {
        ...Typography.rowMeta(),
        color: theme.colors.state.danger.foreground,
    },
    danger: {
        gap: theme.margins.sm,
        alignItems: 'flex-start',
        paddingTop: theme.margins.md,
    },
    encryption: {
        gap: theme.margins.sm,
        alignItems: 'flex-start',
    },
    // The pushed phone preview (lab P3): the chat fills the page below its header, edge to edge.
    previewPage: {
        flex: 1,
        minHeight: 0,
    },
    previewPageContainer: {
        flexGrow: 1,
    },
}));

function formatDay(at: string): string {
    return formatWithCachedDateTimeFormatter(new Date(at), undefined, { day: 'numeric', month: 'short' });
}

function navigate(router: ReturnType<typeof useRouter>, href: string, tag: string, mode: 'push' | 'replace' = 'replace') {
    const result = runGuardedNavigation(() => (mode === 'push' ? router.push(href as never) : router.replace(href as never)));
    if (result !== true) fireAndForget(result, { tag });
}

/** Where a new embed starts: a draft resumed after restoring encryption access, else the defaults. */
type EmbedCreateStart = Readonly<{ draft: EmbedDraft; expiry: ApiTokenExpiryPreset }>;
const DEFAULT_EMBED_CREATE_START: EmbedCreateStart = Object.freeze({ draft: DEFAULT_EMBED_DRAFT, expiry: 'none' });

/**
 * A create interrupted by restoring the secret key comes back with its complete draft in the URL
 * (`apiTokenCreateResume`); it resumes only on the exact Account and Home it started on.
 */
function useEmbedCreateStart(): EmbedCreateStart {
    const params = useGlobalSearchParams<Record<string, string | string[] | undefined>>();
    const activeScope = useActiveServerAccountScope();
    const [start] = React.useState<EmbedCreateStart>(() => {
        const resume = readApiTokenCreateResume(params);
        if (!resume || !resume.draft.grant || !resume.draft.embedConfig) return DEFAULT_EMBED_CREATE_START;
        if (!isApiTokenCreateResumeForActiveAccount(resume, { scope: activeScope ?? null, server: getActiveServerSnapshot() })) {
            return DEFAULT_EMBED_CREATE_START;
        }
        return {
            draft: { label: resume.draft.label, access: deriveEmbedAccessFromGrantV1(resume.draft.grant), config: resume.draft.embedConfig },
            expiry: resume.draft.expiryPreset,
        };
    });
    return start;
}

/** `/settings/embeds/new`: the embed detail in create mode. */
export const EmbedCreateScreen = React.memo(function EmbedCreateScreen() {
    const start = useEmbedCreateStart();
    return <EmbedDetail token={null} start={start} />;
});

/** `/settings/embeds/[tokenId]`: one embed, edited in place. */
export const EmbedEditScreen = React.memo(function EmbedEditScreen() {
    const params = useLocalSearchParams<{ tokenId?: RouteParam }>();
    const tokenId = String(Array.isArray(params.tokenId) ? params.tokenId[0] ?? '' : params.tokenId ?? '');
    const state = useApiTokenSettingsControllerState(useApiTokenSettingsScopeController());
    const router = useRouter();
    const token = state.tokens.find((candidate) => candidate.tokenId === tokenId && isEmbedToken(candidate)) ?? null;
    if (token) return <EmbedDetail key={token.tokenId} token={token} />;
    if ((state.phase === 'idle' || state.phase === 'loading') && state.tokens.length === 0) {
        return (
            <ItemList>
                <SettingsPageHeader />
                <ItemGroup>
                    <ItemLoadStateRows testID="settings-embed-detail-loading" state={{ kind: 'loading' }} rows={4} lines={2}
                        accessibilityLabel={t('settingsEmbeds.title')} />
                </ItemGroup>
            </ItemList>
        );
    }
    return (
        <SurfaceStateCard
            testID="settings-embed-detail-missing"
            kind="unavailable"
            title={t('settingsEmbeds.detail.missingTitle')}
            action={{ label: t('settingsEmbeds.detail.backToEmbeds'), onPress: () => navigate(router, EMBEDS_COLLECTION_ROOT, 'EmbedEditScreen.back') }}
        />
    );
});

const EmbedDetail = React.memo(function EmbedDetail(props: Readonly<{ token: AccountApiTokenSummaryV1 | null; start?: EmbedCreateStart }>) {
    const styles = stylesheet;
    const router = useRouter();
    const controller = useApiTokenSettingsScopeController();
    const state = useApiTokenSettingsControllerState(controller);
    const organization = useEmbedOrganizationNames();
    const summaryNames = useEmbedSummaryNames();
    const create = props.token === null;
    const [draft, setDraft] = React.useState<EmbedDraft>(() => (props.token ? readEmbedDraft(props.token) : (props.start ?? DEFAULT_EMBED_CREATE_START).draft));
    const [expiry, setExpiry] = React.useState<ApiTokenExpiryPreset>(() => (props.start ?? DEFAULT_EMBED_CREATE_START).expiry);
    const [step, setStepState] = React.useState<Step>('settings');
    // A pushed picker replaces the settings in place; Done returns focus to the row that opened it.
    const focusReturn = useInPlaceFocusReturn();
    const setStep = React.useCallback((next: Step) => {
        if (next !== 'settings') focusReturn.capture();
        setStepState(next);
    }, [focusReturn]);
    React.useEffect(() => {
        if (step === 'settings') focusReturn.restore();
    }, [focusReturn, step]);
    const [width, setWidth] = React.useState(0);
    const [saving, setSaving] = React.useState(false);
    const [saveError, setSaveError] = React.useState<string | null>(null);
    // Below this width the preview is a pushed page, never stacked above the settings (plan 04 §6.2).
    const wide = width >= EMBED_DETAIL_TWO_COLUMN_MIN_WIDTH_PX;

    React.useEffect(() => {
        if (create) void controller.refreshEncryptionAvailability();
    }, [controller, create]);

    const update = props.token ? buildEmbedUpdateInput(props.token, draft) : null;
    const enforcedEdit = props.token !== null && isEmbedEnforcedEdit(props.token, draft);
    const labelReady = draft.label.trim().length > 0;
    const draftIssue = readEmbedDraftIssue(draft);
    // An embed on an encrypted account needs a usable encrypted parent; a plain account creates keyless.
    const encryptionReady = state.encryptionAvailability === 'ready' || state.encryptionAvailability === 'plain';
    const grantPart = useEmbedGrantPart({ draft, onChange: setDraft });
    const agentType = useApiTokenGrantModeAgentType(draft.access.create?.agentTargetKey ?? null);

    const save = React.useCallback(async () => {
        if (!props.token || !update) return;
        setSaving(true);
        setSaveError(null);
        const error = await controller.updateToken(update);
        setSaving(false);
        if (error) setSaveError(t(resolveApiTokenOperationErrorMessageKey(error)));
    }, [controller, props.token, update]);

    const createDraft = React.useCallback((): ApiTokenSettingsState['createDraft'] => ({
        label: draft.label.trim(),
        expiryPreset: expiry,
        access: 'limited',
        grant: buildEmbedGrant(draft),
        embedConfig: draft.config,
        encryptionAccess: state.encryptionAvailability === 'ready',
    }), [draft, expiry, state.encryptionAvailability]);

    const submitCreate = React.useCallback(async () => {
        if (!labelReady || draftIssue || !encryptionReady) return;
        // The token controller owns the request identity, expiry and one-time reveal.
        controller.setCreateDraft(createDraft());
        await controller.createToken();
        const reveal = controller.getState().reveal;
        if (!reveal?.apiToken.embedConfig) return;
        showApiTokenCreateModal(controller, Modal, () => {
            navigate(router, embedDetailPath(reveal.apiToken.tokenId), 'EmbedReveal.done');
        }, {
            revealAccessory: (
                <RoundButton
                    testID="settings-embed-reveal-env"
                    size="normal"
                    display="secondary"
                    title={t('settingsEmbeds.reveal.copyEnv')}
                    onPress={() => void setClipboardStringSafe(`HAPPIER_EMBED_KEY=${reveal.token}`).then((copied) => {
                        if (copied) controller.acknowledgeReveal();
                    })}
                />
            ),
        });
    }, [controller, createDraft, draftIssue, encryptionReady, labelReady, router]);

    const activeScope = useActiveServerAccountScope();
    const restoreEncryption = React.useCallback(() => {
        const serverUrl = String(getActiveServerSnapshot().serverUrl ?? '').trim();
        if (!activeScope || !serverUrl || draftIssue) return;
        navigate(router, buildApiTokenCreateRestorePath('/settings/embeds/new', createDraft(), {
            targetServerId: activeScope.serverId,
            targetServerUrl: serverUrl,
            expectedAccountId: activeScope.accountId,
        }), 'EmbedDetail.restoreEncryption', 'push');
    }, [activeScope, createDraft, draftIssue, router]);

    const remove = React.useCallback(async () => {
        if (!props.token) return;
        const token = props.token;
        // The token owner revokes; the confirmation states the embed's consequence and is bound to the Account it opened for.
        const target = await confirmForCapturedAccount(controller, () => Modal.confirm(
            t('settingsEmbeds.delete.title', { label: token.label }),
            t('settingsEmbeds.delete.body'),
            { cancelText: t('common.cancel'), confirmText: t('settingsEmbeds.delete.confirm'), destructive: true },
        ));
        if (target && await controller.revokeToken(token.tokenId, target)) navigate(router, EMBEDS_COLLECTION_ROOT, 'EmbedDetail.deleted');
    }, [controller, props.token, router]);

    const serverUrl = getServerUrl();
    // Stable while what the snippets say is unchanged, so typing a name never rebuilds them.
    const snippetsInput = React.useMemo(() => ({
        happierUrl: resolveWebappUrlFromServerUrl(serverUrl),
        serverUrl,
        hasListingOrganization: draft.config.organization.folderId !== null || draft.config.organization.tagIds.length > 0,
        organizationLabel: [
            draft.config.organization.folderId ? organization.folderName(draft.config.organization.folderId) : null,
            ...draft.config.organization.tagIds.map((tagId) => organization.tagLabel(tagId)),
        ].filter((value): value is string => Boolean(value)).join(' · ') || null,
        createAllowed: draft.access.create !== null,
        newChat: draft.config.newChat?.enabled === true,
    }), [draft.access.create, draft.config.newChat, draft.config.organization, organization, serverUrl]);
    // Stable while the draft's presentation is unchanged, so typing elsewhere never reconfigures the preview.
    const previewUi = React.useMemo(
        () => ({ attachments: draft.config.ui.attachments, modelPicker: draft.access.changeModel }),
        [draft.access.changeModel, draft.config.ui.attachments],
    );

    const meta = props.token ? [
        { key: 'created', text: t('settingsEmbeds.detail.created', { date: formatDay(props.token.createdAt) }) },
        { key: 'used', text: props.token.lastUsedAt ? t('settingsEmbeds.detail.lastUsed', { date: formatDay(props.token.lastUsedAt) }) : t('settingsApiTokens.neverUsed') },
        ...(props.token.expiresAt ? [{ key: 'expires', text: t('settingsEmbeds.detail.expires', { date: formatDay(props.token.expiresAt) }) }] : []),
    ] : undefined;

    const header = (
        <SettingsPageHeader
            title={step === 'models' ? t('settingsEmbeds.models.allowed')
                : step === 'modes' ? t('settingsEmbeds.capabilities.permissionModes')
                    : step === 'preview' ? t('settingsEmbeds.preview.title')
                        : create ? t('settingsEmbeds.newTitle') : draft.label || props.token!.label}
            alwaysShowTitle={!create && step === 'settings'}
            description={step === 'modes' ? t('settingsEmbeds.capabilities.permissionModesDescription')
                : step === 'settings' && create ? t('settingsEmbeds.createDescription') : undefined}
            meta={step === 'settings' ? meta : undefined}
            titleEditor={step !== 'settings' || create ? undefined : {
                value: draft.label,
                placeholder: t('settingsEmbeds.namePlaceholder'),
                accessibilityLabel: t('settingsEmbeds.name'),
                onChangeText: (label) => setDraft((current) => ({ ...current, label })),
            }}
            primaryAction={step !== 'settings' || create ? undefined : {
                title: t('common.save'),
                testID: 'settings-embed-save',
                disabled: !update || !labelReady || saving,
                onPress: () => void save(),
            }}
            cancelAction={step !== 'settings' ? {
                title: t('common.done'),
                testID: 'settings-embed-picker-done',
                onPress: () => setStep('settings'),
            } : create ? {
                title: t('common.cancel'),
                testID: 'settings-embed-cancel',
                onPress: () => navigate(router, EMBEDS_COLLECTION_ROOT, 'EmbedDetail.cancel'),
            } : undefined}
        />
    );

    const settings = (
        <>
            {enforcedEdit ? <Text style={styles.reconnect} accessibilityLiveRegion="polite">{t('settingsEmbeds.detail.reconnect')}</Text> : null}
            {saveError ? <Text style={styles.error} accessibilityLiveRegion="assertive">{saveError}</Text> : null}
            {create ? (
                <ItemGroup>
                    <Item
                        title={t('settingsEmbeds.name')}
                        subtitle={t('settingsEmbeds.nameDescription')}
                        accessoryLayout="adaptive"
                        showChevron={false}
                        rightElement={<EmbedNameField value={draft.label} onChange={(label) => setDraft((current) => ({ ...current, label }))} />}
                    />
                    <ApiTokenExpiryChoiceItem
                        testIDPrefix="settings-embed-expiry"
                        title={t('settingsEmbeds.detail.expiry')}
                        subtitle={t('settingsEmbeds.detail.expiryDescription')}
                        value={expiry}
                        disabled={state.createPending}
                        onChange={setExpiry}
                    />
                </ItemGroup>
            ) : null}
            <EmbedSitesSection draft={draft} onChange={setDraft} />
            <EmbedCapabilitiesSection
                draft={draft}
                onChange={setDraft}
                onOpenPermissionModes={() => setStep('modes')}
                permissionModesSummary={summarizeApiTokenGrantPermissionModes(draft.access.permissionModes, agentType)}
            />
            <EmbedModelsSection draft={draft} onChange={setDraft} onOpenModels={() => setStep('models')} />
            <EmbedOrganizationSection draft={draft} onChange={setDraft} serverId={organization.serverId} />
            <EmbedComposerSection draft={draft} onChange={setDraft} />
            <EmbedSessionsSection draft={draft} onChange={setDraft} serverId={organization.serverId} />
            {!wide ? (
                <ItemGroup>
                    <Item testID="settings-embed-preview-row" title={t('settingsEmbeds.preview.title')} subtitle={t('settingsEmbeds.preview.rowDescription')} onPress={() => setStep('preview')} />
                </ItemGroup>
            ) : null}
            <EmbedAppearanceSection draft={draft} onChange={setDraft} />
            {create ? (
                <View style={styles.footer}>
                    <Text style={styles.review}>{draftIssue
                        ? t('settingsApiTokens.errors.grantIncomplete')
                        : formatEmbedSummary(listEmbedSummaryParts({ grant: buildEmbedGrant(draft), embedConfig: draft.config }), summaryNames)}</Text>
                    <Text testID="settings-embed-key-reach" style={styles.reviewNote}>{t('settingsEmbeds.detail.keyReach')}</Text>
                    {state.encryptionAvailability === 'ready' ? <Text testID="settings-embed-e2ee-trust" style={styles.reviewNote}>{t('settingsEmbeds.detail.e2eeTrust')}</Text> : null}
                    <EmbedEncryptionStatus
                        availability={state.encryptionAvailability}
                        onRestore={restoreEncryption}
                        onRetry={() => void controller.refreshEncryptionAvailability()}
                    />
                    {state.createError ? <Text style={styles.error} accessibilityLiveRegion="assertive">{t(resolveApiTokenOperationErrorMessageKey(state.createError))}</Text> : null}
                    <RoundButton
                        testID="settings-embed-create"
                        title={t('settingsEmbeds.create')}
                        disabled={!labelReady || draftIssue !== null || !encryptionReady || state.createPending}
                        loading={state.createPending}
                        onPress={() => void submitCreate()}
                    />
                </View>
            ) : (
                <>
                    <EmbedSnippetsSection input={snippetsInput} />
                    <View style={styles.danger}>
                        <RoundButton testID="settings-embed-delete" size="normal" display="destructive" title={t('settingsEmbeds.delete.button')} onPress={() => void remove()} />
                    </View>
                </>
            )}
        </>
    );

    const picker = step === 'models' ? (
        <ApiTokenGrantModelsPicker {...grantPart} />
    ) : step === 'modes' ? (
        <EmbedPermissionModesPicker draft={draft} onChange={setDraft} agentType={agentType} />
    ) : step === 'preview' ? (
        <View style={styles.previewPage}>
            <EmbedLivePreview presentation="page" style={draft.config.style} ui={previewUi} newChat={draft.config.newChat?.enabled === true} reconnecting={enforcedEdit} />
        </View>
    ) : null;

    return (
        <View testID="settings-embed-detail-root" style={styles.root} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
            <View style={styles.settings}>
                <ItemList
                    testID="settings-embed-detail"
                    scrollEnabled={step !== 'preview'}
                    containerStyle={step === 'preview' ? styles.previewPageContainer : undefined}
                >
                    {header}
                    <StepTransitionFrame
                        transitionKey={step}
                        direction={step === 'settings' ? 'backward' : 'forward'}
                        style={step === 'preview' ? styles.previewPage : undefined}
                        contentStyle={step === 'preview' ? styles.previewPage : undefined}
                    >
                        {picker ?? settings}
                    </StepTransitionFrame>
                </ItemList>
            </View>
            {wide && step === 'settings' ? (
                <View style={styles.previewColumn}>
                    <EmbedLivePreview style={draft.config.style} ui={previewUi} newChat={draft.config.newChat?.enabled === true} reconnecting={enforcedEdit} />
                </View>
            ) : null}
        </View>
    );
});

/**
 * Whether this account can hold an embed key right now. A plain account and a usable encrypted one say
 * nothing; checking is one quiet line; an encrypted account whose keys are missing or out of date on
 * this device offers the restore that fixes it, and a failed check offers Retry.
 */
function EmbedEncryptionStatus(props: Readonly<{
    availability: ApiTokenSettingsState['encryptionAvailability'];
    onRestore: () => void;
    onRetry: () => void;
}>) {
    const styles = stylesheet;
    const { availability } = props;
    if (availability === 'plain' || availability === 'ready') return null;
    if (availability === 'unchecked' || availability === 'checking') {
        return <Text testID="settings-embed-encryption-checking" style={styles.reviewNote} accessibilityLiveRegion="polite">{t('settingsEmbeds.detail.encryptionChecking')}</Text>;
    }
    const restore = availability === 'unavailable' || availability === 'stale';
    return (
        <View style={styles.encryption} testID={`settings-embed-encryption-${availability}`}>
            <Text style={styles.reviewNote} accessibilityLiveRegion="polite">
                {t(availability === 'unavailable'
                    ? 'settingsEmbeds.detail.encryptionUnavailable'
                    : availability === 'stale'
                        ? 'settingsEmbeds.detail.encryptionStale'
                        : 'settingsEmbeds.detail.encryptionUnreadable')}
            </Text>
            <RoundButton
                testID={restore ? 'settings-embed-restore-encryption' : 'settings-embed-retry-encryption'}
                size="normal"
                display="secondary"
                title={restore ? t('navigation.restoreWithSecretKey') : t('common.retry')}
                onPress={restore ? props.onRestore : props.onRetry}
            />
        </View>
    );
}

function EmbedNameField(props: Readonly<{ value: string; onChange: (next: string) => void }>) {
    return (
        <FieldTextInput
            testID="settings-embed-name"
            accessibilityLabel={t('settingsEmbeds.name')}
            placeholder={t('settingsEmbeds.namePlaceholder')}
            value={props.value}
            onChangeText={props.onChange}
        />
    );
}
