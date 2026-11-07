import type { GithubTriageInvocationContext } from '../invocation.js';
import { TriageSourceCredentialInputsV1, TriageSourceReadFixPullRequestsResultV1Schema,
    projectTriageDisplayTextV1, type TriageSourceReadFixPullRequestsResultV1 } from '@happier-dev/triage-protocol/v1';
import { readGithubDependabotFixPullRequest, GITHUB_SECURITY_ALERT_INPUT_FAILURE } from './reads.js';
import { buildGithubEntryDisplayPath } from '../locator.js';

/** Adapt the exact native association to the incumbent source-neutral fix resolver. */
export async function readGithubTriageFixPullRequests(input: unknown, context: GithubTriageInvocationContext): Promise<TriageSourceReadFixPullRequestsResultV1> {
    const parsed = TriageSourceCredentialInputsV1.readFixPullRequests.safeParse(input);
    if (!parsed.success) return { kind: 'unavailable', failure: GITHUB_SECURITY_ALERT_INPUT_FAILURE };
    if (parsed.data.localRef.kindId !== 'dependabot-alert') return { kind: 'complete', candidates: [] };
    const result = await readGithubDependabotFixPullRequest({ v: 1, instance: parsed.data.instance,
        localRef: parsed.data.localRef, routingToken: parsed.data.lastKnownLocator?.routingToken }, context);
    if (result.kind === 'unavailable') return result;
    if (result.kind === 'none') return { kind: 'complete', candidates: [] };
    const displayPath = buildGithubEntryDisplayPath(result.routingToken, result.localRef.entryId);
    return TriageSourceReadFixPullRequestsResultV1Schema.parse({ kind: 'complete', candidates: [{
        localRef: result.localRef,
        status: result.state === 'OPEN' ? 'open' : result.state === 'MERGED' ? 'merged' : result.state === 'CLOSED' ? 'closed' : 'unknown',
        display: { title: projectTriageDisplayTextV1(result.title).value, displayPath, scopeLabel: result.routingToken },
        locator: { v: 1, routingToken: result.routingToken, webUrl: result.url,
            displayPath },
    }] });
}
