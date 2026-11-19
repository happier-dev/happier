import { describe, expect, it } from 'vitest';
import { AUTOMATION_SESSION_LIFECYCLE_FILTER_PAYLOAD_SCHEMA_V1 } from '@happier-dev/protocol/automations/automationSessionLifecycle';

import { buildPluginEventAutomationPayloadBrowser } from './pluginEventAutomationPayloadBrowser';

describe('Plugin Event Automation payload browser', () => {
    it('offers the canonical nullable Session habit facts to the shared filter controls', () => {
        const browser = buildPluginEventAutomationPayloadBrowser(AUTOMATION_SESSION_LIFECYCLE_FILTER_PAYLOAD_SCHEMA_V1);
        expect(browser.fields).toEqual([
            { pointer: '/launchProfileId', label: 'Launch profile id', scalarKind: 'string', sampleValue: '' },
            { pointer: '/changedFiles', label: 'Changed files', scalarKind: 'boolean', sampleValue: true },
        ]);
    });
    it('exposes only declared scalar leaves of a strict payload object and renders a bounded sample', () => {
        const browser = buildPluginEventAutomationPayloadBrowser({
            type: 'object',
            additionalProperties: false,
            properties: {
                action: { type: 'string', default: 'opened' },
                repository: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        id: { type: 'integer', minimum: 1 },
                        'display/name': { type: 'string', const: 'happier' },
                    },
                },
                draft: { type: 'boolean' },
            },
        });

        expect(browser.fields).toEqual([
            { pointer: '/action', label: 'Action', scalarKind: 'string', sampleValue: 'opened' },
            { pointer: '/repository/id', label: 'Repository · Id', scalarKind: 'number', sampleValue: 1 },
            { pointer: '/repository/display~1name', label: 'Repository · Display/name', scalarKind: 'string', sampleValue: 'happier' },
            { pointer: '/draft', label: 'Draft', scalarKind: 'boolean', sampleValue: true },
        ]);
        expect(browser.samplePayload).toEqual({
            action: 'opened',
            repository: { id: 1, 'display/name': 'happier' },
            draft: true,
        });
    });

    it('fails closed for dynamic, collection, and union branches rather than inventing filter paths', () => {
        const browser = buildPluginEventAutomationPayloadBrowser({
            type: 'object',
            additionalProperties: false,
            properties: {
                dynamic: {
                    type: 'object',
                    additionalProperties: { type: 'string' },
                },
                labels: { type: 'array', items: { type: 'string' } },
                state: { oneOf: [{ type: 'string' }, { type: 'number' }] },
            },
        });

        expect(browser.fields).toEqual([]);
        expect(browser.samplePayload).toEqual({});
    });

    it('browses declared scalar leaves across strict root alternatives without treating a union as dynamic data', () => {
        const browser = buildPluginEventAutomationPayloadBrowser({
            oneOf: [{
                type: 'object',
                additionalProperties: false,
                properties: {
                    kind: { const: 'push' },
                    eventId: { type: 'string', default: 'event-1' },
                    repository: {
                        type: 'object',
                        additionalProperties: false,
                        properties: { id: { type: 'integer', minimum: 1 } },
                    },
                    ref: { type: 'string', default: 'refs/heads/main' },
                },
            }, {
                type: 'object',
                additionalProperties: false,
                properties: {
                    kind: { const: 'issueOpened' },
                    eventId: { type: 'string', default: 'event-2' },
                    repository: {
                        type: 'object',
                        additionalProperties: false,
                        properties: { id: { type: 'integer', minimum: 1 } },
                    },
                    issue: {
                        type: 'object',
                        additionalProperties: false,
                        properties: { number: { type: 'integer', minimum: 1 } },
                    },
                },
            }],
        });

        expect(browser.fields).toEqual([
            { pointer: '/kind', label: 'Kind', scalarKind: 'string', sampleValue: 'push' },
            { pointer: '/eventId', label: 'Event id', scalarKind: 'string', sampleValue: 'event-1' },
            { pointer: '/repository/id', label: 'Repository · Id', scalarKind: 'number', sampleValue: 1 },
            { pointer: '/ref', label: 'Ref', scalarKind: 'string', sampleValue: 'refs/heads/main' },
            { pointer: '/issue/number', label: 'Issue · Number', scalarKind: 'number', sampleValue: 1 },
        ]);
        expect(browser.samplePayload).toEqual({
            kind: 'push',
            eventId: 'event-1',
            repository: { id: 1 },
            ref: 'refs/heads/main',
        });
    });

    it('withholds the browser when the root payload shape is not a declared strict object', () => {
        expect(buildPluginEventAutomationPayloadBrowser({
            type: 'object',
            properties: { action: { type: 'string' } },
        })).toEqual({ fields: [], samplePayload: null });
    });
    it('names each field for people: its declared title, else its key path in words (#184 F3)', () => {
        const browser = buildPluginEventAutomationPayloadBrowser({
            type: 'object',
            additionalProperties: false,
            properties: {
                issueFingerprint: { type: 'string' },
                providerUpdatedAt: { type: 'integer', title: 'Last changed in Sentry' },
                evidence: { type: 'object', additionalProperties: false, properties: { v: { const: 1 } } },
            },
        });
        expect(browser.fields.map((field) => [field.pointer, field.label])).toEqual([
            ['/issueFingerprint', 'Issue fingerprint'],
            ['/providerUpdatedAt', 'Last changed in Sentry'],
            ['/evidence/v', 'Evidence · V'],
        ]);
    });
});
