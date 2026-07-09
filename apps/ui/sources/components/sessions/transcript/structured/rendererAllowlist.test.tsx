import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { PluginStructuredMessageRendererIdV1Schema } from '@happier-dev/protocol/plugins/ui';

import { renderScreen } from '@/dev/testkit';
import type { PluginUiStructuredMessageProjection } from '@/sync/domains/plugins/ui/projection';

import {
    HOST_STRUCTURED_MESSAGE_RENDERER_IDS,
    renderPluginStructuredMessage,
    type PluginStructuredMessageRendererId,
} from './rendererAllowlist';

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

function descriptorForRenderer(rendererId: PluginStructuredMessageRendererId): PluginUiStructuredMessageProjection {
    return {
        id: `structuredMessage:acme.preview:${rendererId}`,
        pluginId: 'acme.preview',
        contributionKind: 'structuredMessage',
        descriptorId: rendererId,
        kind: `acme.preview/${rendererId}.v1`,
        renderer: { kind: 'host', rendererId },
        display: { titleKey: 'preview.title' },
        payloadSchema: { type: 'object' },
    };
}

const rendererCases = [
    {
        rendererId: 'actionList',
        payload: {
            title: 'Available actions',
            actions: [
                { id: 'open', label: 'Open preview', status: 'ready' },
            ],
        },
        expectedTestIds: ['plugin-structured-message-action-0'],
        expectedText: ['Available actions', 'Open preview', 'ready'],
    },
    {
        rendererId: 'keyValue',
        payload: {
            title: 'Preview details',
            items: [
                { key: 'Port', value: '4173' },
            ],
        },
        expectedTestIds: ['plugin-structured-message-key-value-row-0'],
        expectedText: ['Preview details', 'Port', '4173'],
    },
    {
        rendererId: 'markdownSummary',
        payload: {
            title: 'Release notes',
            markdown: 'Preview build finished\n\n- Artifacts uploaded',
        },
        expectedTestIds: ['plugin-structured-message-markdown-summary'],
        expectedText: ['Release notes', 'Preview build finished', 'Artifacts uploaded'],
    },
    {
        rendererId: 'notice',
        payload: {
            title: 'Needs attention',
            message: 'Token expired',
            severity: 'warning',
        },
        expectedTestIds: ['plugin-structured-message-notice'],
        expectedText: ['Needs attention', 'Token expired', 'warning'],
    },
    {
        rendererId: 'resourceLink',
        payload: {
            label: 'Preview URL',
            url: 'https://example.test/preview',
        },
        expectedTestIds: ['plugin-structured-message-resource-link'],
        expectedText: ['Preview URL', 'https://example.test/preview'],
    },
    {
        rendererId: 'status',
        payload: {
            label: 'Preview sync',
            status: 'running',
            detail: '2 checks left',
        },
        expectedTestIds: ['plugin-structured-message-status'],
        expectedText: ['Preview sync', 'running', '2 checks left'],
    },
    {
        rendererId: 'summaryCard',
        payload: {
            title: 'Preview ready',
            summary: 'Open the local preview when you need to inspect it.',
        },
        expectedTestIds: ['plugin-structured-message-title', 'plugin-structured-message-summary'],
        expectedText: ['Preview ready', 'Open the local preview'],
    },
] as const satisfies readonly Readonly<{
    rendererId: PluginStructuredMessageRendererId;
    payload: unknown;
    expectedTestIds: readonly string[];
    expectedText: readonly string[];
}>[];

describe('host structured-message renderer allowlist', () => {
    it('matches the canonical protocol renderer-id enum exactly (single source, no drift)', () => {
        expect([...HOST_STRUCTURED_MESSAGE_RENDERER_IDS].sort()).toEqual(
            [...PluginStructuredMessageRendererIdV1Schema.options].sort(),
        );
    });
});

describe('renderPluginStructuredMessage', () => {
    it.each(rendererCases)('renders bounded payload fields for $rendererId', async (testCase) => {
        const rendered = renderPluginStructuredMessage({
            descriptor: descriptorForRenderer(testCase.rendererId),
            payload: testCase.payload,
        });
        expect(rendered).not.toBeNull();

        const screen = await renderScreen(
            rendered!,
        );

        expect(screen.findByTestId(`plugin-structured-message-${testCase.rendererId}`)).toBeTruthy();
        for (const testID of testCase.expectedTestIds) {
            expect(screen.findByTestId(testID)).toBeTruthy();
        }
        const serialized = JSON.stringify(screen.tree.toJSON());
        for (const expectedText of testCase.expectedText) {
            expect(serialized).toContain(expectedText);
        }
    });
});
