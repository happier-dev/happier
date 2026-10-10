import * as React from 'react';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
    HomeMailDeliveryTestInputV1Schema,
    type HomeMailDeliveryReadinessV1,
    type HomeMailDeliveryTestResultV1,
    type HomeSettingEntryV1,
} from '@happier-dev/protocol/home/governance';

import type { SettingRef } from '@/components/settings/catalog/settingDeclarations';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useHomeEmailSettings } from '@/hooks/home/useHomeEmailSettings';
import { Modal } from '@/modal';
import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import {
    readHomeSettingsInvalidFailure,
    sendHomeTestEmail,
    setHomeSettings,
} from '@/sync/ops/home/homeGovernanceOperations';
import { t } from '@/text';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';

import { HomeAdministrationSection } from './HomeAdministrationSection';
import type { HomeAdministrationContext } from './homeAdministrationContext';
import { homeAdministrationReachPath } from './homeAdministrationRoutes';
import { HOME_EMAIL_SETTINGS } from './homeEmailSettings';
import {
    EMPTY_HOME_EMAIL_DRAFT,
    buildHomeEmailWrite,
    homeEmailFieldError,
    homeEmailFieldForKey,
    homeSettingText,
    selectHomeEmailEntries,
    type HomeEmailDraft,
    type HomeEmailEntries,
    type HomeEmailField,
    type HomeEmailFieldError,
    type HomeEmailTextField,
} from './homeEmailSettingsForm';
import { homeGovernanceFailureNotice } from './homeGovernanceLabels';
import { isHomeSettingWritable } from './homeSettingDeclaration';
import { HomeDeploymentFixedNote } from './HomeDeploymentFixedNote';
import { HomeSecretSettingRow, type HomeSecretDraft } from './HomeSecretSettingRow';

type TestState =
    | Readonly<{ kind: 'idle' }>
    | Readonly<{ kind: 'sending' }>
    | Readonly<{ kind: 'answered'; to: string; result: HomeMailDeliveryTestResultV1 }>
    | Readonly<{ kind: 'refused'; failure: HomeDomainFailure }>;

const IDLE: TestState = Object.freeze({ kind: 'idle' as const });

function securityLabel(secure: boolean): string {
    return secure ? t('homeGovernance.email.tls') : t('homeGovernance.email.starttls');
}

/** The port the mail owner uses when none is stored: 465 with implicit TLS, otherwise 587. */
function defaultPort(secure: boolean): string {
    return secure ? '465' : '587';
}

/** Links name where they open by host, not by the raw origin URL. */
function originHost(origin: string | null): string | null {
    if (!origin) return null;
    try {
        return new URL(origin).host || origin;
    } catch {
        return origin;
    }
}

function testFailureLabel(reason: Extract<HomeMailDeliveryTestResultV1, { status: 'failed' }>['reason']): string {
    switch (reason) {
        case 'not_configured':
            return t('homeGovernance.email.testNotConfigured');
        case 'password_unreadable':
            return t('homeGovernance.email.testPasswordUnreadable');
        case 'render_failed':
            return t('homeGovernance.email.testRenderFailed');
        case 'transport_failed':
            return t('homeGovernance.email.testTransportFailed');
    }
}

/**
 * One text setting. A key the deployment fixed shows its value and the env name that locks it; an
 * admin sees the value only; an owner edits it. A Home that does not project the key omits the row.
 */
const EmailTextRow = React.memo(function EmailTextRow(props: Readonly<{
    field: HomeEmailTextField;
    setting: SettingRef;
    title: string;
    entry: HomeSettingEntryV1 | undefined;
    text: string | undefined;
    readOnly: boolean;
    disabled: boolean;
    error: HomeEmailFieldError | undefined;
    keyboardType?: 'email-address' | 'number-pad';
    onChange: (field: HomeEmailTextField, text: string) => void;
}>) {
    const { entry, field, onChange } = props;
    const handleChange = React.useCallback((text: string) => onChange(field, text), [field, onChange]);
    if (!entry) return null;
    const value = homeSettingText(entry);
    if (entry.fixed || props.readOnly || !isHomeSettingWritable(entry)) {
        return (
            <SettingAnchor setting={props.setting}>
                <Item
                    testID={`home-email-${field}`}
                    title={props.title}
                    subtitleAccessory={entry.fixed ? <HomeDeploymentFixedNote keys={[entry.key]} testID={`home-email-${field}`} /> : undefined}
                    detail={value || t('homeGovernance.email.valueNotSet')}
                    showChevron={false}
                />
            </SettingAnchor>
        );
    }
    return (
        <SettingAnchor setting={props.setting}>
            <Item
                title={props.title}
                accessoryLayout="adaptive"
                showChevron={false}
                rightElement={(
                    <FieldTextInput
                        testID={`home-email-${field}-input`}
                        accessibilityLabel={props.title}
                        value={props.text ?? value}
                        editable={!props.disabled}
                        autoCapitalize="none"
                        keyboardType={props.keyboardType}
                        error={props.error ? t(props.error) : null}
                        onChangeText={handleChange}
                    />
                )}
            />
        </SettingAnchor>
    );
});

/** Port and connection security: one row, because the pair decides how the connection opens. */
const EmailPortRow = React.memo(function EmailPortRow(props: Readonly<{
    port: HomeSettingEntryV1 | undefined;
    secure: HomeSettingEntryV1 | undefined;
    portText: string | undefined;
    secureDraft: boolean | undefined;
    readOnly: boolean;
    disabled: boolean;
    error: HomeEmailFieldError | undefined;
    onChangePort: (field: HomeEmailTextField, text: string) => void;
    onChangeSecure: (secure: boolean) => void;
}>) {
    const { port, secure, onChangePort, onChangeSecure } = props;
    const handlePort = React.useCallback((text: string) => onChangePort('port', text), [onChangePort]);
    const handleSecure = React.useCallback((id: 'tls' | 'starttls') => onChangeSecure(id === 'tls'), [onChangeSecure]);
    if (!port) return null;
    const secureValue = props.secureDraft ?? (secure?.value === true);
    const portValue = homeSettingText(port);
    const portEditable = !props.readOnly && isHomeSettingWritable(port);
    const secureEditable = !props.readOnly && isHomeSettingWritable(secure);
    const fixedKeys = [port, secure].filter((entry): entry is HomeSettingEntryV1 => entry?.fixed === true).map((entry) => entry.key);
    const fixedNote = fixedKeys.length > 0 ? <HomeDeploymentFixedNote keys={fixedKeys} testID="home-email-port" /> : undefined;

    if (!portEditable && !secureEditable) {
        return (
            <SettingAnchor setting={HOME_EMAIL_SETTINGS.settings.port}>
                <Item
                    testID="home-email-port"
                    title={t('homeGovernance.email.portAndSecurity')}
                    subtitleAccessory={fixedNote}
                    detail={`${portValue || defaultPort(secureValue)} · ${securityLabel(secureValue)}`}
                    showChevron={false}
                />
            </SettingAnchor>
        );
    }
    return (
        <SettingAnchor setting={HOME_EMAIL_SETTINGS.settings.port}>
            <Item
                title={t('homeGovernance.email.port')}
                subtitleAccessory={fixedNote}
                accessoryLayout="adaptive"
                showChevron={false}
                rightElement={(
                    <View style={styles.inlineControls}>
                        {portEditable ? (
                            <FieldTextInput
                                testID="home-email-port-input"
                                accessibilityLabel={t('homeGovernance.email.port')}
                                value={props.portText ?? portValue}
                                placeholder={defaultPort(secureValue)}
                                editable={!props.disabled}
                                keyboardType="number-pad"
                                error={props.error ? t(props.error) : null}
                                onChangeText={handlePort}
                                style={styles.portField}
                            />
                        ) : null}
                        <SegmentedTabBar<'tls' | 'starttls'>
                            role="radiogroup"
                            tabs={[
                                { id: 'tls', label: t('homeGovernance.email.tls') },
                                { id: 'starttls', label: t('homeGovernance.email.starttls') },
                            ]}
                            activeTabId={secureValue ? 'tls' : 'starttls'}
                            onSelectTab={handleSecure}
                            slidingThumb
                            segmentSizing="content"
                            disabled={!secureEditable || props.disabled}
                            accessibilityLabel={t('homeGovernance.email.security')}
                            testIDPrefix="home-email-security"
                        />
                    </View>
                )}
            />
        </SettingAnchor>
    );
});

/** The password is write-only: the shared secret row, staged until Save. */
const EmailPasswordRow = React.memo(function EmailPasswordRow(props: Readonly<{
    entry: HomeSettingEntryV1 | undefined;
    draft: HomeSecretDraft;
    readOnly: boolean;
    disabled: boolean;
    onChange: (draft: HomeSecretDraft) => void;
}>) {
    const { entry } = props;
    if (!entry) return null;
    return (
        <SettingAnchor setting={HOME_EMAIL_SETTINGS.settings.password}>
            <HomeSecretSettingRow
                testID="home-email-password"
                entry={entry}
                title={t('homeGovernance.email.password')}
                subtitle={entry.fixed ? undefined : t('homeGovernance.email.passwordDescription')}
                draft={props.draft}
                readOnly={props.readOnly}
                disabled={props.disabled}
                onChange={props.onChange}
            />
        </SettingAnchor>
    );
});

/** Readiness is the mail owner's answer: sending needs a transport, and every mail needs a link. */
const EmailStatusSection = React.memo(function EmailStatusSection(props: Readonly<{
    readiness: HomeMailDeliveryReadinessV1;
    host: string;
    /** Where a missing link target is fixed: the Home's addresses (Reach). */
    onOpenReach: () => void;
}>) {
    const { readiness } = props;
    const linkHost = originHost(readiness.linkOrigin);
    return (
        <ItemGroup title={t('homeGovernance.email.status')}>
            <Item
                testID="home-email-status-sending"
                title={t('homeGovernance.email.sendingMail')}
                subtitle={readiness.transportConfigured
                    ? (props.host ? t('homeGovernance.email.sendingReady', { host: props.host }) : t('homeGovernance.email.valueSet'))
                    : t('homeGovernance.email.sendingNotSetUp')}
                mode="info"
                showChevron={false}
            />
            <Item
                testID="home-email-status-links"
                title={t('homeGovernance.email.links')}
                subtitle={!readiness.linkTargetBuildable
                    ? t('homeGovernance.email.linksMissing')
                    : linkHost
                        ? t('homeGovernance.email.linksOpenAt', { host: linkHost })
                        : t('homeGovernance.email.linksReady')}
                {...(readiness.linkTargetBuildable
                    ? { mode: 'info' as const, showChevron: false }
                    : { detail: t('homeGovernance.email.setInReach'), onPress: props.onOpenReach })}
            />
        </ItemGroup>
    );
});

/** A test send proves the saved settings, so it waits until the form has nothing unsaved. */
const EmailTestSection = React.memo(function EmailTestSection(props: Readonly<{
    context: HomeAdministrationContext;
    unsaved: boolean;
}>) {
    const { context } = props;
    const [to, setTo] = React.useState('');
    const [state, setState] = React.useState<TestState>(IDLE);
    const [invalid, setInvalid] = React.useState(false);
    const sending = state.kind === 'sending';
    const disabled = props.unsaved || !context.mutationsAvailable || sending;

    const send = React.useCallback(async () => {
        const parsed = HomeMailDeliveryTestInputV1Schema.safeParse({ to });
        if (!parsed.success) {
            setInvalid(true);
            return;
        }
        setInvalid(false);
        setState({ kind: 'sending' });
        const outcome = await sendHomeTestEmail({ scope: context.scope, to: parsed.data.to });
        if (outcome.kind === 'approval_pending') {
            context.requestApproval?.(outcome.artifactId);
            setState(IDLE);
            return;
        }
        setState(outcome.kind === 'succeeded'
            ? { kind: 'answered', to: parsed.data.to, result: outcome.value }
            : { kind: 'refused', failure: outcome.failure });
    }, [context, to]);

    return (
        <ItemGroup title={t('homeGovernance.email.test')} description={t('homeGovernance.email.testDescription')}>
            <SettingAnchor setting={HOME_EMAIL_SETTINGS.settings.sendTest}>
                <Item
                    title={t('homeGovernance.email.testTo')}
                    subtitle={props.unsaved ? t('homeGovernance.email.testSaveFirst') : undefined}
                    accessoryLayout="adaptive"
                    showChevron={false}
                    rightElement={(
                        <View style={styles.inlineControls}>
                            <FieldTextInput
                                testID="home-email-test-to"
                                accessibilityLabel={t('homeGovernance.email.testTo')}
                                placeholder={t('homeGovernance.email.testToPlaceholder')}
                                value={to}
                                editable={!sending}
                                autoCapitalize="none"
                                keyboardType="email-address"
                                autoComplete="email"
                                error={invalid ? t('homeGovernance.email.invalidEmail') : null}
                                onChangeText={setTo}
                                onSubmitEditing={disabled ? undefined : () => { void send(); }}
                                style={styles.grow}
                            />
                            <RoundButton
                                testID="home-email-test-send"
                                size="small"
                                display="secondary"
                                title={t('homeGovernance.email.testSend')}
                                loading={sending}
                                disabled={disabled || to.trim().length === 0}
                                onPress={() => { void send(); }}
                            />
                        </View>
                    )}
                />
            </SettingAnchor>
            {state.kind === 'answered' && state.result.status === 'sent' ? (
                <Item
                    testID="home-email-test-sent"
                    title={t('homeGovernance.email.testSent', { to: state.to })}
                    subtitle={t('homeGovernance.email.testSentDetail')}
                    accessibilityLiveRegion="polite"
                    mode="info"
                    showChevron={false}
                />
            ) : null}
            {state.kind === 'answered' && state.result.status === 'failed' ? (
                <Item
                    testID={`home-email-test-failed:${state.result.reason}`}
                    title={t('homeGovernance.email.testFailed')}
                    subtitle={testFailureLabel(state.result.reason)}
                    accessibilityLiveRegion="polite"
                    mode="info"
                    showChevron={false}
                />
            ) : null}
            {state.kind === 'refused' ? (
                <Item
                    testID="home-email-test-refused"
                    title={t('homeGovernance.email.testFailed')}
                    subtitle={homeGovernanceFailureNotice(state.failure).body}
                    accessibilityLiveRegion="polite"
                    mode="info"
                    showChevron={false}
                />
            ) : null}
        </ItemGroup>
    );
});

const EmailPage = React.memo(function EmailPage(props: Readonly<{ context: HomeAdministrationContext }>) {
    const { context } = props;
    const { capabilities } = context.projection;
    const canView = capabilities.viewAdministration;
    const isOwner = capabilities.manageHomeSettings;
    const mail = useHomeEmailSettings(context.scope, canView);
    const router = useRouter();
    const serverId = context.scope.serverId;
    const openReach = React.useCallback(() => router.push(homeAdministrationReachPath(serverId)), [router, serverId]);
    const [draft, setDraft] = React.useState<HomeEmailDraft>(EMPTY_HOME_EMAIL_DRAFT);
    const [errors, setErrors] = React.useState<Readonly<Partial<Record<HomeEmailField, HomeEmailFieldError>>>>({});
    const [saving, setSaving] = React.useState(false);

    // A write held for approval runs later, outside this page's request; re-read the Home once the
    // shell releases the approval so the page shows what actually landed.
    const wasPendingRef = React.useRef(context.approvalPending);
    const { reload } = mail;
    React.useEffect(() => {
        if (wasPendingRef.current && !context.approvalPending) reload();
        wasPendingRef.current = context.approvalPending;
    }, [context.approvalPending, reload]);

    const entries = React.useMemo<HomeEmailEntries>(
        () => (mail.settings ? selectHomeEmailEntries(mail.settings) : {}),
        [mail.settings],
    );
    const write = React.useMemo(() => buildHomeEmailWrite(entries, draft), [entries, draft]);
    const unsaved = write.ok ? write.changed : true;
    const disabled = !context.mutationsAvailable || saving;

    const changeText = React.useCallback((field: HomeEmailTextField, text: string) => {
        setDraft((current) => ({ ...current, text: { ...current.text, [field]: text } }));
        setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
    }, []);
    const changeSecure = React.useCallback((secure: boolean) => {
        setDraft((current) => ({ ...current, secure }));
    }, []);
    const changePassword = React.useCallback((password: HomeSecretDraft) => {
        setDraft((current) => ({ ...current, password }));
    }, []);
    const cancel = React.useCallback(() => {
        setDraft(EMPTY_HOME_EMAIL_DRAFT);
        setErrors({});
    }, []);
    // Leaving with unsaved edits goes through the one unsaved-changes guard: Back, the shell's
    // navigation and a browser unload all ask before the draft is dropped.
    const navigation = useNavigation();
    useUnsavedDraftNavigationGuard({
        navigation,
        isDirty: isOwner && unsaved,
        onDiscard: cancel,
        tag: 'HomeAdministrationEmailScreen.beforeRemove',
    });

    const save = React.useCallback(async () => {
        if (!mail.settings) return;
        if (!write.ok) {
            setErrors(write.errors);
            return;
        }
        if (!write.changed) return;
        setSaving(true);
        try {
            const outcome = await setHomeSettings({
                scope: context.scope,
                expectedRevision: mail.settings.revision,
                values: write.values,
                secrets: write.secrets,
            });
            if (outcome.kind === 'succeeded') {
                mail.adoptSettings(outcome.value);
                setDraft(EMPTY_HOME_EMAIL_DRAFT);
                setErrors({});
                return;
            }
            if (outcome.kind === 'approval_pending') {
                context.requestApproval?.(outcome.artifactId);
                return;
            }
            if (outcome.failure.code === 'home_settings_revision_conflict') {
                // The edits stay; the untouched fields re-base on what the Home now holds.
                await Modal.alertAsync(t('homeGovernance.email.conflictTitle'), t('homeGovernance.email.conflictBody'));
                mail.reload();
                return;
            }
            const invalid = readHomeSettingsInvalidFailure(outcome.failure);
            const field = invalid ? homeEmailFieldForKey(invalid.key) : null;
            if (field) {
                setErrors({ [field]: homeEmailFieldError(field) });
                return;
            }
            const notice = homeGovernanceFailureNotice(outcome.failure);
            await Modal.alertAsync(notice.title, notice.body);
        } finally {
            setSaving(false);
        }
    }, [context, mail, write]);

    if (!canView) {
        return (
            <ItemGroup description={t('homeGovernance.forbiddenBody')}>
                <Item testID="home-email-forbidden" title={t('homeGovernance.forbiddenTitle')} mode="info" showChevron={false} />
            </ItemGroup>
        );
    }

    if (!mail.settings) {
        if (mail.failure) {
            return (
                <ItemGroup description={t('homeGovernance.email.loadFailed')}>
                    <Item
                        testID="home-email-retry"
                        title={t('homeGovernance.retry')}
                        onPress={mail.reload}
                        showChevron={false}
                    />
                </ItemGroup>
            );
        }
        return (
            <ItemGroup>
                <Item testID="home-email-loading" title={t('homeGovernance.loading')} loading mode="info" showChevron={false} />
            </ItemGroup>
        );
    }

    const readOnly = !isOwner;
    const anyEditable = !readOnly && Object.values(entries).some((entry) => isHomeSettingWritable(entry));
    const readiness = mail.readiness;
    const textRow = (field: HomeEmailTextField, setting: SettingRef, title: string, keyboardType?: 'email-address') => (
        <EmailTextRow
            field={field}
            setting={setting}
            title={title}
            entry={entries[field]}
            text={draft.text[field]}
            readOnly={readOnly}
            disabled={disabled}
            error={errors[field]}
            keyboardType={keyboardType}
            onChange={changeText}
        />
    );

    return (
        <>
            {mail.failure ? (
                <SurfaceFreshnessLine
                    testID="home-email-refresh-error"
                    tone="warning"
                    busy={mail.loading}
                    reason={homeGovernanceFailureNotice(mail.failure, { effect: 'read' }).body}
                    action={{ label: t('homeGovernance.retry'), onPress: mail.reload }}
                />
            ) : null}
            {mail.readinessFailure && mail.readiness ? (
                <SurfaceFreshnessLine
                    testID="home-email-readiness-error"
                    tone="warning"
                    busy={mail.readinessLoading}
                    reason={homeGovernanceFailureNotice(mail.readinessFailure, { effect: 'read' }).body}
                    action={{ label: t('homeGovernance.retry'), onPress: mail.reload }}
                />
            ) : mail.readinessFailure ? (
                <SurfaceStateCard
                    testID="home-email-readiness-error"
                    kind="error"
                    size="line"
                    title={t('homeGovernance.email.loadFailed')}
                    reason={homeGovernanceFailureNotice(mail.readinessFailure, { effect: 'read' }).body}
                    action={{ testID: 'home-email-readiness-retry', label: t('homeGovernance.retry'), onPress: mail.reload }}
                />
            ) : !mail.readiness && mail.readinessLoading ? (
                <SurfaceStateCard testID="home-email-readiness-loading" kind="loading" size="line" title={t('homeGovernance.loading')} />
            ) : null}
            {readOnly ? (
                <AttentionBanner
                    testID="home-email-admin-read-only"
                    tone="neutral"
                    title={t('homeGovernance.email.adminTitle')}
                    description={t('homeGovernance.email.adminBody')}
                />
            ) : null}
            {!readOnly && readiness && !readiness.transportConfigured ? (
                <AttentionBanner
                    testID="home-email-not-set-up"
                    title={t('homeGovernance.email.notSetUpTitle')}
                    description={t('homeGovernance.email.notSetUpBody')}
                />
            ) : null}
            {readiness?.passwordUnreadable ? (
                <AttentionBanner
                    testID="home-email-password-unreadable"
                    title={t('homeGovernance.email.unreadableTitle')}
                    description={t('homeGovernance.email.unreadableBody')}
                />
            ) : null}

            {readiness ? (
                <EmailStatusSection
                    readiness={readiness}
                    host={homeSettingText(entries.host)}
                    onOpenReach={openReach}
                />
            ) : null}

            <ItemGroup title={t('homeGovernance.email.mailServer')} description={t('homeGovernance.email.mailServerDescription')}>
                {textRow('host', HOME_EMAIL_SETTINGS.settings.host, t('homeGovernance.email.server'))}
                <EmailPortRow
                    port={entries.port}
                    secure={entries.secure}
                    portText={draft.text.port}
                    secureDraft={draft.secure}
                    readOnly={readOnly}
                    disabled={disabled}
                    error={errors.port}
                    onChangePort={changeText}
                    onChangeSecure={changeSecure}
                />
                {textRow('username', HOME_EMAIL_SETTINGS.settings.username, t('homeGovernance.email.username'))}
                <EmailPasswordRow
                    entry={entries.password}
                    draft={draft.password}
                    readOnly={readOnly}
                    disabled={disabled}
                    onChange={changePassword}
                />
            </ItemGroup>

            <ItemGroup title={t('homeGovernance.email.sender')}>
                {textRow('fromAddress', HOME_EMAIL_SETTINGS.settings.fromAddress, t('homeGovernance.email.fromAddress'), 'email-address')}
                {textRow('fromName', HOME_EMAIL_SETTINGS.settings.fromName, t('homeGovernance.email.fromName'))}
            </ItemGroup>

            {anyEditable ? (
                <ItemGroup surface="none">
                    <SectionContentRow>
                        <View style={styles.formActions}>
                            <RoundButton
                                testID="home-email-cancel"
                                size="small"
                                display="inverted"
                                title={t('common.cancel')}
                                disabled={!unsaved || saving}
                                onPress={cancel}
                            />
                            <RoundButton
                                testID="home-email-save"
                                size="small"
                                title={t('common.save')}
                                loading={saving}
                                disabled={!unsaved || disabled}
                                onPress={() => { void save(); }}
                            />
                        </View>
                    </SectionContentRow>
                </ItemGroup>
            ) : null}

            {isOwner && readiness?.transportConfigured ? (
                <EmailTestSection context={context} unsaved={unsaved} />
            ) : null}
        </>
    );
});

/**
 * How one Home sends mail (plan §3.3, lab `hcEmail-*`): readiness from the mail owner, the SMTP
 * server and sender as registry keys, a write-only password and a test send. Owners edit; admins
 * read; a key the deployment set is locked with its env name.
 */
export const HomeAdministrationEmailScreen = React.memo(function HomeAdministrationEmailScreen(
    props: Readonly<{ serverId: string }>,
) {
    return (
        <HomeAdministrationSection
            serverId={props.serverId}
            title={t('homeGovernance.email.title')}
            description={t('homeGovernance.pages.email')}
        >
            {(context) => <EmailPage context={context} />}
        </HomeAdministrationSection>
    );
});

const styles = StyleSheet.create(() => ({
    inlineControls: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexShrink: 1,
    },
    portField: {
        width: 88,
    },
    grow: {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 160,
    },
    formActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 8,
    },
}));
