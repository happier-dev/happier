import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { resolveHappierFocusRingVisible, useHappierHitArea } from '@happier-dev/plugin-ui/presentation';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { motionTokens, StepTransitionFrame } from '@/components/ui/motion';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

import {
    resolveApiTokenExpiryInstant,
    type ApiTokenSettingsController,
} from './apiTokenSettingsController';
import { buildApiTokenCreateRestorePath } from './apiTokenCreateResume';
import { ApiTokenExpiryChoiceItem } from './ApiTokenExpiryChoiceItem';
import { ApiTokenRevealBody, ApiTokenRevealDone } from './ApiTokenReveal';
import { resolveApiTokenOperationErrorMessageKey } from './apiTokenSettingsPresentation';
import { ApiTokenGrantDeployApprovalRow, ApiTokenGrantEditor, ApiTokenGrantPickerDone, useApiTokenGrantPicker } from './grant/ApiTokenGrantEditor';
import { API_TOKEN_LIMITED_GRANT_START_V1, areApiTokenGrantsEqual, isApiTokenGrantDraftSendable } from './grant/apiTokenGrantDraft';
import { useApiTokenSettingsControllerState } from './useApiTokenSettingsControllerState';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';


const stylesheet = StyleSheet.create((theme) => ({
    // A contained page: its first section's own gap spaces it from the card header, and sections
    // keep the page rhythm between them, so the body adds no top padding or gaps of its own.
    body: {
        paddingHorizontal: theme.space.s20,
        paddingBottom: theme.space.s24,
    },
    stack: {},
    // The one-time reveal is not a page section: it keeps its own breath under the card header.
    revealStep: {
        paddingTop: theme.space.s20,
    },
    note: {
        marginTop: theme.space.s16,
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: theme.space.s10,
    },
    footerNote: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        minWidth: 0,
    },
    footerNoteText: {
        flexShrink: 1,
        color: theme.colors.state.warning.textForeground,
        ...Typography.variant('meta'),
    },
    guidanceRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: theme.space.s4,
        paddingHorizontal: theme.space.s2,
    },
    guidanceText: {
        color: theme.colors.text.secondary,
        ...Typography.variant('body'),
    },
    actionSettingsLink: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: theme.space.s4,
        borderRadius: 8,
    },
    link: {
        color: theme.colors.text.link,
        textDecorationLine: 'underline',
    },
    error: {
        color: theme.colors.state.danger.textForeground,
        ...Typography.variant('body'),
    },
    secret: {
        ...Typography.mono(),
        color: theme.colors.text.primary,
        fontSize: 13,
        lineHeight: 19,
    },
}));

type CreateStage = 'basics' | 'access';

export type ApiTokenRevealCopy = Readonly<{ title: string; shownOnce: string; copy: string }>;

/**
 * Create an API token (label, access, expiry, content and Team access; then, for limited access, the
 * grant editor), reveal it once — or, in `editAccess` mode, edit an existing token's grant. The
 * lifecycle of both lives in `apiTokenSettingsController`.
 */
export function ApiTokenCreateModal(props: Readonly<{
    controller: ApiTokenSettingsController;
    mode?: 'create' | 'editAccess';
    /** Domain-specific copy actions can accompany the canonical one-time reveal. */
    revealAccessory?: React.ReactNode;
    /** A domain's wording for the reveal (an embed's key): the band title, warning and Copy. */
    revealCopy?: ApiTokenRevealCopy;
    /** An exact Environment grant preset; only its saved deployment choice remains editable. */
    deploymentTitle?: string;
}> & CustomModalInjectedProps) {
    if (props.mode === 'editAccess') return <ApiTokenEditAccessContent {...props} />;
    return <ApiTokenCreateContent {...props} />;
}

function ApiTokenCreateContent(props: Readonly<{ controller: ApiTokenSettingsController; revealAccessory?: React.ReactNode; revealCopy?: ApiTokenRevealCopy; deploymentTitle?: string }> & CustomModalInjectedProps) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const router = useRouter();
    const activeServerAccountScope = useActiveServerAccountScope();
    const state = useApiTokenSettingsControllerState(props.controller);
    const reveal = state.reveal;
    const reducedMotion = useReducedMotionPreference();
    // The inline link draws as its words; a finger reaches the touch target above and below them, never over the sentence.
    const actionSettingsHitArea = useHappierHitArea({ restingStyle: () => null, hitReach: { left: 0, right: 0 } });
    const [stage, setStage] = React.useState<CreateStage>('basics');
    const draft = state.createDraft;
    const limited = draft.access === 'limited';
    const grant = draft.grant ?? API_TOKEN_LIMITED_GRANT_START_V1;
    const onAccessStage = limited && stage === 'access' && !reveal;
    const grantPicker = useApiTokenGrantPicker();
    const pickerOpen = onAccessStage && grantPicker.picker !== null;
    const labelReady = draft.label.trim().length > 0;
    const deployment = props.deploymentTitle !== undefined;
    const deploymentReady = !deployment || state.encryptionAvailability === 'plain';
    const canSubmit = labelReady && !state.createPending && !state.recoveryTokenId
        && deploymentReady && (!limited || isApiTokenGrantDraftSendable(grant));

    React.useEffect(() => {
        if (!reveal) return;
        announceAccessibilityMessage(t('settingsApiTokens.reveal.accessibilityAnnouncement'));
    }, [reveal?.token]);

    const setDraft = props.controller.setCreateDraft;
    const advance = React.useCallback(() => {
        if (!labelReady || !deploymentReady) return;
        if (limited && stage === 'basics') {
            setStage('access');
            return;
        }
        void props.controller.createToken();
    }, [deploymentReady, labelReady, limited, props.controller, stage]);

    const footer = React.useMemo(() => (
        <View style={styles.footer}>
            {reveal ? (
                <ApiTokenRevealDone revealKey={reveal.token} reducedMotion={reducedMotion} onClose={props.onClose} />
            ) : pickerOpen ? (
                <ApiTokenGrantPickerDone onPress={grantPicker.close} />
            ) : (
                <>
                    <RoundButton
                        size="normal"
                        display="inverted"
                        title={onAccessStage ? t('settingsApiTokens.create.back') : t('common.cancel')}
                        testID={onAccessStage ? 'settings-api-tokens-create-back' : undefined}
                        disabled={state.createPending && onAccessStage}
                        onPress={onAccessStage ? () => setStage('basics') : props.onClose}
                    />
                    {limited && !onAccessStage ? (
                        <RoundButton
                            size="normal"
                            title={t('settingsApiTokens.create.continue')}
                            testID="settings-api-tokens-create-continue"
                            disabled={!labelReady || !deploymentReady || !!state.recoveryTokenId}
                            onPress={() => setStage('access')}
                        />
                    ) : (
                        <RoundButton
                            size="normal"
                            title={t('settingsApiTokens.create.submit')}
                            testID="settings-api-tokens-create-submit"
                            disabled={!canSubmit}
                            loading={state.createPending}
                            action={props.controller.createToken}
                        />
                    )}
                </>
            )}
        </View>
    ), [canSubmit, deploymentReady, grantPicker.close, labelReady, limited, onAccessStage, pickerOpen, props.controller.createToken, props.onClose, reducedMotion, reveal, state.createPending, state.recoveryTokenId, styles.footer]);

    useModalCardChrome(props.setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        title: reveal
            ? props.revealCopy?.title ?? t('settingsApiTokens.reveal.title')
            : onAccessStage ? t('settingsApiTokens.create.accessTitle') : t('settingsApiTokens.create.title'),
        // The reveal body already says the token is shown once; the band does not repeat it. `null`
        // clears the band (chrome merges `undefined` as "keep", which left the create subtitle up).
        subtitle: reveal ? null : onAccessStage ? draft.label.trim() : t('settingsApiTokens.create.subtitle'),
        testID: 'settings-api-tokens-create-modal',
        closeButtonTestID: 'settings-api-tokens-create-close',
        phonePresentation: 'sheet' as const,
        // The form keeps one height while its steps change; the one-time reveal is a short final
        // step, so the card fits it instead of leaving an empty void under the warning (lab T8).
        scrollHost: reveal ? 'overlay' as const : 'body' as const,
        dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.9, size: 'md' as const },
        footer,
    }), [draft.label, footer, onAccessStage, props.revealCopy?.title, reveal]));

    return (
        <ScrollView
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            {...(Platform.OS === 'ios' ? { automaticallyAdjustKeyboardInsets: true } : {})}
            contentContainerStyle={styles.body}
        >
            {/* The card body is a contained page: section titles and descriptions above their sheets, on the body's one edge. */}
            <ListPresentationProvider value="page" pageInsets="contained">
            <StepTransitionFrame
                transitionKey={reveal ? 'reveal' : onAccessStage ? 'access' : 'create'}
                direction={reveal ? 'replace' : onAccessStage ? 'forward' : 'backward'}
                reducedMotion={reducedMotion}
                testID="settings-api-tokens-create-step"
            >
                {reveal ? (
                    <View style={styles.revealStep}>
                        <ApiTokenRevealBody
                            token={reveal.token}
                            reducedMotion={reducedMotion}
                            onCopied={props.controller.acknowledgeReveal}
                            copy={props.revealCopy}
                            accessory={props.revealAccessory}
                        />
                    </View>
                ) : onAccessStage ? (
                    <View style={styles.stack}>
                        {deployment ? <ItemGroup title={props.deploymentTitle} description={t('projects.deployments.overviewStatus.ciAuthority')}>
                            <ApiTokenGrantDeployApprovalRow value={grant} onChange={(next) => setDraft({ ...draft, grant: next })} disabled={state.createPending} />
                        </ItemGroup> : <ApiTokenGrantEditor
                            testID="settings-api-tokens-grant-editor"
                            value={grant}
                            onChange={(next) => setDraft({ ...draft, grant: next })}
                            picker={grantPicker.picker}
                            onPickerChange={grantPicker.setPicker}
                            disabled={state.createPending}
                            label={draft.label}
                            expiresAt={resolveApiTokenExpiryInstant(draft.expiryPreset, Date.now())}
                        />}
                        {state.createError ? (
                            <Text accessibilityLiveRegion="assertive" style={[styles.error, styles.note]} testID="settings-api-tokens-create-error">
                                {t(resolveApiTokenOperationErrorMessageKey(state.createError))}
                            </Text>
                        ) : null}
                    </View>
                ) : (
                    <View style={styles.stack}>
                        <ItemGroup>
                            <Item
                                title={t('settingsApiTokens.create.label')}
                                accessoryLayout="adaptive"
                                rightElement={(
                                    <FieldTextInput
                                        testID="settings-api-tokens-create-label"
                                        accessibilityLabel={t('settingsApiTokens.create.label')}
                                        autoFocus
                                        maxLength={256}
                                        value={draft.label}
                                        placeholder={t('settingsApiTokens.create.labelPlaceholder')}
                                        editable={!state.createPending}
                                        onChangeText={(label) => setDraft({ ...draft, label })}
                                        returnKeyType={limited ? 'next' : 'done'}
                                        onSubmitEditing={() => {
                                            if (!state.createPending && !state.recoveryTokenId) advance();
                                        }}
                                    />
                                )}
                                mode="info"
                                showChevron={false}
                            />
                            {!deployment ? <SegmentedChoiceItem
                                title={t('settingsApiTokens.create.access')}
                                testIDPrefix="settings-api-tokens-access"
                                options={[
                                    { id: 'full' as const, label: t('settingsApiTokens.create.accessFull') },
                                    { id: 'limited' as const, label: t('settingsApiTokens.create.accessLimited'), description: t('settingsApiTokens.create.accessLimitedDescription') },
                                ]}
                                value={limited ? 'limited' : 'full'}
                                disabled={state.createPending}
                                onChange={(access) => setDraft({
                                    ...draft,
                                    access,
                                    ...(access === 'limited' && !draft.grant ? { grant: API_TOKEN_LIMITED_GRANT_START_V1 } : {}),
                                })}
                            /> : null}
                            <ApiTokenExpiryChoiceItem
                                value={draft.expiryPreset}
                                disabled={state.createPending}
                                onChange={(expiryPreset) => setDraft({ ...draft, expiryPreset })}
                            />
                        </ItemGroup>
                        {!deployment ? <ItemGroup>
                            {state.encryptionAvailability === 'ready' ? (
                                <Item
                                    title={t('settingsApiTokens.encryption.choice')}
                                    subtitle={t('settingsApiTokens.encryption.consequence')}
                                    subtitleLines={0}
                                    rightElement={<Switch
                                        testID="settings-api-tokens-encryption-access"
                                        accessibilityLabel={t('settingsApiTokens.encryption.choice')}
                                        value={draft.encryptionAccess === true}
                                        disabled={state.createPending}
                                        onValueChange={(encryptionAccess) => setDraft({ ...draft, encryptionAccess })}
                                    />}
                                    showChevron={false}
                                />
                            ) : null}
                            <Item
                                title={t('settingsApiTokens.unattended.choice')}
                                subtitle={t('settingsApiTokens.unattended.consequence')}
                                subtitleLines={0}
                                rightElement={<Switch
                                    testID="settings-api-tokens-unattended-team-access"
                                    accessibilityLabel={t('settingsApiTokens.unattended.choice')}
                                    value={draft.authorizeUnattendedTeamAccess === true}
                                    disabled={state.createPending}
                                    onValueChange={(authorizeUnattendedTeamAccess) => setDraft({ ...draft, authorizeUnattendedTeamAccess })}
                                />}
                                showChevron={false}
                            />
                        </ItemGroup> : null}
                        {deployment && !deploymentReady ? (
                            <ItemGroup><Item testID="settings-api-tokens-deployment-client-required"
                                title={state.encryptionAvailability === 'unchecked' || state.encryptionAvailability === 'checking'
                                    ? t('common.loading') : state.encryptionAvailability === 'unreadable' ? t('common.error') : t('projects.deployments.overviewStatus.ciClientRequired')}
                                subtitle={state.encryptionAvailability === 'unchecked' || state.encryptionAvailability === 'checking' || state.encryptionAvailability === 'unreadable' ? undefined : 'client_required'}
                                showChevron={false} mode="info" />
                                <RoundButton size="normal" display="inverted" title={t('common.retry')} action={props.controller.refreshEncryptionAvailability} />
                            </ItemGroup>
                        ) : null}
                        {!limited ? (
                            <View style={[styles.guidanceRow, styles.note]}>
                                <Text style={styles.guidanceText}>{t('settingsApiTokens.create.actionSettingsPrefix')}</Text>
                                <Pressable
                                    testID="settings-api-tokens-action-settings"
                                    accessibilityRole="link"
                                    accessibilityLabel={t('settingsApiTokens.create.actionSettingsLink')}
                                    accessibilityState={{ disabled: state.createPending }}
                                    focusable
                                    disabled={state.createPending}
                                    hitSlop={actionSettingsHitArea.hitSlop}
                                    onLayout={actionSettingsHitArea.onLayout}
                                    onPress={() => {
                                        props.onClose();
                                        router.push('/settings/actions');
                                    }}
                                    style={(interactionState) => {
                                        const webState = interactionState as typeof interactionState & { focused?: boolean };
                                        return [
                                            styles.actionSettingsLink,
                                            focusRingStyle({ focused: resolveHappierFocusRingVisible(webState.focused), color: theme.colors.border.focus }),
                                            { opacity: interactionState.pressed ? motionTokens.press.opacity : 1 },
                                        ];
                                    }}
                                >
                                    {actionSettingsHitArea.frame}
                                    <Text style={styles.link}>{t('settingsApiTokens.create.actionSettingsLink')}</Text>
                                </Pressable>
                            </View>
                        ) : null}
                {state.createError ? (
                    <Text accessibilityLiveRegion="assertive" style={[styles.error, styles.note]} testID="settings-api-tokens-create-error">
                        {t(resolveApiTokenOperationErrorMessageKey(state.createError))}
                    </Text>
                ) : null}
                {state.recoveryTokenId ? (
                    <View testID="settings-api-tokens-create-recovery" style={{ gap: theme.space.s10 }}>
                        <Text style={styles.guidanceText}>{t('settingsApiTokens.encryption.outcomeUnknown')}</Text>
                        <Text selectable style={styles.secret}>{state.recoveryTokenId}</Text>
                        <RoundButton size="normal" display="inverted" title={t('common.refresh')}
                            action={props.controller.refresh} />
                        <RoundButton size="normal" display="inverted" title={t('settingsApiTokens.revoke.confirm')}
                            action={async () => {
                                const tokenId = state.recoveryTokenId;
                                if (!tokenId) return;
                                if (props.controller.getState().recoveryTokenId === tokenId) {
                                    await props.controller.revokeToken(tokenId);
                                }
                            }} />
                    </View>
                ) : null}
                {(state.createError === 'api_token_encryption_not_ready' || state.createError === 'api_token_encryption_stale')
                    && activeServerAccountScope ? (
                    <RoundButton
                        testID="settings-api-tokens-restore-encryption"
                        size="normal"
                        display="inverted"
                        title={t('navigation.restoreWithSecretKey')}
                        onPress={() => {
                            const targetServerUrl = String(getActiveServerSnapshot().serverUrl ?? '').trim();
                            if (!targetServerUrl) return;
                            props.onClose();
                            // The whole non-secret draft travels (a limited grant included), never a secret.
                            router.push(buildApiTokenCreateRestorePath('/settings/account/api-tokens', state.createDraft, {
                                targetServerId: activeServerAccountScope.serverId,
                                targetServerUrl,
                                expectedAccountId: activeServerAccountScope.accountId,
                            }));
                        }}
                    />
                ) : null}
                    </View>
                )}
            </StepTransitionFrame>
            </ListPresentationProvider>
        </ScrollView>
    );
}

/** Edit an existing token's access: the same editor, Save as the primary, and the consequence for embedded credentials. */
function ApiTokenEditAccessContent(props: Readonly<{ controller: ApiTokenSettingsController }> & CustomModalInjectedProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const state = useApiTokenSettingsControllerState(props.controller);
    const edit = state.accessEdit;
    const token = edit ? state.tokens.find((candidate) => candidate.tokenId === edit.tokenId) ?? null : null;
    const changed = Boolean(edit && token && !areApiTokenGrantsEqual(edit.grant, token.grant));
    const canSave = Boolean(edit && changed && !edit.pending && isApiTokenGrantDraftSendable(edit.grant));
    const { onClose } = props;
    const grantPicker = useApiTokenGrantPicker();
    const pickerOpen = grantPicker.picker !== null;

    const save = React.useCallback(async () => {
        if (await props.controller.saveAccessEdit()) onClose();
    }, [onClose, props.controller]);

    const footer = React.useMemo(() => pickerOpen ? (
        <View style={styles.footer}>
            <ApiTokenGrantPickerDone onPress={grantPicker.close} />
        </View>
    ) : (
        <View style={styles.footer}>
            {edit?.signsOutEmbeddedCredentials ? (
                <View style={styles.footerNote} testID="settings-api-tokens-edit-signs-out">
                    <Icon name="warning" size={14} color={theme.colors.state.warning.foreground} />
                    <Text style={styles.footerNoteText}>{t('settingsApiTokens.edit.signsOut')}</Text>
                </View>
            ) : null}
            <RoundButton size="normal" display="inverted" title={t('common.cancel')} onPress={onClose} />
            <RoundButton
                size="normal"
                title={t('settingsApiTokens.edit.save')}
                testID="settings-api-tokens-edit-save"
                disabled={!canSave}
                loading={edit?.pending === true}
                action={save}
            />
        </View>
    ), [canSave, edit?.pending, edit?.signsOutEmbeddedCredentials, grantPicker.close, onClose, pickerOpen, save, styles.footer, styles.footerNote, styles.footerNoteText, theme.colors.state.warning.foreground]);

    useModalCardChrome(props.setChrome, React.useMemo(() => ({
        kind: 'card' as const,
        title: t('settingsApiTokens.edit.title'),
        subtitle: token?.label,
        testID: 'settings-api-tokens-edit-modal',
        closeButtonTestID: 'settings-api-tokens-edit-close',
        phonePresentation: 'sheet' as const,
        scrollHost: 'body' as const,
        dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.9, size: 'md' as const },
        footer,
    }), [footer, token?.label]));

    if (!edit || !token) return null;
    return (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
            <ListPresentationProvider value="page" pageInsets="contained">
            <ApiTokenGrantEditor
                testID="settings-api-tokens-edit-editor"
                value={edit.grant}
                onChange={props.controller.setAccessEditGrant}
                picker={grantPicker.picker}
                onPickerChange={grantPicker.setPicker}
                disabled={edit.pending}
                label={token.label}
                expiresAt={token.expiresAt}
            />
            {edit.error ? (
                <Text accessibilityLiveRegion="assertive" style={[styles.error, styles.note]} testID="settings-api-tokens-edit-error">
                    {t(resolveApiTokenOperationErrorMessageKey(edit.error))}
                </Text>
            ) : null}
            </ListPresentationProvider>
        </ScrollView>
    );
}
