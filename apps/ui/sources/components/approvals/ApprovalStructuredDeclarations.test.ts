import { expect, it } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { describeApprovalActionFields } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { z } from 'zod/v4/mini';
import { MACHINE_POOL_ACTION_IDS_V1 } from '@happier-dev/protocol/machines/pools/actionIdsV1';
import { SERVER_CONFIG } from '@happier-dev/protocol/serverConfig/registry';

// Exercise the real catalog reader with a test-owned private review declaration, restored synchronously.
it.each(['home.hub.layout.update', MACHINE_POOL_ACTION_IDS_V1[0]] as const)('applies declarations and exact parent context in structured operations (%s)', actionId => {
    const spec = getActionSpec(actionId);
    const descriptor = Object.getOwnPropertyDescriptor(spec, 'approvalPresentation');
    const schemaDescriptor = Object.getOwnPropertyDescriptor(spec, 'inputSchema');
    const inputSchema = z.object({ operations: z.array(z.object({
        correlation: z.string(), protocols: z.array(z.string()), placement: z.optional(z.nullable(z.string())),
        settings: z.record(z.string(), z.unknown()),
        target: z.object({ presetId: z.string(), homeId: z.string() }), fingerprint: z.string(),
    })) });
    const declaration: NonNullable<typeof spec.approvalPresentation> = {
        projectInput: value => value, inputSchema,
        inputHints: { fields: [
            { path: 'operations', title: 'Operations', widget: 'json' },
            { path: 'operations.[].protocols.[]', title: 'Protocol', widget: 'select', options: [
                { value: 'wire_v1', label: 'Readable protocol', labelKey: 'common.yes' },
            ] },
        ] },
        technicalInputPaths: ['operations.[].correlation'],
        clearInputPaths: ['operations.[].placement'],
        codeInputPaths: ['operations.[].fingerprint'],
        homeSettingMapInputPaths: ['operations.[].settings'],
        referenceForField: (path, value, _input, parent) => path === 'operations.[].target.presetId'
            && typeof value === 'string' && parent && typeof parent === 'object' && 'homeId' in parent
            && typeof parent.homeId === 'string' ? { kind: 'machinePreset', id: value, homeId: parent.homeId } : undefined,
    };
    Object.defineProperty(spec, 'approvalPresentation', { configurable: true, value: declaration });
    Object.defineProperty(spec, 'inputSchema', { configurable: true, value: inputSchema });
    try {
        const operations = ['first-home', 'second-home'].map(homeId => ({
            correlation: 'opaque-correlation', protocols: ['wire_v1'], placement: null,
            target: { presetId: 'same-preset', homeId }, fingerprint: 'exact-bytes',
            settings: { [SERVER_CONFIG.HAPPIER_HOME_DISPLAY_NAME.key]: null },
        }));
        const result = describeApprovalActionFields({ actionId, actionArgs: { operations }, status: 'open' });
        const row = result.rows.find(row => row.path === 'operations');
        expect(result.unrepresentable).toBeNull();
        expect(row).toMatchObject({ kind: 'value', entries: expect.arrayContaining([
            expect.objectContaining({ value: 'opaque-correlation', technical: true }),
            expect.objectContaining({ value: 'Readable protocol', selectedOptions: expect.arrayContaining([expect.objectContaining({ label: 'Readable protocol', labelKey: 'common.yes' })]) }),
            expect.objectContaining({ label: 'Placement', value: 'null', valueFormat: 'clear' }),
            expect.objectContaining({ value: 'exact-bytes', valueFormat: 'code' }),
            expect.objectContaining({ value: 'null', homeSetting: { key: SERVER_CONFIG.HAPPIER_HOME_DISPLAY_NAME.key, cleared: true } }),
            expect.objectContaining({ reference: { kind: 'machinePreset', id: 'same-preset', homeId: 'first-home' } }),
            expect.objectContaining({ reference: { kind: 'machinePreset', id: 'same-preset', homeId: 'second-home' } }),
        ]) });
        expect(result.rows.filter(row => row.path.includes('protocols'))).toEqual([]);
        const { placement: _cleared, ...omitted } = operations[0]!;
        const absence = describeApprovalActionFields({ actionId, actionArgs: { operations: [omitted] }, status: 'open' });
        const absentRow = absence.rows.find(row => row.path === 'operations');
        expect(absentRow?.kind === 'value' ? absentRow.entries?.filter(entry => entry.valueFormat === 'clear') : undefined).toEqual([]);
    } finally {
        if (schemaDescriptor) Object.defineProperty(spec, 'inputSchema', schemaDescriptor);
        if (descriptor) Object.defineProperty(spec, 'approvalPresentation', descriptor);
        else Reflect.deleteProperty(spec, 'approvalPresentation');
    }
});

it('keeps a selected group named but marks a new allocation technical for the declared variant', () => {
    const spec = getActionSpec('home.hub.layout.update');
    const descriptor = Object.getOwnPropertyDescriptor(spec, 'approvalPresentation');
    const schemaDescriptor = Object.getOwnPropertyDescriptor(spec, 'inputSchema');
    const inputSchema = z.object({ intent: z.object({
        kind: z.enum(['group_create', 'move']), groupId: z.string(),
    }) });
    const declaration: NonNullable<typeof spec.approvalPresentation> = {
        projectInput: value => value, inputSchema,
        inputHints: { fields: [{ path: 'intent', title: 'Intent', widget: 'json' }] },
        technicalInputPaths: [{ path: 'intent.groupId', when: { path: 'intent.kind', equals: 'group_create' } }],
        referenceForField: (path, value) => path === 'intent.groupId' && typeof value === 'string'
            ? { kind: 'homeLayoutItem', id: value } : undefined,
    };
    Object.defineProperty(spec, 'approvalPresentation', { configurable: true, value: declaration });
    Object.defineProperty(spec, 'inputSchema', { configurable: true, value: inputSchema });
    try {
        for (const kind of ['group_create', 'move'] as const) {
            const result = describeApprovalActionFields({ actionId: spec.id,
                actionArgs: { intent: { kind, groupId: 'same-group' } }, status: 'open' });
            const row = result.rows.find(row => row.path === 'intent');
            const group = row?.kind === 'value' ? row.entries?.find(entry => entry.value === 'same-group') : undefined;
            expect(result.unrepresentable).toBeNull();
            if (kind === 'group_create') {
                expect(group).toMatchObject({ technical: true });
                expect(group).not.toHaveProperty('reference');
            } else {
                expect(group).toMatchObject({ reference: { kind: 'homeLayoutItem', id: 'same-group' } });
                expect(group).not.toHaveProperty('technical');
            }
        }
    } finally {
        if (schemaDescriptor) Object.defineProperty(spec, 'inputSchema', schemaDescriptor);
        if (descriptor) Object.defineProperty(spec, 'approvalPresentation', descriptor);
        else Reflect.deleteProperty(spec, 'approvalPresentation');
    }
});
