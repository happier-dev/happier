import * as React from 'react';
import { View } from 'react-native';
import { UsageFileResultSchema } from '@happier-dev/protocol/usage/usageExport';
import type { UsageCalendarExportInput } from '@happier-dev/protocol/usage/usageCalendarExport';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import { exportUsageTextDocument } from '../../usageExportFile';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { useUsageSelectorMachineId } from './useUsagePlans';
import { useProjectedConnectedServicesRegistry } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import type { UsagePlanAccount } from './usagePlansModel';

/** Save is an explicit local operation after the same authorized, selected-fact Action read. */
export function UsageCalendarExportButton(props: Readonly<{ input: UsageCalendarExportInput; serverId: string; testID: string }>) {
  const [state, setState] = React.useState<'idle' | 'pending' | 'failed' | 'saved'>('idle');
  const pending = React.useRef<Readonly<{ cancel(): void; dispose(): void }> | null>(null);
  React.useEffect(() => () => { pending.current?.cancel(); pending.current?.dispose(); }, []);
  const save = async () => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime?.isCurrent() || lifetime.scope.serverId !== props.serverId) { setState('failed'); return; }
    setState('pending');
    const controller = new AbortController();
    const retired = lifetime.onRetire(() => { controller.abort(); setState('idle'); });
    const request = { cancel: () => controller.abort(), dispose: () => retired.dispose() };
    pending.current = request;
    try {
      const result = await createFrontDoorActionExecute()('usage.calendar.export', props.input, {
        surface: 'ui', serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId, signal: controller.signal,
      });
      if (controller.signal.aborted || !lifetime.isCurrent()) return;
      const file = result.ok ? UsageFileResultSchema.safeParse(result.result) : null;
      if (!file?.success || file.data.mediaType !== 'text/calendar') { setState('failed'); return; }
      const saved = await exportUsageTextDocument({ content: new TextDecoder().decode(decodeBase64(file.data.base64)),
        fileName: file.data.fileName, mimeType: file.data.mediaType, isCurrent: () => !controller.signal.aborted && lifetime.isCurrent() });
      if (!controller.signal.aborted && lifetime.isCurrent()) setState(saved ? 'saved' : 'failed');
    } catch { if (!controller.signal.aborted && lifetime.isCurrent()) setState('failed'); }
    finally { request.dispose(); if (pending.current === request) pending.current = null; }
  };
  return <View>
    <RoundButton size="small" display="secondary" testID={props.testID} title={t('usage.board.plans.calendarExport')}
      loading={state === 'pending'} disabled={state === 'pending'} onPress={() => { void save(); }} />
    {state === 'failed' ? <Text accessibilityRole="alert">{t('usage.board.plans.calendarFailed')}</Text> : null}
    {state === 'saved' ? <Text>{t('usage.board.plans.calendarSaved')}</Text> : null}
  </View>;
}

/** No browser destination is derived here: the admitted Connected Account descriptor owns it. */
export function UsageBillingButton(props: Readonly<{ account: UsagePlanAccount; serverId: string; testID: string }>) {
  const machineId = useUsageSelectorMachineId();
  const registry = useProjectedConnectedServicesRegistry();
  const destinationKnown = registry.entries.some(entry => entry.service?.pluginId === props.account.service.pluginId
    && entry.service.localId === props.account.service.localId && entry.projectedDescriptor?.billingUrl && entry.executable === true);
  const [state, setState] = React.useState<'idle' | 'pending' | 'failed'>('idle');
  const pending = React.useRef<Readonly<{ cancel(): void; dispose(): void }> | null>(null);
  React.useEffect(() => () => { pending.current?.cancel(); pending.current?.dispose(); }, []);
  const open = async () => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!machineId || !destinationKnown || !lifetime?.isCurrent() || lifetime.scope.serverId !== props.serverId) { setState('failed'); return; }
    setState('pending');
    const controller = new AbortController();
    const retired = lifetime.onRetire(() => { controller.abort(); setState('idle'); });
    const request = { cancel: () => controller.abort(), dispose: () => retired.dispose() };
    pending.current = request;
    try {
      const result = await createFrontDoorActionExecute()('connectedServices.billing.open', { account: props.account.read.source.ref, machineId }, {
        surface: 'ui', serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId, signal: controller.signal,
      });
      if (!controller.signal.aborted && lifetime.isCurrent()) setState(result.ok ? 'idle' : 'failed');
    } catch { if (!controller.signal.aborted && lifetime.isCurrent()) setState('failed'); }
    finally { request.dispose(); if (pending.current === request) pending.current = null; }
  };
  return <View>
    <RoundButton size="small" display="secondary" testID={props.testID} title={t('usage.board.plans.billingOpen')}
      loading={state === 'pending'} disabled={!machineId || !destinationKnown || state === 'pending'} onPress={() => { void open(); }} />
    {!machineId || !destinationKnown || state === 'failed' ? <Text>{t('usage.board.plans.billingUnavailable')}</Text> : null}
  </View>;
}

export type UsagePlanActionState = 'idle' | 'pending' | 'approval' | 'failed';

/**
 * One approval-gated Plans write through the UI front door, under the captured Account lifetime: the
 * same call for binding a pending start to a reset and for cancelling it. An approval request leaves
 * the row waiting; nothing is applied locally.
 */
export function useUsagePlanAction(): Readonly<{
  state: UsagePlanActionState;
  run(actionId: 'session.pending.resetStart.set' | 'session.pending.resetStart.cancel', input: unknown, onSettled: () => void): Promise<void>;
}> {
  const [state, setState] = React.useState<UsagePlanActionState>('idle');
  const run = React.useCallback(async (actionId: 'session.pending.resetStart.set' | 'session.pending.resetStart.cancel', input: unknown, onSettled: () => void) => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime?.isCurrent()) { setState('failed'); return; }
    setState('pending');
    try {
      const result = await createFrontDoorActionExecute()(actionId, input, {
        surface: 'ui', serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
      });
      if (!lifetime.isCurrent()) return;
      if (!result.ok) { setState('failed'); return; }
      if (ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success) { setState('approval'); return; }
      setState('idle');
      onSettled();
    } catch { if (lifetime.isCurrent()) setState('failed'); }
  }, []);
  return { state, run };
}
