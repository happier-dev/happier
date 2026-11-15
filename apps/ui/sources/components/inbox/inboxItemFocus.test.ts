import { describe, expect, it } from 'vitest';
import { buildActivityOverviewSnapshot } from '@/activity/attention/buildActivityOverviewSnapshot';
import { buildInboxSessionPresentation } from '@/activity/presentation/buildInboxSessionPresentation';
import { buildInboxWorkGroups } from '@/activity/presentation/buildInboxWorkGroups';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createAccountNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';

import { createInboxItemRoute, isFocusedInboxWorkItem, readInboxItemFocus, resolveInboxItemPageRoute, resolveInboxNoticeSubjectRoute } from './inboxItemFocus';

describe('Home-qualified Inbox focus', () => {
    it('links the affected Environment from its service-health notice', () => {
        const { header } = createAccountNoticeArtifactFixture({ header: {
            source: { kind: 'host', topic: 'service_health', subject: { kind: 'environment',
                environmentId: 'environment', targetLinkId: 'runtime', condition: 'health' } },
            healthPhase: 'open', page: { kind: 'host', page: 'environment', targetLinkId: 'runtime',
                environment: { serverId: 'home', projectSourceId: 'source', environmentId: 'environment' } },
        } });
        const url = new URL(resolveInboxNoticeSubjectRoute(header)!, 'https://happier.test');
        expect(url.pathname).toBe('/deployments/source');
        expect(url.searchParams.get('deploymentEnvironment')).toBe('environment');
        expect(url.searchParams.get('deployment')).toBeNull();
    });
    it('opens the exact failed receipt from a deployment notice', () => {
        const { header } = createAccountNoticeArtifactFixture({ header: {
            source: { kind: 'host', topic: 'service_health', subject: { kind: 'environment',
                environmentId: 'environment', targetLinkId: 'runtime', condition: 'deployment_failed' } },
            healthPhase: 'open', page: { kind: 'host', page: 'environment',
                environment: { serverId: 'home', projectSourceId: 'source', environmentId: 'environment' },
                targetLinkId: 'runtime', deploymentId: 'failed/receipt' },
        } });
        const route = resolveInboxItemPageRoute({ kind: 'notice', serverId: 'home', id: 'notice' }, { notice: header });
        const url = new URL(route, 'https://happier.test');
        expect(url.pathname).toBe('/deployments/source');
        expect(url.searchParams.get('deployment')).toBe('failed/receipt');
        expect(url.searchParams.get('deploymentEnvironment')).toBe('environment');
    });
    it('opens a managed Machine on its exact Home through the existing page presenter', () => {
        const focus = { kind: 'managed_machine', serverId: 'home:b', id: 'box/one' } as const;
        const route = createInboxItemRoute(focus);
        expect(readInboxItemFocus(route.params.item)).toEqual(focus);
        expect(resolveInboxItemPageRoute(focus)).toBe('/settings/machines/managed/box%2Fone?serverId=home%3Ab');
    });
    it('opens an Automation occurrence through the canonical Run route on the row Home', () => {
        const focus = { kind: 'automation_run', serverId: 'home-b', id: 'same-run', automationId: 'same-automation' } as const;
        expect(resolveInboxItemPageRoute(focus))
            .toBe('/workflows/runs/same-run?target=occurrence&automationId=same-automation&serverId=home-b');
    });
    it('opens the same qualified committed Discussion root as the Doc', () => {
        const focus = { kind: 'discussion', serverId: 'saved-home', id: 'same-thread', messageId: 'saved-root' } as const;
        const route = createInboxItemRoute(focus);
        expect(readInboxItemFocus(route.params.item)).toEqual(focus);
        expect(resolveInboxItemPageRoute(focus)).toBe('/discussions/same-thread?serverId=saved-home&messageId=saved-root');
        expect(readInboxItemFocus('discussion:saved-home:same-thread')).toBeNull();
    });
    it('round-trips an existing positive source jumpSeq anchor without inventing an anchor for missing context', () => {
        const focus = { kind: 'session', serverId: 'home-a', id: 'session-a', jumpSeq: 18 } as const;
        const route = createInboxItemRoute(focus);
        expect(readInboxItemFocus(route.params.item, undefined, route.params.jumpSeq)).toEqual(focus);
        expect(resolveInboxItemPageRoute(focus)).toBe('/session/session-a?serverId=home-a&jumpSeq=18');
        for (const invalid of [undefined, '0', '-1', 'NaN', '1.5']) {
            expect(readInboxItemFocus(route.params.item, undefined, invalid)).toEqual({ kind: 'session', serverId: 'home-a', id: 'session-a' });
        }
    });

    it('selects only the qualified Session when two Homes have the same id', () => {
        const sessions = ['home-a', 'home-b'].map((serverId) => createSessionFixture({
            id: 'same-session', serverId, active: true, pendingPermissionRequestCount: 1, pendingRequestObservedAt: 1_000,
        }));
        const presentation = buildInboxSessionPresentation({ overview: buildActivityOverviewSnapshot({ sessions, nowMs: 1_000 }) });
        const items = buildInboxWorkGroups({ sessionEntries: presentation.sessionsNeedingAttention,
            workflowRuns: [], automationRuns: [], automationServerId: null, openApprovals: [],
            stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null,
        }).flatMap((group) => group.items);
        expect(items).toHaveLength(2);
        const focus = readInboxItemFocus(createInboxItemRoute({ kind: 'session', serverId: 'home-b', id: 'same-session' }).params.item);
        expect(items.filter((item) => isFocusedInboxWorkItem(item, focus)).map((item) => item.key)).toEqual(['session:home-b:same-session']);
    });

    it('round-trips qualified ids and refuses ambiguous legacy or malformed input', () => {
        const focus = { kind: 'session', serverId: 'https://home.example/a:b', id: 'session:with/parts' } as const;
        const route = createInboxItemRoute(focus);
        expect(readInboxItemFocus([route.params.item])).toEqual(focus);
        for (const value of [undefined, '', 'session:legacy', 'run:legacy', 'session::id', 'run:home:', 'session:%XX:id', 'session:home:id:extra']) {
            expect(readInboxItemFocus(value)).toBeNull();
        }
    });

    it('addresses an approval by its artifact, with its Home when the request names one', () => {
        for (const focus of [
            { kind: 'approval', serverId: 'home-a', id: 'artifact:1' },
            { kind: 'approval', serverId: '', id: 'artifact-2' },
        ] as const) {
            expect(readInboxItemFocus(createInboxItemRoute(focus).params.item)).toEqual(focus);
        }
        expect(readInboxItemFocus('approval:home-a:')).toBeNull();
    });

    it('compares the workflow Run focus against the Home that serves the Inbox window', async () => {
        const { createWorkflowRunSummaryFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
        const { workflowRunRowFromSummary } = await import('@/sync/store/domains/workflowRuns');
        const row = workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'same-run' }), null);
        const item = { kind: 'workflow_run', key: 'run:same-run', runId: 'same-run', row,
            heldStepLabel: null, heldStepLaneLabel: null, heldStepNeed: null } as const;
        const focus = readInboxItemFocus(createInboxItemRoute({ kind: 'workflow_run', serverId: 'home-b', id: 'same-run' }).params.item);
        expect(isFocusedInboxWorkItem(item, focus, 'home-a')).toBe(false);
        expect(isFocusedInboxWorkItem(item, focus, 'home-b')).toBe(true);
        expect(isFocusedInboxWorkItem(item, focus, null)).toBe(false);
    });

    it('retains an exact held invocation when opening a Run beside the Inbox', () => {
        const focus = { kind: 'workflow_run', serverId: 'home-a', id: 'run-a',
            invocationId: '33333333-3333-4333-8333-333333333333' } as const;
        const route = createInboxItemRoute(focus);
        expect(readInboxItemFocus(route.params.item, route.params.invocationId)).toEqual(focus);
    });

    it('retains a notice Artifact selection without putting plugin routing authority in the URL', () => {
        expect(readInboxItemFocus('notice:home-a:artifact-42')).toEqual({ kind: 'notice', serverId: 'home-a', id: 'artifact-42' });
    });

    it('opens a notice that points nowhere as its own Inbox item, never the stored document page', () => {
        const focus = { kind: 'notice', serverId: 'home a', id: 'artifact/42' } as const;
        const route = resolveInboxItemPageRoute(focus, { notice: null });
        expect(route.startsWith('/artifacts')).toBe(false);
        const url = new URL(route, 'https://happier.test');
        expect(url.pathname).toBe('/inbox');
        // The phone pushes this route and lands on the same selected notice the wide pane shows.
        expect(readInboxItemFocus(url.searchParams.get('item') ?? undefined)).toEqual(focus);
    });
});
