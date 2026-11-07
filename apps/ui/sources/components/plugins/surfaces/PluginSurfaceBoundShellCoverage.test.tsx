import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import type {
    PluginUiProjectionModel,
    PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

// Install network boundaries before importing the real mounted surface graph.
installDisconnectedServerSocketBoundary();
const { buildLocalServiceInventoryState, createRootLayoutFeaturesResponse, renderScreen, standardCleanup } = await import('@/dev/testkit');
// The context fixture reaches the real plugin surface graph, so it also loads after the boundary.
const { createPluginProjectContextFixture } = await import('@/dev/testkit/fixtures/pluginSurfaceContextFixture');
const { createLocalServiceLauncherState } = await import('@/sync/domains/local/services/launch');
const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
const { createPluginDeclarativeModelFixture } = await import('@/dev/testkit/fixtures/pluginDeclarativeModelFixture');
const { serveAccountHomes } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { LocalServicesSurfaceHost } = await import('@/components/sessions/localServices/LocalServicesSurfaceHost');
const { PluginDetailsPaneOverlay } = await import('@/components/appShell/panes/details/surfaces/PluginDetailsPaneOverlay');
let home: Awaited<ReturnType<typeof serveAccountHomes>> | null = null;
beforeEach(async () => {
    home = await serveAccountHomes({
        homes: [{ key: 'bound', serverUrl: 'https://bound-shell.test', accountId: 'account-bound' }],
        route: request => request.path === '/v1/features' || request.path === '/v1/features/authenticated'
            ? Response.json(createRootLayoutFeaturesResponse()) : undefined,
    });
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    await waitForHomeGovernance(() => expect(captureActiveServerAccountScopeLifetime()?.isCurrent()).toBe(true));
});
afterEach(async () => {
    await standardCleanup();
    await home?.dispose();
    home = null;
});

// React Native and responsive layout are platform boundaries. Keep their
// observed environment deterministic while the real Services stack, Details
// adapter, placement host, bound controller, and declarative renderer remain
// mounted below this test.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: { children?: React.ReactNode }) => React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return await createUnistylesMock();
});

vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/platform/responsive')>()),
    getDeviceType: () => 'tablet' as const,
    useDeviceType: () => 'tablet' as const,
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
        translateLoose: (key: string) => key,
        getPreferredLanguage: () => 'en',
    });
});

function placement(input: Readonly<{
    destinationId: string;
    rendererId: string;
    container: 'servicesPanel' | 'detailsPane';
    target: Readonly<Record<string, unknown>>;
    label: string;
}>): PluginUiSurfacePlacementProjection {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId: 'com.example.bound-shell',
        destinationId: input.destinationId,
        rendererId: input.rendererId,
        container: input.container,
        target: input.target,
    });
    if (!binding) {
        throw new Error(`expected admitted ${input.container}/${String(input.target.kind)} fixture binding`);
    }
    return Object.freeze({
        id: `surfacePlacement:com.example.bound-shell:${input.destinationId}`,
        pluginId: 'com.example.bound-shell',
        occurrenceId: 'bound-shell-occurrence-1',
        contributionKind: 'surfacePlacement',
        descriptorId: input.destinationId,
        binding,
        target: binding.target,
        renderer: Object.freeze({
            kind: 'declarative',
            contributionId: input.rendererId,
            model: createPluginDeclarativeModelFixture({
                pluginId: 'com.example.bound-shell',
                localId: input.rendererId,
                occurrenceId: 'bound-shell-occurrence-1',
                document: { version: 1, root: { kind: 'text', text: input.label } },
            }),
        }),
        display: Object.freeze({ developerFallback: input.label }),
        availability: Object.freeze({ state: 'available', reason: 'available', diagnostics: [] }),
        headerActions: Object.freeze([]),
    });
}

const servicesPlacement = placement({
    destinationId: 'services-bound',
    rendererId: 'services-bound-renderer',
    container: 'servicesPanel',
    target: { kind: 'services' },
    label: 'Services bound host mounted',
});

const projectDetailsPlacement = placement({
    destinationId: 'project-details-bound',
    rendererId: 'project-details-bound-renderer',
    container: 'detailsPane',
    target: { kind: 'project', projectIdPath: '/project/id' },
    label: 'Project Details bound host mounted',
});

function projectionWithBoundShellSurfaces(): PluginUiProjectionModel {
    return Object.freeze({
        ...EMPTY_PLUGIN_UI_PROJECTION,
        generation: 741,
        surfacePlacementsById: Object.freeze({
            [servicesPlacement.id]: servicesPlacement,
            [projectDetailsPlacement.id]: projectDetailsPlacement,
        }),
    });
}

const projectOverlay = Object.freeze({
    destination: Object.freeze({
        pluginId: 'com.example.bound-shell',
        localId: 'project-details-bound',
    }),
    returnFocusedGroupId: null,
    returnMaximizedGroupId: null,
    returnIsOpen: true,
});

function BoundShellCoverage(props: Readonly<{
    projection: PluginUiProjectionModel;
}>): React.ReactElement {
    return (
        <>
            <LocalServicesSurfaceHost
                machineId="machine-bound"
                serverId={home!.homes.bound!.id}
                workspaceRoot="/workspace/bound"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                launcherState={createLocalServiceLauncherState()}
                publicPreviewState={null}
                pluginUiProjection={props.projection}
                projectionInteractionEnabled
                platform="web"
                testID="bound-shell-services"
            />
            <PluginDetailsPaneOverlay
                targetKind="project"
                projection={props.projection}
                overlay={projectOverlay}
                mount={{
                    machineId: 'machine-bound',
                    serverId: home!.homes.bound!.id,
                    projectId: 'project-bound',
                    projectContext: createPluginProjectContextFixture({ id: 'project-bound', serverId: home!.homes.bound!.id, machineId: 'machine-bound' }),
                    platform: 'web',
                    formFactor: 'tablet',
                    projectionPhase: 'current',
                    projectionInteractionEnabled: true,
                }}
            />
        </>
    );
}

describe('bound Services and Project details shell coverage', () => {
    it('mounts both real bound hosts and retires them when their admitted projection disappears', async () => {
        const mounted = projectionWithBoundShellSurfaces();
        const screen = await renderScreen(<BoundShellCoverage projection={mounted} />);

        expect(screen.findByTestId(
            `bound-shell-services-plugin-stack-placement-${servicesPlacement.id}`,
        )).toBeTruthy();
        await waitForHomeGovernance(() => {
            expect(screen.getTextContent()).toContain('Services bound host mounted');
            expect(screen.getTextContent()).toContain('Project Details bound host mounted');
        });

        await screen.update(
            <BoundShellCoverage projection={{
                ...EMPTY_PLUGIN_UI_PROJECTION,
                generation: 742,
            }} />,
        );

        expect(screen.findAllByTestId(
            `bound-shell-services-plugin-stack-placement-${servicesPlacement.id}`,
        )).toHaveLength(0);
        expect(screen.getTextContent()).not.toContain('Services bound host mounted');
        expect(screen.getTextContent()).not.toContain('Project Details bound host mounted');
        expect(screen.findByTestId('plugin-rn-ui-unavailable')).toBeTruthy();
    });
});
