import type { NormalizedMessage } from '@happier-dev/session-core/raw';
import type { SessionMessageProvenance, SessionMessageSendResultV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';

import type { Session } from '@/sync/domains/state/storageTypes';

import { DEMO_MACHINE_ID, DEMO_NOW_MS, DEMO_PROJECT_PATH, DEMO_SECONDARY_MACHINE_ID } from './constants';

export const DEMO_SUBAGENTS_SESSION_ID = 'demo-session-auth-implementation';
export const DEMO_SESSION_MESSAGES_SESSION_ID = 'demo-session-auth-review';
export const DEMO_BROWSER_CONTEXT_SESSION_ID = 'demo-session-checkout-polish';

type FeatureSessionSeed = Readonly<{
    id: string;
    machineId: string;
    title: string;
    path: string;
    active: boolean;
    activeAt: number;
    seq: number;
    thinking: boolean;
    flavor: string;
}>;

// Consume the existing persisted-session fixture without importing sessions.ts
// back into its own seed dependency.
export function buildDemoFeatureSessions(createSession: (seed: FeatureSessionSeed) => Session): Session[] {
    return [
        createSession({
            id: DEMO_BROWSER_CONTEXT_SESSION_ID, machineId: DEMO_MACHINE_ID,
            title: 'Checkout polish', path: DEMO_PROJECT_PATH,
            active: false, activeAt: DEMO_NOW_MS - 5_000, seq: 3, thinking: false, flavor: 'opencode',
        }),
        createSession({
            id: DEMO_SUBAGENTS_SESSION_ID,
            machineId: DEMO_MACHINE_ID,
            title: 'Auth implementation',
            path: DEMO_PROJECT_PATH,
            active: true,
            activeAt: DEMO_NOW_MS,
            seq: 20,
            thinking: true,
            flavor: 'claude',
        }),
        createSession({
            id: DEMO_SESSION_MESSAGES_SESSION_ID,
            machineId: DEMO_SECONDARY_MACHINE_ID,
            title: 'Auth review',
            path: DEMO_PROJECT_PATH,
            active: true,
            activeAt: DEMO_NOW_MS - 15_000,
            seq: 8,
            thinking: false,
            flavor: 'codex',
        }),
    ];
}

function userMessage(id: string, seq: number, ageMs: number, text: string, sourceSessionId?: string): NormalizedMessage {
    return { id, seq, localId: sourceSessionId ? id : null, createdAt: DEMO_NOW_MS - ageMs, isSidechain: false,
        ...(sourceSessionId ? { meta: { happierProvenanceV1: {
            v: 1, kind: 'happierSession', sourceSessionId, via: 'mcp',
        } satisfies SessionMessageProvenance } } : {}),
        role: 'user', content: { type: 'text', text } };
}

function agentMessage(id: string, seq: number, ageMs: number, text: string, sidechainId?: string): NormalizedMessage {
    return { id, seq, localId: null, createdAt: DEMO_NOW_MS - ageMs, isSidechain: Boolean(sidechainId),
        ...(sidechainId ? { sidechainId } : {}),
        role: 'agent', content: [{ type: 'text', text, uuid: `${id}-text`, parentUUID: null }] };
}

function toolMessage(params: Readonly<{
    id: string;
    seq: number;
    ageMs: number;
    name: string;
    input: Record<string, unknown>;
    description: string;
    result?: unknown;
    sidechainId?: string;
}>): NormalizedMessage {
    return {
        id: params.id,
        seq: params.seq,
        localId: null,
        createdAt: DEMO_NOW_MS - params.ageMs,
        isSidechain: Boolean(params.sidechainId),
        ...(params.sidechainId ? { sidechainId: params.sidechainId } : {}),
        role: 'agent',
        content: [
            { type: 'tool-call', id: params.id, name: params.name, input: params.input,
                description: params.description, uuid: `${params.id}-call`, parentUUID: null },
            ...(params.result === undefined ? [] : [{ type: 'tool-result' as const, tool_use_id: params.id,
                content: params.result, is_error: false, uuid: `${params.id}-result`, parentUUID: null }]),
        ],
    };
}

const reviewRequest = 'Please review the auth redirect and pending setup intent. Maya has covered refresh and reconnect; check the return path before I wrap up.';
const reviewAnswer = 'Review complete: the setup intent survives sign-in and the return path stays inside the app. Keep the reconnect regression in the final checks.';

export function buildDemoFeatureMessages(): Record<string, NormalizedMessage[]> {
    return {
        [DEMO_BROWSER_CONTEXT_SESSION_ID]: [
            userMessage('demo-checkout-request', 1, 120_000,
                'Review the Northstar storefront checkout. Keep the order summary clear on a phone and make the next step easy to find.'),
            agentMessage('demo-checkout-review', 2, 65_000,
                'The checkout keeps the two items, delivery details, and $64 total together. I’m checking the spacing and the payment action in the live preview.'),
            agentMessage('demo-checkout-ready', 3, 10_000,
                'The preview is ready. Attach the checkout page to your next message so we can review the exact screen together.'),
        ],
        [DEMO_SUBAGENTS_SESSION_ID]: [
            userMessage('demo-auth-team-request', 1, 240_000,
                'Polish the sign-in handoff. Split the regression checks and accessibility pass, then ask Auth review to check the result.'),
            agentMessage('demo-auth-team-intro', 2, 225_000,
                'Maya is checking the redirect and restore path. Jules is checking keyboard focus and the loading state. I’ll bring their results together here.'),
            toolMessage({ id: 'demo-auth-team-create', seq: 3, ageMs: 210_000, name: 'AgentTeamCreate',
                description: 'Create the auth polish team',
                input: { team_name: 'Auth polish', description: 'Regression coverage and a calm, accessible sign-in handoff' },
                result: { status: 'created', tool_use_result: { team_name: 'Auth polish' } } }),
            toolMessage({ id: 'demo-auth-maya-task', seq: 4, ageMs: 180_000, name: 'Task',
                description: 'Maya · redirect regression checks',
                input: { description: 'Maya · redirect regression checks', subagent_type: 'general-purpose',
                    prompt: 'Check that the pending setup intent survives sign-in, refresh, and reconnect. Report the results.' },
                result: { content: [{ type: 'text', text: 'All four redirect regressions pass. The setup intent survives refresh and reconnect, and the return path stays inside the app.' }] } }),
            toolMessage({ id: 'demo-auth-review-send', seq: 5, ageMs: 75_000,
                name: 'mcp__happier__session_message_send', description: 'Send the handoff to Auth review',
                input: { sessionId: DEMO_SESSION_MESSAGES_SESSION_ID, message: reviewRequest, reply: 'none' },
                result: { status: 'accepted', localId: 'demo-auth-review-request' } satisfies SessionMessageSendResultV1 }),
            userMessage('demo-auth-review-response', 6, 38_000, reviewAnswer, DEMO_SESSION_MESSAGES_SESSION_ID),
            toolMessage({ id: 'demo-auth-team-note', seq: 7, ageMs: 32_000, name: 'AgentTeamSendMessage',
                description: 'Share the review with Jules',
                input: { team_name: 'Auth polish', name: 'Jules', type: 'message',
                    content: 'Redirect review is clear. Please finish the keyboard-focus check and keep the loading state stable.' },
                result: { tool_use_result: { status: 'delivered' } } }),
            toolMessage({ id: 'demo-auth-jules-task', seq: 8, ageMs: 25_000, name: 'Task',
                description: 'Jules · keyboard and loading polish',
                input: { description: 'Jules · keyboard and loading polish', subagent_type: 'general-purpose',
                    prompt: 'Check keyboard focus through sign-in and make sure the loading state preserves the page layout.' } }),
            toolMessage({ id: 'demo-auth-jules-read', seq: 9, ageMs: 15_000, name: 'Read',
                sidechainId: 'demo-auth-jules-task', description: 'Inspect the sign-in shell',
                input: { file_path: `${DEMO_PROJECT_PATH}/apps/ui/sources/auth/DashboardAuthShell.tsx` },
                result: 'The sign-in shell keeps a stable content area and returns focus to the pending setup action.' }),
            agentMessage('demo-auth-team-progress', 10, 5_000,
                'The redirect checks and independent review are clear. Jules is finishing the keyboard pass; the changes are ready for your next note.'),
            userMessage('demo-auth-cross-agent-request', 11, 4_500,
                'Before we ship Northstar, ask Codex to review the redirect regressions and Gemini to check accessibility. Keep both reviews here.'),
            agentMessage('demo-auth-cross-agent-plan', 12, 4_000,
                'I’m delegating a redirect review to Codex and an accessibility review to Gemini through Happier. You can send either reviewer a note while they work.'),
            toolMessage({ id: 'demo-auth-codex-delegate', seq: 13, ageMs: 3_500, name: 'SubAgentRun',
                description: 'Codex · redirect review',
                input: { runId: 'run_de0c0de00001', label: 'Codex · redirect review', intent: 'delegate',
                    backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                    instructions: 'Review the Northstar sign-in redirect regressions, refresh, and reconnect. Report any blocking findings.',
                    permissionMode: 'read-only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' } }),
            toolMessage({ id: 'demo-auth-gemini-delegate', seq: 14, ageMs: 3_000, name: 'SubAgentRun',
                description: 'Gemini · accessibility review',
                input: { runId: 'run_de0acce00002', label: 'Gemini · accessibility review', intent: 'delegate',
                    backendTarget: { kind: 'builtInAgent', agentId: 'gemini' },
                    instructions: 'Review the Northstar sign-in keyboard focus, accessible labels, and loading-state continuity. Report any blocking findings.',
                    permissionMode: 'read-only', retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' } }),
            agentMessage('demo-auth-codex-review-start', 15, 2_800,
                'I’m tracing Northstar’s sign-in return path, including refresh and reconnect. I’ll flag any place that drops the pending setup intent.',
                'demo-auth-codex-delegate'),
            toolMessage({ id: 'demo-auth-codex-review-read', seq: 16, ageMs: 2_500, name: 'Read',
                sidechainId: 'demo-auth-codex-delegate', description: 'Inspect the redirect and restore path',
                input: { file_path: `${DEMO_PROJECT_PATH}/apps/ui/sources/auth/DashboardAuthShell.tsx` },
                result: 'The sign-in shell preserves the pending setup intent before authentication and restores the intended in-app destination afterward.' }),
            agentMessage('demo-auth-codex-review-progress', 17, 2_000,
                'Refresh and reconnect preserve the pending setup intent. I’m checking the signed-out return path next, especially the handoff back to the setup action.',
                'demo-auth-codex-delegate'),
            agentMessage('demo-auth-gemini-review-start', 18, 1_800,
                'I’m reviewing keyboard order, the loading announcement, and focus restoration through the Northstar sign-in handoff.',
                'demo-auth-gemini-delegate'),
            toolMessage({ id: 'demo-auth-gemini-review-read', seq: 19, ageMs: 1_500, name: 'Read',
                sidechainId: 'demo-auth-gemini-delegate', description: 'Inspect the sign-in focus and loading states',
                input: { file_path: `${DEMO_PROJECT_PATH}/apps/ui/sources/auth/DashboardAuthShell.tsx` },
                result: 'The loading state keeps the sign-in action in a stable content area. The pending setup action is available as the focus-restoration destination.' }),
            agentMessage('demo-auth-gemini-review-progress', 20, 1_000,
                'The loading state keeps the action in place. I’m checking that keyboard focus returns to the pending setup action after sign-in, without an extra tab stop.',
                'demo-auth-gemini-delegate'),
        ],
        [DEMO_SESSION_MESSAGES_SESSION_ID]: [
            userMessage('demo-auth-review-context', 1, 240_000,
                'Review the sign-in handoff before the Northstar release. Keep the review focused on redirect and restore behavior.'),
            agentMessage('demo-auth-review-context-plan', 2, 210_000,
                'I’ll check sign-in, refresh, and reconnect, then send any findings back to Auth implementation.'),
            agentMessage('demo-auth-review-baseline', 3, 120_000,
                'The redirect regressions pass. I’m ready to review the final handoff from Auth implementation.'),
            userMessage('demo-auth-review-request', 4, 75_000, reviewRequest, DEMO_SUBAGENTS_SESSION_ID),
            agentMessage('demo-auth-review-plan', 5, 65_000,
                'I’ll trace the return path and check the restore behavior against the regression coverage.'),
            toolMessage({ id: 'demo-auth-review-read', seq: 6, ageMs: 55_000, name: 'Read',
                description: 'Review the redirect guard',
                input: { file_path: `${DEMO_PROJECT_PATH}/apps/ui/sources/auth/DashboardAuthShell.tsx` },
                result: 'The guard preserves the pending setup intent before sign-in and restores it after authentication.' }),
            toolMessage({ id: 'demo-auth-review-return', seq: 7, ageMs: 40_000,
                name: 'mcp__happier__session_message_send', description: 'Return the review to Auth implementation',
                input: { sessionId: DEMO_SUBAGENTS_SESSION_ID, message: reviewAnswer, reply: 'none' },
                result: { status: 'accepted', localId: 'demo-auth-review-response' } satisfies SessionMessageSendResultV1 }),
            agentMessage('demo-auth-review-done', 8, 15_000,
                'Sent the review back to Auth implementation. No blocking findings; the reconnect regression stays in the final checks.'),
        ],
    };
}
