import { describe, expect, it } from 'vitest';

import type {
    PluginSettingsContributionV2,
    PluginStructuredMessageDescriptorV1,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';

import {
    createStablePluginDeclarativeModel,
    createStablePluginStructuredMessageModel,
} from './declarativeModel';
import { createStablePluginSettingsModel } from './settings';

const settingsContribution: PluginSettingsContributionV2 = {
    id: 'appearance',
    version: 1,
    title: 'Appearance',
    target: { kind: 'plugin' },
    scope: 'local',
    fields: [
        { id: 'enabled', title: 'Enabled', schema: { type: 'boolean' }, default: false },
        {
            id: 'mode',
            title: 'Mode',
            schema: { type: 'string', enum: ['compact', 'full'] },
            default: 'compact',
        },
    ],
    presentation: { sections: [], subagentSections: [] },
};

function expectPluginError(operation: () => unknown, code: string): void {
    try {
        operation();
    } catch (error) {
        expect(error).toBeInstanceOf(PluginError);
        expect((error as PluginError).code).toBe(code);
        return;
    }
    throw new Error(`Expected PluginError '${code}'`);
}

describe('stable declarative plugin model', () => {
    it('normalizes fields and inert qualified actions in deterministic preorder', () => {
        const settings = createStablePluginSettingsModel({
            pluginId: 'com.acme.forms',
            contribution: settingsContribution,
        });

        const model = createStablePluginDeclarativeModel({
            pluginId: 'com.acme.forms',
            generation: 'generation-7',
            renderer: {
                id: 'preferences',
                kind: 'declarative',
                root: {
                    kind: 'stack',
                    children: [
                        { kind: 'field', label: 'Enabled', control: { kind: 'toggle', settingId: 'enabled' } },
                        {
                            kind: 'field',
                            label: 'Mode',
                            control: {
                                kind: 'select',
                                settingId: 'mode',
                                options: [
                                    { value: 'compact', label: 'Compact' },
                                    { value: 'full', label: 'Full' },
                                ],
                            },
                        },
                        { kind: 'action', action: 'save', label: 'Save', input: { source: 'form' } },
                        {
                            kind: 'action',
                            action: { pluginId: 'com.acme.shared', localId: 'reset' },
                            label: 'Reset',
                        },
                    ],
                },
            },
            settings: [settings],
            actions: [
                { pluginId: 'com.acme.forms', localId: 'save' },
                { pluginId: 'com.acme.shared', localId: 'reset' },
            ],
            availability: {
                visible: true,
                enabledActions: {
                    'com.acme.forms/save': true,
                    'com.acme.shared/reset': false,
                },
            },
        });

        expect(model.identity).toEqual({
            pluginId: 'com.acme.forms',
            localId: 'preferences',
            qualifiedId: 'com.acme.forms/preferences',
            generation: 'generation-7',
        });
        expect(model.visible).toBe(true);
        expect(model.nodes.map((node) => [node.kind, node.path, node.order])).toEqual([
            ['stack', 'root', 0],
            ['field', 'root.children[0]', 1],
            ['field', 'root.children[1]', 2],
            ['action', 'root.children[2]', 3],
            ['action', 'root.children[3]', 4],
        ]);
        expect(model.nodes[1]).toMatchObject({
            kind: 'field',
            setting: {
                id: 'enabled',
                qualifiedId: 'com.acme.forms/settings/appearance/fields/enabled',
                descriptor: { schema: { type: 'boolean' } },
            },
        });
        expect(model.nodes[3]).toMatchObject({
            kind: 'action',
            action: {
                identity: { pluginId: 'com.acme.forms', localId: 'save' },
                qualifiedId: 'com.acme.forms/save',
            },
            enabled: true,
            input: { source: 'form' },
        });
        expect(model.nodes[4]).toMatchObject({
            kind: 'action',
            action: { qualifiedId: 'com.acme.shared/reset' },
            enabled: false,
        });
        expect(Object.isFrozen(model)).toBe(true);
    });

    it('fails closed for ambiguous settings, invalid select values, and missing actions', () => {
        const settings = createStablePluginSettingsModel({
            pluginId: 'com.acme.forms',
            contribution: settingsContribution,
        });
        const duplicateFieldSettings = createStablePluginSettingsModel({
            pluginId: 'com.acme.forms',
            contribution: { ...settingsContribution, id: 'other' },
        });
        const base = {
            pluginId: 'com.acme.forms',
            generation: 'generation-7',
            actions: [{ pluginId: 'com.acme.forms', localId: 'save' }],
            availability: { visible: true, enabledActions: {} },
        } as const;

        expectPluginError(() => createStablePluginDeclarativeModel({
            ...base,
            settings: [settings, duplicateFieldSettings],
            renderer: {
                id: 'ambiguous',
                kind: 'declarative',
                root: { kind: 'field', label: 'Enabled', control: { kind: 'toggle', settingId: 'enabled' } },
            },
        }), 'plugin_declarative_setting_ambiguous');

        expectPluginError(() => createStablePluginDeclarativeModel({
            ...base,
            settings: [settings],
            renderer: {
                id: 'bad-option',
                kind: 'declarative',
                root: {
                    kind: 'field',
                    label: 'Mode',
                    control: { kind: 'select', settingId: 'mode', options: [{ value: 'other', label: 'Other' }] },
                },
            },
        }), 'plugin_declarative_option_invalid');

        expectPluginError(() => createStablePluginDeclarativeModel({
            ...base,
            settings: [settings],
            renderer: {
                id: 'missing-action',
                kind: 'declarative',
                root: { kind: 'action', action: 'missing', label: 'Missing' },
            },
        }), 'plugin_declarative_action_missing');
    });

    it('rejects semantically duplicate structured select options', () => {
        const nullPrototypeValue = {
            columns: 2.5,
            nested: [{ score: -0 }],
            valueOf: null,
        };
        Object.setPrototypeOf(nullPrototypeValue, null);
        const settings = createStablePluginSettingsModel({
            pluginId: 'com.acme.forms',
            contribution: {
                id: 'structured',
                version: 1,
                title: 'Structured',
                target: { kind: 'plugin' },
                scope: 'local',
                fields: [{
                    id: 'layout',
                    title: 'Layout',
                    schema: {
                        type: 'object',
                        enum: [nullPrototypeValue],
                    },
                }],
                presentation: { sections: [], subagentSections: [] },
            },
        });

        expectPluginError(() => createStablePluginDeclarativeModel({
            pluginId: 'com.acme.forms',
            generation: 'generation-7',
            settings: [settings],
            actions: [],
            renderer: {
                id: 'duplicate-options',
                kind: 'declarative',
                root: {
                    kind: 'field',
                    label: 'Layout',
                    control: {
                        kind: 'select',
                        settingId: 'layout',
                        options: [
                            { value: nullPrototypeValue, label: 'First' },
                            {
                                value: { valueOf: null, nested: [{ score: 0 }], columns: 2.5 },
                                label: 'Duplicate',
                            },
                        ],
                    },
                },
            },
        }), 'plugin_declarative_option_duplicate');

        let valueOfReads = 0;
        const accessorValue: Record<string, unknown> = { columns: 2.5, nested: [{ score: 0 }] };
        Object.defineProperty(accessorValue, 'valueOf', {
            enumerable: true,
            get() {
                valueOfReads += 1;
                return null;
            },
        });
        expectPluginError(() => createStablePluginDeclarativeModel({
            pluginId: 'com.acme.forms',
            generation: 'generation-7',
            settings: [settings],
            actions: [],
            renderer: {
                id: 'accessor-option',
                kind: 'declarative',
                root: {
                    kind: 'field',
                    label: 'Layout',
                    control: {
                        kind: 'select',
                        settingId: 'layout',
                        options: [{ value: accessorValue, label: 'Unsafe' }],
                    },
                },
            },
        }), 'plugin_declarative_invalid_plain_data');
        expect(valueOfReads).toBe(0);
    });

    it('rejects noncanonical array properties and oversized JSON object keys without retaining them', () => {
        const actionInput: unknown[] = [];
        Object.defineProperty(actionInput, '01', {
            value: 'hidden',
            enumerable: true,
        });
        const base = {
            pluginId: 'com.acme.forms',
            generation: 'generation-7',
            settings: [],
            actions: [{ pluginId: 'com.acme.forms', localId: 'save' }],
        } as const;

        expectPluginError(() => createStablePluginDeclarativeModel({
            ...base,
            renderer: {
                id: 'array-property',
                kind: 'declarative',
                root: { kind: 'action', action: 'save', label: 'Save', input: actionInput },
            },
        }), 'plugin_declarative_invalid_plain_data');

        expectPluginError(() => createStablePluginDeclarativeModel({
            ...base,
            renderer: {
                id: 'oversized-key',
                kind: 'declarative',
                root: {
                    kind: 'action',
                    action: 'save',
                    label: 'Save',
                    input: { ['k'.repeat((256 * 1024) + 1)]: null },
                },
            },
        }), 'plugin_declarative_invalid_plain_data');
    });

    it('maps malformed availability to a coded model error', () => {
        expectPluginError(() => createStablePluginDeclarativeModel({
            pluginId: 'com.acme.forms',
            generation: 'generation-7',
            settings: [],
            actions: [],
            renderer: {
                id: 'malformed-availability',
                kind: 'declarative',
                root: { kind: 'text', text: 'Safe' },
            },
            availability: null as unknown as { visible: boolean; enabledActions: Readonly<Record<string, boolean>> },
        }), 'plugin_declarative_availability_invalid');
    });

    it('maps a malformed identity inventory to its coded domain error', () => {
        expectPluginError(() => createStablePluginDeclarativeModel({
            pluginId: 'com.acme.forms',
            generation: 'generation-7',
            settings: [],
            actions: null as unknown as [],
            renderer: {
                id: 'malformed-actions',
                kind: 'declarative',
                root: { kind: 'text', text: 'Safe' },
            },
        }), 'plugin_action_identity_invalid');
    });
});

describe('stable structured-message plugin model', () => {
    const descriptor: PluginStructuredMessageDescriptorV1 = {
        id: 'build-result',
        title: 'Build result',
        kind: 'acme.build-result.v1',
        payloadSchema: {
            type: 'object',
            properties: { status: { type: 'string', enum: ['passed', 'failed'] } },
            required: ['status'],
            additionalProperties: false,
        },
        renderer: 'result-card',
        actions: ['retry', { pluginId: 'com.acme.shared', localId: 'open-log' }],
        fallback: { kind: 'summary', template: 'Build: {{status}}' },
        availability: { when: { fact: 'session.exists', operator: 'equals', value: true } },
    };

    it('normalizes bounded values, actions, resources, fallback, and generation identity without executing them', () => {
        const model = createStablePluginStructuredMessageModel({
            pluginId: 'com.acme.build',
            generation: 'generation-8',
            descriptor,
            value: {
                kind: 'acme.build-result.v1',
                payload: { status: 'passed' },
                resources: ['report', { pluginId: 'com.acme.shared', localId: 'log' }],
            },
            actions: [
                { pluginId: 'com.acme.build', localId: 'retry' },
                { pluginId: 'com.acme.shared', localId: 'open-log' },
            ],
            resources: [
                { pluginId: 'com.acme.build', localId: 'report' },
                { pluginId: 'com.acme.shared', localId: 'log' },
            ],
            renderers: [{ pluginId: 'com.acme.build', localId: 'result-card' }],
            availability: {
                visible: true,
                enabledActions: {
                    'com.acme.build/retry': false,
                    'com.acme.shared/open-log': true,
                },
            },
        });

        expect(model.identity).toEqual({
            pluginId: 'com.acme.build',
            localId: 'build-result',
            qualifiedId: 'com.acme.build/build-result',
            generation: 'generation-8',
        });
        expect(model.renderer.qualifiedId).toBe('com.acme.build/result-card');
        expect(model.actions.map((action) => [action.qualifiedId, action.enabled])).toEqual([
            ['com.acme.build/retry', false],
            ['com.acme.shared/open-log', true],
        ]);
        expect(model.resources.map((resource) => resource.qualifiedId)).toEqual([
            'com.acme.build/report',
            'com.acme.shared/log',
        ]);
        expect(model.payload).toEqual({ status: 'passed' });
        expect(Object.getPrototypeOf(model.payload)).toBeNull();
        expect(model.fallback).toEqual({ kind: 'summary', template: 'Build: {{status}}' });
        expect(model.visible).toBe(true);
    });

    it('validates values and references, fails conditional visibility closed, and rejects accessors without reading them', () => {
        const base = {
            pluginId: 'com.acme.build',
            generation: 'generation-8',
            descriptor,
            actions: [
                { pluginId: 'com.acme.build', localId: 'retry' },
                { pluginId: 'com.acme.shared', localId: 'open-log' },
            ],
            resources: [{ pluginId: 'com.acme.build', localId: 'report' }],
            renderers: [{ pluginId: 'com.acme.build', localId: 'result-card' }],
        } as const;

        const unavailable = createStablePluginStructuredMessageModel({
            ...base,
            value: { kind: 'acme.build-result.v1', payload: { status: 'passed' }, resources: [] },
        });
        expect(unavailable.visible).toBe(false);
        expect(unavailable.actions.every((action) => action.enabled === false)).toBe(true);

        expectPluginError(() => createStablePluginStructuredMessageModel({
            ...base,
            value: { kind: 'acme.build-result.v1', payload: { status: 'unknown' }, resources: [] },
        }), 'plugin_structured_message_payload_invalid');

        expectPluginError(() => createStablePluginStructuredMessageModel({
            ...base,
            value: { kind: 'acme.build-result.v1', payload: { status: 'passed' }, resources: ['missing'] },
        }), 'plugin_structured_message_resource_missing');

        let getterReads = 0;
        const payload = Object.create(null) as { status: string };
        Object.defineProperty(payload, 'status', {
            enumerable: true,
            get() {
                getterReads += 1;
                return 'passed';
            },
        });
        expectPluginError(() => createStablePluginStructuredMessageModel({
            ...base,
            value: { kind: 'acme.build-result.v1', payload, resources: [] },
        }), 'plugin_structured_message_invalid_plain_data');
        expect(getterReads).toBe(0);
    });

    it('applies nested const and oneOf ambiguity with safe JSON equality', () => {
        const nullPrototypePayload = {
            rows: [{ score: 1.5 }],
            valueOf: null,
        };
        Object.setPrototypeOf(nullPrototypePayload, null);
        const base = {
            pluginId: 'com.acme.build',
            generation: 'generation-8',
            actions: [],
            resources: [],
            renderers: [{ pluginId: 'com.acme.build', localId: 'result-card' }],
        } as const;
        const exact = createStablePluginStructuredMessageModel({
            ...base,
            descriptor: {
                ...descriptor,
                actions: [],
                payloadSchema: { const: nullPrototypePayload },
            },
            value: {
                kind: 'acme.build-result.v1',
                payload: { valueOf: null, rows: [{ score: 1.5 }] },
                resources: [],
            },
        });
        expect(exact.payload).toEqual({ valueOf: null, rows: [{ score: 1.5 }] });

        expectPluginError(() => createStablePluginStructuredMessageModel({
            ...base,
            descriptor: {
                ...descriptor,
                actions: [],
                payloadSchema: {
                    oneOf: [
                        { const: nullPrototypePayload },
                        { enum: [{ valueOf: null, rows: [{ score: 1.5 }] }] },
                    ],
                },
            },
            value: {
                kind: 'acme.build-result.v1',
                payload: nullPrototypePayload,
                resources: [],
            },
        }), 'plugin_structured_message_payload_invalid');

    });

    it('accepts the exact serialized payload limit and classifies limit-plus-one overflow', () => {
        const exactPayload = 'x'.repeat((1024 * 1024) - 2);
        const exact = createStablePluginStructuredMessageModel({
            pluginId: 'com.acme.build',
            generation: 'generation-8',
            descriptor: {
                ...descriptor,
                payloadSchema: { type: 'string' },
                actions: [],
            },
            value: {
                kind: 'acme.build-result.v1',
                payload: exactPayload,
                resources: [],
            },
            actions: [],
            resources: [],
            renderers: [{ pluginId: 'com.acme.build', localId: 'result-card' }],
        });
        expect(exact.payload).toBe(exactPayload);

        expectPluginError(() => createStablePluginStructuredMessageModel({
            pluginId: 'com.acme.build',
            generation: 'generation-8',
            descriptor: {
                ...descriptor,
                payloadSchema: { type: 'string' },
                actions: [],
            },
            value: {
                kind: 'acme.build-result.v1',
                payload: 'x'.repeat((1024 * 1024) + 1),
                resources: [],
            },
            actions: [],
            resources: [],
            renderers: [{ pluginId: 'com.acme.build', localId: 'result-card' }],
        }), 'plugin_structured_message_payload_bounded');
    });

    it('rejects malformed resource identities with a coded boundary error', () => {
        expectPluginError(() => createStablePluginStructuredMessageModel({
            pluginId: 'com.acme.build',
            generation: 'generation-8',
            descriptor: { ...descriptor, actions: [] },
            value: {
                kind: 'acme.build-result.v1',
                payload: { status: 'passed' },
                resources: ['INVALID'],
            },
            actions: [],
            resources: [],
            renderers: [{ pluginId: 'com.acme.build', localId: 'result-card' }],
        }), 'plugin_structured_message_resource_identity_invalid');
    });

    it('rejects extra structured-value envelope fields', () => {
        const valueWithExtraField = {
            kind: 'acme.build-result.v1',
            payload: { status: 'passed' },
            resources: [],
            executable: 'never',
        };
        expectPluginError(() => createStablePluginStructuredMessageModel({
            pluginId: 'com.acme.build',
            generation: 'generation-8',
            descriptor: { ...descriptor, actions: [] },
            value: valueWithExtraField,
            actions: [],
            resources: [],
            renderers: [{ pluginId: 'com.acme.build', localId: 'result-card' }],
        }), 'plugin_structured_message_value_invalid');
    });

    it('maps a malformed structured-value envelope to a coded model error', () => {
        expectPluginError(() => createStablePluginStructuredMessageModel({
            pluginId: 'com.acme.build',
            generation: 'generation-8',
            descriptor: { ...descriptor, actions: [] },
            value: null as unknown as { kind: string; payload: null },
            actions: [],
            resources: [],
            renderers: [{ pluginId: 'com.acme.build', localId: 'result-card' }],
        }), 'plugin_structured_message_value_invalid');
    });
});
