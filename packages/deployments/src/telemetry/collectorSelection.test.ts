import { expect, it } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { resolveTelemetryCollectorSelectionV1 } from './export.js';

it('offers collector deployment for a Team without inferring ownership or uptime from placement', () => {
    const detail = createDeploymentEnvironmentDetailV1();
    const link = detail.targetLinks[0]!.targetLink;
    link.machines = ['personal-runtime'];
    const input = { environment: { ...detail.environment, owner: { kind: 'team' as const, teamId: 'team' },
        telemetryMachineId: null, runtimeTargetLinkId: link.id }, targetLinks: detail.targetLinks, projectDefaultMachineId: 'personal-default' };
    expect(resolveTelemetryCollectorSelectionV1(input)).toEqual({ kind: 'collector_required',
        recovery: 'deploy_collector', teamId: 'team', requireExplicitDestination: true });
    expect(resolveTelemetryCollectorSelectionV1({ ...input, collector: { machineId: 'chosen' } }))
        .toEqual({ kind: 'selected', machineId: 'chosen' });
    expect(resolveTelemetryCollectorSelectionV1({ ...input, environment: { ...input.environment, telemetryMachineId: 'chosen' } }))
        .toEqual({ kind: 'selected', machineId: 'chosen' });
    expect(resolveTelemetryCollectorSelectionV1({ ...input, environment: { ...input.environment, telemetryMachineId: 'chosen' }, rotate: true }))
        .toEqual({ kind: 'selected', machineId: 'chosen' });
    expect(resolveTelemetryCollectorSelectionV1({ ...input, collector: null }))
        .toEqual({ kind: 'selected', machineId: null });
});

it('keeps the deliberate Project default and own-server runtime preselection for personal Environments', () => {
    const detail = createDeploymentEnvironmentDetailV1();
    const link = detail.targetLinks[0]!.targetLink;
    link.machines = ['runtime'];
    const input = { environment: { ...detail.environment, owner: { kind: 'account' as const, accountId: 'account' },
        runtimeTargetLinkId: link.id }, targetLinks: detail.targetLinks };
    expect(resolveTelemetryCollectorSelectionV1({ ...input, projectDefaultMachineId: 'default' }))
        .toEqual({ kind: 'selected', machineId: 'default' });
    expect(resolveTelemetryCollectorSelectionV1(input)).toEqual({ kind: 'selected', machineId: 'runtime' });
    expect(resolveTelemetryCollectorSelectionV1({ ...input, targetLinks: [] }))
        .toEqual({ kind: 'collector_required', recovery: 'choose_collector' });
});
