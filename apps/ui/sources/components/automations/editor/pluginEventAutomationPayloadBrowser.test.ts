import { describe, expect, it } from 'vitest';

import { buildPluginEventAutomationPayloadBrowser } from './pluginEventAutomationPayloadBrowser';

describe('Plugin Event Automation payload browser', () => {
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
            { pointer: '/action', scalarKind: 'string', sampleValue: 'opened' },
            { pointer: '/repository/id', scalarKind: 'number', sampleValue: 1 },
            { pointer: '/repository/display~1name', scalarKind: 'string', sampleValue: 'happier' },
            { pointer: '/draft', scalarKind: 'boolean', sampleValue: true },
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
            { pointer: '/kind', scalarKind: 'string', sampleValue: 'push' },
            { pointer: '/eventId', scalarKind: 'string', sampleValue: 'event-1' },
            { pointer: '/repository/id', scalarKind: 'number', sampleValue: 1 },
            { pointer: '/ref', scalarKind: 'string', sampleValue: 'refs/heads/main' },
            { pointer: '/issue/number', scalarKind: 'number', sampleValue: 1 },
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
});
