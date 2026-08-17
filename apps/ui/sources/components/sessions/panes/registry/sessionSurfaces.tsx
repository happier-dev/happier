import * as React from 'react';

import {
    SimulatorDeviceResourceV1Schema,
    type SimulatorDeviceResourceV1,
} from '@happier-dev/protocol';

import type { DetailsTabState } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { SessionSimulatorPreviewPane } from '@/components/sessions/simulator/SessionSimulatorPreviewPane';
import { selectSimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/selectors';
import type { SimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/types';
import type { SimulatorPreviewActions } from '@/sync/domains/devices/simulator/useSimulatorPreview';
import type { SimulatorPreviewSurfaceRuntime } from '@/sync/domains/devices/simulator/useSimulatorPreviewRuntime';
type SimulatorPreviewSessionSurfaceResource = Readonly<{
    kind: 'simulatorPreview';
    viewerId?: string;
    selectedSimulatorId?: string | null;
    resources?: unknown;
}>;

const EMPTY_SIMULATOR_PREVIEW_ACTIONS: Partial<SimulatorPreviewActions> = Object.freeze({});

function isSimulatorPreviewSessionSurfaceResource(value: unknown): value is SimulatorPreviewSessionSurfaceResource {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const maybe = value as { kind?: unknown };
    return maybe.kind === 'simulatorPreview';
}

function readSimulatorDeviceResources(value: unknown): readonly SimulatorDeviceResourceV1[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.flatMap((entry) => {
        const parsed = SimulatorDeviceResourceV1Schema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
    });
}

function readOptionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readOptionalNullableString(value: unknown): string | null | undefined {
    return value === null ? null : readOptionalString(value);
}

function resolveSimulatorPreviewViewModel(params: Readonly<{
    resource: SimulatorPreviewSessionSurfaceResource;
    runtime?: SimulatorPreviewSurfaceRuntime | null;
    nowMs?: () => number;
}>): SimulatorPreviewViewModel {
    const resourceSelectedSimulatorId = readOptionalNullableString(params.resource.selectedSimulatorId);
    if (
        params.runtime?.viewModel
        && (
            resourceSelectedSimulatorId === undefined
            || params.runtime.viewModel.selectedSimulatorId === resourceSelectedSimulatorId
        )
    ) {
        return params.runtime.viewModel;
    }
    const resources = params.runtime?.resources
        ?? readSimulatorDeviceResources(params.resource.resources);
    return selectSimulatorPreviewViewModel({
        resources,
        selectedSimulatorId:
            params.runtime?.selectedSimulatorId
            ?? readOptionalNullableString(params.resource.selectedSimulatorId)
            ?? null,
        viewerId:
            params.runtime?.viewerId
            ?? readOptionalString(params.resource.viewerId)
            ?? 'session-simulator-viewer',
        previewStatesBySimulatorId: params.runtime?.previewStatesBySimulatorId,
        playerStatesBySimulatorId: params.runtime?.playerStatesBySimulatorId,
        snapshotDiagnostics: params.runtime?.diagnostics,
        nowMs: params.nowMs?.(),
    });
}

export function renderSimulatorSessionSurfaceTab(params: Readonly<{
    sessionId: string;
    tab: DetailsTabState;
    simulatorPreview?: SimulatorPreviewSurfaceRuntime | null;
    nowMs?: () => number;
}>): React.ReactNode | null {
    if (!isSimulatorPreviewSessionSurfaceResource(params.tab.resource)) {
        return null;
    }
    return (
        <SessionSimulatorPreviewPane
            sessionId={params.sessionId}
            viewModel={resolveSimulatorPreviewViewModel({
                resource: params.tab.resource,
                runtime: params.simulatorPreview,
                nowMs: params.nowMs,
            })}
            actions={params.simulatorPreview?.actions ?? EMPTY_SIMULATOR_PREVIEW_ACTIONS}
        />
    );
}

export function renderSessionSurfaceTab(params: Readonly<{
    sessionId: string;
    tab: DetailsTabState;
    simulatorPreview?: SimulatorPreviewSurfaceRuntime | null;
    nowMs?: () => number;
}>): React.ReactNode | null {
    return renderSimulatorSessionSurfaceTab({
        sessionId: params.sessionId,
        tab: params.tab,
        simulatorPreview: params.simulatorPreview,
        nowMs: params.nowMs,
    });
}

export function resolveSessionSurfaceTabIconName(params: Readonly<{
    tab: DetailsTabState;
}>): string | null {
    if (isSimulatorPreviewSessionSurfaceResource(params.tab.resource)) {
        return 'device-mobile';
    }
    return null;
}
