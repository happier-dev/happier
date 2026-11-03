import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { PrivateActionInputContinuationV1Schema, PrivateSecretContinuationV1Schema, type PrivateSecretChoiceV1 } from '@happier-dev/protocol/approvals/privateSecretContinuationV1';

import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { ApprovalDecisionBar } from './ApprovalDecisionBar';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SecretsList } from '@/components/secrets/SecretsList';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { continueConfidentialActionInputs, continueConfidentialSecretFill, type ConfidentialActionInputsContinuationResult,
    type ConfidentialSecretContinuationResult } from '@/sync/ops/actions/confidentialSecretContinuation';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { t } from '@/text';
import { resolveConfidentialFillOutcome, resolveConfidentialInputsOutcome, resolveConfidentialSecretSaveName, resolveConfidentialSubmitOutcome,
    type ConfidentialActionInput, type ConfidentialActionInputsApproval, type ConfidentialSecretApproval as ReviewedFill } from './confidentialSecretApprovalModel';

type Account = Awaited<ReturnType<typeof captureLazyActionAccountContext>>;
type SavedChoice = Extract<PrivateSecretChoiceV1, { kind: 'saved' }>;
type SelectSaved = (choice: SavedChoice, name: string | null) => void;

function SavedCatalogRows(props: Readonly<{ account: Account; personal: readonly SavedSecret[];
    selected: SavedChoice | null; disabled: boolean; onSelect: SelectSaved }>) {
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
                revision: resolved.kind === 'personal' ? null : resolved.revision },
            resolved.entry?.name ?? resolved.secret?.name ?? null);
        }} />;
}

/** Demand-mounted: the catalog is read only once the person opens "Use a saved secret". */
function SavedChoicePicker(props: Readonly<{ account: Account; selected: SavedChoice | null;
    disabled: boolean; onSelect: SelectSaved }>) {
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

type ReviewedApproval = ReviewedFill | ConfidentialActionInputsApproval;
type Draft = Readonly<{ value: string; saved: Readonly<{ choice: SavedChoice; name: string | null }> | null;
    pickerOpen: boolean; remember: boolean; name: string }>;
type Settlement = Readonly<{ kind: 'fill'; result: ConfidentialSecretContinuationResult }>
    | Readonly<{ kind: 'inputs'; result: ConfidentialActionInputsContinuationResult }>;
type RememberStatus = ConfidentialSecretContinuationResult['remember'];

const EMPTY_DRAFT: Draft = { value: '', saved: null, pickerOpen: false, remember: false, name: '' };
/** The one credential a native fill asks for. */
const FILL_INPUT_PATH = 'value';

function isActionInputs(approval: ReviewedApproval): approval is ConfidentialActionInputsApproval {
    return 'kind' in approval && approval.kind === 'action_inputs';
}

function rememberMessage(status: RememberStatus | null, ran: boolean): string | null {
    switch (status) {
        case 'saved': return t('approvals.confidential.rememberSaved');
        case 'failed': return t(ran ? 'approvals.confidential.inputsRememberFailed' : 'approvals.confidential.rememberFailed');
        case 'unknown': return t(ran ? 'approvals.confidential.inputsRememberUnknown' : 'approvals.confidential.rememberUnknown');
        case 'canceled': return t('approvals.confidential.rememberCanceled');
        default: return null;
    }
}

/**
 * One credential the request needs: typed for this request only, or a Saved Secret in its place (each
 * replaces the other), with "Save for next time" offered only for a typed value.
 */
function CredentialEntry(props: Readonly<{ input: ConfidentialActionInput; draft: Draft; testIDSuffix: string;
    prepared: Readonly<{ account: Account }> | null; disabled: boolean; defaultName: string;
    onChange: (next: Draft) => void }>) {
    const { draft, onChange, testIDSuffix: x } = props;
    return <>
        <Item title={t('secrets.fields.value')} mode="info" showChevron={false} accessoryLayout="stacked"
            rightElement={<FieldTextInput testID={`approvals.secret-value${x}`} value={draft.value} accessibilityLabel={props.input.label}
                onChangeText={next => onChange({ ...draft, value: next, saved: next.length > 0 ? null : draft.saved })}
                secureTextEntry autoCapitalize="none"
                textContentType={Platform.OS === 'ios' ? 'password' : undefined} editable={!props.disabled && props.prepared !== null} />} />
        <ExpandableItem testID={`approvals.secret-saved${x}`} expanded={draft.pickerOpen} onExpandedChange={open => onChange({ ...draft, pickerOpen: open })}
            header={state => <Item testID={`approvals.secret-saved${x}.header`} {...state.headerProps}
                title={t('approvals.confidential.useSaved')} detail={draft.saved?.name ?? undefined} disabled={props.disabled} />}>
            {props.prepared ? <SavedChoicePicker account={props.prepared.account} selected={draft.saved?.choice ?? null} disabled={props.disabled}
                onSelect={(choice, savedName) => onChange({ ...EMPTY_DRAFT, saved: { choice, name: savedName } })} />
                : <Item title={t('approvals.confidential.loading')} mode="info" showChevron={false} />}
        </ExpandableItem>
        {draft.saved === null ? <Item title={t('approvals.confidential.remember')} showChevron={false}
            rightElement={<Switch testID={`approvals.secret-remember${x}`} value={draft.remember} disabled={props.disabled}
                accessibilityLabel={t('approvals.confidential.remember')}
                onValueChange={next => onChange({ ...draft, remember: next, name: next && !draft.name.trim() ? props.defaultName : draft.name })} />} /> : null}
        {draft.saved === null && draft.remember ? <Item title={t('secrets.fields.name')} mode="info" showChevron={false} accessoryLayout="stacked"
            rightElement={<FieldTextInput testID={`approvals.secret-name${x}`} value={draft.name} onChangeText={name => onChange({ ...draft, name })}
                accessibilityLabel={t('secrets.fields.name')} editable={!props.disabled} autoCapitalize="none" />} /> : null}
    </>;
}

function readChoice(draft: Draft): PrivateSecretChoiceV1 | null {
    return draft.saved?.choice ?? (draft.value.length > 0 ? { kind: 'once', value: draft.value } : null);
}

/**
 * Live human input in the incumbent approval detail, never an Artifact/Action operand. It answers a native
 * fill (one credential for one field) or a consuming Action waiting for its declared secret inputs (one entry
 * per input); both go privately to the request's own continuation.
 */
export function ConfidentialSecretApproval(props: Readonly<{ artifactId: string; approval: ReviewedApproval;
    serverId: string | null; isOpen: boolean; unavailable: boolean; isDeciding: boolean;
    /** The request's durable record already says the entry did not happen (the page's Request section shows it). */
    outcomeRecorded?: boolean;
    onDecision: (decision: 'cancel' | 'reject') => Promise<void> }>) {
    // The parent keys this leaf by immutable reviewed semantics, not lifecycle
    // status/bodyVersion. Normal executing/executed receipts cannot cancel Remember.
    const [reviewed] = React.useState(() => props.approval);
    const inputs: readonly ConfidentialActionInput[] = isActionInputs(reviewed) ? reviewed.inputs
        : [{ path: FILL_INPUT_PATH, label: t('secrets.fields.value') }];
    const [prepared, setPrepared] = React.useState<Readonly<{ account: Account; mode: 'plain' | 'e2ee' }> | null>(null);
    const [unavailable, setUnavailable] = React.useState(false);
    const [drafts, setDrafts] = React.useState<Readonly<Record<string, Draft>>>({});
    const [submit, setSubmit] = React.useState(false);
    const { theme } = useUnistyles();
    const [busy, setBusy] = React.useState(false);
    const [settlement, setSettlement] = React.useState<Settlement | null>(null);
    const mounted = React.useRef(false);
    const started = React.useRef(false);
    const controller = React.useRef<AbortController | null>(null);
    const clearDraft = React.useCallback(() => { setDrafts({}); setSubmit(false); }, []);
    const draftFor = (path: string) => drafts[path] ?? EMPTY_DRAFT;

    React.useEffect(() => {
        mounted.current = true;
        const cancellation = new AbortController();
        controller.current = cancellation;
        let account: Account | null = null;
        let retirement: Readonly<{ dispose(): void }> | undefined;
        void (async () => {
            if (!props.serverId) throw new Error('home_unavailable');
            if (isActionInputs(reviewed) && !reviewed.machineId) throw new Error('machine_unavailable');
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

    const disabled = busy || settlement !== null || props.isDeciding || !props.isOpen || props.unavailable || unavailable;
    // Every requested input has a choice, and every value to remember has a name.
    const ready = inputs.every(input => {
        const draft = draftFor(input.path);
        return readChoice(draft) !== null && (draft.saved !== null || !draft.remember || draft.name.trim().length > 0);
    });
    const continueFill = async () => {
        if (disabled || started.current || !prepared || !prepared.account.accountLifetime.isCurrent() || !ready) return;
        const choices = inputs.map(input => ({ path: input.path, choice: readChoice(draftFor(input.path))! }));
        const remember = inputs.flatMap(input => {
            const draft = draftFor(input.path);
            return draft.saved === null && draft.remember ? [{ path: input.path, name: draft.name.trim() }] : [];
        });
        started.current = true;
        setBusy(true);
        clearDraft();
        const context = { scope: prepared.account.accountLifetime.scope,
            expectedServerIdentityId: reviewed.expectedServerIdentityId, signal: controller.current?.signal,
            isCurrent: () => mounted.current && prepared.account.accountLifetime.isCurrent() };
        try {
            if (isActionInputs(reviewed)) {
                const continuation = PrivateActionInputContinuationV1Schema.parse({ v: 1, kind: 'action_inputs', artifactId: props.artifactId,
                    actionId: reviewed.actionId, requestId: reviewed.requestId, request: reviewed.request,
                    serverId: props.serverId, machineId: reviewed.machineId, accountEncryptionMode: prepared.mode, choices });
                try {
                    const result = await continueConfidentialActionInputs({ ...context, continuation, remember });
                    if (mounted.current) setSettlement({ kind: 'inputs', result });
                } finally {
                    for (const entry of continuation.choices) if (entry.choice.kind === 'once') entry.choice.value = '';
                }
            } else {
                const choice = choices[0]!.choice;
                const continuation = PrivateSecretContinuationV1Schema.parse({ v: 1, artifactId: props.artifactId,
                    actionId: reviewed.actionId, requestId: reviewed.requestId, request: reviewed.request,
                    accountEncryptionMode: prepared.mode, choice, submit: Boolean(reviewed.request.submit && submit) });
                try {
                    const result = await continueConfidentialSecretFill({ ...context, continuation,
                        remember: remember[0] ? { name: remember[0].name } : undefined });
                    if (mounted.current) setSettlement({ kind: 'fill', result });
                } finally {
                    if (continuation.choice.kind === 'once') continuation.choice.value = '';
                }
            }
        } finally {
            for (const entry of choices) if (entry.choice.kind === 'once') entry.choice.value = '';
            if (mounted.current) { clearDraft(); setBusy(false); }
        }
    };
    const fill = isActionInputs(reviewed) ? null : reviewed;
    const fillResult = settlement?.kind === 'fill' ? settlement.result : null;
    const inputsResult = settlement?.kind === 'inputs' ? settlement.result : null;
    const defaultName = (input: ConfidentialActionInput) => fill ? resolveConfidentialSecretSaveName(fill) : input.label;
    const approveTitle = fill
        ? submit && fill.request.submit
            ? t('approvals.confidential.approveAndSubmit', { submitControl: fill.request.submit.label })
            : t('approvals.confidential.approve')
        // Not the Action's own verb: beside "Save for next time", a "Save" button would read as saving the secret.
        : t('approvals.approve');
    // Said once: when the durable record already names a refused entry, the live answer does not repeat it.
    const outcome = fillResult ? (props.outcomeRecorded && fillResult.fill.status !== 'filled' ? null : resolveConfidentialFillOutcome(fillResult.fill))
        : inputsResult ? resolveConfidentialInputsOutcome(inputsResult.execution) : null;
    const submitOutcome = fillResult && fill ? resolveConfidentialSubmitOutcome(fillResult.fill, fill.request.submit?.label ?? null) : null;
    const rememberFor = (path: string): string | null => fillResult ? rememberMessage(fillResult.remember, false)
        : inputsResult ? rememberMessage(inputsResult.remember.find(entry => entry.path === path)?.status ?? null, true) : null;
    const targetRow = fill?.actionId === 'browser.automation.secret.fill' ? <Item title={t('approvals.confidential.target')}
        subtitle={joinHappierFacts(fill.request.origin, fill.request.field.fieldId, fill.request.purpose)}
        subtitleLines={0} mode="info" showChevron={false} /> : null;
    // A request settled before this view had a part in it keeps only what it was for; its outcome is the
    // Request section's, and a credential form that can no longer be used is not drawn.
    if (!props.isOpen && settlement === null && !busy && !started.current) {
        return targetRow ? <ItemGroup title={t('approvals.confidential.title')}>{targetRow}</ItemGroup> : null;
    }
    const unavailableRow = unavailable || props.unavailable
        ? <Item title={t('approvals.confidential.unavailable')} mode="info" showChevron={false} /> : null;
    const outcomeRow = outcome ? <Item title={outcome.title} subtitle={outcome.detail ?? undefined} titleLines={0} subtitleLines={0}
        icon={outcome.warning ? <Icon name="warning" size={ICON_SIZE.md} color={theme.colors.state.warning.foreground} /> : undefined}
        mode="info" showChevron={false} testID="approvals.secret-outcome" /> : null;
    const suffix = (index: number) => index === 0 ? '' : `.${index}`;
    const entry = (input: ConfidentialActionInput, index: number) => <CredentialEntry input={input} draft={draftFor(input.path)}
        testIDSuffix={suffix(index)} prepared={prepared} disabled={disabled} defaultName={defaultName(input)}
        onChange={next => setDrafts(current => ({ ...current, [input.path]: next }))} />;
    const rememberedRow = (input: ConfidentialActionInput, index: number) => {
        const message = rememberFor(input.path);
        return message ? <Item title={message} mode="info" showChevron={false} testID={`approvals.secret-remembered${suffix(index)}`} /> : null;
    };
    const decisionBar = <ItemGroup surface="none"><SectionContentRow>
        <ApprovalDecisionBar layout="stacked" busy={busy || props.isDeciding}
            approve={{ testID: 'approvals.secret-continue', label: approveTitle, busy,
                disabled: disabled || !prepared || !ready, onPress: continueFill }}
            // The approval page's own pair: Dismiss closes the request with no answer, Deny refuses the agent.
            dismiss={props.isOpen ? { testID: 'approvals.cancel', accessibilityHint: t('approvals.dismissHint'), disabled: settlement !== null,
                onPress: async () => { clearDraft(); await props.onDecision('cancel'); } } : undefined}
            reject={props.isOpen ? { testID: 'approvals.reject', disabled: props.unavailable || settlement !== null,
                onPress: async () => { clearDraft(); await props.onDecision('reject'); } } : undefined} />
    </SectionContentRow></ItemGroup>;
    if (!fill) {
        // One section per requested input, titled by what the Action calls it; the privacy promise is said once.
        return <>
            {inputs.map((input, index) => <ItemGroup key={input.path} title={input.label}
                description={index === 0 ? t('approvals.confidential.inputsDescription') : undefined}>
                {entry(input, index)}
                {index === inputs.length - 1 ? <>{unavailableRow}{outcomeRow}</> : null}
                {rememberedRow(input, index)}
            </ItemGroup>)}
            {decisionBar}
        </>;
    }
    return <>
        <ItemGroup title={t('approvals.confidential.title')} description={t('approvals.confidential.description')}>
            {targetRow}
            {entry(inputs[0]!, 0)}
            {fill.request.submit ? <Item title={fill.request.submit.label} subtitle={fill.request.submit.consequence}
                subtitleLines={0} showChevron={false} rightElement={<Switch testID="approvals.secret-submit" value={submit}
                    onValueChange={setSubmit} disabled={disabled} accessibilityLabel={fill.request.submit.label}
                    accessibilityHint={fill.request.submit.consequence} />} /> : null}
            {unavailableRow}
            {outcomeRow}
            {submitOutcome ? <Item mode="info" showChevron={false} title={submitOutcome} /> : null}
            {rememberedRow(inputs[0]!, 0)}
        </ItemGroup>
        {decisionBar}
    </>;
}
