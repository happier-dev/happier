import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import type { NormalizedMessage } from '@/sync/typesRaw';

import { DEMO_NOW_MS, DEMO_REVIEW_SESSION_ID, DEMO_RICH_SESSION_ID } from './constants';

export function buildDemoMessages(): Record<string, NormalizedMessage[]> {
    return {
        [DEMO_RICH_SESSION_ID]: [
            {
                id: 'demo-msg-user-1',
                seq: 1,
                localId: null,
                createdAt: DEMO_NOW_MS - 180_000,
                isSidechain: false,
                role: 'user',
                content: {
                    type: 'text',
                    text: 'Implement the dashboard auth skeleton and prepare the review notes.',
                },
            },
            {
                id: 'demo-msg-agent-tool-1',
                seq: 2,
                localId: null,
                createdAt: DEMO_NOW_MS - 150_000,
                isSidechain: false,
                role: 'agent',
                content: [
                    {
                        type: 'thinking',
                        thinking: 'I will inspect the auth routes, add the missing shell, and keep the diff tight.',
                        uuid: 'demo-thinking-1',
                        parentUUID: null,
                    },
                    {
                        type: 'tool-call',
                        id: 'demo-tool-diff',
                        name: 'diff',
                        input: {
                            path: 'apps/ui/sources/auth/DashboardAuthShell.tsx',
                            hunks: 2,
                        },
                        description: 'Reviewing the generated dashboard auth diff',
                        uuid: 'demo-tool-call-1',
                        parentUUID: null,
                    },
                ],
            },
            {
                id: 'demo-msg-agent-2',
                seq: 3,
                localId: null,
                createdAt: DEMO_NOW_MS - 90_000,
                isSidechain: false,
                role: 'agent',
                content: [
                    {
                        type: 'text',
                        text: 'Auth shell is wired. I left one review comment on the redirect guard.',
                        uuid: 'demo-agent-text-1',
                        parentUUID: null,
                    },
                ],
            },
            {
                id: 'demo-msg-user-2',
                seq: 4,
                localId: null,
                createdAt: DEMO_NOW_MS - 78_000,
                isSidechain: false,
                role: 'user',
                content: {
                    type: 'text',
                    text: 'Can you tighten the loading state and make sure the auth redirect keeps the pending setup intent?',
                },
            },
            {
                id: 'demo-msg-agent-tool-2',
                seq: 5,
                localId: null,
                createdAt: DEMO_NOW_MS - 66_000,
                isSidechain: false,
                role: 'agent',
                content: [
                    {
                        type: 'tool-call',
                        id: 'demo-tool-test',
                        name: 'test',
                        input: {
                            command: 'vitest run DashboardAuthShell.test.tsx',
                            status: 'passing',
                        },
                        description: 'Running the auth shell regression test',
                        uuid: 'demo-tool-call-2',
                        parentUUID: null,
                    },
                ],
            },
            {
                id: 'demo-msg-agent-3',
                seq: 6,
                localId: null,
                createdAt: DEMO_NOW_MS - 54_000,
                isSidechain: false,
                role: 'agent',
                content: [
                    {
                        type: 'text',
                        text: [
                            'I tightened the guard and kept the setup intent intact.',
                            '',
                            '```tsx',
                            'if (!credentials) {',
                            '  return <Redirect href="/auth" />;',
                            '}',
                            '```',
                        ].join('\n'),
                        uuid: 'demo-agent-text-2',
                        parentUUID: null,
                    },
                ],
            },
            {
                id: 'demo-msg-agent-4',
                seq: 7,
                localId: null,
                createdAt: DEMO_NOW_MS - 42_000,
                isSidechain: false,
                role: 'agent',
                content: [
                    {
                        type: 'text',
                        text: [
                            'Review diff:',
                            '- return <Redirect href="/" />;',
                            '+ preservePendingSetupIntent();',
                            '+ return <Redirect href="/auth" />;',
                        ].join('\n'),
                        uuid: 'demo-agent-text-3',
                        parentUUID: null,
                    },
                ],
            },
            {
                id: 'demo-msg-user-3',
                seq: 8,
                localId: null,
                createdAt: DEMO_NOW_MS - 34_000,
                isSidechain: false,
                role: 'user',
                content: {
                    type: 'text',
                    text: 'Great. Leave a note for the reviewer and queue the follow-up to validate the restore path.',
                },
            },
            {
                id: 'demo-msg-agent-5',
                seq: 9,
                localId: null,
                createdAt: DEMO_NOW_MS - 26_000,
                isSidechain: false,
                role: 'agent',
                content: [
                    {
                        type: 'text',
                        text: 'Queued the restore-path follow-up and added a reviewer note with the exact redirect invariant.',
                        uuid: 'demo-agent-text-4',
                        parentUUID: null,
                    },
                ],
            },
        ],
        // A distinct review session ("Review mobile PR from the train") backing the
        // A8 review dream beat: a real diff transcript plus line-anchored review
        // comment drafts (below) so the diff-and-notes loop renders from seed.
        [DEMO_REVIEW_SESSION_ID]: [
            {
                id: 'demo-review-msg-user-1',
                seq: 1,
                localId: null,
                createdAt: DEMO_NOW_MS - 240_000,
                isSidechain: false,
                role: 'user',
                content: {
                    type: 'text',
                    text: 'Open the mobile PR diff so I can leave line notes before it merges.',
                },
            },
            {
                id: 'demo-review-msg-agent-tool-1',
                seq: 2,
                localId: null,
                createdAt: DEMO_NOW_MS - 210_000,
                isSidechain: false,
                role: 'agent',
                content: [
                    {
                        type: 'tool-call',
                        id: 'demo-review-tool-diff',
                        name: 'diff',
                        input: {
                            path: 'apps/ui/sources/components/sessions/mobile/SessionMobileHeader.tsx',
                            hunks: 3,
                        },
                        description: 'Loading the changed files for review',
                        uuid: 'demo-review-tool-call-1',
                        parentUUID: null,
                    },
                ],
            },
            {
                id: 'demo-review-msg-agent-1',
                seq: 3,
                localId: null,
                createdAt: DEMO_NOW_MS - 180_000,
                isSidechain: false,
                role: 'agent',
                content: [
                    {
                        type: 'text',
                        text: [
                            'Three files changed. Here is the header hunk under review:',
                            '',
                            '```tsx',
                            '- <Text>{title}</Text>',
                            '+ <Text numberOfLines={1} ellipsizeMode="tail">{title}</Text>',
                            '+ {unreadCount > 0 ? <UnreadBadge count={unreadCount} /> : null}',
                            '```',
                        ].join('\n'),
                        uuid: 'demo-review-agent-text-1',
                        parentUUID: null,
                    },
                ],
            },
            {
                id: 'demo-review-msg-user-2',
                seq: 4,
                localId: null,
                createdAt: DEMO_NOW_MS - 150_000,
                isSidechain: false,
                role: 'user',
                content: {
                    type: 'text',
                    text: 'Left two notes on the badge and the truncation. Send them back into the loop.',
                },
            },
        ],
    };
}

export function buildDemoPendingMessages(): Record<string, { messages: PendingMessage[] }> {
    return {
        [DEMO_RICH_SESSION_ID]: {
            messages: [
                {
                    id: 'demo-pending-restore-path',
                    localId: 'demo-local-restore-path',
                    createdAt: DEMO_NOW_MS - 12_000,
                    updatedAt: DEMO_NOW_MS - 12_000,
                    source: 'local_outbound',
                    deliveryStatus: 'queued',
                    pendingDeliveryStatus: 'server_queued',
                    text: 'Also validate the restore path after auth succeeds and keep the reviewer note anchored.',
                    rawRecord: {
                        id: 'demo-pending-restore-path',
                        text: 'Also validate the restore path after auth succeeds and keep the reviewer note anchored.',
                    },
                },
            ],
        },
    };
}

export function buildDemoReviewComments(): Record<string, ReviewCommentDraft[]> {
    return {
        [DEMO_RICH_SESSION_ID]: [
            {
                id: 'demo-review-comment-1',
                filePath: 'apps/ui/sources/auth/DashboardAuthShell.tsx',
                source: 'diff',
                anchor: {
                    kind: 'line',
                    filePath: 'apps/ui/sources/auth/DashboardAuthShell.tsx',
                    line: 42,
                    side: 'after',
                },
                snapshot: {
                    selectedLines: ['return <Redirect href="/" />;'],
                    beforeContext: ['if (!credentials) {'],
                    afterContext: ['}'],
                },
                body: 'This should preserve the pending setup intent before redirecting.',
                includeInPrompt: true,
                createdAt: DEMO_NOW_MS - 45_000,
            },
        ],
        [DEMO_REVIEW_SESSION_ID]: [
            {
                id: 'demo-review-comment-badge',
                filePath: 'apps/ui/sources/components/sessions/mobile/SessionMobileHeader.tsx',
                source: 'diff',
                anchor: {
                    kind: 'line',
                    filePath: 'apps/ui/sources/components/sessions/mobile/SessionMobileHeader.tsx',
                    line: 58,
                    side: 'after',
                },
                snapshot: {
                    selectedLines: ['{unreadCount > 0 ? <UnreadBadge count={unreadCount} /> : null}'],
                    beforeContext: ['<Text numberOfLines={1} ellipsizeMode="tail">{title}</Text>'],
                    afterContext: ['</View>'],
                },
                body: 'Cap the badge at 99+ so a busy inbox never blows out the header width.',
                includeInPrompt: true,
                createdAt: DEMO_NOW_MS - 140_000,
            },
            {
                id: 'demo-review-comment-truncate',
                filePath: 'apps/ui/sources/components/sessions/mobile/SessionMobileHeader.tsx',
                source: 'diff',
                anchor: {
                    kind: 'line',
                    filePath: 'apps/ui/sources/components/sessions/mobile/SessionMobileHeader.tsx',
                    line: 57,
                    side: 'after',
                },
                snapshot: {
                    selectedLines: ['<Text numberOfLines={1} ellipsizeMode="tail">{title}</Text>'],
                    beforeContext: ['<View style={styles.headerRow}>'],
                    afterContext: ['{unreadCount > 0 ? <UnreadBadge count={unreadCount} /> : null}'],
                },
                body: 'Good call on the tail truncation — can we also add a testID so the header suite pins it?',
                includeInPrompt: true,
                createdAt: DEMO_NOW_MS - 135_000,
            },
        ],
    };
}
