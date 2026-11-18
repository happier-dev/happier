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
import { ValueFieldSelect } from '@/components/ui/forms/ValueFieldSelect';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { DeploymentBackupSetupSheet, preferredBackupDestination } = await import('./DeploymentBackupControls');
afterEach(standardCleanup);
/** Configure-mode props of the sheet (its props are a Configure | intent union). */
type ConfigureProps = Extract<React.ComponentProps<typeof DeploymentBackupSetupSheet>, { mode?: 'configure' }>;

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
        const configure = vi.fn<ConfigureProps['configure']>(async draft => ({
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
            const configure = vi.fn<ConfigureProps['configure']>(async draft => ({
                kind: 'configured', environmentId: detail.environment.id, revision: 2,
                configuration: DeploymentBackupConfigurationV1Schema.parse(draft.configuration),
            }));
            const onConfigured = vi.fn<NonNullable<ConfigureProps['onConfigured']>>(async () => {});
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

    describe('provider presets', () => {
        const preset: typeof destination = { ...destination, id: 'com.acme.backups/archive-preset', definition: {
            ...destination.definition, id: 'archive-preset', title: 'Archive preset', fieldHints: { fields: [{
                ...destination.definition.fieldHints!.fields[0]!, defaultValue: 'modern' }] } } };
        const render = (props: Partial<ConfigureProps>, configure = vi.fn<
            ConfigureProps['configure']>(async draft => ({
            kind: 'configured', environmentId: 'env', revision: 2,
            configuration: DeploymentBackupConfigurationV1Schema.parse(draft.configuration) }))) => renderScreen(
            <DeploymentBackupSetupSheet detail={environmentDetail()} destination={destination}
                sourceChoices={[{ kind: 'dump', sourceId: 'database', service: 'database', consistency: 'logical' }]} machine="Controller"
                review={{ pendingId: null, request() {}, open() {} }} configure={configure} onChanged={() => {}}
                onClose={() => {}} testID="setup" {...props} />);
        const layout = (screen: Awaited<ReturnType<typeof render>>) => screen.findAllByType(HappierInputField)
            .find(entry => entry.props.field.path === 'layout')!;

        it('opens a preset destination with its descriptor defaults and saves them unchanged', async () => {
            const configure = vi.fn<ConfigureProps['configure']>(async draft => ({
                kind: 'configured', environmentId: 'env', revision: 2,
                configuration: DeploymentBackupConfigurationV1Schema.parse(draft.configuration) }));
            const screen = await render({ destination: preset }, configure);
            expect(layout(screen).props.value).toBe('modern');
            await screen.pressByTestIdAsync('setup.save');
            expect(configure).toHaveBeenCalledWith(expect.objectContaining({
                configuration: expect.objectContaining({ config: { layout: 'modern' } }) }));
        });

        it('replaces the draft with the newly chosen preset defaults', async () => {
            const screen = await render({ destinations: [destination, preset] });
            expect(layout(screen).props.value).toBeUndefined();
            await act(async () => screen.findAllByType(ValueFieldSelect)
                .find(entry => entry.props.testID === 'setup.destination')!.props.onSelect(preset.id));
            expect(layout(screen).props.value).toBe('modern');
        });

        it('keeps authored values when reopening a saved draft', async () => {
            const screen = await renderScreen(<DeploymentBackupSetupSheet detail={environmentDetail()} destination={preset}
                sourceChoices={[{ kind: 'dump', sourceId: 'database', service: 'database', consistency: 'logical' }]} machine="Controller"
                mode="intent" onIntent={() => {}} onClose={() => {}} testID="setup" initialIntent={{ prefix: '', bindings: [],
                    configuration: { configRevision: 1, destinationRef: { pluginId: preset.pluginId, localId: preset.definition.id },
                        occurrenceId: preset.definition.id, config: { layout: 'legacy' },
                        sources: [{ kind: 'dump', sourceId: 'database', service: 'database', consistency: 'logical' }],
                        credentialBindings: [], retention: { kind: 'keepEverything' } } }} />);
            expect(layout(screen).props.value).toBe('legacy');
        });
    });

    it('retries schedule authoring without replaying the settled Configure write', async () => {
        const detail = environmentDetail();
        const configure = vi.fn<ConfigureProps['configure']>(async draft => ({
            kind: 'configured', environmentId: detail.environment.id, revision: 2,
            configuration: DeploymentBackupConfigurationV1Schema.parse(draft.configuration),
        }));
        const onConfigured = vi.fn<NonNullable<ConfigureProps['onConfigured']>>()
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

    it('offers to initialize a repository only after Test found none there (PAGE-ACCEPT-176 D20)', async () => {
        const detail = environmentDetail();
        const configure = vi.fn<ConfigureProps['configure']>(async draft => draft.intent === 'test'
            ? { kind: 'tested', test: { kind: 'failed', step: 'repository', reason: 'repository_missing', nativeExitCode: 10,
                remedy: 'review_destination' } }
            : { kind: 'configured', environmentId: detail.environment.id, revision: 2,
                configuration: DeploymentBackupConfigurationV1Schema.parse(draft.configuration) });
        const screen = await renderScreen(<DeploymentBackupSetupSheet detail={detail} destination={destination}
            sourceChoices={[{ kind: 'dump', sourceId: 'database', service: 'database', consistency: 'logical' }]}
            machine="Controller" review={{ pendingId: null, request() {}, open() {} }} configure={configure}
            onChanged={() => {}} onClose={() => {}} testID="setup" />);
        await act(async () => screen.findAllByType(HappierInputField).find(entry => entry.props.field.path === 'layout')!.props.onChange('modern'));
        expect(screen.findByTestId('setup.initialize')).toBeNull();
        // A bucket has no disk to read free space from.
        expect(screen.findByTestId('setup.capacityReview')).toBeNull();
        await screen.pressByTestIdAsync('setup.test');
        await screen.pressByTestIdAsync('setup.initialize');
        expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({ intent: 'initializeAndSave' }));
    });

    it('opens on the destination last used, else this Machine, never simply the first plugin', () => {
        const local: typeof destination = { ...destination, id: 'happier.backup.destinations/local', pluginId: 'happier.backup.destinations',
            definition: { ...destination.definition, id: 'local', locality: 'local' } };
        const sftp: typeof destination = { ...destination, id: 'happier.backup.destinations/sftp', pluginId: 'happier.backup.destinations',
            definition: { ...destination.definition, id: 'sftp' } };
        expect(preferredBackupDestination([destination, sftp, local], null)).toBe(local);
        expect(preferredBackupDestination([destination, sftp, local], { pluginId: sftp.pluginId, localId: 'sftp' })).toBe(sftp);
        expect(preferredBackupDestination([destination, sftp], undefined)).toBe(destination);
    });
});
