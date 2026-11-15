import * as React from 'react';
import { registerSessionComposerPresentationTarget, useStableComposerPresentationTarget, type ComposerPresentationTarget } from '@/components/sessions/presentation/sessionComposerPresentationTargets';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';

/** The inspection Action resolves its Machine from the real Session record. */
export function publishSessionDraftPickerFixture(scope: ServerAccountScope, sessionId: string) {
    storage.setState({ sessions: { ...storage.getState().sessions, [sessionId]: createSessionFixture({
        id: sessionId, serverId: scope.serverId, metadata: { machineId: 'machine-1', path: '/repo', host: 'tester.local', flavor: 'claude' },
    }) } });
}

/** Mount the real draft Action presentation seam around an isolated picker owner. */
export function useSessionDraftPickerPresentation(
    picker: Pick<ComposerPresentationTarget, 'applyDraftAgentIntent' | 'applyDraftModelIntent'>,
    scope: ServerAccountScope | null,
    sessionId: string,
) {
    const ref = React.useMemo(() => ({ kind: 'session' as const, sessionId }), [sessionId]);
    const target = useStableComposerPresentationTarget(ref, {
        readRevision: () => 0,
        replace: (_text, revision) => revision,
        readScope: () => scope,
        applyDraftAgentIntent: picker.applyDraftAgentIntent,
        applyDraftModelIntent: picker.applyDraftModelIntent,
    });
    React.useEffect(() => scope ? registerSessionComposerPresentationTarget({ serverId: scope.serverId, sessionId }, target)
        : undefined, [scope, sessionId, target]);
}
