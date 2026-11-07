import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES, isExternalActionResultWithinResponseEnvelopeLimitV1 } from '@happier-dev/plugin-sdk/actions';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriageSourceReadFixPullRequestsResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';
import { activate, activateAccount } from '../../activate.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { GITHUB_PLUGIN_ID, GITHUB_CONNECTED_ACCOUNT_PURPOSE } from '../../observations/githubProviderContracts.js';
import { encodeGithubTriageConfiguration } from '../configuration.js';
import { GITHUB_REPOSITORY_RESPONSE } from '../__fixtures__/githubResponses.js';
import { createStubGithubTransport, readRecordedJsonBody } from '../testkit/githubTriage.test-support.js';
import { GithubSecurityAlertReadResultV1Schema, GithubCodeScanningLocationResultV1Schema, GithubDependabotFixPullRequestResultV1Schema, GithubSecurityAlertMutationResultV1Schema } from './actionContracts.js';
import { GITHUB_TRIAGE_ACTION_IDS_V1 } from '../contribution.js';

const repository = 'octo-org/example-app';
const base = `https://api.github.com/repos/${repository}`;
const sha = '39406e42cb832f683daa691dd652a8dc36ee8930';
const dependency = { number: 1, state: 'open', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', html_url: `https://github.com/${repository}/security/dependabot/1`, dependency: { package: { name: 'fixture', ecosystem: 'npm' }, manifest_path: 'package.json', scope: 'runtime', relationship: 'direct' }, security_advisory: { summary: 'Unsafe package', description: 'Native advisory', severity: 'high', ghsa_id: 'GHSA-fixture' }, security_vulnerability: { vulnerable_version_range: '< 2', first_patched_version: { identifier: '2' } } };
const location = { ref: 'refs/heads/main', analysis_key: 'analysis', environment: '', category: 'category', state: 'open', commit_sha: sha, message: { text: 'Untrusted data' }, location: { path: 'src/example.ts', start_line: 2, end_line: 2, start_column: 1, end_column: 5 } };
const scanning = { number: 1, state: 'open', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', html_url: `https://github.com/${repository}/security/code-scanning/1`, rule: { id: 'rule', description: 'Unsafe code', security_severity_level: 'medium', severity: 'error' }, tool: { name: 'CodeQL' }, most_recent_instance: location };
function input(kindId = 'dependabot-alert') {
  const fixture = createTriageSourceV1Fixture();
  const token = encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'repository', repositoryKey: repository } });
  if (token === null) throw new Error('fixture configuration');
  return { v: 1, instance: { ...fixture.configuredInstance, instance: { ...fixture.configuredInstance.instance, source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' } }, binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: { service: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' }, accountId: 'security-native-test' } }, localInstanceKey: 'github.com', configuration: { v: 1, token } }, localRef: { kindId, collisionScope: 'github:4210', entryId: '1' }, routingToken: repository };
}
async function harness(respond: Parameters<typeof createStubGithubTransport>[0]['respond']) {
  const stub = createStubGithubTransport({ respond: request => request.url === base ? { status: 200, body: GITHUB_REPOSITORY_RESPONSE } : respond(request) });
  const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: { http: stub.context.services.http, connectedAccounts: stub.context.services.connectedAccounts } });
  return { stub, plugin };
}
describe('registered native security alert Actions', () => {
  it('feeds the existing generic fix-candidate role through one exact association read and no PR inventory', async () => {
    const { stub, plugin } = await harness(request => request.url === 'https://api.github.com/graphql' ? { status: 200, body: {
      data: { repository: { databaseId: 4210, nameWithOwner: repository, vulnerabilityAlert: { number: 1,
        dependabotUpdate: { pullRequest: { number: 19, title: 'Update fixture', url: `https://github.com/${repository}/pull/19`,
          state: 'OPEN', repository: { databaseId: 4210, nameWithOwner: repository } } } } } },
    } } : undefined);
    try {
      const target = input();
      const result = TriageSourceReadFixPullRequestsResultV1Schema.parse(await plugin.invokeAction('triage/read-github-fix-pull-requests', {
        v: 1, instance: target.instance, localRef: target.localRef, lastKnownLocator: { v: 1, routingToken: target.routingToken },
      }));
      expect(result).toMatchObject({ kind: 'complete', candidates: [{ localRef: { kindId: 'pull-request',
        collisionScope: 'github:4210', entryId: '19' }, status: 'open',
        locator: { routingToken: repository, webUrl: `https://github.com/${repository}/pull/19`, displayPath: `${repository}#19` },
        display: { title: 'Update fixture', displayPath: `${repository}#19`, scopeLabel: repository } }] });
      expect(stub.requests.map(request => request.url)).toEqual([base, 'https://api.github.com/graphql']);
      const before = stub.requests.length;
      expect(await plugin.invokeAction('triage/read-github-fix-pull-requests', { v: 1, instance: target.instance,
        localRef: { ...target.localRef, kindId: 'code-scanning-alert' } })).toEqual({ kind: 'complete', candidates: [] });
      expect(stub.requests).toHaveLength(before);
    } finally { await plugin.dispose(); }
  });
  it('reads retained alerts with discovery off through native endpoints without PR/issue or file fanout', async () => {
    const { stub, plugin } = await harness(request => request.url === `${base}/dependabot/alerts/1` ? { status: 200, body: dependency } : undefined);
    try {
      const result = GithubSecurityAlertReadResultV1Schema.parse(await plugin.invokeAction('github/security-alert/read', input()));
      expect(result).toMatchObject({ kind: 'alert', kindId: 'dependabot-alert', detail: { packageName: 'fixture', advisory: 'Native advisory', patchedVersion: '2' } });
      expect(stub.requests.map(request => request.url)).toEqual([base, `${base}/dependabot/alerts/1`]);
    } finally { await plugin.dispose(); }
  });
  it('fits an oversized advisory to the real Action envelope while preserving native finding coordinates', async () => {
    const advisory = 'long evidence '.repeat(Math.ceil(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / 13));
    const { plugin } = await harness(request => request.url === `${base}/dependabot/alerts/1` ? { status: 200, body: { ...dependency, security_advisory: { ...dependency.security_advisory, description: advisory } } } : undefined);
    try {
      const result = GithubSecurityAlertReadResultV1Schema.parse(await plugin.invokeAction('github/security-alert/read', input()));
      expect(result).toMatchObject({ kind: 'alert', kindId: 'dependabot-alert', detail: { packageName: 'fixture', manifestPath: 'package.json', nativeState: 'open', projectionTruncated: true } });
      expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
      if (result.kind === 'alert' && result.kindId === 'dependabot-alert') {
        expect(result.detail.advisory.length).toBeGreaterThan(0);
        expect(advisory.startsWith(result.detail.advisory)).toBe(true);
      }
    } finally { await plugin.dispose(); }
  });
  it('dismisses once and settles a lost PATCH response by a fresh native read', async () => {
    let state = 'open';
    const { stub, plugin } = await harness(request => {
      if (request.url !== `${base}/dependabot/alerts/1`) return undefined;
      if (request.method === 'PATCH') { state = 'dismissed'; throw new Error('response lost'); }
      return { status: 200, body: { ...dependency, state } };
    });
    try {
      expect(GithubSecurityAlertMutationResultV1Schema.parse(await plugin.invokeAction('github/dependabot-alert/dismiss', { ...input(), reason: 'not_used', comment: 'Unused' }))).toMatchObject({ kind: 'applied', effect: 'changed', observation: { kind: 'present', snapshot: { state: { presentation: 'suppressed' } } } });
      const writes = stub.requests.filter(request => request.method === 'PATCH');
      expect(writes).toHaveLength(1);
      expect(readRecordedJsonBody(writes[0]!)).toEqual({ state: 'dismissed', dismissed_reason: 'not_used', dismissed_comment: 'Unused' });
    } finally { await plugin.dispose(); }
  });
  it('refuses fixed-state reopen without sending a write', async () => {
    const { stub, plugin } = await harness(request => request.url === `${base}/code-scanning/alerts/1` ? { status: 200, body: { ...scanning, state: 'fixed' } } : undefined);
    try {
      const result = await plugin.invokeAction('github/code-scanning-alert/reopen', input('code-scanning-alert'));
      expect(stub.requests.filter(request => request.method !== 'GET')).toHaveLength(0);
      expect(result).toMatchObject({ kind: 'refused', reason: 'state_not_reopenable' });
    } finally { await plugin.dispose(); }
  });
  it('refuses a reused repository path before reading its alert or writing', async () => {
    const stub = createStubGithubTransport({ respond: request => request.url === base ? { status: 200, body: { ...GITHUB_REPOSITORY_RESPONSE, id: 999 } } : undefined });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: { http: stub.context.services.http, connectedAccounts: stub.context.services.connectedAccounts } });
    try {
      expect(await plugin.invokeAction('github/dependabot-alert/reopen', input())).toMatchObject({ kind: 'failed', failure: { code: 'route-body-mismatch' } });
      expect(stub.requests.map(request => request.url)).toEqual([base]);
    } finally { await plugin.dispose(); }
  });
  it('keeps exact retained get unresolved before native disclosure when a repository path is reassigned', async () => {
    const stub = createStubGithubTransport({ respond: request => {
      if (request.url === base) return { status: 200, body: { ...GITHUB_REPOSITORY_RESPONSE, id: 999 } };
      if (request.url === `${base}/dependabot/alerts/1`) return { status: 200, body: dependency };
      return undefined;
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: { http: stub.context.services.http, connectedAccounts: stub.context.services.connectedAccounts } });
    try {
      const target = input();
      expect(await plugin.invokeAction(GITHUB_TRIAGE_ACTION_IDS_V1.get, { v: 1, instance: target.instance, localRef: target.localRef, lastKnownLocator: { v: 1, routingToken: target.routingToken } }))
        .toMatchObject({ kind: 'unresolved', failure: { code: 'route-body-mismatch' } });
      expect(stub.requests.map(request => request.url)).toEqual([base]);
    } finally { await plugin.dispose(); }
  });
  it.each([
    [404, 'github_not_found'],
    [410, 'github_gone'],
  ] as const)('settles an exact alert HTTP %s without treating it as a missing observation', async (status, code) => {
    const requestId = 'A89C:E6813:2EE25D2:4481C49:6AEB94CC';
    const { plugin } = await harness(request => request.url === `${base}/dependabot/alerts/1`
      ? { status, headers: { 'x-github-request-id': requestId }, body: { message: status === 410 ? 'Alert number 1 has been withdrawn' : 'Not Found' } }
      : undefined);
    try {
      expect(await plugin.invokeAction('github/security-alert/read', input()))
        .toMatchObject({ kind: 'unavailable', failure: { code, detail: expect.stringContaining(requestId) } });
      const target = input();
      expect(await plugin.invokeAction(GITHUB_TRIAGE_ACTION_IDS_V1.get, { v: 1, instance: target.instance,
        localRef: target.localRef, lastKnownLocator: { v: 1, routingToken: target.routingToken } }))
        .toMatchObject({ kind: 'unresolved', failure: { code, detail: expect.stringContaining(requestId) } });
    }
    finally { await plugin.dispose(); }
  });
  it('does no PATCH when the requested native state is already satisfied', async () => {
    const { stub, plugin } = await harness(request => request.url === `${base}/dependabot/alerts/1` ? { status: 200, body: dependency } : undefined);
    try {
      expect(await plugin.invokeAction('github/dependabot-alert/reopen', input())).toMatchObject({ kind: 'applied', effect: 'alreadySatisfied' });
      expect(stub.requests.filter(request => request.method === 'PATCH')).toHaveLength(0);
    } finally { await plugin.dispose(); }
  });
  it('never reopens a scanning-only unsupported native auto-dismissed state', async () => {
    const { stub, plugin } = await harness(request => request.url === `${base}/code-scanning/alerts/1` ? { status: 200, body: { ...scanning, state: 'auto_dismissed' } } : undefined);
    try {
      expect(await plugin.invokeAction('github/code-scanning-alert/reopen', input('code-scanning-alert'))).toMatchObject({ kind: 'refused' });
      expect(stub.requests.filter(request => request.method === 'PATCH')).toHaveLength(0);
    } finally { await plugin.dispose(); }
  });
  it('keeps an accepted pending dismissal separate from confirmed native dismissed state', async () => {
    const { stub, plugin } = await harness(request => request.url === `${base}/code-scanning/alerts/1`
      ? request.method === 'PATCH' ? { status: 202, body: scanning } : { status: 200, body: scanning } : undefined);
    try {
      expect(await plugin.invokeAction('github/code-scanning-alert/dismiss', { ...input('code-scanning-alert'), reason: 'used in tests' })).toMatchObject({ kind: 'refused', reason: 'dismissal_pending', observation: { snapshot: { state: { presentation: 'active' } } } });
      const write = stub.requests.find(request => request.method === 'PATCH');
      expect(write).toBeDefined();
      expect(readRecordedJsonBody(write!)).toEqual({ state: 'dismissed', dismissed_reason: 'used in tests' });
    } finally { await plugin.dispose(); }
  });
  it('does not claim dismissal when a lost write cannot be confirmed', async () => {
    let attempted = false;
    const { stub, plugin } = await harness(request => {
      if (request.url !== `${base}/dependabot/alerts/1`) return undefined;
      if (request.method === 'PATCH') { attempted = true; throw new Error('response lost'); }
      return attempted ? { status: 503 } : { status: 200, body: dependency };
    });
    try {
      expect(await plugin.invokeAction('github/dependabot-alert/dismiss', { ...input(), reason: 'not_used' })).toMatchObject({ kind: 'uncertain' });
      expect(stub.requests.filter(request => request.method === 'PATCH')).toHaveLength(1);
    } finally { await plugin.dispose(); }
  });
  it('reads only the exact native Dependabot update association and validates PR repository identity', async () => {
    const { stub, plugin } = await harness(request => request.url === 'https://api.github.com/graphql' ? { status: 200, body: { data: { repository: { databaseId: 4210, nameWithOwner: repository, vulnerabilityAlert: { number: 1, dependabotUpdate: { pullRequest: { number: 19, title: 'Update fixture', url: `https://github.com/${repository}/pull/19`, state: 'OPEN', repository: { databaseId: 4210, nameWithOwner: repository } } } } } } } } : undefined);
    try {
      const result = GithubDependabotFixPullRequestResultV1Schema.parse(await plugin.invokeAction('github/dependabot-alert/read-fix-pull-request', input()));
      expect(result).toMatchObject({ kind: 'pullRequest', localRef: { kindId: 'pull-request', collisionScope: 'github:4210', entryId: '19' } });
      expect(stub.requests.map(request => request.url)).toEqual([base, 'https://api.github.com/graphql']);
      const body = readRecordedJsonBody(stub.requests[1]!);
      expect(body).toMatchObject({ variables: { owner: 'octo-org', name: 'example-app', number: 1 } });
      expect(JSON.stringify(body)).toContain('vulnerabilityAlert(number:');
      expect(JSON.stringify(body)).not.toContain('pullRequests(');
    } finally { await plugin.dispose(); }
  });
  it('does not treat denied GraphQL association fields as no update PR', async () => {
    const { plugin } = await harness(request => request.url === 'https://api.github.com/graphql' ? { status: 200, body: { data: { repository: { databaseId: 4210, vulnerabilityAlert: null } }, errors: [{ type: 'FORBIDDEN', message: 'Field denied' }] } } : undefined);
    try { expect(await plugin.invokeAction('github/dependabot-alert/read-fix-pull-request', input())).toMatchObject({ kind: 'unavailable' }); }
    finally { await plugin.dispose(); }
  });
  it('refuses an associated PR from a different immutable repository without disclosing its title', async () => {
    const { plugin } = await harness(request => request.url === 'https://api.github.com/graphql' ? { status: 200, body: { data: { repository: { databaseId: 4210, nameWithOwner: repository, vulnerabilityAlert: { number: 1, dependabotUpdate: { pullRequest: { number: 19, title: 'Foreign title', url: `https://github.com/${repository}/pull/19`, state: 'OPEN', repository: { databaseId: 999, nameWithOwner: repository } } } } } } } } : undefined);
    try {
      expect(await plugin.invokeAction('github/dependabot-alert/read-fix-pull-request', input()))
        .toEqual({ kind: 'unavailable', failure: { class: 'unknown', code: 'route-body-mismatch' } });
    } finally { await plugin.dispose(); }
  });
  it('rereads the selected provider instance before reading content at its immutable commit', async () => {
    const selectedInstance = { ref: location.ref, analysisKey: location.analysis_key, environment: '', category: location.category, state: 'open', commitSha: sha, path: location.location.path, startLine: 2, endLine: 2, startColumn: 1, endColumn: 5, message: location.message.text };
    const { stub, plugin } = await harness(request => {
      if (request.url === `${base}/code-scanning/alerts/1/instances?per_page=30&page=1`) return { status: 200, body: [location] };
      if (request.url === `${base}/contents/src/example.ts?ref=${sha}`) return { status: 200, body: { type: 'file', encoding: 'base64', content: btoa('first\nsecond\nthird\n') } };
      return undefined;
    });
    try {
      const result = GithubCodeScanningLocationResultV1Schema.parse(await plugin.invokeAction('github/code-scanning-alert/read-location', { ...input('code-scanning-alert'), limit: 30, selectedInstance }));
      expect(result).toMatchObject({ kind: 'location', location: { commitSha: sha, path: 'src/example.ts' }, code: 'second' });
      expect(stub.requests.filter(request => request.url.includes('/contents/'))).toHaveLength(1);
      const rejected = await plugin.invokeAction('github/code-scanning-alert/read-location', { ...input('code-scanning-alert'), limit: 30, selectedInstance: { ...selectedInstance, path: '../private' } });
      expect(rejected).toMatchObject({ kind: 'unavailable' });
      expect(stub.requests.filter(request => request.url.includes('/contents/'))).toHaveLength(1);
    } finally { await plugin.dispose(); }
  });
  it('retains selected immutable coordinates when Contents permission is denied', async () => {
    const selectedInstance = { ref: location.ref, analysisKey: location.analysis_key, environment: '', category: location.category, state: 'open', commitSha: sha, path: location.location.path, startLine: 2, endLine: 2, startColumn: 1, endColumn: 5, message: location.message.text };
    const { plugin } = await harness(request => {
      if (request.url === `${base}/code-scanning/alerts/1/instances?per_page=30&page=1`) return { status: 200, body: [location] };
      if (request.url === `${base}/contents/src/example.ts?ref=${sha}`) return { status: 403, body: { message: 'Resource not accessible by personal access token' } };
      return undefined;
    });
    try {
      expect(GithubCodeScanningLocationResultV1Schema.parse(await plugin.invokeAction('github/code-scanning-alert/read-location', { ...input('code-scanning-alert'), limit: 30, selectedInstance })))
        .toMatchObject({ kind: 'location', location: { commitSha: sha, path: 'src/example.ts', startLine: 2 }, code: null, codeUnavailable: { class: 'permission' }, sourceUrl: `https://github.com/${repository}/blob/${sha}/src/example.ts#L2-L2` });
    } finally { await plugin.dispose(); }
  });
});
