import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ConnectedServicesProfileOptionsByServiceId } from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import type { SelectionListProps } from '@/components/ui/selectionList';
import { renderScreen } from '@/dev/testkit';

import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const capturedSelectionLists = vi.hoisted(() => [] as SelectionListProps[]);
// The real hook returns a `React.useMemo` result, so it keeps its identity while
// its inputs do; a mock minting a fresh object per render would fake churn the
// production boundary never produces.
const EMPTY_QUOTA_BADGES = vi.hoisted(() => ({} as Record<string, Array<{ meterId: string; text: string }>>));

installNewSessionComponentsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Platform: { OS: 'ios' } });
    },
    icons: () => ({
        Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/components/ui/selectionList', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/ui/selectionList')>();
    return {
        ...actual,
        SelectionList: (props: SelectionListProps) => {
            capturedSelectionLists.push(props);
            return React.createElement('SelectionList', { testID: props.testID });
        },
    };
});

vi.mock('@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName', () => ({
    resolveConnectedServiceDisplayName: (id: string) => id,
}));

vi.mock('@/components/settings/connectedServices/ConnectedServiceQuotaBadgesView', () => ({
    ConnectedServiceQuotaBadgesView: (props: Record<string, unknown>) =>
        React.createElement('ConnectedServiceQuotaBadgesView', props),
}));

vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: React.ReactNode) => node,
}));

vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaBadges', () => ({
    useConnectedServiceQuotaBadges: () => EMPTY_QUOTA_BADGES,
}));

/**
 * The popover / modal hosts build this content through a render callback that
 * the hosting surface re-invokes with a freshly created element on every render
 * while it is open (the popover hosts at minimum once more when the measured
 * placement lands). `useSessionConnectedServicesAuthSwitch` closes each handler
 * over the per-invocation `requestClose`, so those props genuinely cannot be
 * hoisted and arrive with new identities on every one of those passes.
 */
const STABLE_SERVICE_IDS = ['anthropic'] as const;
const STABLE_PROFILE_OPTIONS: ConnectedServicesProfileOptionsByServiceId = {
    anthropic: [
        { profileId: 'work', label: 'Work', providerEmail: 'work@example.com', kind: 'token', status: 'connected' },
        { profileId: 'stale', label: 'Stale', providerEmail: 'stale@example.com', kind: 'oauth', status: 'needs_reauth' },
    ],
};
const STABLE_GROUP_OPTIONS = {};
const STABLE_BINDINGS: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>> = {};
const STABLE_AVAILABILITY = () => ({});

type ChurningHandlers = Readonly<{
    bindingSpy: ReturnType<typeof vi.fn>;
    settingsSpy: ReturnType<typeof vi.fn>;
    reconnectSpy: ReturnType<typeof vi.fn>;
    setBindingForService: (serviceId: string, binding: ConnectedServicesServiceBinding) => void;
    onOpenSettings: (serviceId: string) => void;
    onReconnectProfile: (serviceId: string, profileId: string) => void;
}>;

function makeChurningHandlers(): ChurningHandlers {
    const bindingSpy = vi.fn();
    const settingsSpy = vi.fn();
    const reconnectSpy = vi.fn();
    return {
        bindingSpy,
        settingsSpy,
        reconnectSpy,
        setBindingForService: (serviceId, binding) => bindingSpy(serviceId, binding),
        onOpenSettings: (serviceId) => settingsSpy(serviceId),
        onReconnectProfile: (serviceId, profileId) => reconnectSpy(serviceId, profileId),
    };
}

function findStaticOption(props: SelectionListProps, idFragment: string) {
    const section = props.rootStep.sections[0];
    if (!section || section.kind !== 'static') throw new Error('Expected a static connected-services section');
    const option = section.options.find((candidate) => candidate.id.includes(idFragment));
    if (!option) throw new Error(`Expected an option matching ${idFragment}`);
    return option;
}

describe('NewSessionConnectedServicesSelectionContent model stability', () => {
    async function buildElement(
        handlers: ChurningHandlers,
        bindings: Readonly<Record<string, ConnectedServicesServiceBinding | undefined>>,
        withReconnect = true,
    ) {
        const { NewSessionConnectedServicesSelectionContent } = await import('./NewSessionConnectedServicesSelectionContent');
        return (
            <NewSessionConnectedServicesSelectionContent
                supportedServiceIds={STABLE_SERVICE_IDS}
                profileOptionsByServiceId={STABLE_PROFILE_OPTIONS}
                groupOptionsByServiceId={STABLE_GROUP_OPTIONS}
                bindingsByServiceId={bindings}
                setBindingForService={handlers.setBindingForService}
                onOpenSettings={handlers.onOpenSettings}
                {...(withReconnect ? { onReconnectProfile: handlers.onReconnectProfile } : {})}
                resolveOptionAvailability={STABLE_AVAILABILITY}
                maxHeight={420}
            />
        );
    }

    it('reuses the built step tree when only the caller handler identities change', async () => {
        capturedSelectionLists.length = 0;
        const rendered = await renderScreen(await buildElement(makeChurningHandlers(), STABLE_BINDINGS));
        await rendered.update(await buildElement(makeChurningHandlers(), STABLE_BINDINGS));

        expect(capturedSelectionLists.length).toBeGreaterThanOrEqual(2);
        const first = capturedSelectionLists[0]!;
        const last = capturedSelectionLists[capturedSelectionLists.length - 1]!;

        // Handlers are behaviour, not data: recreating them must not rebuild the
        // step tree, because every option's `icon` / `rightAccessory` element
        // loses referential identity when it does, and React can then no longer
        // skip those row subtrees while the popover re-renders.
        expect(last.rootStep).toBe(first.rootStep);
        expect(last.rootStep.sections).toBe(first.rootStep.sections);
        expect(findStaticOption(last, ':profile:')).toBe(findStaticOption(first, ':profile:'));
        expect(findStaticOption(last, ':reauth:').rightAccessory)
            .toBe(findStaticOption(first, ':reauth:').rightAccessory);

        await rendered.unmount();
    });

    it('activates the LATEST handlers after the caller replaced them', async () => {
        capturedSelectionLists.length = 0;
        const initial = makeChurningHandlers();
        const rendered = await renderScreen(await buildElement(initial, STABLE_BINDINGS));
        const next = makeChurningHandlers();
        await rendered.update(await buildElement(next, STABLE_BINDINGS));

        const last = capturedSelectionLists[capturedSelectionLists.length - 1]!;
        await React.act(async () => {
            findStaticOption(last, ':profile:').onSelect?.();
            findStaticOption(last, ':reauth:').onSelect?.();
        });

        expect(next.bindingSpy).toHaveBeenCalledTimes(1);
        expect(next.reconnectSpy).toHaveBeenCalledWith('anthropic', 'stale');
        expect(initial.bindingSpy).not.toHaveBeenCalled();
        expect(initial.reconnectSpy).not.toHaveBeenCalled();

        await rendered.unmount();
    });

    it('rebuilds the step tree when the binding data actually changes', async () => {
        capturedSelectionLists.length = 0;
        const handlers = makeChurningHandlers();
        const rendered = await renderScreen(await buildElement(handlers, STABLE_BINDINGS));
        const before = capturedSelectionLists[capturedSelectionLists.length - 1]!.rootStep;

        await rendered.update(await buildElement(handlers, {
            anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
        }));
        const after = capturedSelectionLists[capturedSelectionLists.length - 1]!;

        expect(after.rootStep).not.toBe(before);
        expect(after.selectedOptionId).toBe('connected-service:anthropic:profile:work');

        await rendered.unmount();
    });

    it('drops the reconnect route when the caller stops supplying a reconnect handler', async () => {
        capturedSelectionLists.length = 0;
        const handlers = makeChurningHandlers();
        const rendered = await renderScreen(await buildElement(handlers, STABLE_BINDINGS));
        await rendered.update(await buildElement(handlers, STABLE_BINDINGS, false));

        const last = capturedSelectionLists[capturedSelectionLists.length - 1]!;
        await React.act(async () => {
            findStaticOption(last, ':reauth:').onSelect?.();
        });

        // Presence, unlike identity, is a real render input: with no reconnect
        // handler the reauth row must fall back to the settings route.
        expect(handlers.reconnectSpy).not.toHaveBeenCalled();
        expect(handlers.settingsSpy).toHaveBeenCalledWith('anthropic');

        await rendered.unmount();
    });
});
