import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { PrivateSecretContinuationV1Schema, type PrivateSecretChoiceV1 } from '@happier-dev/protocol/approvals/privateSecretContinuationV1';

import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { ApprovalDecisionBar } from './ApprovalDecisionBar';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SecretsList } from '@/components/secrets/SecretsList';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { continueConfidentialSecretFill, type ConfidentialSecretContinuationResult } from '@/sync/ops/actions/confidentialSecretContinuation';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { t } from '@/text';
import type { ConfidentialSecretApproval as ReviewedApproval } from './confidentialSecretApproval';

type Account = Awaited<ReturnType<typeof captureLazyActionAccountContext>>;
type SavedChoice = Extract<PrivateSecretChoiceV1, { kind: 'saved' }>;

function SavedCatalogRows(props: Readonly<{ account: Account; personal: readonly SavedSecret[];
    selected: SavedChoice | null; disabled: boolean; onSelect: (choice: SavedChoice) => void }>) {
    const catalog = useSavedSecretCatalog({ scope: props.account.accountLifetime.scope, personalSecrets: props.personal });
    return <SecretsList secrets={catalog.personalSecrets} sharedEntries={catalog.sharedEntries}
        resolveSharedReference={catalog.resolveReference} sharedCatalogStale={catalog.stale}
        onRetrySharedCatalog={() => { void catalog.reload().catch(() => undefined); }}
        selectedId={props.selected?.ref} allowAdd={false} allowEdit={false} wrapInItemList={false} footer={null}
        onSelectId={props.disabled ? undefined : ref => {
            const resolved = catalog.resolveReference(ref);
            if (resolved.status !== 'ready' || !resolved.fingerprint) return;
            // Catalog material stays in its owner. Only the reviewed metadata
            // crosses into the live private continuation; the executor rechecks it.
            props.onSelect({ kind: 'saved', ref, fingerprint: resolved.fingerprint,
                revision: resolved.kind === 'personal' ? null : resolved.revision });
        }} />;
}

/** Demand-mounted: the once-default prompt does not open the Saved Secret catalog. */
function SavedChoicePicker(props: Readonly<{ account: Account; selected: SavedChoice | null;
    disabled: boolean; onSelect: (choice: SavedChoice) => void }>) {
    const [personal, setPersonal] = React.useState<readonly SavedSecret[] | null>(null);
    const [failed, setFailed] = React.useState(false);
    React.useEffect(() => {
        let current = true;
        void props.account.readSettings().then(settings => {
            if (current && props.account.accountLifetime.isCurrent()) setPersonal(settings.secrets);
        }, () => { if (current) setFailed(true); });
        return () => { current = false; };
    }, [props.account]);
    return personal ? <SavedCatalogRows {...props} personal={personal} />
        : <Item title={t(failed ? 'approvals.confidential.unavailable' : 'approvals.confidential.loading')} mode="info" showChevron={false} />;
}

/** Live human input in the incumbent approval detail, never an Artifact/Action operand. */
type ConfidentialFillOutcome = Readonly<{ title: string; detail: string | null; warning: boolean }>;

/**
 * What became of the entry, said once (lab `b-secret` S): the outcome, why nothing was entered when
 * it was refused, and what to do next. Unknown completion is never retried.
 */
function resolveConfidentialFillOutcome(fill: ConfidentialSecretContinuationResult['fill']): ConfidentialFillOutcome {
    if (fill.status === 'filled') return { title: t('approvals.confidential.filled'), detail: null, warning: false };
    if (fill.status === 'canceled') return { title: t('approvals.confidential.canceled'), detail: null, warning: false };
    if (fill.status === 'unknown') return { title: t('approvals.confidential.unknown'), detail: t('approvals.confidential.unknownBody'), warning: true };
    switch (fill.code) {
        case 'field_verification_unsupported':
            return { title: t('approvals.confidential.fieldUnsupported'), detail: t('approvals.confidential.fieldUnsupportedBody'), warning: true };
        case 'target_changed':
        case 'approval_changed':
            return { title: t('approvals.confidential.targetChanged'), detail: t('approvals.confidential.nothingEntered'), warning: true };
        case 'saved_secret_missing':
        case 'saved_secret_unavailable':
        case 'saved_secret_forbidden':
        case 'saved_secret_repair_required':
        case 'saved_secret_deleted':
        case 'saved_secret_mode_incompatible':
        case 'saved_secret_corrupt':
        case 'saved_secret_changed':
            return { title: t('approvals.confidential.savedUnavailable'), detail: t('approvals.confidential.savedUnavailableBody'), warning: true };
        default:
            return { title: t('approvals.confidential.refused'), detail: null, warning: true };
    }
}

export function ConfidentialSecretApproval(props: Readonly<{ artifactId: string; approval: ReviewedApproval;
    serverId: string | null; isOpen: boolean; unavailable: boolean; isDeciding: boolean;
    onDecision: (decision: 'cancel' | 'reject') => Promise<void> }>) {
    // The parent keys this leaf by immutable reviewed semantics, not lifecycle
    // status/bodyVersion. Normal executing/executed receipts cannot cancel Remember.
    const [reviewed] = React.useState(() => props.approval);
    const [prepared, setPrepared] = React.useState<Readonly<{ account: Account; mode: 'plain' | 'e2ee' }> | null>(null);
    const [unavailable, setUnavailable] = React.useState(false);
    const [source, setSource] = React.useState<'once' | 'saved'>('once');
    const [value, setValue] = React.useState('');
    const [saved, setSaved] = React.useState<SavedChoice | null>(null);
    const [remember, setRemember] = React.useState(false);
    const [name, setName] = React.useState('');
    const [submit, setSubmit] = React.useState(false);
    const { theme } = useUnistyles();
    const [busy, setBusy] = React.useState(false);
    const [result, setResult] = React.useState<ConfidentialSecretContinuationResult | null>(null);
    const mounted = React.useRef(false);
    const started = React.useRef(false);
    const controller = React.useRef<AbortController | null>(null);
    const clearDraft = React.useCallback(() => { setValue(''); setSaved(null); setRemember(false); setName(''); setSubmit(false); }, []);

    React.useEffect(() => {
        mounted.current = true;
        const cancellation = new AbortController();
        controller.current = cancellation;
        let account: Account | null = null;
        let retirement: Readonly<{ dispose(): void }> | undefined;
        void (async () => {
            if (!props.serverId) throw new Error('home_unavailable');
            account = await captureLazyActionAccountContext(props.serverId, cancellation.signal);
            if (reviewed.expectedServerIdentityId && account.serverIdentityId !== reviewed.expectedServerIdentityId) throw new Error('home_changed');
            const encryption = await account.resolveAccountEncryption();
            account.assertCurrent();
            if (!mounted.current || cancellation.signal.aborted) return;
            retirement = account.accountLifetime.onRetire(() => {
                cancellation.abort();
                if (mounted.current) { clearDraft(); setPrepared(null); setUnavailable(true); }
            });
            setPrepared({ account, mode: encryption.accountMode });
        })().catch(() => { if (mounted.current && !cancellation.signal.aborted) setUnavailable(true); });
        return () => {
            mounted.current = false;
            cancellation.abort();
            retirement?.dispose();
            account?.dispose();
        };
    }, [clearDraft, props.serverId, reviewed]);
    React.useEffect(() => { if (!props.isOpen && !started.current) clearDraft(); }, [clearDraft, props.isOpen]);

    const disabled = busy || result !== null || props.isDeciding || !props.isOpen || props.unavailable || unavailable;
    const continueFill = async () => {
        if (disabled || started.current || !prepared || !prepared.account.accountLifetime.isCurrent()) return;
        const choice: PrivateSecretChoiceV1 | null = source === 'once' ? value.length > 0 ? { kind: 'once', value } : null : saved;
        if (!choice || (source === 'once' && remember && !name.trim())) return;
        started.current = true;
        setBusy(true);
        const continuation = PrivateSecretContinuationV1Schema.parse({ v: 1, artifactId: props.artifactId,
            actionId: reviewed.actionId, requestId: reviewed.requestId, request: reviewed.request,
            accountEncryptionMode: prepared.mode, choice, submit: Boolean(reviewed.request.submit && submit) });
        const rememberChoice = source === 'once' && remember ? { name: name.trim() } : undefined;
        clearDraft();
        try {
            const input = { continuation, scope: prepared.account.accountLifetime.scope,
                expectedServerIdentityId: reviewed.expectedServerIdentityId,
                signal: controller.current?.signal,
                isCurrent: () => mounted.current && prepared.account.accountLifetime.isCurrent(), remember: rememberChoice };
            const settlement = await continueConfidentialSecretFill(input);
            if (mounted.current) setResult(settlement);
        } finally {
            if (continuation.choice.kind === 'once') continuation.choice.value = '';
            if (mounted.current) { clearDraft(); setBusy(false); }
        }
    };
    const approveTitle = submit && reviewed.request.submit
        ? t('approvals.confidential.approveAndSubmit', { submitControl: reviewed.request.submit.label })
        : t('approvals.confidential.approve');
    const outcome = result ? resolveConfidentialFillOutcome(result.fill) : null;
    const rememberMessage = result?.remember === 'saved' ? t('approvals.confidential.rememberSaved')
        : result?.remember === 'failed' ? t('approvals.confidential.rememberFailed')
            : result?.remember === 'unknown' ? t('approvals.confidential.rememberUnknown')
                : result?.remember === 'canceled' ? t('approvals.confidential.rememberCanceled') : null;
    return <>
        <ItemGroup title={t('approvals.confidential.title')} description={t('approvals.confidential.description')}>
            {reviewed.actionId === 'browser.automation.secret.fill' ? <Item title={t('approvals.confidential.target')}
                subtitle={joinHappierFacts(reviewed.request.origin, reviewed.request.field.fieldId, reviewed.request.purpose)}
                subtitleLines={0} mode="info" showChevron={false} /> : null}
            <SegmentedChoiceItem title={t('approvals.confidential.source')} value={source} disabled={disabled}
                options={[{ id: 'once', label: t('approvals.confidential.once') }, { id: 'saved', label: t('approvals.confidential.saved') }]}
                testIDPrefix="approvals.secret-source" onChange={next => { clearDraft(); setSource(next); }} />
            {source === 'once' ? <>
                <Item title={t('secrets.fields.value')} mode="info" showChevron={false} accessoryLayout="stacked"
                    rightElement={<FieldTextInput testID="approvals.secret-value" value={value} onChangeText={setValue}
                        accessibilityLabel={t('secrets.fields.value')} secureTextEntry autoCapitalize="none"
                        textContentType={Platform.OS === 'ios' ? 'password' : undefined} editable={!disabled && prepared !== null} />} />
                <Item title={t('approvals.confidential.remember')} showChevron={false}
                    rightElement={<Switch testID="approvals.secret-remember" value={remember} onValueChange={setRemember}
                        disabled={disabled} accessibilityLabel={t('approvals.confidential.remember')} />} />
                {remember ? <Item title={t('secrets.fields.name')} mode="info" showChevron={false} accessoryLayout="stacked"
                    rightElement={<FieldTextInput testID="approvals.secret-name" value={name} onChangeText={setName}
                        accessibilityLabel={t('secrets.fields.name')} editable={!disabled} autoCapitalize="none" />} /> : null}
            </> : prepared ? <SavedChoicePicker account={prepared.account} selected={saved} disabled={disabled} onSelect={setSaved} /> : null}
            {reviewed.request.submit ? <Item title={reviewed.request.submit.label} subtitle={reviewed.request.submit.consequence}
                subtitleLines={0} showChevron={false} rightElement={<Switch testID="approvals.secret-submit" value={submit}
                    onValueChange={setSubmit} disabled={disabled} accessibilityLabel={reviewed.request.submit.label}
                    accessibilityHint={reviewed.request.submit.consequence} />} /> : null}
            <Item title={t('approvals.confidential.privacy')} mode="info" showChevron={false} titleLines={0} />
            {unavailable || props.unavailable ? <Item title={t('approvals.confidential.unavailable')} mode="info" showChevron={false} /> : null}
            {outcome ? <Item title={outcome.title} subtitle={outcome.detail ?? undefined} titleLines={0} subtitleLines={0}
                icon={outcome.warning ? <Icon name="warning" size={ICON_SIZE.md} color={theme.colors.state.warning.foreground} /> : undefined}
                mode="info" showChevron={false} testID="approvals.secret-outcome" /> : null}
            {result?.fill.status === 'filled' && result.fill.submit ? <Item mode="info" showChevron={false}
                title={t(result.fill.submit.status === 'submitted' ? 'approvals.confidential.submitted'
                    : result.fill.submit.status === 'unknown' ? 'approvals.confidential.submitUnknown' : 'approvals.confidential.submitRefused')} /> : null}
            {rememberMessage ? <Item title={rememberMessage} mode="info" showChevron={false} /> : null}
        </ItemGroup>
        <ItemGroup surface="none"><SectionContentRow>
            <ApprovalDecisionBar layout="stacked" busy={busy || props.isDeciding}
                approve={{ testID: 'approvals.secret-continue', label: approveTitle, busy,
                    disabled: disabled || !prepared
                        || (source === 'once' ? !value.length || (remember && !name.trim()) : saved === null),
                    onPress: continueFill }}
                dismiss={props.isOpen ? { testID: 'approvals.cancel', label: t('common.cancel'), disabled: result !== null,
                    onPress: async () => { clearDraft(); await props.onDecision('cancel'); } } : undefined}
                reject={props.isOpen ? { testID: 'approvals.reject', disabled: props.unavailable || result !== null,
                    onPress: async () => { clearDraft(); await props.onDecision('reject'); } } : undefined} />
        </SectionContentRow></ItemGroup>
    </>;
}
