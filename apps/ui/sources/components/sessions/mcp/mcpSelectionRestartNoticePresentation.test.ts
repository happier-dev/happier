import { describe, expect, it } from 'vitest';

import { buildMcpSelectionRestartNoticePresentation } from './mcpSelectionRestartNoticePresentation';

const translate = (key: string) => key;

const changedMetadata = {
    mcpSelectionV1: {
        v: 1 as const,
        managedServersEnabled: true,
        forceIncludeServerIds: ['server-new'],
        forceExcludeServerIds: [],
    },
    mcpSelectionRestartRequiredV1: {
        v: 1 as const,
        appliedSelection: {
            v: 1 as const,
            managedServersEnabled: true,
            forceIncludeServerIds: [],
            forceExcludeServerIds: [],
        },
    },
};

describe('buildMcpSelectionRestartNoticePresentation', () => {
    it('builds a banner and badge for a real active-session selection change', () => {
        expect(buildMcpSelectionRestartNoticePresentation({
            sessionActive: true,
            metadata: changedMetadata,
            operationStatus: null,
            translate,
        })).toMatchObject({
            banner: {
                testID: 'session.mcpSelectionRestartRequired.banner',
                title: 'session.mcpRestartRequired.title',
                body: 'session.mcpRestartRequired.body',
                primaryAction: {
                    label: 'session.mcpRestartRequired.restartAction',
                    disabled: false,
                },
            },
            badge: {
                key: 'session-mcp-selection-restart-required',
                label: 'session.mcpRestartRequired.badgeLabel',
                tone: 'warning',
            },
        });
    });

    it('does not show for inactive sessions or an effectively unchanged selection', () => {
        expect(buildMcpSelectionRestartNoticePresentation({
            sessionActive: false,
            metadata: changedMetadata,
            operationStatus: null,
            translate,
        })).toBeNull();

        expect(buildMcpSelectionRestartNoticePresentation({
            sessionActive: true,
            metadata: {
                mcpSelectionV1: changedMetadata.mcpSelectionV1,
                mcpSelectionRestartRequiredV1: {
                    v: 1,
                    appliedSelection: {
                        ...changedMetadata.mcpSelectionV1,
                        forceIncludeServerIds: ['server-new', 'server-new'],
                    },
                },
            },
            operationStatus: null,
            translate,
        })).toBeNull();
    });

    it('disables the restart action while pending and explains a failed restart', () => {
        expect(buildMcpSelectionRestartNoticePresentation({
            sessionActive: true,
            metadata: changedMetadata,
            operationStatus: 'pending',
            translate,
        })?.banner.primaryAction).toMatchObject({
            label: 'session.mcpRestartRequired.restartPendingAction',
            disabled: true,
        });

        expect(buildMcpSelectionRestartNoticePresentation({
            sessionActive: true,
            metadata: changedMetadata,
            operationStatus: 'failed',
            translate,
        })?.banner.body).toBe('session.mcpRestartRequired.failureBody');
    });
});
