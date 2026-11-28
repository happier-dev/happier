import * as React from 'react';
import { AppState, Platform } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { MMKV } from 'react-native-mmkv';
import { readServerEnabledBit } from '@happier-dev/protocol';
import { z } from 'zod';

import { useOptionalModal } from '@/modal';
import { log } from '@/log';
import { getCachedServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { derivePendingRequestFlagsFromSession } from '@/sync/domains/session/pending/listPendingSessionRequests';
import { subscribeSessionSupporterAskSignal } from '@/sync/domains/session/realtime/sessionSupporterAskSignal';
import { storage } from '@/sync/domains/state/storage';
import { serverFetch } from '@/sync/http/client';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveSessionLiveConsumption } from '@/sync/runtime/sessionLiveConsumption';
import { trackStarAsk } from '@/track';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { HAPPIER_GITHUB_URL } from '@/utils/url/happierGithubUrl';

import { StarAskCard, type StarAskPresentation } from './StarAskCard';
import { ComposerAuxiliaryFrame } from './ComposerAuxiliaryFrame';
import { createStarAskMoment } from './starAskMoment';

const dueSchema = z.object({ due: z.enum(['star', 'supporter_prompt']).nullable() });
const statsSchema = z.object({ stars: z.number().int().positive() });
const githubStarSchema = z.discriminatedUnion('status', [
    z.object({ status: z.enum(['starred', 'web', 'unknown']) }),
    z.object({ status: z.literal('unstarred'), login: z.string().regex(/^[\da-zA-Z-]{1,39}$/) }),
]);
type Ask = NonNullable<z.infer<typeof dueSchema>['due']>;
type Actions = ReturnType<typeof createDefaultActionExecutor>;
const moment = createStarAskMoment<StarAskPresentation | 'closed'>();
let markers: MMKV | undefined;
const keyFor = (accountId: string, ask: Ask) => `supporter.ask.${accountId}.${ask}`;
export const touchSessionSupporterAsk = moment.touch;

function isFocused() {
    if (Platform.OS === 'web' && typeof document !== 'undefined') return !document.hidden && document.hasFocus();
    return AppState.currentState === 'active';
}

function watchActivity(): () => void {
    if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof document !== 'undefined') {
        const events = ['keydown', 'pointerdown', 'wheel', 'blur', 'focus'] as const;
        for (const event of events) window.addEventListener(event, moment.touch, true);
        document.addEventListener('visibilitychange', moment.touch);
        return () => {
            for (const event of events) window.removeEventListener(event, moment.touch, true);
            document.removeEventListener('visibilitychange', moment.touch);
        };
    }
    const listener = AppState.addEventListener('change', moment.touch);
    return () => listener.remove();
}

async function closeAsk(actions: Actions, scope: ServerAccountScope, ask: Ask): Promise<void> {
    try {
        markers?.set(keyFor(scope.accountId, ask), true);
    } catch {
        log.log('Unable to save supporter ask close on this device');
    }
    if (!areServerAccountScopesEqual(scope, getActiveServerAccountScope())) return;
    try {
        const response = await actions.execute('supporter.ask.close', { ask }, {
            surface: 'ui_button', serverId: scope.serverId,
        });
        if (!response.ok) throw new Error('Supporter ask close refused');
    } catch {
        log.log('Unable to save supporter ask close on the Home');
    }
}

async function readStars(signal: AbortSignal): Promise<number | null> {
    try {
        const response = await fetch('https://stats.happier.dev/github.json', { signal });
        if (!response.ok) return null;
        const stats = statsSchema.safeParse(await response.json());
        return stats.success ? stats.data.stars : null;
    } catch {
        return null;
    }
}

async function callGithubStar(actions: Actions, scope: ServerAccountScope, machineId: string, id: 'github.star' | 'github.star.status') {
    const result = await actions.execute(id, {}, {
        defaultSessionMachineId: machineId, serverId: scope.serverId, surface: 'ui_button',
    });
    return result.ok ? githubStarSchema.parse(result.result) : { status: 'unknown' as const };
}

type SessionSupporterAskProps = Readonly<{ sessionId: string; serverId?: string | null }>;

export function SessionSupporterAsk(props: SessionSupporterAskProps) {
    const pathname = usePathname();
    return pathname === `/session/${props.sessionId}`
        ? <ActiveSessionSupporterAsk key={`${props.serverId ?? ''}/${props.sessionId}`} {...props} />
        : null;
}

function ActiveSessionSupporterAsk({ sessionId, serverId }: SessionSupporterAskProps) {
    const router = useRouter();
    const actions = React.useMemo(() => createDefaultActionExecutor(), []);
    const modal = useOptionalModal();
    const hasOpenModal = modal?.hasOpenModal;
    const [visible, setVisible] = React.useState<{ scope: ServerAccountScope; presentation: StarAskPresentation; machineId?: string } | null>(null);
    const [state, setState] = React.useState<'ready' | 'pending' | 'web' | 'done'>('ready');
    const actionInProgress = React.useRef(false);
    const clearCard = React.useCallback(() => setVisible(null), []);

    React.useEffect(() => {
        let didArm = false;
        const unsubscribe = subscribeSessionSupporterAskSignal((id, event) => {
            if (event === 'task_started') {
                if (didArm && resolveSessionLiveConsumption(id, serverId).isVisible) moment.disarm();
                return;
            }
            if (id !== sessionId || (Platform.OS === 'web' && typeof window !== 'undefined' && window.top !== window)) return;
            const scope = getActiveServerAccountScope();
            if (!scope || (serverId && scope.serverId !== serverId)) return;
            const snapshot = getCachedServerFeaturesSnapshot({ serverId: scope.serverId });
            if (snapshot?.status !== 'ready' || readServerEnabledBit(snapshot.features, 'supporter') !== true) return;
            const session = storage.getState().sessions[sessionId];
            if (!session || session.accessLevel) return;
            let local: MMKV;
            try {
                local = markers ??= new MMKV();
                if (local.getBoolean(keyFor(scope.accountId, 'supporter_prompt'))) return;
            } catch {
                return;
            }
            const machineId = session.metadata?.machineId;
            const sessionCurrent = () => areServerAccountScopesEqual(scope, getActiveServerAccountScope())
                && resolveSessionLiveConsumption(sessionId, scope.serverId).isVisible;
            if (!sessionCurrent()) return;
            const active = () => isFocused() && sessionCurrent();
            let stopActivity: (() => void) | undefined;
            didArm = moment.arm({
                accountId: scope.accountId,
                active,
                eligible: () => {
                    const current = storage.getState().sessions[sessionId];
                    if (!current || current.accessLevel || hasOpenModal?.()) return false;
                    const pending = derivePendingRequestFlagsFromSession(current);
                    return !pending.hasPendingPermissionRequests && !pending.hasPendingUserActionRequests;
                },
                prepare: async (signal) => {
                    const response = await serverFetch('/v1/account/asks', { method: 'GET', signal, responseSizeBounded: true });
                    if (!response.ok) throw new Error('Supporter ask eligibility unavailable');
                    const { due } = dueSchema.parse(await response.json());
                    if (!due || signal.aborted || local.getBoolean(keyFor(scope.accountId, due))) return null;
                    if (due === 'supporter_prompt') return { kind: due };
                    if (!machineId) return null;
                    const result = await callGithubStar(actions, scope, machineId, 'github.star.status');
                    if (signal.aborted || !sessionCurrent()) return null;
                    if (result.status === 'starred') {
                        trackStarAsk('already_starred');
                        void closeAsk(actions, scope, 'star');
                        return 'closed' as const;
                    }
                    if (result.status === 'unknown') throw new Error('GitHub star status unavailable');
                    return { kind: 'star', count: await readStars(signal), login: result.status === 'unstarred' ? result.login : undefined };
                },
                show: (presentation) => {
                    if (presentation === 'closed') return;
                    if (presentation.kind === 'star') trackStarAsk('shown');
                    setVisible({ scope, machineId, presentation });
                },
                onDisarm: () => {
                    didArm = false;
                    stopActivity?.();
                },
            });
            if (didArm) stopActivity = watchActivity();
        });
        return () => {
            if (didArm) moment.disarm();
            unsubscribe();
        };
    }, [actions, hasOpenModal, serverId, sessionId]);

    if (!visible || !areServerAccountScopesEqual(visible.scope, getActiveServerAccountScope())) return null;
    const { scope, presentation, machineId } = visible;
    function dismiss() {
        if (presentation.kind === 'star') trackStarAsk('dismissed');
        setVisible(null);
        void closeAsk(actions, scope, presentation.kind);
    }
    async function primary() {
        if (actionInProgress.current || !areServerAccountScopesEqual(scope, getActiveServerAccountScope())) return;
        if (presentation.kind === 'supporter_prompt') {
            setVisible(null);
            void closeAsk(actions, scope, presentation.kind);
            router.push({ pathname: '/settings/plan', params: { offer: 'supporter' } });
            return;
        }
        if (state === 'web' || !presentation.login || !machineId) {
            if (await openExternalUrl(HAPPIER_GITHUB_URL)) {
                trackStarAsk('opened_github');
                setVisible(null);
                void closeAsk(actions, scope, 'star');
            }
            return;
        }
        actionInProgress.current = true;
        setState('pending');
        try {
            const result = await callGithubStar(actions, scope, machineId, 'github.star');
            if (result.status === 'starred') {
                trackStarAsk('starred');
                setState('done');
                void closeAsk(actions, scope, 'star');
            } else {
                setState('web');
            }
        } catch {
            setState('web');
        } finally {
            actionInProgress.current = false;
        }
    }
    return (
        <ComposerAuxiliaryFrame>
            <StarAskCard presentation={presentation} state={state} primary={() => void primary()} dismiss={dismiss} onThanksFinished={clearCard} />
        </ComposerAuxiliaryFrame>
    );
}
