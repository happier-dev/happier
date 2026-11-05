import * as React from 'react';

import {
    CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
    CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY,
    CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
    CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD,
    CurrentSessionPresentationBindResultV1Schema,
    CurrentSessionPresentationStateV1Schema,
    type CurrentSessionPresentationAckV1,
} from '@happier-dev/protocol/sessions';

import { randomUUID } from '@/platform/randomUUID';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { storage } from '@/sync/domains/state/storage';
import {
    getFocusedSessionAddress,
    subscribeSessionSurfaceVisibility,
} from '@/sync/domains/session/sessionSurfaceVisibility';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { normalizeSessionAddress, sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { sessionRpcWithPreferredSessionScope } from '@/sync/runtime/orchestration/serverScopedRpc/sessionRpcWithPreferredSessionScope';

import { applyCurrentSessionPresentationCommand } from './applyCurrentSessionPresentationCommand';
import { PresentationNoticeHost } from './PresentationNoticeHost';
import { desktopHostKind } from '@/utils/platform/desktopHost';
import { observeDesktopAppWindowSurfaces, publishDesktopAppWindowSurface } from '@/desktop/window/appWindowSurface';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useMountedClientActionMethods } from '@/components/appShell/runtime/mountedClientActionAddresses';
import { publishPresentationNotice } from './presentationNotices';
import {
    readSessionComposerPresentationTargetAtAddress,
    readSessionPresentationAdapterAtAddress,
    subscribeSessionComposerPresentationTargets,
} from './sessionComposerPresentationTargets';

function isExactFocusedSession(address: SessionAddress): boolean {
    const focused = getFocusedSessionAddress();
    return focused !== null
        && focused.sessionId === address.sessionId
        && areServerProfileIdentifiersEquivalent(focused.serverId, address.serverId);
}

function isCurrentSessionRowAtAddress(
    address: SessionAddress,
    scopeLifetime: ActiveServerAccountScopeLifetime,
): boolean {
    const session = storage.getState().sessions[address.sessionId];
    return scopeLifetime.isCurrent()
        && session !== undefined
        && session.active !== false
        && areServerProfileIdentifiersEquivalent(scopeLifetime.scope.serverId, address.serverId)
        && areServerProfileIdentifiersEquivalent(session.serverId, address.serverId);
}

type PresentationSyncBinding = Readonly<{
    address: SessionAddress;
    scopeLifetime: ActiveServerAccountScopeLifetime;
    bindingKey: string;
}>;

export const CurrentSessionPresentationRuntime = React.memo(function CurrentSessionPresentationRuntime() {
    const clientIdRef = React.useRef<string>(randomUUID());
    const scope = storage(state => state.profileScope);
    const methods = useMountedClientActionMethods(scope?.serverId ?? null, scope?.accountId ?? null);

    React.useEffect(() => {
        if (desktopHostKind() !== 'tauri') return;
        let previous: Parameters<typeof publishDesktopAppWindowSurface>[0] | undefined;
        const publish = () => {
            if (!scope) return;
            const focused = getFocusedSessionAddress();
            const next = { homeId: scope.serverId, accountId: scope.accountId,
                sessionId: focused && areServerProfileIdentifiersEquivalent(focused.serverId, scope.serverId) ? focused.sessionId : null,
                methods };
            if (previous?.homeId === next.homeId && previous.accountId === next.accountId && previous.sessionId === next.sessionId) return;
            previous = next;
            fireAndForget(publishDesktopAppWindowSurface(next), { tag: 'appWindow.surface' });
        };
        publish();
        const stopVisibility = subscribeSessionSurfaceVisibility(publish);
        return stopVisibility;
    }, [scope, methods]);

    React.useEffect(() => {
        if (desktopHostKind() !== 'tauri') return;
        let disposed = false;
        let stopObservation: (() => void) | undefined;
        fireAndForget(observeDesktopAppWindowSurfaces().then(stop => {
            if (disposed) stop(); else stopObservation = stop;
        }), { tag: 'appWindow.focus' });
        return () => {
            disposed = true;
            stopObservation?.();
        };
    }, []);

    React.useEffect(() => {
        const clientId = clientIdRef.current;
        const boundHostNonce = new Map<string, string>();
        const boundBindings = new Map<string, PresentationSyncBinding>();
        const bindSignatures = new Map<string, string>();
        const inFlight = new Map<string, Promise<void>>();
        const reschedule = new Set<string>();
        const processedCommandsByBinding = new Map<string, Readonly<{
            hostNonce: string;
            commands: Map<string, CurrentSessionPresentationAckV1 | null>;
        }>>();
        let disposed = false;

        const retireBinding = async (binding: PresentationSyncBinding) => {
            if (!boundBindings.has(binding.bindingKey)) return;
            boundBindings.delete(binding.bindingKey);
            boundHostNonce.delete(binding.bindingKey);
            bindSignatures.delete(binding.bindingKey);
            processedCommandsByBinding.delete(binding.bindingKey);
            try {
                await sessionRpcWithPreferredSessionScope({
                    serverId: binding.address.serverId,
                    sessionId: binding.address.sessionId,
                    method: CURRENT_SESSION_PRESENTATION_UNBIND_RPC_METHOD,
                    payload: { clientId },
                    timeoutMs: 5_000,
                });
            } catch {
                // The authenticated socket disconnect lifecycle independently
                // retires this exact origin when an explicit unbind cannot land.
            }
        };

        const readProcessedCommands = (bindingKey: string, hostNonce: string) => {
            const existing = processedCommandsByBinding.get(bindingKey);
            if (existing?.hostNonce === hostNonce) return existing.commands;
            // PEP promises dedupe for the retained current binding, not across a
            // daemon replacement. Retiring the old binding is the natural bound;
            // evicting commands by an arbitrary count could replay an old visible
            // effect while that same binding is still current.
            const commands = new Map<string, CurrentSessionPresentationAckV1 | null>();
            processedCommandsByBinding.set(bindingKey, { hostNonce, commands });
            return commands;
        };

        const syncSession = async ({ address, scopeLifetime, bindingKey }: PresentationSyncBinding) => {
            const sessionId = address.sessionId;
            const session = storage.getState().sessions[sessionId];
            if (!session || session.active === false || disposed) return;
            if (
                !isCurrentSessionRowAtAddress(address, scopeLifetime)
                || !areServerProfileIdentifiersEquivalent(scopeLifetime.scope.serverId, address.serverId)
            ) return;
            const composer = readSessionComposerPresentationTargetAtAddress(address);
            // A presented composer-less surface (full-screen Board/Companion) is a
            // current-UI target in its own right: presentation availability does
            // not depend on whether Chat's composer is mounted.
            const presentationAdapter = readSessionPresentationAdapterAtAddress(address);
            if (!composer && !presentationAdapter) {
                await retireBinding({ address, scopeLifetime, bindingKey });
                return;
            }
            const focused = isExactFocusedSession(address);
            const draftRevision = composer?.revision ?? 0;
            const observedRaw = (session.agentState as Record<string, unknown> | null)?.[
                CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY
            ];
            const observed = CurrentSessionPresentationStateV1Schema.safeParse(observedRaw);
            // A daemon replacement publishes a new host nonce before this UI has
            // rebound. Include that canonical state in the incumbent bind trigger;
            // focus/draft stability alone must not strand every later command.
            const observedHostNonce = observed.success ? observed.data.hostNonce : '';
            const signatureBase = `${sessionAddressKey(address)}:${scopeLifetime.scope.accountId}:${focused ? 1 : 0}:${draftRevision}`;
            // A shared-only socket/list row can temporarily omit the owner
            // AgentState between hydrated echoes. That absence is not a new
            // daemon; keep the accepted host until an actual different nonce arrives.
            const signature = `${signatureBase}:${observedHostNonce || boundHostNonce.get(bindingKey) || ''}`;

            if (bindSignatures.get(bindingKey) !== signature) {
                const result = CurrentSessionPresentationBindResultV1Schema.parse(
                    await sessionRpcWithPreferredSessionScope({
                        serverId: address.serverId,
                        sessionId,
                        method: CURRENT_SESSION_PRESENTATION_BIND_RPC_METHOD,
                        payload: { clientId, focused, draftRevision },
                        timeoutMs: 5_000,
                    }),
                );
                if (result.status === 'rejected') {
                    boundHostNonce.delete(bindingKey);
                    boundBindings.delete(bindingKey);
                    processedCommandsByBinding.delete(bindingKey);
                    return;
                }
                const acceptedBinding = { address, scopeLifetime, bindingKey };
                if (
                    result.sessionId !== sessionId
                    || disposed
                    || !isCurrentSessionRowAtAddress(address, scopeLifetime)
                    || (
                        !readSessionComposerPresentationTargetAtAddress(address)
                        && !readSessionPresentationAdapterAtAddress(address)
                    )
                ) {
                    // The Home/daemon may have accepted this exact socket origin
                    // while its mounted target was retiring. Record it just long
                    // enough for the one canonical retirement path to unbind it;
                    // otherwise an app-level socket can outlive this runtime.
                    boundBindings.set(bindingKey, acceptedBinding);
                    await retireBinding(acceptedBinding);
                    return;
                }
                boundHostNonce.set(bindingKey, result.hostNonce);
                boundBindings.set(bindingKey, acceptedBinding);
                bindSignatures.set(bindingKey, `${signatureBase}:${result.hostNonce}`);
            }

            const latest = storage.getState().sessions[sessionId];
            if (
                !latest
                || latest.active === false
                || !isCurrentSessionRowAtAddress(address, scopeLifetime)
            ) return;
            const raw = (latest?.agentState as Record<string, unknown> | null)?.[
                CURRENT_SESSION_PRESENTATION_AGENT_STATE_KEY
            ];
            const parsed = CurrentSessionPresentationStateV1Schema.safeParse(raw);
            const hostNonce = boundHostNonce.get(bindingKey);
            if (!parsed.success || !hostNonce || !parsed.data.command) return;
            const processedCommands = readProcessedCommands(bindingKey, hostNonce);
            const commandKey = parsed.data.command.id;
            if (processedCommands.has(commandKey)) {
                const settledAck = processedCommands.get(commandKey) ?? null;
                if (settledAck) {
                    await sessionRpcWithPreferredSessionScope({
                        serverId: address.serverId,
                        sessionId,
                        method: CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
                        payload: settledAck,
                        timeoutMs: 5_000,
                    });
                }
                return;
            }
            // Resolve all identity and target facts before entering the pure
            // dispatcher, then recheck the same captured Account/Home lifetime
            // at the effect boundary. A raw Session row can be replaced during
            // the awaited bind even when a new Home happens to reuse the nonce.
            if (!isCurrentSessionRowAtAddress(address, scopeLifetime)) return;
            const application = applyCurrentSessionPresentationCommand({
                state: parsed.data,
                hostNonce,
                clientId,
                isCurrentSession: isExactFocusedSession(address),
                notify: (event) => publishPresentationNotice({
                    // Notice lifetime is global, so its identity must retain the
                    // exact Account/Home/Session binding as well as daemon and
                    // command identity. A same-id Session in another Account can
                    // then never retire or replace feedback under the same key.
                    key: `session-presentation:${bindingKey}:${hostNonce}:${commandKey}`,
                    message: event.message,
                    severity: event.severity,
                }),
                composer: composer && {
                    revision: composer.revision,
                    apply: composer.applyTransaction,
                },
                presentation: presentationAdapter ? { apply: presentationAdapter.apply } : null,
            });
            if (!application) return;
            processedCommands.set(commandKey, application.ack);
            if (!application.ack) return;
            await sessionRpcWithPreferredSessionScope({
                serverId: address.serverId,
                sessionId,
                method: CURRENT_SESSION_PRESENTATION_ACK_RPC_METHOD,
                payload: application.ack,
                timeoutMs: 5_000,
            });
        };

        const scheduleSession = (binding: PresentationSyncBinding) => {
            const { bindingKey } = binding;
            if (inFlight.has(bindingKey)) {
                reschedule.add(bindingKey);
                return;
            }
            const pending = syncSession(binding)
                .catch(() => undefined)
                .finally(() => {
                    inFlight.delete(bindingKey);
                    if (reschedule.delete(bindingKey) && !disposed) {
                        const nextLifetime = captureActiveServerAccountScopeLifetime();
                        if (!nextLifetime) return;
                        const nextSession = storage.getState().sessions[binding.address.sessionId];
                        const nextAddress = normalizeSessionAddress(nextSession?.serverId, binding.address.sessionId);
                        if (
                            !nextAddress
                            || nextSession?.active === false
                            || !areServerProfileIdentifiersEquivalent(nextLifetime.scope.serverId, nextAddress.serverId)
                        ) return;
                        scheduleSession({
                            address: nextAddress,
                            scopeLifetime: nextLifetime,
                            bindingKey: `${serverAccountScopeKeySuffix(nextLifetime.scope)}${sessionAddressKey(nextAddress)}`,
                        });
                    }
                });
            inFlight.set(bindingKey, pending);
        };
        const syncAll = () => {
            const scopeLifetime = captureActiveServerAccountScopeLifetime();
            if (!scopeLifetime?.isCurrent()) {
                for (const binding of boundBindings.values()) void retireBinding(binding);
                return;
            }
            const currentBindingKeys = new Set<string>();
            for (const session of Object.values(storage.getState().sessions)) {
                if (session.active === false) continue;
                const address = normalizeSessionAddress(session.serverId, session.id);
                if (
                    !address
                    || !areServerProfileIdentifiersEquivalent(scopeLifetime.scope.serverId, address.serverId)
                ) continue;
                const binding = {
                    address,
                    scopeLifetime,
                    bindingKey: `${serverAccountScopeKeySuffix(scopeLifetime.scope)}${sessionAddressKey(address)}`,
                };
                currentBindingKeys.add(binding.bindingKey);
                scheduleSession(binding);
            }
            for (const [bindingKey, binding] of boundBindings) {
                if (!currentBindingKeys.has(bindingKey)) void retireBinding(binding);
            }
        };

        syncAll();
        let previousSocketStatus: 'disconnected' | 'connecting' | 'connected' | 'error' | null = null;
        const unsubscribeSocketStatus = apiSocket.onStatusChange((status) => {
            const previous = previousSocketStatus;
            previousSocketStatus = status;
            if (status === 'connected' && previous !== null && previous !== 'connected') {
                // Home retires this exact socket origin on disconnect. A new
                // connection is a real binding change even if focus and draft
                // stayed fixed while the UI was offline or backgrounded.
                bindSignatures.clear();
                syncAll();
            }
        });
        const unsubscribeStorage = storage.subscribe(syncAll);
        const unsubscribeVisibility = subscribeSessionSurfaceVisibility(syncAll);
        const unsubscribeComposer = subscribeSessionComposerPresentationTargets(syncAll);
        return () => {
            disposed = true;
            unsubscribeSocketStatus();
            unsubscribeStorage();
            unsubscribeVisibility();
            unsubscribeComposer();
            for (const binding of boundBindings.values()) void retireBinding(binding);
        };
    }, []);

    // The app's ONE presentation notice, drawn by its own host. Its producers are
    // the daemon command stream above, mounted plugin UI's `notify` host method
    // (§3.4) and Board/Companion feedback; this component only keeps it mounted
    // app-globally.
    return <PresentationNoticeHost />;
});
