import { describe, expect, it } from 'vitest';

import type { SessionSubagent } from './types';
import { deriveSessionSubagentActivityPreview } from './deriveSessionSubagentActivityPreview';

const baseSubagent: SessionSubagent = {
    id: 'agent_team_member:qa:beta@qa',
    kind: 'agent_team_member',
    status: 'terminated',
    display: { title: 'beta', providerLabel: 'Claude', groupKey: 'qa', groupLabel: 'qa' },
    transcript: { sidechainId: 'toolu_beta', toolId: 'toolu_beta', toolMessageRouteId: 'tool:toolu_beta' },
    recipient: { kind: 'agent_team_member', teamId: 'qa', memberId: 'beta@qa', memberLabel: 'beta' },
    capabilities: { canOpen: true, canSend: false, canStop: false, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: false },
    timestamps: {},
};

describe('deriveSessionSubagentActivityPreview', () => {
    it('returns the latest normal text preview for standard subagent transcripts', () => {
        const preview = deriveSessionSubagentActivityPreview({
            subagent: {
                ...baseSubagent,
                id: 'execution_run:run_1',
                kind: 'execution_run',
                status: 'succeeded',
                display: { title: 'Delegate execution run', providerLabel: 'claude' },
                transcript: { sidechainId: 'toolu_run', toolId: 'toolu_run', toolMessageRouteId: 'tool:toolu_run' },
                runRef: { runId: 'run_1', backendId: 'claude', intent: 'delegate' },
                recipient: { kind: 'execution_run', runId: 'run_1', label: 'Delegate execution run' },
                capabilities: { canOpen: true, canSend: false, canStop: false, canLaunchChild: false, canDelete: false, canOpenAdvancedRun: true },
            },
            reducerState: {
                sidechains: new Map([
                    ['toolu_run', [
                        { text: 'Earlier line' },
                        { text: 'Done — all 30 ticks completed.' },
                    ]],
                ]),
            },
        });

        expect(preview).toBe('Done — all 30 ticks completed.');
    });

    it('skips raw shutdown lifecycle payloads and keeps the latest meaningful Claude teammate output', () => {
        const preview = deriveSessionSubagentActivityPreview({
            subagent: baseSubagent,
            reducerState: {
                sidechains: new Map([
                    ['toolu_beta', [
                        { text: 'There is no AGENTS.md inside the live-ui-manual-qa-repo directory.' },
                        { text: '{"type":"idle_notification","from":"beta","timestamp":"2026-03-05T23:27:04.238Z","idleReason":"available"}' },
                        { text: '{"type":"shutdown_approved","requestId":"shutdown-1772753156778@beta","from":"beta","timestamp":"2026-03-05T23:27:07.540Z","paneId":"in-process","backendType":"in-process"}' },
                    ]],
                ]),
            },
        });

        expect(preview).toBe('There is no AGENTS.md inside the live-ui-manual-qa-repo directory.');
    });

    it('skips double-encoded lifecycle payloads when scanning from newest to oldest', () => {
        const preview = deriveSessionSubagentActivityPreview({
            subagent: baseSubagent,
            reducerState: {
                sidechains: new Map([
                    ['toolu_beta', [
                        { text: 'Beta finished scanning headings.' },
                        { text: '"{\\"type\\":\\"shutdown_approved\\",\\"from\\":\\"beta\\"}"' },
                    ]],
                ]),
            },
        });

        expect(preview).toBe('Beta finished scanning headings.');
    });
});
