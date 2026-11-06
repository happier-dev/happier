import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { UsageFileResultSchema } from '@happier-dev/protocol/usage/usageExport';
import type { UsageCalendarExportInput } from '@happier-dev/protocol/usage/usageCalendarExport';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { NoticeLine } from '@/components/ui/lists/NoticeLine';
import { Text } from '@/components/ui/text/Text';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { ProviderAccountSubscriptionMonthlyPriceV1Schema } from '@happier-dev/protocol/connect/accountSubscription';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { UsagePlanDisclosure } from './UsagePlanParts';
import { t } from '@/text';
import { exportUsageTextDocument } from '../../usageExportFile';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { useUsageSelectorMachineId } from './useUsagePlans';
import { useProjectedConnectedServicesRegistry } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import type { UsagePlanAccount } from './usagePlansModel';

/** A write's outcome line: a failure is announced; a waiting approval says it is waiting. */
function PlanNotice(props: Readonly<{ kind: 'error' | 'pending'; message: string; testID: string }>) {
  const { theme } = useUnistyles();
  const line = <NoticeLine testID={props.testID} iconName={props.kind === 'error' ? 'warning' : 'info'}
    iconColor={props.kind === 'error' ? theme.colors.state.danger.foreground : theme.colors.text.secondary} title={props.message} />;
  return props.kind === 'error' ? <View accessibilityRole="alert">{line}</View> : line;
}

/** Save is an explicit local operation after the same authorized, selected-fact Action read. */
export function UsageCalendarExportButton(props: Readonly<{ input: UsageCalendarExportInput; serverId: string; testID: string }>) {
  const [state, setState] = React.useState<'idle' | 'pending' | 'failed' | 'saved'>('idle');
  const pending = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => { pending.current?.abort(); }, []);
  const { execute, isCurrent } = useMountedActionExecution(props.serverId);
  const save = async () => {
    if (!isCurrent()) { setState('failed'); return; }
    setState('pending');
    const controller = new AbortController();
    pending.current?.abort();
    pending.current = controller;
    const current = () => !controller.signal.aborted && isCurrent();
    try {
      const result = await execute('usage.calendar.export', props.input, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!isCurrent()) { setState('idle'); return; }
      if (!result.ok && isActionApprovalDeclinedErrorCode(result.errorCode)) { setState('idle'); return; }
      const file = result.ok ? UsageFileResultSchema.safeParse(result.result) : null;
      if (!file?.success || file.data.mediaType !== 'text/calendar') { setState('failed'); return; }
      const saved = await exportUsageTextDocument({ content: new TextDecoder().decode(decodeBase64(file.data.base64)),
        fileName: file.data.fileName, mimeType: file.data.mediaType, isCurrent: current });
      if (current()) setState(saved ? 'saved' : 'failed');
    } catch { if (current()) setState('failed'); }
    finally { if (pending.current === controller) pending.current = null; }
  };
  return <View>
    <RoundButton size="small" display="secondary" testID={props.testID} title={t('usage.board.plans.calendarExport')}
      loading={state === 'pending'} disabled={state === 'pending'} onPress={() => { void save(); }} />
    {state === 'failed' ? <PlanNotice kind="error" testID={`${props.testID}.failed`} message={t('usage.board.plans.calendarFailed')} /> : null}
    {state === 'saved' ? <Text style={priceStyles.note}>{t('usage.board.plans.calendarSaved')}</Text> : null}
  </View>;
}

/** No browser destination is derived here: the admitted Connected Account descriptor owns it. */
export function UsageBillingButton(props: Readonly<{ account: UsagePlanAccount; serverId: string; testID: string }>) {
  const machineId = useUsageSelectorMachineId();
  const registry = useProjectedConnectedServicesRegistry();
  const destinationKnown = registry.entries.some(entry => entry.service?.pluginId === props.account.service.pluginId
    && entry.service.localId === props.account.service.localId && entry.projectedDescriptor?.billingUrl && entry.executable === true);
  const [state, setState] = React.useState<'idle' | 'pending' | 'failed'>('idle');
  const pending = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => { pending.current?.abort(); }, []);
  const { execute, isCurrent } = useMountedActionExecution(props.serverId);
  const open = async () => {
    if (!machineId || !destinationKnown || !isCurrent()) { setState('failed'); return; }
    setState('pending');
    const controller = new AbortController();
    pending.current?.abort();
    pending.current = controller;
    try {
      const result = await execute('connectedServices.billing.open', { account: props.account.source.ref, machineId },
        { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!isCurrent()) { setState('idle'); return; }
      setState(result.ok || isActionApprovalDeclinedErrorCode(result.errorCode) ? 'idle' : 'failed');
    } catch { if (!controller.signal.aborted && isCurrent()) setState('failed'); }
    finally { if (pending.current === controller) pending.current = null; }
  };
  return <View style={priceStyles.billing}>
    <RoundButton size="small" display="secondary" testID={props.testID} title={t('usage.board.plans.billingOpen')}
      loading={state === 'pending'} disabled={!machineId || !destinationKnown || state === 'pending'} onPress={() => { void open(); }} />
    {!machineId || !destinationKnown || state === 'failed' ? <Text style={priceStyles.note}>{t('usage.board.plans.billingUnavailable')}</Text> : null}
  </View>;
}

export type UsagePlanActionState = 'idle' | 'pending' | 'approval' | 'failed';
type UsagePlanWriteActionId = 'session.pending.resetStart.set' | 'session.pending.resetStart.cancel' | 'connectedServices.subscription.price.set';

/**
 * One approval-gated Plans write through the mounted Action owner, under the Account lifetime it
 * binds: the same call for binding a pending start to a reset and for cancelling it. The owner
 * presents the approval and settles with its terminal result; until then the row waits and nothing
 * is applied locally.
 */
export function useUsagePlanAction(expectedServerId?: string): Readonly<{
  state: UsagePlanActionState;
  failureMessage: string | null;
  run(actionId: UsagePlanWriteActionId, input: unknown, onSettled: () => void): Promise<void>;
}> {
  const viewer = useActiveServerAccountScope();
  const scopeKey = JSON.stringify([viewer?.serverId ?? null, viewer?.accountId ?? null]);
  const [presentation, setPresentation] = React.useState<Readonly<{ scopeKey: string; state: UsagePlanActionState; errorCode?: string }>>({ scopeKey, state: 'idle' });
  const pending = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => { pending.current?.abort(); }, []);
  const state = presentation.scopeKey === scopeKey ? presentation.state : 'idle';
  const onApprovalPending = React.useCallback(() => setPresentation({ scopeKey, state: 'approval' }), [scopeKey]);
  const { execute, isCurrent } = useMountedActionExecution(expectedServerId ?? viewer?.serverId ?? null,
    { onApprovalPending });
  const run = React.useCallback(async (actionId: UsagePlanWriteActionId, input: unknown, onSettled: () => void) => {
    const setState = (next: UsagePlanActionState, errorCode?: string) => setPresentation({ scopeKey, state: next, errorCode });
    if (!isCurrent()) { setState('failed'); return; }
    setState('pending');
    const controller = new AbortController();
    pending.current?.abort();
    pending.current = controller;
    try {
      const result = await execute(actionId, input, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!isCurrent()) { setState('idle'); return; }
      if (result.ok) { setState('idle'); onSettled(); return; }
      setState('failed', result.errorCode);
    } catch { if (!controller.signal.aborted && isCurrent()) setState('failed'); }
    finally { if (pending.current === controller) pending.current = null; }
  }, [execute, isCurrent, scopeKey]);
  const failureMessage = state === 'failed' && isActionApprovalDeclinedErrorCode(presentation.errorCode)
    ? t('usage.board.plans.approvalDeclined') : null;
  return { state, failureMessage, run };
}

/** The entered price is personal metadata. Its Action owns Account-mode sealing and persistence. */
export function UsageSubscriptionPriceEditor(props: Readonly<{
  account: UsagePlanAccount; serverId: string; testID: string; onSettled(): void;
}>) {
  const viewer = useActiveServerAccountScope();
  const scopeKey = JSON.stringify([props.serverId, viewer?.accountId ?? null, props.account.key]);
  return <UsagePlanDisclosure title={t('usage.board.plans.monthlyPrice')} testID={props.testID}>
    <SubscriptionPriceFields key={scopeKey} {...props} />
  </UsagePlanDisclosure>;
}

function SubscriptionPriceFields(props: React.ComponentProps<typeof UsageSubscriptionPriceEditor>) {
  const entered = props.account.subscription?.enteredMonthlyPrice;
  const [amount, setAmount] = React.useState(entered ? String(entered.amount) : '');
  const [currency, setCurrency] = React.useState(entered?.currency ?? '');
  const { state, failureMessage, run } = useUsagePlanAction(props.serverId);
  const viewer = useActiveServerAccountScope();
  const price = ProviderAccountSubscriptionMonthlyPriceV1Schema.safeParse({
    amount: amount.trim() ? Number(amount) : NaN, currency: currency.trim().toUpperCase(), enteredAtMs: Date.now(),
  });
  const available = viewer?.serverId === props.serverId && state !== 'pending' && state !== 'approval';
  // One line: amount, currency, then Save (and Clear). The fields keep a field's width, never the row's.
  return <View style={priceStyles.root}>
    <View style={priceStyles.line}>
      <FieldItem label={t('usage.board.plans.monthlyPriceAmount')} style={priceStyles.amount}>
        <FieldTextInput testID={`${props.testID}.amount`} value={amount} onChangeText={setAmount}
          accessibilityLabel={t('usage.board.plans.monthlyPriceAmount')} keyboardType="decimal-pad" inputMode="decimal" />
      </FieldItem>
      <FieldItem label={t('usage.board.plans.monthlyPriceCurrency')} style={priceStyles.currency}>
        <FieldTextInput testID={`${props.testID}.currency`} value={currency} onChangeText={setCurrency}
          accessibilityLabel={t('usage.board.plans.monthlyPriceCurrency')} autoCapitalize="characters" />
      </FieldItem>
      <View style={priceStyles.actions}>
        <RoundButton size="small" display="secondary" testID={`${props.testID}.save`} title={t('common.save')}
          disabled={!available || !price.success} loading={state === 'pending'} action={async () => {
            if (!price.success || !available) return;
            return run('connectedServices.subscription.price.set', { account: props.account.source.ref,
              price: { amount: price.data.amount, currency: price.data.currency } }, props.onSettled);
          }} />
        {entered ? <RoundButton size="small" display="secondary" testID={`${props.testID}.clear`} title={t('usage.board.plans.monthlyPriceClear')}
          disabled={!available} action={() => run('connectedServices.subscription.price.set',
            { account: props.account.source.ref, price: null }, () => { setAmount(''); setCurrency(''); props.onSettled(); })} /> : null}
      </View>
    </View>
    <Text style={priceStyles.note}>{t('usage.board.plans.monthlyPriceNote')}</Text>
    {state === 'failed' ? <PlanNotice kind="error" testID={`${props.testID}.failed`} message={failureMessage ?? t('common.saveError')} /> : null}
    {state === 'approval' ? <PlanNotice kind="pending" testID={`${props.testID}.approval`} message={t('usage.board.plans.waitingApproval')} /> : null}
  </View>;
}

const priceStyles = StyleSheet.create((theme) => ({
  root: { gap: theme.space.s6 },
  // A small secondary button hugs its label at the leading edge; its reason sits beneath it.
  billing: { gap: theme.space.s6, alignItems: 'flex-start' },
  line: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: theme.space.s12 },
  amount: { width: 160 },
  currency: { width: 96 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, paddingBottom: theme.space.s2 },
  note: {  color: theme.colors.text.secondary, ...Typography.variant('meta') },
}));
