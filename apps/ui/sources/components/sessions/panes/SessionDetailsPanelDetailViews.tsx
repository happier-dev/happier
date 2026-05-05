import * as React from 'react';

import type { SessionCommitDetailsViewProps } from '@/components/sessions/files/views/SessionCommitDetailsView';
import type { SessionFileDetailsViewProps } from '@/components/sessions/files/views/SessionFileDetailsView';
import type { SessionScmReviewDetailsViewProps } from '@/components/sessions/files/views/SessionScmReviewDetailsView';
import type { SessionScmStashDetailsViewProps } from '@/components/sessions/files/views/SessionScmStashDetailsView';

type SessionSubagentDetailsViewProps = Readonly<{
    sessionId: string;
    scopeId: string;
    subagentId: string;
}>;

export const SessionFileDetailsViewForPanel = React.lazy(async () => {
    const mod = await import('@/components/sessions/files/views/SessionFileDetailsView');
    return { default: mod.SessionFileDetailsView };
}) satisfies React.ComponentType<SessionFileDetailsViewProps>;

export const SessionCommitDetailsViewForPanel = React.lazy(async () => {
    const mod = await import('@/components/sessions/files/views/SessionCommitDetailsView');
    return { default: mod.SessionCommitDetailsView };
}) satisfies React.ComponentType<SessionCommitDetailsViewProps>;

export const SessionScmReviewDetailsViewForPanel = React.lazy(async () => {
    const mod = await import('@/components/sessions/files/views/SessionScmReviewDetailsView');
    return { default: mod.SessionScmReviewDetailsView };
}) satisfies React.ComponentType<SessionScmReviewDetailsViewProps>;

export const SessionScmStashDetailsViewForPanel = React.lazy(async () => {
    const mod = await import('@/components/sessions/files/views/SessionScmStashDetailsView');
    return { default: mod.SessionScmStashDetailsView };
}) satisfies React.ComponentType<SessionScmStashDetailsViewProps>;

export const SessionSubagentDetailsViewForPanel = React.lazy(async () => {
    const mod = await import('@/components/sessions/agents/details/SessionSubagentDetailsView');
    return { default: mod.SessionSubagentDetailsView };
}) satisfies React.ComponentType<SessionSubagentDetailsViewProps>;
