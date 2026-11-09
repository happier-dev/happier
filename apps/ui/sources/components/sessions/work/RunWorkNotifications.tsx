import * as React from 'react';
import { View } from 'react-native';
import type { ScmDiffSummaryOutputKind } from '@happier-dev/protocol/scm/diffSummary';
import { personalRunFollowOnceKeyV1, type PersonalRunFollowOnceV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { GetOtherAccountFollowResponseV1Schema, SetOtherAccountFollowResponseV1Schema } from '@happier-dev/protocol/sessions/follow/api';
import type { OtherFollowSourceRefV1 } from '@happier-dev/protocol/sessions/follow/followSourceRefTransportV1';
import { callWorkflowAction } from '@/sync/domains/workflows/callWorkflowAction';
import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { isAccountFollowConfigurationChangeRelevant } from '@/components/sessions/follow/sessionFollowAccountChange';
import { t } from '@/text';
import { WorkNotificationOperationView } from './WorkNotificationOperation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';

export type RunWorkNotificationSource = Extract<OtherFollowSourceRefV1, { kind: 'execution_run' | 'workflow_run' }>;
export type RunFollowRead = Readonly<{
    status: 'loading' | 'ready' | 'failed';
    once: readonly PersonalRunFollowOnceV1[];
    pendingIntent: string | null;
    errorIntent: string | null;
    change: (intent: PersonalRunFollowOnceV1, armed: boolean) => Promise<void>;
}>;

/** The selected saved output's identity; baseline and settled catch-up belong to its source owner. */
export type RunWorkNotificationOutput = Readonly<{
    output: ScmDiffSummaryOutputKind;
    comparisonId: string;
    resultId: string;
}>;

export function RunWorkNotifyOperation(props: Readonly<{
    source: RunWorkNotificationSource;
    read: RunFollowRead;
    selectedOutput?: RunWorkNotificationOutput;
    /** The rows stand on a page in their own sheet; inside a card or sheet host they stay bare rows. */
    sheet?: boolean;
}>) {
    const conditions = props.source.kind === 'workflow_run' ? ['terminal', 'needs_attention'] as const : ['terminal'] as const;
    const rows = conditions.flatMap(condition => {
        const intent: PersonalRunFollowOnceV1 = condition === 'needs_attention' ? { kind: 'first_needs_you' }
            : props.selectedOutput ? { kind: 'output_ready', outputRef: { kind: 'scm_diff_summary', ...props.selectedOutput } }
                : { kind: 'run_settled' };
        const key = personalRunFollowOnceKeyV1(intent);
        const armed = props.read.once.some(once => personalRunFollowOnceKeyV1(once) === key);
        if (props.read.status === 'failed' && !armed && props.read.errorIntent !== key) return [];
        return [<WorkNotificationOperationView key={condition} sourceId={props.source.runId} testIDPrefix={`notify-run-${condition}`}
            title={condition === 'terminal' ? t('sessionWork.notify.run') : t('sessionWork.notify.attention')}
            armed={armed}
            pending={props.read.pendingIntent === key} disabled={(!armed && props.read.status !== 'ready') || props.read.pendingIntent !== null}
            error={props.read.errorIntent === key} onChange={armed => props.read.change(intent, armed)} />];
    });
    // On a page the host column owns the padding: the sheet stands on the same edge as the header and the content below.
    if (props.sheet) return rows.length > 0
        ? <ListPresentationProvider value="page" pageInsets="contained"><ItemGroup density="compact" constrainToContentWidth={false}>{rows}</ItemGroup></ListPresentationProvider>
        : null;
    return <View style={{ minWidth: 0 }}>{rows}</View>;
}

/** Run Notify me is a personal Follow edit, never an authored Habit or a delivery-channel writer. */
export function RunWorkNotifications(props: Readonly<{
    source: RunWorkNotificationSource;
    serverId?: string | null;
    selectedOutput?: RunWorkNotificationOutput;
    sheet?: boolean;
}>) {
    const lifetime = useActiveServerAccountScopeLifetime();
    if (!lifetime?.isCurrent() || (props.serverId && !areServerProfileIdentifiersEquivalent(props.serverId, lifetime.scope.serverId))) return null;
    return <RunWorkNotificationsForAccount key={JSON.stringify([lifetime.scope, props.source, props.selectedOutput])}
        {...props} lifetime={lifetime} />;
}

function RunWorkNotificationsForAccount(props: React.ComponentProps<typeof RunWorkNotifications> & Readonly<{
    lifetime: NonNullable<ReturnType<typeof useActiveServerAccountScopeLifetime>>;
}>) {
    const { lifetime } = props;
    const [status, setStatus] = React.useState<RunFollowRead['status']>('loading');
    const statusRef = React.useRef(status);
    statusRef.current = status;
    const [once, setOnce] = React.useState<readonly PersonalRunFollowOnceV1[]>([]);
    const [pendingIntent, setPendingIntent] = React.useState<string | null>(null);
    const [errorIntent, setErrorIntent] = React.useState<string | null>(null);
    const [attempt, setAttempt] = React.useState(0);
    const busy = React.useRef(false);
    const latestEdit = React.useRef<object | null>(null);
    const refreshAfterWrite = React.useRef(false);
    const refreshRef = React.useRef<() => Promise<void>>(async () => {});
    const source = props.source;
    const sourceKey = JSON.stringify(source);
    const read = React.useCallback((signal?: AbortSignal) => callWorkflowAction({ actionId: 'follow.get',
        input: { receiver: { kind: 'account' }, source }, accountLifetime: lifetime, signal,
        parseResult: value => GetOtherAccountFollowResponseV1Schema.parse(value) }), [lifetime, sourceKey]);
    React.useEffect(() => {
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        let running = false;
        let dirty = false;
        const refresh = async () => {
            if (busy.current) { refreshAfterWrite.current = true; return; }
            if (running) { dirty = true; return; }
            running = true;
            let readEdit = latestEdit.current;
            try {
                do {
                    dirty = false;
                    readEdit = latestEdit.current;
                    const result = await read(controller.signal);
                    if (controller.signal.aborted || !lifetime.isCurrent()) return;
                    if (busy.current) { refreshAfterWrite.current = true; return; }
                    if (readEdit !== latestEdit.current) { dirty = true; continue; }
                    setOnce(result.follow?.once ?? []);
                    setStatus('ready');
                } while (dirty);
            } catch {
                if (!controller.signal.aborted && lifetime.isCurrent()) {
                    if (busy.current) refreshAfterWrite.current = true;
                    else if (readEdit !== latestEdit.current) dirty = true;
                    else setStatus('failed');
                }
            } finally {
                running = false;
                if (dirty && !busy.current && !controller.signal.aborted && lifetime.isCurrent()) void refresh();
            }
        };
        refreshRef.current = refresh;
        const unsubscribe = subscribeHomeAccountChange(event => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, lifetime.scope.serverId)
                && isAccountFollowConfigurationChangeRelevant(event)) void refresh();
        }, { reconnect: { readNotCurrent: () => running || statusRef.current !== 'ready' } });
        void refresh();
        return () => { controller.abort(); retirement.dispose(); unsubscribe(); };
    }, [attempt, lifetime, read]);
    const change = async (intent: PersonalRunFollowOnceV1, armed: boolean) => {
        if (busy.current || !lifetime.isCurrent()) return;
        if (status !== 'ready' && (armed || !once.some(value => personalRunFollowOnceKeyV1(value) === personalRunFollowOnceKeyV1(intent)))) return;
        busy.current = true;
        latestEdit.current = {};
        const key = personalRunFollowOnceKeyV1(intent);
        setPendingIntent(key);
        setErrorIntent(null);
        try {
            // A different output surface may have committed since this row mounted. Replace only this intent.
            const current = await read();
            const next = (current.follow?.once ?? []).filter(value => personalRunFollowOnceKeyV1(value) !== key);
            if (armed) next.push(intent);
            const result = await callWorkflowAction({ actionId: 'follow.set',
                input: { receiver: { kind: 'account' }, source, once: next }, accountLifetime: lifetime,
                parseResult: value => SetOtherAccountFollowResponseV1Schema.parse(value) });
            if (lifetime.isCurrent()) setOnce(result.follow.once ?? []);
        } catch {
            if (lifetime.isCurrent()) setErrorIntent(key);
        } finally {
            busy.current = false;
            if (lifetime.isCurrent()) {
                setPendingIntent(null);
                if (refreshAfterWrite.current) { refreshAfterWrite.current = false; void refreshRef.current(); }
            }
        }
    };
    return <>
        <RunWorkNotifyOperation source={source} selectedOutput={props.selectedOutput} sheet={props.sheet} read={{ status, once, pendingIntent, errorIntent, change }} />
        {status === 'failed' ? <RoundButton display="inverted" size="small" style={{ minHeight: 44 }}
            title={t('common.retry')} onPress={() => setAttempt(value => value + 1)} /> : null}
    </>;
}

export function SessionRunWorkNotifications(props: Readonly<{
    sessionId: string;
    runId: string;
    serverId?: string | null;
    selectedOutput?: RunWorkNotificationOutput;
    sheet?: boolean;
}>) {
    return <RunWorkNotifications source={{ kind: 'execution_run', runId: props.runId, sessionId: props.sessionId }}
        serverId={props.serverId} selectedOutput={props.selectedOutput} sheet={props.sheet} />;
}
