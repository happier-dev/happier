import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { GetSessionFollowResponse, SetSessionFollowRequest } from '@happier-dev/protocol/sessions/follow/api';
import { normalizeAccountFollowNotificationChoiceV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { t } from '@/text';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';

import { AccountSessionFollowEditor, type AccountSessionFollowEditorParts } from './AccountSessionFollowEditor';
import { createAccountSessionFollowController, type AccountSessionFollowEditorSnapshot, type AccountSessionFollowTransport } from './accountSessionFollowController';

installSettingsViewCommonModuleMocks();

function legacyEditorPreferences(input: SetSessionFollowRequest) {
    const { notificationLevel, includeInVoice } = input;
    if (notificationLevel === undefined || includeInVoice === undefined) {
        throw new Error('This legacy editor fixture requires both preference fields');
    }
    return { notificationLevel, includeInVoice };
}

type Screen = Awaited<ReturnType<typeof renderSettingsView>>;
/** The shared editor's preset segment (the pressable radio), by preset id. */
function presetSegment(screen: Screen, preset: string) {
    return screen.tree.root.findAll((node) => node.props.testID === `session-follow-policy.preset.${preset}`
        && typeof node.props.onPress === 'function')[0];
}

describe('Account Follow editor', () => {
    it('presents a scope refusal with the existing denial notice and disabled controls', async () => {
        const screen = await renderSettingsView(<AccountSessionFollowEditor state={{
            projection: null, draft: null, loading: false, saving: false, online: true,
            error: 'credential_scope_denied', voiceInitialSnapshotPending: false,
        }} voiceReadiness="eligible" archived={false} onSet={() => {}} onRemove={() => {}}
            onRetry={() => {}} onOpenNotificationSettings={() => {}} onEditPolicy={() => {}} />);
        expect(screen.getTextContent()).toContain(t('errors.permissionDenied'));
        expect(screen.findByTestId('session-follow-follow')?.props.disabled).toBe(true);
        await screen.unmount();
    });
    it('claims no Follow state while the first read is pending', async () => {
        const screen = await renderSettingsView(<AccountSessionFollowEditor state={{
            projection: null, draft: null, loading: true, saving: false, online: true,
            error: null, voiceInitialSnapshotPending: false,
        }} voiceReadiness="eligible" archived={false} onSet={() => {}} onRemove={() => {}}
            onRetry={() => {}} onOpenNotificationSettings={() => {}} onEditPolicy={() => {}} />);
        // An owner is tracked; a disabled Off switch before the read would say the opposite.
        expect(screen.findByTestId('session-follow-follow')).toBeNull();
        expect(screen.findByTestId('session-follow-unfollow')).toBeNull();
        expect(screen.findByTestId('session-follow-owner-note')).toBeNull();
        expect(screen.getTextContent()).toContain(t('common.loading'));
        await screen.unmount();
    });
    it('creates, updates, unfollows, and refollows through the mounted editor', async () => {
        const address = { serverId: 'home-a', sessionId: 'session-a' };
        let stored: GetSessionFollowResponse['follow'] = null;
        const writes: string[] = [];
        const transport: AccountSessionFollowTransport = {
            get: async () => ({ kind: 'ok', value: {
                follow: stored,
                isSessionOwner: false,
                capabilities: { manageFollow: true },
                voiceInitialSnapshotPending: stored?.following === true && stored.includeInVoice,
            } }),
            set: async (target, preferences) => {
                if (preferences.policy) {
                    // A policy edit keeps the row's level ingress and stores the chosen policy beside it.
                    writes.push(`policy:${preferences.policy.preset}`);
                    stored = { sessionId: target.sessionId, following: true, notificationLevel: 'important', includeInVoice: false, policy: preferences.policy };
                    return { kind: 'ok', value: { changed: true, follow: stored, voiceInitialSnapshotPending: false } };
                }
                const legacy = legacyEditorPreferences(preferences);
                writes.push(`set:${preferences.notificationLevel}`);
                // The Home persists a scalar edit as its canonical policy and projects both.
                stored = { sessionId: target.sessionId, following: true, ...preferences, ...legacy, policy: normalizeAccountFollowNotificationChoiceV1(legacy) };
                return { kind: 'ok', value: {
                    changed: true,
                    follow: stored,
                    voiceInitialSnapshotPending: legacy.includeInVoice,
                } };
            },
            remove: async (target) => {
                writes.push('remove');
                stored = {
                    sessionId: target.sessionId,
                    following: false,
                    notificationLevel: 'none',
                    includeInVoice: false,
                };
                return { kind: 'ok', value: { changed: true } };
            },
        };
        const controller = createAccountSessionFollowController(address, transport);
        await controller.refresh();
        function Editor() {
            const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
            return <AccountSessionFollowEditor state={state} voiceReadiness="eligible" archived={false}
                onSet={(next) => { void controller.set(next); }} onRemove={() => { void controller.remove(); }}
                onRetry={() => { void controller.retry(); }} onOpenNotificationSettings={() => {}}
                onEditPolicy={(edit) => { void controller.editPolicy(edit); }} />;
        }
        const screen = await renderSettingsView(<Editor />);

        await act(async () => { screen.findByTestId('session-follow-follow')?.props.onPress(); });
        expect(presetSegment(screen, 'important')?.props.checked).toBe(true);
        await act(async () => { presetSegment(screen, 'everything')?.props.onPress(); });
        expect(presetSegment(screen, 'everything')?.props.checked).toBe(true);
        // Unfollow stays in the editor, which then offers Follow again (its own undo).
        await act(async () => { screen.findByTestId('session-follow-unfollow')?.props.onPress(); });
        expect(screen.findByTestId('session-follow-unfollow')).toBeNull();
        expect(presetSegment(screen, 'important')).toBeUndefined();
        await act(async () => { screen.findByTestId('session-follow-follow')?.props.onPress(); });
        expect(presetSegment(screen, 'important')?.props.checked).toBe(true);
        expect(writes).toEqual(['set:important', 'policy:everything', 'remove', 'set:important']);
        await screen.unmount();
    });

    it('turns Voice on as a policy edit and keeps the chosen preset', async () => {
        const address = { serverId: 'home-a', sessionId: 'session-a' };
        const transport: AccountSessionFollowTransport = {
            get: async () => ({ kind: 'ok', value: {
                follow: { sessionId: address.sessionId, following: true, notificationLevel: 'important', includeInVoice: false, policy: { preset: 'important' } },
                isSessionOwner: false,
                capabilities: { manageFollow: true },
                voiceInitialSnapshotPending: false,
            } }),
            set: async (target, preferences) => ({ kind: 'ok', value: {
                changed: true,
                // The server's modern writer retires the legacy bit; policy is authoritative.
                follow: { sessionId: target.sessionId, following: true, notificationLevel: 'important', includeInVoice: false, policy: preferences.policy ?? { preset: 'important' } },
                voiceInitialSnapshotPending: true,
            } }),
            remove: async () => ({ kind: 'ok', value: { changed: true } }),
        };
        const controller = createAccountSessionFollowController(address, transport);
        await controller.refresh();
        function Editor() {
            const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
            return <AccountSessionFollowEditor state={state}
                voiceReadiness={state.voiceInitialSnapshotPending ? 'pending' : 'eligible'} archived={false}
                onSet={(next) => { void controller.set(next); }} onRemove={() => { void controller.remove(); }}
                onRetry={() => { void controller.retry(); }} onOpenNotificationSettings={() => {}}
                onEditPolicy={(edit) => { void controller.editPolicy(edit); }} />;
        }
        const screen = await renderSettingsView(<Editor />);
        expect(presetSegment(screen, 'important')?.props.checked).toBe(true);
        await act(async () => { screen.findByTestId('session-follow-voice')?.props.onValueChange(true); });
        await act(async () => {});
        expect(controller.getSnapshot().projection?.follow).toMatchObject({ policy: { preset: 'important', voice: true } });
        expect(screen.findByTestId('session-follow-voice')?.props.value).toBe(true);
        expect(presetSegment(screen, 'important')?.props.checked).toBe(true);
        expect(screen.getTextContent()).toContain(t('session.follow.voice.initialSnapshotPending'));
        await screen.unmount();
    });
    it('arms and clears a one-shot "Notify me once" through the Follow controller', async () => {
        const address = { serverId: 'home-a', sessionId: 'session-a' };
        const writes: unknown[] = [];
        let once: unknown;
        const transport: AccountSessionFollowTransport = {
            get: async () => ({ kind: 'ok', value: {
                follow: null, isSessionOwner: true, capabilities: { manageFollow: true }, voiceInitialSnapshotPending: false,
            } }),
            set: async (target, preferences) => {
                writes.push(preferences);
                once = preferences.once ?? undefined;
                return { kind: 'ok', value: { changed: true, voiceInitialSnapshotPending: false, follow: {
                    sessionId: target.sessionId, following: true, notificationLevel: 'important', includeInVoice: false, policy: { preset: 'important' },
                    ...(once ? { once } : {}),
                } as never } };
            },
            remove: async () => { throw new Error('A one-shot change must not Unfollow'); },
        };
        const controller = createAccountSessionFollowController(address, transport);
        await controller.refresh();
        function Editor() {
            const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
            return <AccountSessionFollowEditor state={state} voiceReadiness="eligible" archived={false}
                notifyOnce={{ sourceTurnId: 'turn-1', onOnce: controller.setOnce }}
                onSet={() => {}} onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}}
                onEditPolicy={() => {}} />;
        }
        const screen = await renderSettingsView(<Editor />);
        const select = () => screen.tree.root.findAll((node) => node.props.testID === 'session-follow-once'
            && typeof node.props.onSelect === 'function')[0];
        expect(select()?.props.selectedId).toBe('off');
        await act(async () => { select()?.props.onSelect('turn'); });
        expect(select()?.props.selectedId).toBe('turn');
        await act(async () => { select()?.props.onSelect('off'); });
        expect(writes).toEqual([{ once: { kind: 'turn_finished', sourceTurnId: 'turn-1' } }, { once: null }]);
        expect(select()?.props.selectedId).toBe('off');
        await screen.unmount();
    });

    it('projects the Session owner as tracked with the Important default and no interest toggle', async () => {
        const onEditPolicy = vi.fn();
        const screen = await renderSettingsView(<AccountSessionFollowEditor
            state={{
                // No stored row: the Home still tracks the owner and treats them as
                // Important-eligible, so an Off switch would be a false statement.
                projection: { follow: null, isSessionOwner: true, capabilities: { manageFollow: true }, voiceInitialSnapshotPending: false },
                draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
            }}
            voiceReadiness="eligible" archived={false} onSet={() => {}} onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}} onEditPolicy={onEditPolicy}
        />);
        // No stored row still means Important; the owner can explicitly turn delivery off.
        expect(screen.findByTestId('session-follow-follow')).toBeNull();
        expect(screen.findByTestId('session-follow-unfollow')).not.toBeNull();
        expect(presetSegment(screen, 'important')?.props.checked).toBe(true);
        // The editor is the owner's override, and it writes a real policy through the controller.
        expect(presetSegment(screen, 'quiet')?.props.disabled).not.toBe(true);
        await act(async () => { presetSegment(screen, 'quiet')?.props.onPress(); });
        expect(onEditPolicy).toHaveBeenCalledWith({ kind: 'preset', preset: 'quiet' });
        await screen.unmount();
    });

    it('restores an explicitly suppressed owner through the existing Follow set controller', async () => {
        const address = { serverId: 'home-a', sessionId: 'session-a' };
        let follow: GetSessionFollowResponse['follow'] = {
            sessionId: address.sessionId, following: false, notificationLevel: 'none', includeInVoice: false,
        };
        const writes: SetSessionFollowRequest[] = [];
        const controller = createAccountSessionFollowController(address, {
            get: async () => ({ kind: 'ok', value: { follow, isSessionOwner: true,
                capabilities: { manageFollow: true }, voiceInitialSnapshotPending: false } }),
            set: async (_target, preferences) => {
                writes.push(preferences);
                follow = { sessionId: address.sessionId, following: true, notificationLevel: 'important', includeInVoice: false, policy: { preset: 'important' } };
                return { kind: 'ok', value: { changed: true, follow, voiceInitialSnapshotPending: false } };
            },
            remove: async () => ({ kind: 'ok', value: { changed: false } }),
        });
        await controller.refresh();
        function Editor() {
            const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
            return <AccountSessionFollowEditor state={state} voiceReadiness="eligible" archived={false}
                onSet={(next) => { void controller.set(next); }} onRemove={() => { void controller.remove(); }}
                onRetry={() => { void controller.retry(); }} onOpenNotificationSettings={() => {}}
                onEditPolicy={(edit) => { void controller.editPolicy(edit); }} />;
        }
        const screen = await renderSettingsView(<Editor />);
        expect(controller.getPolicyEditorState()).toMatchObject({ following: true, suppressed: true, deliveryEnabled: false, model: null });
        expect(screen.findByTestId('session-follow-not-following')).not.toBeNull();
        expect(screen.findByTestId('session-follow-follow')?.props.disabled).toBe(false);
        expect(screen.findByTestId('session-follow-owner-note')).toBeNull();
        await act(async () => { screen.findByTestId('session-follow-follow')?.props.onPress(); });
        await act(async () => { await controller.refresh(); });
        expect(writes).toEqual([{ notificationLevel: 'important', includeInVoice: false }]);
        expect(presetSegment(screen, 'important')?.props.checked).toBe(true);
        await screen.unmount();
    });

    it('shows a non-owner with no stored choice as not following', async () => {
        const screen = await renderSettingsView(<AccountSessionFollowEditor
            state={{
                projection: { follow: null, isSessionOwner: false, capabilities: { manageFollow: true }, voiceInitialSnapshotPending: false },
                draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
            }}
            voiceReadiness="eligible" archived={false} onSet={() => {}} onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}} onEditPolicy={() => {}}
        />);
        expect(screen.findByTestId('session-follow-follow')?.props.disabled).toBe(false);
        expect(screen.findByTestId('session-follow-unfollow')).toBeNull();
        expect(presetSegment(screen, 'important')).toBeUndefined();
        await screen.unmount();
    });

    it('leaves explicit Unfollow available for an archived Session and disables preference edits offline', async () => {
        const onRemove = vi.fn();
        const screen = await renderSettingsView(<AccountSessionFollowEditor
            state={{
                projection: {
                    follow: { sessionId: 'session-a', following: true, notificationLevel: 'important', includeInVoice: true, policy: { preset: 'important', voice: true } },
                    isSessionOwner: false,
                    capabilities: { manageFollow: true },
                    voiceInitialSnapshotPending: false,
                },
                draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
            }}
            voiceReadiness="eligible" archived onSet={() => {}} onRemove={onRemove} onRetry={() => {}} onOpenNotificationSettings={() => {}} onEditPolicy={() => {}}
        />);
        // Unfollow is the body's last row now, not a footer button: it stays pressable while archived.
        await act(async () => { screen.findByTestId('session-follow-unfollow')?.props.onPress(); });
        expect(onRemove).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('session-follow-voice')?.props.disabled).toBe(true);
        expect(presetSegment(screen, 'important')?.props.disabled).toBe(true);
        await screen.unmount();
    });

    it('does not allow a non-owner to start following an archived Session', async () => {
        const onSet = vi.fn();
        const screen = await renderSettingsView(<AccountSessionFollowEditor
            state={{
                projection: {
                    follow: null,
                    isSessionOwner: false,
                    capabilities: { manageFollow: true },
                    voiceInitialSnapshotPending: false,
                },
                draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
            }}
            voiceReadiness="eligible"
            archived
            onSet={onSet}
            onRemove={() => {}}
            onRetry={() => {}}
            onOpenNotificationSettings={() => {}} onEditPolicy={() => {}}
        />);

        const follow = screen.findByTestId('session-follow-follow');
        expect(follow?.props.disabled).toBe(true);
        await act(async () => { follow?.props.onPress(); });
        expect(onSet).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('does not expose an enabled mutation control when the Home denies Follow management', async () => {
        const screen = await renderSettingsView(<AccountSessionFollowEditor
            state={{
                projection: {
                    follow: { sessionId: 'session-a', following: true, notificationLevel: 'important', includeInVoice: false, policy: { preset: 'important' } },
                    isSessionOwner: false,
                    capabilities: { manageFollow: false },
                    voiceInitialSnapshotPending: false,
                },
                draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
            }}
            voiceReadiness="eligible" archived={false} onSet={() => {}} onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}} onEditPolicy={() => {}}
        />);
        expect(screen.findByTestId('session-follow-unfollow')?.props.disabled).toBe(true);
        expect(presetSegment(screen, 'important')?.props.disabled).toBe(true);
        await screen.unmount();
    });

    it('renders the readiness selected by the canonical Voice runtime projection', async () => {
        const state = {
            projection: {
                follow: { sessionId: 'session-a', following: true, notificationLevel: 'important' as const, includeInVoice: true, policy: { preset: 'important' as const, voice: true } },
                isSessionOwner: false,
                capabilities: { manageFollow: true },
                voiceInitialSnapshotPending: false,
            },
            draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
        };
        const screen = await renderSettingsView(<AccountSessionFollowEditor
            state={state}
            voiceReadiness="waiting_encrypted"
            archived={false} onSet={() => {}} onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}} onEditPolicy={() => {}}
        />);
        expect(screen.getTextContent()).toContain(t('session.follow.voice.waitingEncrypted'));
        await screen.unmount();
    });

    it('describes eligible Voice inclusion as Voice context rather than generic Account following', async () => {
        const screen = await renderSettingsView(<AccountSessionFollowEditor
            state={{
                projection: {
                    follow: { sessionId: 'session-a', following: true, notificationLevel: 'important', includeInVoice: true, policy: { preset: 'important', voice: true } },
                    isSessionOwner: false,
                    capabilities: { manageFollow: true },
                    voiceInitialSnapshotPending: false,
                },
                draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
            }}
            voiceReadiness="eligible"
            archived={false} onSet={() => {}} onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}} onEditPolicy={() => {}}
        />);
        expect(screen.getTextContent()).toContain(t('session.follow.voice.subtitle'));
        await screen.unmount();
    });

    it('states nominal Voice delivery once instead of repeating the row subtitle beneath itself', async () => {
        const screen = await renderSettingsView(<AccountSessionFollowEditor
            state={{
                projection: {
                    follow: { sessionId: 'session-a', following: true, notificationLevel: 'important', includeInVoice: true, policy: { preset: 'important', voice: true } },
                    isSessionOwner: false,
                    capabilities: { manageFollow: true },
                    voiceInitialSnapshotPending: false,
                },
                draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
            }}
            voiceReadiness="eligible"
            archived={false} onSet={() => {}} onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}} onEditPolicy={() => {}}
        />);
        // The row subtitle already says what Voice inclusion does. A status row is
        // only worth its vertical space when it reports something the subtitle does
        // not, so the nominal case must not print the same sentence twice in a row.
        const subtitle = t('session.follow.voice.subtitle');
        const occurrences = screen.getTextContent().split(subtitle).length - 1;
        expect(occurrences).toBe(1);
        expect(screen.findByTestId('session-follow-voice-delivery')).toBeNull();
        await screen.unmount();
    });

    it('explains provider withholding without turning off Voice inclusion', async () => {
        const screen = await renderSettingsView(<AccountSessionFollowEditor
            state={{
                projection: {
                    follow: { sessionId: 'session-a', following: true, notificationLevel: 'important', includeInVoice: true, policy: { preset: 'important', voice: true } },
                    isSessionOwner: false,
                    capabilities: { manageFollow: true },
                    voiceInitialSnapshotPending: false,
                },
                draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
            }}
            voiceReadiness="provider_withheld"
            archived={false} onSet={() => {}} onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}} onEditPolicy={() => {}}
        />);
        expect(screen.findByTestId('session-follow-voice')?.props.value).toBe(true);
        expect(screen.getTextContent()).toContain(t('session.follow.voice.providerWithheld'));
        await screen.unmount();
    });

    it('explains that a followed external Session with Background sync off may only update while attached', async () => {
        const state = {
            projection: {
                follow: { sessionId: 'session-a', following: true, notificationLevel: 'important' as const, includeInVoice: false, policy: { preset: 'important' as const } },
                isSessionOwner: false,
                capabilities: { manageFollow: true },
                voiceInitialSnapshotPending: false,
            },
            draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
        };
        const quiet = await renderSettingsView(<AccountSessionFollowEditor
            state={state}
            voiceReadiness="eligible"
            archived={false} onSet={() => {}} onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}} onEditPolicy={() => {}}
        />);
        // A Session whose Background sync is on promises nothing extra, so the
        // explanation must not appear there.
        expect(quiet.findByTestId('session-follow-external-attached-only')).toBeNull();
        await quiet.unmount();

        const screen = await renderSettingsView(<AccountSessionFollowEditor
            state={state}
            voiceReadiness="eligible"
            externalBackgroundSyncOff
            archived={false} onSet={() => {}} onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}} onEditPolicy={() => {}}
        />);
        expect(screen.findByTestId('session-follow-external-attached-only')).not.toBeNull();
        expect(screen.getTextContent()).toContain(t('session.follow.editor.externalAttachedOnly'));
        // It explains a consequence of the external source's acquisition; it is
        // not a second Follow control and changes nothing the person chose.
        expect(screen.findByTestId('session-follow-unfollow')).not.toBeNull();
        expect(presetSegment(screen, 'important')?.props.checked).toBe(true);
        await screen.unmount();
    });

    it('chooses how much you hear with the one shared Follow policy editor, not the old level form (C1 §4.3, lab P2)', async () => {
        const onEditPolicy = vi.fn();
        const state = {
            projection: { follow: { sessionId: 'session-a', following: true, notificationLevel: 'important', includeInVoice: false, policy: { preset: 'important' } }, isSessionOwner: false, capabilities: { manageFollow: true }, voiceInitialSnapshotPending: false },
            draft: null, policyDraft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
        } as unknown as AccountSessionFollowEditorSnapshot;
        const screen = await renderSettingsView(
            <ListPresentationProvider value="page">
                <AccountSessionFollowEditor state={state} onEditPolicy={onEditPolicy} voiceReadiness="eligible" archived={false} onSet={() => {}}
                    onRemove={() => {}} onRetry={() => {}} onOpenNotificationSettings={() => {}} />
            </ListPresentationProvider>,
        );
        expect(screen.findByTestId('session-follow-level')).toBeNull();
        expect(screen.findByTestId('session-follow-policy')).not.toBeNull();
        // Important groups what interrupts you apart from what arrives quietly.
        expect(screen.findByTestId('session-follow-policy.group.interrupt')).not.toBeNull();
        const everything = screen.tree.root.find((node) => node.props.testID === 'session-follow-policy.preset.everything'
            && typeof node.props.onPress === 'function');
        await act(async () => { everything.props.onPress(); });
        expect(onEditPolicy).toHaveBeenCalledWith({ kind: 'preset', preset: 'everything' });
        await screen.unmount();
    });
    it('hands its host the parts: what following does and where it arrives, Turn off beside Done, and who else follows it', async () => {
        const onClose = vi.fn();
        const onOpenPeople = vi.fn();
        let parts: AccountSessionFollowEditorParts | null = null;
        const screen = await renderSettingsView(<AccountSessionFollowEditor
            state={{
                projection: {
                    follow: { sessionId: 'session-a', following: true, notificationLevel: 'important', includeInVoice: false, policy: { preset: 'important' } },
                    isSessionOwner: false, capabilities: { manageFollow: true }, voiceInitialSnapshotPending: false,
                },
                draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
            }}
            voiceReadiness="eligible" archived={false} onSet={() => {}} onRemove={() => {}} onRetry={() => {}}
            onOpenNotificationSettings={() => {}} onEditPolicy={() => {}}
            onClose={onClose}
            alsoFollowing={{ people: 3, sessions: 2 }} onOpenPeople={onOpenPeople} quietHours="22:00–07:00"
            frame={(next) => { parts = next; return <>{next.body}{next.footer}</>; }}
        />);
        // The header says what following does, and its one sentence says where the updates arrive.
        expect(parts!.title).toBe(t('session.follow.editor.panelTitle'));
        expect(parts!.subtitle).toBe(t('session.follow.editor.panelSubtitle'));
        // Leaving and closing share the one footer row: Turn off at the start, Done at the end.
        const footer = await renderSettingsView(<>{parts!.footer}</>);
        expect(footer.findByTestId('session-follow-unfollow')).not.toBeNull();
        expect(footer.findByTestId('session-follow-done')).not.toBeNull();
        await footer.unmount();
        expect(screen.getTextContent()).toContain(t('session.follow.editor.quietHours', { range: '22:00–07:00' }));
        await act(async () => { screen.findByTestId('session-follow-people')?.props.onPress(); });
        expect(onOpenPeople).toHaveBeenCalledTimes(1);
        await act(async () => { screen.findByTestId('session-follow-done')?.props.onPress(); });
        expect(onClose).toHaveBeenCalledTimes(1);
        await screen.unmount();
    });

    it('claims no one else follows it while the census is unknown or empty', async () => {
        const state = {
            projection: {
                follow: { sessionId: 'session-a', following: true, notificationLevel: 'important' as const, includeInVoice: false, policy: { preset: 'important' as const } },
                isSessionOwner: false, capabilities: { manageFollow: true }, voiceInitialSnapshotPending: false,
            },
            draft: null, loading: false, saving: false, online: true, error: null, voiceInitialSnapshotPending: false,
        };
        for (const alsoFollowing of [null, { people: 0, sessions: 0 }]) {
            const screen = await renderSettingsView(<AccountSessionFollowEditor state={state}
                voiceReadiness="eligible" archived={false} onSet={() => {}} onRemove={() => {}} onRetry={() => {}}
                onOpenNotificationSettings={() => {}} onEditPolicy={() => {}} alsoFollowing={alsoFollowing} onOpenPeople={() => {}} />);
            expect(screen.findByTestId('session-follow-people')).toBeNull();
            await screen.unmount();
        }
    });
});
