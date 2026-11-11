import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentBackupConfigurationV1Schema } from '@happier-dev/deployment-protocol';
import { HappyError } from '@/utils/errors/errors';
import { DeployOutcomeBanner } from './DeploymentEnvironmentDetail';
import { HappierInputField } from '@happier-dev/plugin-ui/presentation';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { formatAutomationScheduleLabel } from '@/components/automations/list/automationListFormatting';
import { t } from '@/text';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { DeploymentBackupSetupSheet } = await import('./DeploymentBackupControls');
afterEach(standardCleanup);

const destination: React.ComponentProps<typeof DeploymentBackupSetupSheet>['destination'] = {
    id: 'com.acme.backups/archive', pluginId: 'com.acme.backups', pluginVersion: '1.0.0',
    definition: { id: 'archive', title: 'Archive', resticTransport: 's3', locality: 'offHost',
        credentialRoles: [{ role: 'repositoryPassword' }], actions: {
            test: { kind: 'hostAction', actionId: 'deployments.backups.test' },
            open: { pluginId: 'com.acme.backups', localId: 'open' } },
        configSchema: { type: 'object', required: ['layout'], properties: { layout: { type: 'string', enum: ['legacy', 'modern'] } }, additionalProperties: false },
        fieldHints: { fields: [{ path: 'layout', title: 'Archive layout', widget: 'select', required: true,
            options: [{ value: 'legacy', label: 'Compatible' }, { value: 'modern', label: 'Current' }] }] } },
};

function environmentDetail() {
    return { ...createDeploymentEnvironmentDetailV1(), runtimeTargetLink: null, memberVersions: {}, secretRevisions: [] };
}

describe('Backup destination setup fields', () => {
    it.each([
        { defaults: undefined, retention: { kind: 'keepEverything' as const } },
        { defaults: { values: { retainPreviousDeployments: 1, backupRetention: { kind: 'keep' as const, daily: 14 } },
            sources: { backupRetention: 'project' as const } }, retention: { kind: 'keep' as const, daily: 14 } },
    ])('renders descriptor fields and submits the captured first-configuration retention ($retention.kind)', async ({ defaults, retention }) => {
        const detail = environmentDetail();
        const configure = vi.fn<React.ComponentProps<typeof DeploymentBackupSetupSheet>['configure']>(async draft => ({
            kind: 'configured', environmentId: detail.environment.id, revision: 2,
            configuration: DeploymentBackupConfigurationV1Schema.parse(draft.configuration),
        }));
        const screen = await renderScreen(<DeploymentBackupSetupSheet detail={detail} destination={destination}
            defaults={defaults}
            sourceChoices={[{ kind: 'dump', sourceId: 'database', service: 'database', consistency: 'logical' }]} machine="Controller"
            review={{ pendingId: null, request() {}, open() {} }} configure={configure} onChanged={() => {}}
            onClose={() => {}} testID="setup" />);
        const field = () => screen.findAllByType(HappierInputField).find(entry => entry.props.field.path === 'layout')!;
        expect(field().props.field.title).toBe('Archive layout');
        expect(field().props.options.map((entry: { label: string }) => entry.label)).toEqual(['Compatible', 'Current']);
        await act(async () => field().props.onChange('modern'));
        await screen.pressByTestIdAsync('setup.save');
        expect(configure).toHaveBeenCalledWith(expect.objectContaining({ intent: 'save',
            configuration: expect.objectContaining({ config: { layout: 'modern' }, retention }) }));
    });

    it.each([null, { kind: 'cron' as const, scheduleExpr: '30 3 * * *', everyMs: null, timezone: 'Europe/Amsterdam' }])(
        'authors only the captured nonnull schedule after configuration settles (%j)', async schedule => {
            const detail = environmentDetail();
            const configure = vi.fn<React.ComponentProps<typeof DeploymentBackupSetupSheet>['configure']>(async draft => ({
                kind: 'configured', environmentId: detail.environment.id, revision: 2,
                configuration: DeploymentBackupConfigurationV1Schema.parse(draft.configuration),
            }));
            const onConfigured = vi.fn<NonNullable<React.ComponentProps<typeof DeploymentBackupSetupSheet>['onConfigured']>>(async () => {});
            const screen = await renderScreen(<DeploymentBackupSetupSheet detail={detail} destination={destination}
                defaults={{ values: { retainPreviousDeployments: 1, backupSchedule: schedule }, sources: { backupSchedule: 'project' } }}
                sourceChoices={[{ kind: 'dump', sourceId: 'database', service: 'database', consistency: 'logical' }]}
                machine="Controller" review={{ pendingId: null, request() {}, open() {} }} configure={configure}
                onConfigured={onConfigured} onChanged={() => {}} onClose={() => {}} testID="setup" />);
            expect(screen.findByTestId('setup.schedule')).not.toBeNull();
            expect(screen.getTextContent()).toContain(schedule
                ? formatAutomationScheduleLabel({ schedule }) : t('projects.deployments.settingsSections.scheduleOff'));
            await act(async () => screen.findAllByType(HappierInputField).find(entry => entry.props.field.path === 'layout')!.props.onChange('modern'));
            await screen.pressByTestIdAsync('setup.save');
            if (schedule === null) expect(onConfigured).not.toHaveBeenCalled();
            else expect(onConfigured).toHaveBeenCalledWith(expect.objectContaining({ destinationRef: {
                pluginId: destination.pluginId, localId: destination.definition.id } }), schedule);
        });

    it('retries schedule authoring without replaying the settled Configure write', async () => {
        const detail = environmentDetail();
        const configure = vi.fn<React.ComponentProps<typeof DeploymentBackupSetupSheet>['configure']>(async draft => ({
            kind: 'configured', environmentId: detail.environment.id, revision: 2,
            configuration: DeploymentBackupConfigurationV1Schema.parse(draft.configuration),
        }));
        const onConfigured = vi.fn<NonNullable<React.ComponentProps<typeof DeploymentBackupSetupSheet>['onConfigured']>>()
            .mockRejectedValueOnce(new HappyError('approval_stale', false, { code: 'approval_stale' })).mockResolvedValueOnce(undefined);
        const onClose = vi.fn();
        const screen = await renderScreen(<DeploymentBackupSetupSheet detail={detail} destination={destination}
            defaults={{ values: { retainPreviousDeployments: 1, backupSchedule: { kind: 'interval', everyMs: 86_400_000,
                scheduleExpr: null, timezone: null } }, sources: { backupSchedule: 'account' } }}
            sourceChoices={[{ kind: 'dump', sourceId: 'database', service: 'database', consistency: 'logical' }]}
            machine="Controller" review={{ pendingId: null, request() {}, open() {} }} configure={configure}
            onConfigured={onConfigured} onChanged={() => {}} onClose={onClose} testID="setup" />);
        await act(async () => screen.findAllByType(HappierInputField).find(entry => entry.props.field.path === 'layout')!.props.onChange('modern'));
        await screen.pressByTestIdAsync('setup.save');
        expect(onClose).not.toHaveBeenCalled();
        const banner = screen.findAllByType(DeployOutcomeBanner).find(entry => entry.props.controller.outcome.kind === 'refused');
        expect(banner).toBeDefined();
        await screen.pressByTestIdAsync('project-deployments.outcome.refused.other.action');
        expect(configure).toHaveBeenCalledOnce();
        expect(onConfigured).toHaveBeenCalledTimes(2);
        expect(onClose).toHaveBeenCalledOnce();
    });
});
