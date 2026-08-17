import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import {
    buildLocalServiceInventoryState,
    buildManagedLocalServicesState,
    renderScreen,
} from '@/dev/testkit';
import {
    createLocalServiceLauncherState,
} from '@/sync/domains/local/services/launch';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import { LocalServicesSurfaceHost } from '@/components/sessions/localServices/LocalServicesSurfaceHost';
import { PluginDetailsPaneOverlay } from '@/components/appShell/panes/details/surfaces/PluginDetailsPaneOverlay';

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
        contributionKind: 'surfacePlacement',
        descriptorId: input.destinationId,
        binding,
        target: binding.target,
        renderer: Object.freeze({
            kind: 'declarative',
            contributionId: input.rendererId,
            model: Object.freeze({
                visible: true,
                identity: Object.freeze({
                    pluginId: 'com.example.bound-shell',
                    localId: input.rendererId,
                    qualifiedId: `com.example.bound-shell/${input.rendererId}`,
                    generation: 'bound-shell-generation-1',
                }),
                nodes: Object.freeze([]),
                root: Object.freeze({
                    kind: 'text',
                    path: 'root',
                    order: 0,
                    text: input.label,
                }),
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
                serverId="server-bound"
                workspaceRoot="/workspace/bound"
                inventoryState={buildLocalServiceInventoryState({ rows: [] })}
                managedState={buildManagedLocalServicesState({ rows: [] })}
                launcherState={createLocalServiceLauncherState()}
                publicPreviewState={null}
                runtimeActionExecute={async () => null}
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
                    serverId: 'server-bound',
                    projectId: 'project-bound',
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
        expect(screen.getTextContent()).toContain('Services bound host mounted');
        expect(screen.getTextContent()).toContain('Project Details bound host mounted');

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
