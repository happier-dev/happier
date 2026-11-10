import * as React from 'react';
import { View } from 'react-native';
import { MACHINE_PROVISIONER_SIZE_DIMENSIONS_V1, readMachineProvisionerResizeCapabilityV1, readMachineProvisionerResizeRequirementsV1,
    type MachineProvisionerContributionV1, type MachineProvisionerSizeV1,
    type MachineProvisionerSizeDimensionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { MachineProvisionerSizeV1Schema } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { EffectiveActionInputField } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { ActionInputFields } from '@/components/sessions/actions/ActionInputFields';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { formatManagedSizeBytes } from './managedConfigurationPresentation';

const GIB = 1024 ** 3;
const NO_OPTIONS = () => [];
const fieldLabel = (dimension: MachineProvisionerSizeDimensionV1) => dimension === 'cpuCores'
    ? t('managedMachines.config.columns.cpu') : dimension === 'memoryBytes'
        ? t('managedMachines.resize.memory') : t('managedMachines.resize.disk');
const fieldValue = (dimension: MachineProvisionerSizeDimensionV1, value: number | undefined) =>
    value === undefined ? undefined : dimension === 'cpuCores' ? value : value / GIB;
const physicalValue = (dimension: MachineProvisionerSizeDimensionV1, value: unknown) =>
    typeof value !== 'number' ? value : dimension === 'cpuCores' ? value : value * GIB;

/** The configurator's free-form size picker, shown beneath the existing receipt for one reviewed resize. */
export function ManagedMachineResize(props: Readonly<{
    machine: ManagedMachineV1;
    descriptor?: Pick<MachineProvisionerContributionV1, 'resize'>;
    disabled: boolean;
    pending: boolean;
    onCancel: () => void;
    onConfirm: (size: MachineProvisionerSizeV1) => void;
}>) {
    const current = props.machine.observation?.size;
    const created = props.machine.reviewedFacts?.nativeFacts?.size;
    const [input, setInput] = React.useState<Record<string, unknown>>(() => Object.fromEntries(
        MACHINE_PROVISIONER_SIZE_DIMENSIONS_V1.map(dimension => [dimension, fieldValue(dimension, current?.[dimension])])));
    const desired = Object.fromEntries(MACHINE_PROVISIONER_SIZE_DIMENSIONS_V1.flatMap(dimension => {
        const capability = readMachineProvisionerResizeCapabilityV1(props.descriptor ?? {}, dimension);
        const value = physicalValue(dimension, input[dimension]);
        return capability.kind === 'supported' && value !== undefined && value !== current?.[dimension] ? [[dimension, value]] : [];
    }));
    const parsed = MachineProvisionerSizeV1Schema.safeParse(desired);
    const fields: EffectiveActionInputField[] = MACHINE_PROVISIONER_SIZE_DIMENSIONS_V1.map(dimension => {
        const capability = readMachineProvisionerResizeCapabilityV1(props.descriptor ?? {}, dimension);
        return { path: dimension, widget: 'number', title: fieldLabel(dimension), visible: true, required: false,
            disabled: capability.kind === 'unsupported',
            ...(capability.kind === 'supported' && capability.changes === 'grow-only'
                ? { description: t('managedMachines.resize.growOnly') } : {}) };
    });
    const requirements = parsed.success
        ? readMachineProvisionerResizeRequirementsV1(props.descriptor ?? {}, parsed.data, current) : null;
    const restart = requirements?.kind === 'supported' && requirements.requiresRestart;
    const describeSize = (size: MachineProvisionerSizeV1 | undefined) => MACHINE_PROVISIONER_SIZE_DIMENSIONS_V1.flatMap(dimension => {
        const value = size?.[dimension];
        if (value === undefined) return [];
        return [dimension === 'cpuCores' ? t('managedMachines.receipt.cores', { count: value }) : formatManagedSizeBytes(value)];
    }).join(' · ') || t('common.unknown');
    return <View testID="managed-machine.resize-review">
        <ItemGroup title={t('managedMachines.resize.title')}>
            <Item testID="managed-machine.resize-current" title={t('managedMachines.resize.current')}
                subtitle={describeSize(props.machine.observation?.size)} mode="info" showChevron={false} />
            {!current && created ? <Item title={t('managedMachines.resize.reviewed')}
                subtitle={describeSize(created)} mode="info" showChevron={false} /> : null}
            {fields.map(field => {
                const dimension = field.path as MachineProvisionerSizeDimensionV1;
                const capability = readMachineProvisionerResizeCapabilityV1(props.descriptor ?? {}, dimension);
                return <React.Fragment key={field.path}>
                    <SectionContentRow><ActionInputFields fields={[field]} input={input} editable={!props.disabled} busy={props.pending}
                        resolveFieldOptions={NO_OPTIONS} onPatch={patch => setInput(value => ({ ...value, ...patch }))}
                        resolveFieldTestID={() => `managed-machine.resize-field:${field.path}`} /></SectionContentRow>
                    {capability.kind === 'unsupported' ? <SurfaceStateCard kind="unavailable" size="line"
                        testID={`managed-machine.resize-unsupported:${dimension}`} title={t('managedMachines.resize.unsupported')}
                        diagnosticCode={capability.code} /> : null}
                </React.Fragment>;
            })}
        </ItemGroup>
        <ItemGroup surface="none">
            <SectionButtonRow footnote={parsed.success && requirements?.kind === 'supported'
                ? t(restart ? 'managedMachines.resize.restart' : 'managedMachines.resize.live') : undefined}
                footnoteTestID="managed-machine.resize-consequence" trailing={<>
                    <RoundButton title={t('common.cancel')} display="inverted" size="small" disabled={props.pending}
                        testID="managed-machine.resize-cancel" onPress={props.onCancel} />
                    <RoundButton title={t('managedMachines.resize.confirm')} size="small"
                        testID="managed-machine.resize-confirm" disabled={props.disabled || !parsed.success || requirements?.kind !== 'supported'}
                        loading={props.pending} onPress={() => { if (!props.disabled && parsed.success && requirements?.kind === 'supported') props.onConfirm(parsed.data); }} />
                </>}>{null}</SectionButtonRow>
        </ItemGroup>
    </View>;
}
