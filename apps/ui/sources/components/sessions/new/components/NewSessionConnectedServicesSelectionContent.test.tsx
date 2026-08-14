import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ConnectedServicesProfileOptionsByServiceId } from '@/components/sessions/new/modules/connectedServicesNewSessionBindings';
import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';
import type { SelectionListProps } from '@/components/ui/selectionList';
import { activateSelectionListRow } from '@/components/ui/selectionList/SelectionListRowActivation';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createPassThroughComponent } from '@/dev/testkit/mocks/components';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const capturedSelectionLists: SelectionListProps[] = [];

vi.mock('react-native', () => createReactNativeWebMock({
    View: createPassThroughComponent('View'),
    Platform: {
        OS: 'ios',
        select: (options: any) => options.ios ?? options.native ?? options.default,
    },
}));

vi.mock('react-native-unistyles', () => createUnistylesMock());
vi.mock('@expo/vector-icons', () => ({
    Ionicons: createPassThroughComponent('Ionicons'),
}));
vi.mock('@/text', () => createTextModuleMock({ translate: (key) => key }));
// The real hook returns a `React.useMemo` result, so it keeps its identity while
// its inputs do; a mock minting a fresh object per render would fake churn the
// production boundary never produces.
const EMPTY_QUOTA_BADGES: Record<string, Array<{ meterId: string; text: string }>> = {};
vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaBadges', () => ({
    useConnectedServiceQuotaBadges: () => EMPTY_QUOTA_BADGES,
}));
vi.mock('@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName', () => ({
    resolveConnectedServiceDisplayName: (serviceId: string) => serviceId,
}));
vi.mock('@/components/settings/connectedServices/ConnectedServiceQuotaBadgesView', () => ({
    ConnectedServiceQuotaBadgesView: createPassThroughComponent('ConnectedServiceQuotaBadgesView'),
}));
vi.mock('@/components/ui/rendering/normalizeNodeForView', () => ({
    normalizeNodeForView: (node: React.ReactNode) => node,
}));
vi.mock('@/components/ui/selectionList', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/ui/selectionList')>();
    return {
        ...actual,
        StatusPill: createPassThroughComponent('StatusPill'),
        SelectionList: (props: SelectionListProps) => {
            capturedSelectionLists.push(props);
            return React.createElement('SelectionList', { testID: props.testID });
        },
    };
});

describe('NewSessionConnectedServicesSelectionContent', () => {
    it('uses measured native height for connected-services auth content under the computed popover cap', async () => {
        const { NewSessionConnectedServicesSelectionContent } = await import('./NewSessionConnectedServicesSelectionContent');

        capturedSelectionLists.length = 0;
        await renderScreen(
            <NewSessionConnectedServicesSelectionContent
                supportedServiceIds={[]}
                profileOptionsByServiceId={{}}
                bindingsByServiceId={{}}
                setBindingForService={() => {}}
                onOpenSettings={() => {}}
                maxHeight={420}
            />,
        );

        expect(capturedSelectionLists).toHaveLength(1);
        expect(capturedSelectionLists[0]?.heightBehavior).toBe('measuredToMaxHeight');
    });

    it('closes the connected-services popover after selecting a profile option', async () => {
        const { NewSessionConnectedServicesSelectionContent } = await import('./NewSessionConnectedServicesSelectionContent');

        capturedSelectionLists.length = 0;
        const requestClose = vi.fn();
        const setBindingForService = vi.fn();
        await renderScreen(
            <NewSessionConnectedServicesSelectionContent
                supportedServiceIds={['anthropic']}
                profileOptionsByServiceId={{
                    anthropic: [{
                        profileId: 'work',
                        label: 'Work',
                        providerEmail: 'work@example.com',
                        kind: 'token',
                        status: 'connected',
                    }],
                }}
                bindingsByServiceId={{}}
                setBindingForService={setBindingForService}
                onOpenSettings={() => {}}
                maxHeight={420}
                requestClose={requestClose}
            />,
        );

        expect(capturedSelectionLists).toHaveLength(1);
        const selectionList = capturedSelectionLists[0]!;
        const staticSection = selectionList.rootStep.sections[0];
        if (!staticSection || staticSection.kind !== 'static') {
            throw new Error('Expected a static connected-services section');
        }
        const profileOption = staticSection.options.find((option) => option.id.includes(':profile:'));
        if (!profileOption) {
            throw new Error('Expected a connected profile option');
        }

        await React.act(async () => {
            activateSelectionListRow({
                option: profileOption,
                onSelect: selectionList.onSelect,
                onPushStep: vi.fn(),
            });
        });

        expect(setBindingForService).toHaveBeenCalledWith('anthropic', {
            source: 'connected',
            selection: 'profile',
            profileId: 'work',
        });
        expect(requestClose).toHaveBeenCalledTimes(1);
    });
});

/**
 * The popover hosts build this content through
 * `renderContent({ requestClose, maxHeight })`, which the floating overlay
 * re-invokes with a freshly created element on every render while the popover
 * is open (at minimum once more when the measured placement lands). Two of the
 * three hosts cannot hoist their handlers — `useSessionConnectedServicesAuthSwitch`
 * closes each one over the per-invocation `requestClose` — so the handler props
 * arrive with new identities on every one of those passes.
 */
const STABLE_SERVICE_IDS = ['anthropic'] as const;
const STABLE_PROFILE_OPTIONS: ConnectedServicesProfileOptionsByServiceId = {
    anthropic: [
        { profileId: 'work', label: 'Work', providerEmail: 'work@example.com', kind: 'token', status: 'connected' },
        { profileId: 'stale', label: 'Stale', providerEmail: 'stale@example.com', kind: 'oauth', status: 'needs_reauth' },
    ],
};
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
    async function renderWithHandlers(handlers: ChurningHandlers, bindings = STABLE_BINDINGS) {
        const { NewSessionConnectedServicesSelectionContent } = await import('./NewSessionConnectedServicesSelectionContent');
        return renderScreen(
            <NewSessionConnectedServicesSelectionContent
                supportedServiceIds={STABLE_SERVICE_IDS}
                profileOptionsByServiceId={STABLE_PROFILE_OPTIONS}
                bindingsByServiceId={bindings}
                setBindingForService={handlers.setBindingForService}
                onOpenSettings={handlers.onOpenSettings}
                onReconnectProfile={handlers.onReconnectProfile}
                resolveOptionAvailability={STABLE_AVAILABILITY}
                maxHeight={420}
            />,
        );
    }

    async function updateHandlers(
        rendered: Awaited<ReturnType<typeof renderWithHandlers>>,
        handlers: ChurningHandlers,
        bindings = STABLE_BINDINGS,
    ) {
        const { NewSessionConnectedServicesSelectionContent } = await import('./NewSessionConnectedServicesSelectionContent');
        await rendered.update(
            <NewSessionConnectedServicesSelectionContent
                supportedServiceIds={STABLE_SERVICE_IDS}
                profileOptionsByServiceId={STABLE_PROFILE_OPTIONS}
                bindingsByServiceId={bindings}
                setBindingForService={handlers.setBindingForService}
                onOpenSettings={handlers.onOpenSettings}
                onReconnectProfile={handlers.onReconnectProfile}
                resolveOptionAvailability={STABLE_AVAILABILITY}
                maxHeight={420}
            />,
        );
    }

    it('reuses the built step tree when only the caller handler identities change', async () => {
        capturedSelectionLists.length = 0;
        const rendered = await renderWithHandlers(makeChurningHandlers());
        await updateHandlers(rendered, makeChurningHandlers());

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
        const rendered = await renderWithHandlers(initial);
        const next = makeChurningHandlers();
        await updateHandlers(rendered, next);

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
        const rendered = await renderWithHandlers(handlers);
        const before = capturedSelectionLists[capturedSelectionLists.length - 1]!.rootStep;

        await updateHandlers(rendered, handlers, {
            anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
        });
        const after = capturedSelectionLists[capturedSelectionLists.length - 1]!;

        expect(after.rootStep).not.toBe(before);
        expect(after.selectedOptionId).toBe('connected-service:anthropic:profile:work');

        await rendered.unmount();
    });

    it('drops the reconnect route when the caller stops supplying a reconnect handler', async () => {
        const { NewSessionConnectedServicesSelectionContent } = await import('./NewSessionConnectedServicesSelectionContent');
        capturedSelectionLists.length = 0;
        const handlers = makeChurningHandlers();
        const rendered = await renderWithHandlers(handlers);

        await rendered.update(
            <NewSessionConnectedServicesSelectionContent
                supportedServiceIds={STABLE_SERVICE_IDS}
                profileOptionsByServiceId={STABLE_PROFILE_OPTIONS}
                bindingsByServiceId={STABLE_BINDINGS}
                setBindingForService={handlers.setBindingForService}
                onOpenSettings={handlers.onOpenSettings}
                resolveOptionAvailability={STABLE_AVAILABILITY}
                maxHeight={420}
            />,
        );

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
