import { describe, expect, it } from 'vitest';

import { buildThisComputerSetupStageModel } from './buildThisComputerSetupStageModel';

const basePreflight = {
    activeRelayUrl: 'https://relay.example.test',
    localCliReady: false,
    serviceInstalled: false,
    daemonRunning: false,
    machineId: null as string | null,
    needsAuth: false,
    daemonServerUrl: 'https://relay.example.test',
    daemonComparableKey: 'https://relay.example.test',
    daemonAccountId: 'acct_1',
    daemonMachineRegistered: false as boolean | null,
    uiAccountId: 'acct_1',
    serverMismatch: false,
    accountMismatch: false,
    pairingRequired: false,
    relayDriftBanner: null,
};

describe('buildThisComputerSetupStageModel', () => {
    it('builds high-level setup stages instead of low-level bootstrap rows', () => {
        const items = buildThisComputerSetupStageModel({
            preflight: {
                ...basePreflight,
                serviceInstalled: true,
                daemonRunning: false,
                machineId: null,
            },
            prompt: null,
        });

        expect(items.map((item) => item.id)).toEqual([
            'setup.thisComputer.stage.installTools',
            'setup.thisComputer.stage.useRelay',
            'setup.thisComputer.stage.registerComputer',
            'setup.thisComputer.stage.backgroundService',
        ]);

        const installToolsStage = items[0];
        expect(installToolsStage?.children?.map((item) => item.id)).toEqual([
            'setup.thisComputer.ensureCli',
        ]);
        const useRelayStage = items[1];
        expect(useRelayStage?.children?.map((item) => item.id)).toEqual([
            'setup.thisComputer.resolveRelay',
            'setup.thisComputer.checkAuth',
            'setup.thisComputer.configureRelay',
        ]);
        const registerStage = items[2];
        expect(registerStage?.children?.map((item) => item.id)).toEqual([
            'setup.thisComputer.auth.request',
            'setup.thisComputer.auth.wait',
        ]);
        const backgroundServiceStage = items[3];
        expect(backgroundServiceStage?.children?.map((item) => item.id)).toEqual([
            'setup.thisComputer.installService',
            'setup.thisComputer.startService',
            'setup.thisComputer.verifyService',
        ]);
        expect(items.some((item) => item.id === 'setup.thisComputer.checkAuth')).toBe(false);
        expect(items.some((item) => item.id === 'setup.thisComputer.auth.wait')).toBe(false);
        expect(items.every((item) => item.kind === 'stage')).toBe(true);
    });

    it('surfaces the background-service decision stage from the active prompt', () => {
        const items = buildThisComputerSetupStageModel({
            preflight: basePreflight,
            prompt: {
                kind: 'releaseChannel.switchDefaultForSetup',
                message: 'Switch default channel',
                targetReleaseChannel: 'preview',
                currentDefaultReleaseChannel: 'stable',
                targetServerUrl: 'https://relay.example.test',
                managedReleaseChannels: [],
            },
        });

        const backgroundServiceStage = items.find((item) => item.id === 'setup.thisComputer.stage.backgroundService');
        expect(backgroundServiceStage).toMatchObject({
            kind: 'stage',
        });
        expect(backgroundServiceStage?.badge).toBeTruthy();
        expect(backgroundServiceStage?.details).toContain('preview');
        expect(backgroundServiceStage?.details).toContain('relay.example.test');
        expect(backgroundServiceStage?.satisfied).toBe(false);
        expect(backgroundServiceStage?.children?.map((item) => item.id)).toEqual([
            'setup.thisComputer.preflight.releaseChannel',
            'setup.thisComputer.installService',
            'setup.thisComputer.startService',
            'setup.thisComputer.verifyService',
        ]);
    });

    it('describes local registration without approval or waiting copy', () => {
        const items = buildThisComputerSetupStageModel({
            preflight: {
                ...basePreflight,
                needsAuth: false,
                pairingRequired: true,
                machineId: null,
            },
            prompt: null,
        });

        const registerStage = items.find((item) => item.id === 'setup.thisComputer.stage.registerComputer');
        expect(registerStage?.title).not.toBe('settings.machineSetupStepAuthRequest');
        expect(registerStage?.title).not.toBe('settings.machineSetupStepAuthWait');
    });

    it('keeps the background-service stage incomplete until the service is actually ready', () => {
        const items = buildThisComputerSetupStageModel({
            preflight: {
                ...basePreflight,
                serviceInstalled: false,
                daemonRunning: false,
                machineId: null,
            },
            prompt: null,
        });

        const backgroundServiceStage = items.find((item) => item.id === 'setup.thisComputer.stage.backgroundService');
        expect(backgroundServiceStage?.satisfied).toBe(false);
        expect(backgroundServiceStage?.badge).toBeUndefined();
    });

    it('keeps the relay-confirmation stage incomplete when the daemon is pointed at a different relay', () => {
        const items = buildThisComputerSetupStageModel({
            preflight: {
                ...basePreflight,
                serverMismatch: true,
                daemonServerUrl: 'https://wrong.example.test',
            },
            prompt: null,
        });

        const relayStage = items.find((item) => item.id === 'setup.thisComputer.stage.useRelay');
        expect(relayStage?.satisfied).toBe(false);
    });

    it('adds explanatory details for every top-level stage', () => {
        const items = buildThisComputerSetupStageModel({
            preflight: basePreflight,
            prompt: null,
        });

        expect(items.every((item) => Boolean(item.details))).toBe(true);
    });

    it('keeps install-tools incomplete when daemon state exists but local CLI readiness is not verified', () => {
        const items = buildThisComputerSetupStageModel({
            preflight: {
                ...basePreflight,
                serviceInstalled: true,
                daemonRunning: true,
                machineId: 'machine-local-1',
                daemonMachineRegistered: true,
                localCliReady: false,
            },
            prompt: null,
        });

        const installToolsStage = items.find((item) => item.id === 'setup.thisComputer.stage.installTools');
        expect(installToolsStage?.satisfied).toBe(false);
        expect(installToolsStage?.children?.find((item) => item.id === 'setup.thisComputer.ensureCli')?.satisfied).toBe(false);
    });

    it('marks install-tools done only when local CLI readiness is explicitly verified', () => {
        const items = buildThisComputerSetupStageModel({
            preflight: {
                ...basePreflight,
                localCliReady: true,
            },
            prompt: null,
        });

        const installToolsStage = items.find((item) => item.id === 'setup.thisComputer.stage.installTools');
        expect(installToolsStage?.satisfied).toBe(true);
        expect(installToolsStage?.children?.find((item) => item.id === 'setup.thisComputer.ensureCli')?.satisfied).toBe(true);
    });
});
