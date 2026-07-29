import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installConnectedServicesCommonModuleMocks } from './connectedServicesTestHelpers';
import { AGENTS_CORE } from '@happier-dev/agents';
import type { ConnectedServiceId, ConnectedServicesDefaultAuthByAgentIdV1 } from '@happier-dev/protocol';
import type { ConnectedServicesServiceBinding } from '@/sync/domains/connectedServices/connectedServicesAgentOptionStateBindings';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type CapturedDefaultAuthModalProps = Readonly<{
    setBindingForService: (serviceId: string, binding: ConnectedServicesServiceBinding) => void;
}> & Record<string, unknown>;

type CapturedDefaultAuthModalConfig = Readonly<{
    component: React.ComponentType<CapturedDefaultAuthModalProps>;
    props: CapturedDefaultAuthModalProps;
}>;

const modalShowMock = vi.fn((_config: CapturedDefaultAuthModalConfig) => 'default-auth-modal');
const modalUpdateMock = vi.fn((_modalId: string, _props: Record<string, unknown>) => {});

installConnectedServicesCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: (config: unknown) => modalShowMock(config as CapturedDefaultAuthModalConfig),
                update: (modalId: string, props: Record<string, unknown>) => modalUpdateMock(modalId, props),
            },
        }).module;
    },
});

vi.mock('@/hooks/server/connectedServices/useConnectedServiceQuotaBadges', () => ({
    useConnectedServiceQuotaBadges: () => ({}),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

const narrowLayoutRef = vi.hoisted(() => ({ value: false }));
vi.mock('@/components/settings/actions/useActionSettingsNarrowLayout', () => ({
    useActionSettingsNarrowLayout: () => narrowLayoutRef.value,
}));

type SelectionListProps = Readonly<{
    selectedOptionId: string | null;
    rootStep: {
        sections: ReadonlyArray<{
            options: ReadonlyArray<{
                id: string;
                onSelect: () => void;
            }>;
        }>;
    };
}>;

function findSelectionListProps(tree: renderer.ReactTestRenderer): SelectionListProps {
    return tree.root.findByProps({
        testID: 'new-session.connected-services.selection-list',
    }).props as SelectionListProps;
}

function findSelectionOption(tree: renderer.ReactTestRenderer, optionId: string): { onSelect: () => void } {
    const listProps = findSelectionListProps(tree);
    for (const section of listProps.rootStep.sections) {
        const option = section.options.find((candidate) => candidate.id === optionId);
        if (option) return option;
    }
    throw new Error(`Selection option not found: ${optionId}`);
}

function getShownModalConfig(index: number): CapturedDefaultAuthModalConfig {
    const config = modalShowMock.mock.calls[index]?.[0];
    if (!config) {
        throw new Error(`Expected shown modal at index ${index}`);
    }
    return config;
}

function findDefaultAuthTrigger(tree: renderer.ReactTestRenderer, agentId: string): Record<string, any> {
    const node = tree.root.findAll((candidate) =>
        candidate.props?.testID === `settings-connected-services-default-auth-${agentId}`
    )[0];
    if (!node) {
        throw new Error(`Expected default auth trigger for ${agentId}`);
    }
    return node.props as Record<string, any>;
}

async function openPickerModal(
    tree: renderer.ReactTestRenderer,
    agentId: string,
    modalIndex = 0,
): Promise<renderer.ReactTestRenderer> {
    await act(async () => {
        findDefaultAuthTrigger(tree, agentId).onPress();
    });
    const config = getShownModalConfig(modalIndex);
    const Content = config.component;
    return (await renderScreen(<Content {...config.props} />)).tree;
}

function findPoolSuggestion(
    tree: renderer.ReactTestRenderer,
    agentId: string,
    serviceId: string,
): { accept: () => void; dismiss: () => void } {
    const prefix = `settings-connected-services-pool-adoption-suggestion-${agentId}-${serviceId}`;
    const acceptNode = tree.root.findAll((candidate) => candidate.props?.testID === `${prefix}-accept`)[0];
    const dismissNode = tree.root.findAll((candidate) => candidate.props?.testID === `${prefix}-dismiss`)[0];
    if (!acceptNode || !dismissNode) {
        throw new Error(`Expected pool adoption suggestion for ${agentId}/${serviceId}`);
    }
    return {
        accept: () => acceptNode.props.onPress(),
        dismiss: () => dismissNode.props.onPress(),
    };
}

function hasPoolSuggestion(
    tree: renderer.ReactTestRenderer,
    agentId: string,
    serviceId: string,
): boolean {
    const prefix = `settings-connected-services-pool-adoption-suggestion-${agentId}-${serviceId}`;
    return tree.root.findAll((candidate) => candidate.props?.testID === `${prefix}-accept`).length > 0;
}

describe('ConnectedServicesDefaultAuthRow', () => {
    beforeEach(() => {
        modalShowMock.mockClear();
        modalUpdateMock.mockClear();
        narrowLayoutRef.value = false;
    });

    async function renderClaudeNativeRow() {
        const { ConnectedServicesDefaultAuthRow } = await import('./ConnectedServicesDefaultAuthRow');
        return (await renderScreen(
            <ConnectedServicesDefaultAuthRow
                agentId="claude"
                agentTitle="Claude"
                agentCore={{ connectedServices: { supportedServiceIds: ['anthropic' as ConnectedServiceId] } }}
                accountGroupsEnabled={false}
                accountProfileConnectedServicesV2={[{
                    serviceId: 'anthropic' as ConnectedServiceId,
                    profiles: [{ profileId: 'work', status: 'connected', kind: 'token', providerEmail: 'work@example.com' }],
                }]}
                settings={{
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                }}
                setDefaultAuthSettings={vi.fn()}
                onOpenConnectedServicesSettings={vi.fn()}
            />,
        )).tree;
    }

    it('on a compact layout shows the selected value in the subtitle and hides the right detail', async () => {
        narrowLayoutRef.value = true;
        const tree = await renderClaudeNativeRow();
        const trigger = findDefaultAuthTrigger(tree, 'claude');
        // Compact: the (long) selected value moves to the subtitle; the right detail
        // is suppressed so it doesn't crowd the title.
        expect(trigger.detail).toBeUndefined();
        expect(trigger.subtitle).toBe('connectedServices.authChip.nativeLabel');
    });

    it('on a wide layout keeps the selected value in the right detail, not the subtitle', async () => {
        narrowLayoutRef.value = false;
        const tree = await renderClaudeNativeRow();
        const trigger = findDefaultAuthTrigger(tree, 'claude');
        expect(trigger.detail).toBe('connectedServices.authChip.nativeLabel');
        expect(trigger.subtitle).toBe('connectedServices.defaultAuth.rowDetail');
    });

    it('opens the canonical searchable SelectionList via Modal.show and writes the per-agent default binding', async () => {
        const { ConnectedServicesDefaultAuthRow } = await import('./ConnectedServicesDefaultAuthRow');
        const setDefaultAuthSettings = vi.fn();

        const { tree } = await renderScreen(
            <ConnectedServicesDefaultAuthRow
                agentId="claude"
                agentTitle="Claude"
                agentCore={{ connectedServices: { supportedServiceIds: ['anthropic' as ConnectedServiceId] } }}
                accountGroupsEnabled={false}
                accountProfileConnectedServicesV2={[
                    {
                        serviceId: 'anthropic' as ConnectedServiceId,
                        profiles: [
                            { profileId: 'work', status: 'connected', kind: 'token', providerEmail: 'work@example.com' },
                        ],
                    },
                ]}
                settings={{
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                }}
                setDefaultAuthSettings={setDefaultAuthSettings}
                onOpenConnectedServicesSettings={vi.fn()}
            />,
        );

        expect(findDefaultAuthTrigger(tree, 'claude').title).toBe('Claude');
        expect(modalShowMock).not.toHaveBeenCalled();

        const modalTree = await openPickerModal(tree, 'claude');
        expect(modalShowMock).toHaveBeenCalledTimes(1);
        expect(findSelectionListProps(modalTree).selectedOptionId).toBe('connected-service:anthropic:native');

        await act(async () => {
            findSelectionOption(modalTree, 'connected-service:anthropic:profile:work').onSelect();
        });

        expect(setDefaultAuthSettings).toHaveBeenCalledWith({
            v: 1,
            bindingsByAgentId: {
                claude: {
                    v: 1,
                    bindingsByServiceId: {
                        anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
                    },
                },
            },
        });
    });

    it('closes the picker before navigating to connected-service settings', async () => {
        const { ConnectedServicesDefaultAuthRow } = await import('./ConnectedServicesDefaultAuthRow');
        const onOpenConnectedServicesSettings = vi.fn();

        const { tree } = await renderScreen(
            <ConnectedServicesDefaultAuthRow
                agentId="claude"
                agentTitle="Claude"
                agentCore={{ connectedServices: { supportedServiceIds: ['anthropic' as ConnectedServiceId] } }}
                accountGroupsEnabled={false}
                accountProfileConnectedServicesV2={[]}
                settings={{
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                }}
                setDefaultAuthSettings={vi.fn()}
                onOpenConnectedServicesSettings={onOpenConnectedServicesSettings}
            />,
        );

        await act(async () => {
            findDefaultAuthTrigger(tree, 'claude').onPress();
        });
        const config = getShownModalConfig(0);
        const onClose = vi.fn();
        const Content = config.component as React.ComponentType<Record<string, unknown>>;
        const modalTree = (await renderScreen(
            <Content {...config.props} onClose={onClose} />,
        )).tree;

        await act(async () => {
            findSelectionOption(modalTree, 'connected-service:anthropic:connect').onSelect();
        });

        expect(onClose).toHaveBeenCalledOnce();
        expect(onOpenConnectedServicesSettings).toHaveBeenCalledWith('anthropic');
        expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(
            onOpenConnectedServicesSettings.mock.invocationCallOrder[0]!,
        );
    });

    it('reflects the persisted binding as the selected option in the picker list', async () => {
        const { ConnectedServicesDefaultAuthRow } = await import('./ConnectedServicesDefaultAuthRow');

        const { tree } = await renderScreen(
            <ConnectedServicesDefaultAuthRow
                agentId="claude"
                agentTitle="Claude"
                agentCore={{ connectedServices: { supportedServiceIds: ['anthropic' as ConnectedServiceId] } }}
                accountGroupsEnabled={false}
                accountProfileConnectedServicesV2={[
                    {
                        serviceId: 'anthropic' as ConnectedServiceId,
                        profiles: [
                            { profileId: 'work', status: 'connected', kind: 'token', providerEmail: 'work@example.com' },
                        ],
                    },
                ]}
                settings={{
                    connectedServicesProfileLabelByKey: { 'anthropic/work': 'Work' },
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: {
                        v: 1,
                        bindingsByAgentId: {
                            claude: {
                                v: 1,
                                bindingsByServiceId: {
                                    anthropic: { source: 'connected', selection: 'profile', profileId: 'work' },
                                },
                            },
                        },
                    },
                }}
                setDefaultAuthSettings={vi.fn()}
                onOpenConnectedServicesSettings={vi.fn()}
            />,
        );

        const modalTree = await openPickerModal(tree, 'claude');
        expect(findSelectionListProps(modalTree).selectedOptionId).toBe('connected-service:anthropic:profile:work');
        expect(modalUpdateMock).not.toHaveBeenCalled();
    });

    it('stores group defaults as group bindings without a fallback profile id', async () => {
        const { ConnectedServicesDefaultAuthRow } = await import('./ConnectedServicesDefaultAuthRow');
        const setDefaultAuthSettings = vi.fn();

        const { tree } = await renderScreen(
            <ConnectedServicesDefaultAuthRow
                agentId="codex"
                agentTitle="Codex"
                agentCore={{ connectedServices: { supportedServiceIds: ['openai-codex' as any] } }}
                accountGroupsEnabled={true}
                accountProfileConnectedServicesV2={[
                    {
                        serviceId: 'openai-codex' as any,
                        profiles: [{ profileId: 'fresh', status: 'connected', kind: 'oauth' }],
                        groups: [{
                            groupId: 'primary',
                            displayName: 'Primary pool',
                            activeProfileId: 'fresh',
                            memberProfileIds: ['fresh'],
                        }],
                    },
                ]}
                settings={{
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                }}
                setDefaultAuthSettings={setDefaultAuthSettings}
                onOpenConnectedServicesSettings={vi.fn()}
            />,
        );

        const modalTree = await openPickerModal(tree, 'codex');
        await act(async () => {
            findSelectionOption(modalTree, 'connected-service:openai-codex:group:primary').onSelect();
        });

        expect(setDefaultAuthSettings).toHaveBeenCalledWith({
            v: 1,
            bindingsByAgentId: {
                codex: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': { source: 'connected', selection: 'group', groupId: 'primary' },
                    },
                },
            },
        });
    });

    it('renders the effective fallback warning for stale group defaults on the trigger', async () => {
        const { ConnectedServicesDefaultAuthRow } = await import('./ConnectedServicesDefaultAuthRow');

        const { tree } = await renderScreen(
            <ConnectedServicesDefaultAuthRow
                agentId="codex"
                agentTitle="Codex"
                agentCore={{ connectedServices: { supportedServiceIds: ['openai-codex' as any] } }}
                accountGroupsEnabled={true}
                accountProfileConnectedServicesV2={[
                    {
                        serviceId: 'openai-codex' as any,
                        profiles: [{ profileId: 'work', status: 'connected', kind: 'oauth' }],
                        groups: [],
                    },
                ]}
                settings={{
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
                    connectedServicesDefaultAuthByAgentIdV1: {
                        v: 1,
                        bindingsByAgentId: {
                            codex: {
                                v: 1,
                                bindingsByServiceId: {
                                    'openai-codex': {
                                        source: 'connected',
                                        selection: 'group',
                                        groupId: 'missing-group',
                                    },
                                },
                            },
                        },
                    },
                }}
                setDefaultAuthSettings={vi.fn()}
                onOpenConnectedServicesSettings={vi.fn()}
            />,
        );

        const trigger = findDefaultAuthTrigger(tree, 'codex');
        expect(trigger.subtitle).toBe('connectedServices.defaultAuth.warning.connected_group_unavailable');
    });

    it('offers Claude subscription OAuth, setup-token, and Anthropic API key as selectable options for OpenCode', async () => {
        const { ConnectedServicesDefaultAuthRow } = await import('./ConnectedServicesDefaultAuthRow');
        const setDefaultAuthSettings = vi.fn();

        const { tree } = await renderScreen(
            <ConnectedServicesDefaultAuthRow
                agentId="opencode"
                agentTitle="OpenCode"
                agentCore={{ connectedServices: AGENTS_CORE.opencode.connectedServices }}
                accountGroupsEnabled={false}
                accountProfileConnectedServicesV2={[
                    {
                        serviceId: 'claude-subscription' as ConnectedServiceId,
                        profiles: [
                            { profileId: 'claude-oauth', status: 'connected', kind: 'oauth', providerEmail: 'oauth@example.com' },
                            { profileId: 'claude-setup', status: 'connected', kind: 'token', providerEmail: 'setup@example.com' },
                        ],
                    },
                    {
                        serviceId: 'anthropic' as ConnectedServiceId,
                        profiles: [
                            { profileId: 'api', status: 'connected', kind: 'token', providerEmail: 'api@example.com' },
                        ],
                    },
                ]}
                settings={{
                    connectedServicesProfileLabelByKey: {},
                    connectedServicesDefaultProfileByServiceId: {},
                    connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: {} },
                }}
                setDefaultAuthSettings={setDefaultAuthSettings}
                onOpenConnectedServicesSettings={vi.fn()}
            />,
        );

        const modalTree = await openPickerModal(tree, 'opencode');
        const optionIds = findSelectionListProps(modalTree).rootStep.sections
            .flatMap((section) => section.options.map((option) => option.id));

        // All three Anthropic auth options surface as real selectable connected profiles:
        // browser-login OAuth + setup-token (claude-subscription) and Console API key (anthropic).
        expect(optionIds).toContain('connected-service:claude-subscription:profile:claude-oauth');
        expect(optionIds).toContain('connected-service:claude-subscription:profile:claude-setup');
        expect(optionIds).toContain('connected-service:anthropic:profile:api');

        await act(async () => {
            findSelectionOption(modalTree, 'connected-service:claude-subscription:profile:claude-oauth').onSelect();
        });

        expect(setDefaultAuthSettings).toHaveBeenCalledWith({
            v: 1,
            bindingsByAgentId: {
                opencode: {
                    v: 1,
                    bindingsByServiceId: {
                        'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'claude-oauth' },
                    },
                },
            },
        });
    });

    function renderProfileDefaultInReadyPool(overrides: Readonly<{
        dismissedPoolAdoptionSuggestionKeys?: Record<string, boolean>;
        onDismissPoolAdoptionSuggestion?: (key: string) => void;
        setDefaultAuthSettings?: (next: ConnectedServicesDefaultAuthByAgentIdV1) => void;
        autoSwitch?: boolean;
        includeMember?: boolean;
    }> = {}) {
        const autoSwitch = overrides.autoSwitch ?? true;
        const includeMember = overrides.includeMember ?? true;
        return import('./ConnectedServicesDefaultAuthRow').then(({ ConnectedServicesDefaultAuthRow }) =>
            renderScreen(
                <ConnectedServicesDefaultAuthRow
                    agentId="codex"
                    agentTitle="Codex"
                    agentCore={{ connectedServices: { supportedServiceIds: ['openai-codex' as any] } }}
                    accountGroupsEnabled={true}
                    accountProfileConnectedServicesV2={[
                        {
                            serviceId: 'openai-codex' as any,
                            profiles: [
                                { profileId: 'work', status: 'connected', kind: 'oauth' },
                                { profileId: 'backup', status: 'connected', kind: 'oauth' },
                            ],
                            groups: [{
                                groupId: 'primary',
                                displayName: 'Primary pool',
                                activeProfileId: 'work',
                                memberProfileIds: includeMember ? ['work', 'backup'] : ['backup'],
                                autoSwitch,
                            }],
                        },
                    ]}
                    settings={{
                        connectedServicesProfileLabelByKey: {},
                        connectedServicesDefaultProfileByServiceId: {},
                        connectedServicesDefaultAuthByAgentIdV1: {
                            v: 1,
                            bindingsByAgentId: {
                                codex: {
                                    v: 1,
                                    bindingsByServiceId: {
                                        'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
                                    },
                                },
                            },
                        },
                    }}
                    setDefaultAuthSettings={overrides.setDefaultAuthSettings ?? vi.fn()}
                    onOpenConnectedServicesSettings={vi.fn()}
                    dismissedPoolAdoptionSuggestionKeys={overrides.dismissedPoolAdoptionSuggestionKeys}
                    onDismissPoolAdoptionSuggestion={overrides.onDismissPoolAdoptionSuggestion}
                />,
            ),
        );
    }

    it('suggests adopting a ready autoSwitch pool when the default is a lone member profile, and accepting writes the pool as the stored default', async () => {
        const setDefaultAuthSettings = vi.fn();
        const { tree } = await renderProfileDefaultInReadyPool({ setDefaultAuthSettings });

        expect(hasPoolSuggestion(tree, 'codex', 'openai-codex')).toBe(true);

        await act(async () => {
            findPoolSuggestion(tree, 'codex', 'openai-codex').accept();
        });

        // Accepting writes the literal stored default to the pool (no silent resolution-time rewrite).
        expect(setDefaultAuthSettings).toHaveBeenCalledWith({
            v: 1,
            bindingsByAgentId: {
                codex: {
                    v: 1,
                    bindingsByServiceId: {
                        'openai-codex': { source: 'connected', selection: 'group', groupId: 'primary' },
                    },
                },
            },
        });
    });

    it('dismissing the pool suggestion suppresses it and records the dismissal without changing the stored default', async () => {
        const setDefaultAuthSettings = vi.fn();
        const onDismissPoolAdoptionSuggestion = vi.fn();
        const { tree } = await renderProfileDefaultInReadyPool({
            setDefaultAuthSettings,
            onDismissPoolAdoptionSuggestion,
        });

        await act(async () => {
            findPoolSuggestion(tree, 'codex', 'openai-codex').dismiss();
        });

        expect(onDismissPoolAdoptionSuggestion).toHaveBeenCalledWith('codex:openai-codex:primary');
        expect(setDefaultAuthSettings).not.toHaveBeenCalled();
        expect(hasPoolSuggestion(tree, 'codex', 'openai-codex')).toBe(false);
    });

    it('does not show the pool suggestion when it was previously dismissed', async () => {
        const { tree } = await renderProfileDefaultInReadyPool({
            dismissedPoolAdoptionSuggestionKeys: { 'codex:openai-codex:primary': true },
        });
        expect(hasPoolSuggestion(tree, 'codex', 'openai-codex')).toBe(false);
    });

    it('does not show the pool suggestion when the pool is not autoSwitch', async () => {
        const { tree } = await renderProfileDefaultInReadyPool({ autoSwitch: false });
        expect(hasPoolSuggestion(tree, 'codex', 'openai-codex')).toBe(false);
    });

    it('does not show the pool suggestion when the default profile is not a member of the pool', async () => {
        const { tree } = await renderProfileDefaultInReadyPool({ includeMember: false });
        expect(hasPoolSuggestion(tree, 'codex', 'openai-codex')).toBe(false);
    });
});
