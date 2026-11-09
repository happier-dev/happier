import * as React from 'react';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createResolvedAgentCatalogEntryFixture } from '@/dev/testkit/fixtures/agentCatalogFixtures';

import { AgentCatalogIdentityIcon } from './AgentCatalogIdentityIcon';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

/** The Account-epoch boundary, held current so brand reads are admitted. */
const accountScopeState = vi.hoisted(() => ({ current: true }));

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => Object.freeze({
        scope: Object.freeze({ serverId: 'server-1', accountId: 'account-1' }),
        isCurrent: () => accountScopeState.current,
        onRetire: () => Object.freeze({ dispose: () => undefined }),
    }),
}));

/**
 * The brand hook is the admitted-Resource boundary (leases, Account Artifact
 * reads, currentness), so the component test controls it here and asserts the
 * exact input the owner hands it. The hook's own currentness/refusal behavior
 * is proven in its own suite; this suite proves the owner's gating and rendering.
 */
const brandPresentationState = vi.hoisted(() => ({
    presentation: null as Readonly<{ displayName: string; bytes?: Uint8Array }> | null,
    input: null as Record<string, unknown> | null,
    bundledInput: null as Readonly<{ pluginId: string | null | undefined; displayName?: string; iconAgentId?: string | null }> | null,
}));

vi.mock('@/components/plugins/shared/installedPluginBrandPresentation', () => ({
    useInstalledPluginBrandPresentation: (input: Record<string, unknown>) => {
        brandPresentationState.input = input;
        return input.installedPackage
            ? brandPresentationState.presentation
            : null;
    },
    // Bundled artwork is a host-owned catalog read; the stub names which Agent the owner asked for.
    useBundledPluginBrandPresentation: (pluginId: string | null | undefined, displayName?: string, iconAgentId?: string | null) => {
        brandPresentationState.bundledInput = { pluginId, displayName, iconAgentId };
        return iconAgentId ? Object.freeze({ displayName: `bundled:${iconAgentId}` }) : null;
    },
}));


vi.mock('@/components/ui/media/HappierBrandMark', () => ({
    HappierBrandMark: (props: Record<string, unknown>) => React.createElement('HappierBrandMark', props),
}));

function renderIcon(
    entry: Parameters<typeof AgentCatalogIdentityIcon>[0]['entry'],
    overrides?: Readonly<{
        current?: boolean;
        machineId?: string | null;
        serverId?: string | null;
    }>,
): ReactTestRenderer {
    let tree: ReactTestRenderer | null = null;
    act(() => {
        tree = create(
            <AgentCatalogIdentityIcon
                entry={entry}
                current={overrides?.current ?? true}
                machineId={overrides?.machineId !== undefined ? overrides.machineId : 'machine-1'}
                serverId={overrides?.serverId !== undefined ? overrides.serverId : 'server-1'}
            />,
        );
    });
    if (tree === null) throw new Error('Agent identity icon renderer did not mount');
    return tree;
}

/** An external Agent whose captured package facts match its qualified identity. */
function createExternalEntryWithMatchingPackage(): ReturnType<typeof createResolvedAgentCatalogEntryFixture> {
    return createResolvedAgentCatalogEntryFixture({
        agentId: 'acme/ultracode',
        mergedProviderProjectionById: {
            'acme/ultracode': {
                agentId: 'acme/ultracode',
                qualifiedId: 'acme.plugin/ultracode',
                identity: { pluginId: 'acme.plugin', localId: 'ultracode' },
                installedPackage: {
                    id: 'acme.plugin',
                    displayName: 'UltraCode',
                    enabled: true,
                    source: { kind: 'localPath', locator: '/plugins/acme.plugin' },
                    immutableGenerationId: 'gen-11',
                    brand: {
                        state: 'available',
                        resource: { pluginId: 'acme.plugin', localId: 'brand' },
                        width: 128,
                        height: 128,
                        digest: `sha256:${'a'.repeat(64)}`,
                    },
                },
                projectionGeneration: 7,
                title: 'UltraCode',
                isBuiltIn: false,
                // A stale bundled carrier icon fact may still sit beside the
                // external declaration; it must never become the external mark.
                iconAgentId: 'codex',
            },
        },
    });
}

describe('AgentCatalogIdentityIcon', () => {
    beforeEach(() => {
        brandPresentationState.presentation = null;
        brandPresentationState.input = null;
        brandPresentationState.bundledInput = null;
        accountScopeState.current = true;
    });

    it('renders a bundled Agent with its own brand mark rather than a generic glyph', () => {
        const tree = renderIcon(createResolvedAgentCatalogEntryFixture({ agentId: 'claude' }));

        expect(brandPresentationState.bundledInput?.iconAgentId).toBe('claude');
        expect(tree.root.findByType(HappierBrandMark).props.brand).toEqual({ displayName: 'bundled:claude' });
    });

    it('keeps an external Agent neutral when its exact package identity is unavailable', () => {
        const tree = renderIcon(createResolvedAgentCatalogEntryFixture({
            agentId: 'acme/ultracode',
            mergedProviderProjectionById: {
                'acme/ultracode': {
                    agentId: 'acme/ultracode',
                    qualifiedId: 'acme.plugin/ultracode',
                    identity: null,
                    installedPackage: null,
                    projectionGeneration: 7,
                    title: 'UltraCode',
                    isBuiltIn: false,
                    iconAgentId: 'codex',
                },
            },
        }));

        // Neutral: the title-only mark, never the stale bundled carrier's artwork.
        expect(tree.root.findByType(HappierBrandMark).props.brand).toEqual({ displayName: 'UltraCode' });
        expect(brandPresentationState.bundledInput?.iconAgentId).toBeNull();
        expect(brandPresentationState.input?.installedPackage).toBeNull();
    });

    it('renders the package brand when the external Agent package matches its qualified identity', () => {
        brandPresentationState.presentation = Object.freeze({ displayName: 'UltraCode', bytes: new Uint8Array([1]) });
        const entry = createExternalEntryWithMatchingPackage();

        const tree = renderIcon(entry);

        const mark = tree.root.findByType(HappierBrandMark);
        expect(mark.props.brand).toMatchObject({ displayName: 'UltraCode', bytes: new Uint8Array([1]) });
        // The brand read is machine-scoped and retains the package occurrence
        // through the installed-package projection plus the owner currentness predicate.
        expect(brandPresentationState.input).toMatchObject({
            machineId: 'machine-1',
            serverId: 'server-1',
        });
        expect(brandPresentationState.input?.installedPackage).toMatchObject({ id: 'acme.plugin' });
        expect(typeof (brandPresentationState.input as { isCurrent?: unknown } | null)?.isCurrent).toBe('function');
    });

    it('stays neutral when the projection is not current instead of lending a stale brand', () => {
        const entry = createExternalEntryWithMatchingPackage();

        const tree = renderIcon(entry, { current: false });

        // The owner hands the boundary no package facts at all when the row is
        // not current, so a stale package cannot keep lending its brand.
        expect(brandPresentationState.input?.installedPackage).toBeNull();
        expect(tree.root.findByType(HappierBrandMark).props.brand).toEqual({ displayName: 'UltraCode' });
    });

    it('keeps an external Agent neutral when its package facts belong to another plugin', () => {
        brandPresentationState.presentation = Object.freeze({ displayName: 'Someone Else' });
        const entry = createResolvedAgentCatalogEntryFixture({
            agentId: 'acme/ultracode',
            mergedProviderProjectionById: {
                'acme/ultracode': {
                    agentId: 'acme/ultracode',
                    qualifiedId: 'acme.plugin/ultracode',
                    identity: { pluginId: 'acme.plugin', localId: 'ultracode' },
                    installedPackage: {
                        id: 'other.plugin',
                        displayName: 'Someone Else',
                        enabled: true,
                        source: { kind: 'localPath', locator: '/plugins/other.plugin' },
                        immutableGenerationId: 'gen-3',
                        brand: {
                            state: 'available',
                            resource: { pluginId: 'other.plugin', localId: 'brand' },
                            width: 128,
                            height: 128,
                            digest: `sha256:${'b'.repeat(64)}`,
                        },
                    },
                    projectionGeneration: 7,
                    title: 'UltraCode',
                    isBuiltIn: false,
                },
            },
        });

        const tree = renderIcon(entry);

        expect(brandPresentationState.input?.installedPackage).toBeNull();
        expect(tree.root.findByType(HappierBrandMark).props.brand).toEqual({ displayName: 'UltraCode' });
    });
});
