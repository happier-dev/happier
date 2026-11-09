import {
    TriageSourceDescriptorV1Schema, TriageSourceEntrySnapshotV1Schema,
    TriageSourceViewerFactsV1Schema, type TriageSourceDescriptorV1,
} from '@happier-dev/triage-protocol/v1';
import { GITHUB_PLUGIN_ID, GITHUB_CONNECTED_ACCOUNT_ID, GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import { GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1, GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1 } from '../../../../../packages/plugins/scm-github/src/triage/contribution';
import { LINEAR_PLUGIN_ID, LINEAR_SOURCE_ID, LINEAR_PURPOSE, LINEAR_SERVICE_ID } from '../../../../../packages/plugins/linear/src/contracts';
import { SENTRY_PLUGIN_ID, SENTRY_CONTRIBUTION_ID, SENTRY_CONNECTED_ACCOUNT_ID, SENTRY_CONNECTED_ACCOUNT_PURPOSE, SENTRY_SOURCE_DISPLAY_NAME, SENTRY_ENTRY_KIND_ID } from '../../../../../packages/plugins/sentry/src/sentryContracts';
import { POSTHOG_PLUGIN_ID, POSTHOG_SOURCE_CONTRIBUTION_ID, POSTHOG_CONNECTED_ACCOUNT_PURPOSE, POSTHOG_SOURCE_DISPLAY_NAME } from '../../../../../packages/plugins/posthog/src/posthogContracts';
import { POSTHOG_ENTRY_KIND } from '../../../../../packages/plugins/posthog/src/source/map/entrySnapshot';
import { DEMO_NOW_MS } from './constants';

function issueDescriptor(purpose: string, displayName: string, kindId: string, workflowSubject: 'issue' | 'errorIssue'): TriageSourceDescriptorV1 {
    return TriageSourceDescriptorV1Schema.parse({ v: 1, purpose, displayName,
        kinds: [{ id: kindId, workflowSubject, displayName: workflowSubject === 'issue' ? 'Issue' : 'Error issue' }] });
}

/** Provider responses and display-only connection references; this world contains no credentials. */
export function buildDemoTriageWorld() {
    const sources = [
        { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_CONTRIBUTION_LOCAL_ID_V1,
            serviceId: GITHUB_CONNECTED_ACCOUNT_ID, descriptor: GITHUB_TRIAGE_SOURCE_DESCRIPTOR_V1,
            kindId: 'pull-request', collisionScope: 'northstar/web', entryId: '142',
            title: 'Keep Session context through reconnects', scopeLabel: 'northstar/web',
            displayPath: 'northstar/web #142', webUrl: 'https://github.com/northstar/web/pull/142',
            purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE },
        { pluginId: LINEAR_PLUGIN_ID, localId: LINEAR_SOURCE_ID, serviceId: LINEAR_SERVICE_ID,
            descriptor: issueDescriptor(LINEAR_PURPOSE, 'Linear', 'issue', 'issue'),
            kindId: 'issue', collisionScope: 'northstar-engineering', entryId: 'ENG-84',
            title: 'Surface blockers before the next handoff', scopeLabel: 'Northstar · Engineering',
            displayPath: 'ENG-84', webUrl: 'https://linear.app/northstar/issue/ENG-84', purpose: LINEAR_PURPOSE },
        { pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_CONTRIBUTION_ID, serviceId: SENTRY_CONNECTED_ACCOUNT_ID,
            descriptor: issueDescriptor(SENTRY_CONNECTED_ACCOUNT_PURPOSE, SENTRY_SOURCE_DISPLAY_NAME, SENTRY_ENTRY_KIND_ID, 'errorIssue'),
            kindId: SENTRY_ENTRY_KIND_ID, collisionScope: 'northstar-web', entryId: '247',
            title: 'Reconnect drops the selected model', scopeLabel: 'Northstar · Web',
            displayPath: 'WEB-247', webUrl: 'https://northstar.sentry.io/issues/247/', purpose: SENTRY_CONNECTED_ACCOUNT_PURPOSE },
        { pluginId: POSTHOG_PLUGIN_ID, localId: POSTHOG_SOURCE_CONTRIBUTION_ID, serviceId: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
            descriptor: issueDescriptor(POSTHOG_CONNECTED_ACCOUNT_PURPOSE, POSTHOG_SOURCE_DISPLAY_NAME, POSTHOG_ENTRY_KIND, 'errorIssue'),
            kindId: POSTHOG_ENTRY_KIND, collisionScope: 'northstar-production', entryId: 'error-84',
            title: 'Checkout stalls after a workspace switch', scopeLabel: 'Northstar · Production',
            displayPath: 'Checkout · 84 occurrences', webUrl: 'https://eu.posthog.com/project/1/error_tracking/84', purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE },
    ];
    return sources.map((source, index) => ({
        source: { pluginId: source.pluginId, localId: source.localId },
        service: { pluginId: source.pluginId, localId: source.serviceId },
        descriptor: source.descriptor,
        sourceInstanceId: `66666666-6666-4666-8666-00000000000${index + 1}`,
        purpose: source.purpose,
        localRef: { kindId: source.kindId, collisionScope: source.collisionScope, entryId: source.entryId },
        locator: { v: 1 as const, displayPath: source.displayPath, webUrl: source.webUrl },
        snapshot: TriageSourceEntrySnapshotV1Schema.parse({ v: 1, title: source.title, scopeLabel: source.scopeLabel,
            createdAtMs: DEMO_NOW_MS - (index + 1) * 60 * 60 * 1000,
            state: { presentation: 'active', nativeLabel: index === 1 ? 'In progress' : 'Open' }, facts: [] }),
        viewer: TriageSourceViewerFactsV1Schema.parse({ involvement: index === 0 ? ['reviewRequested'] : ['assignee'] }),
        sourceUpdatedAtMs: DEMO_NOW_MS - index * 15 * 60 * 1000,
    }));
}
