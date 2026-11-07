// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { Button, Text, defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriageReobserveEntryInputV1Schema } from '../../actions/reobserveEntryProtocol.js';
import { reobserveTriageEntry } from '../../actions/reobserveEntry.js';
import type { TriageAdmittedSourceV1 } from '../../actions/listEntries.js';
import { toTriageWireObservation } from '../../projection/listWindowWire.js';
import { createTriageEphemeralSharedScopeFixture } from '../window/ephemeralSharedScope.test-support.js';
import { useTriagePostMutationRow } from './useTriagePostMutationRow.js';
import { getGithubTriageEntry } from '../../../../scm-github/src/triage/operations.js';
import { encodeGithubTriageConfiguration } from '../../../../scm-github/src/triage/configuration.js';
import { GITHUB_ISSUE_RESPONSE, GITHUB_REPOSITORY_RESPONSE } from '../../../../scm-github/src/triage/__fixtures__/githubResponses.js';
import { createStubGithubTransport, GITHUB_TEST_ACCOUNT } from '../../../../scm-github/src/triage/testkit/githubTriage.test-support.js';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_PLUGIN_ID } from '../../../../scm-github/src/observations/githubProviderContracts.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('one opened GitHub issue read owner', () => {
  it.each(['close', 'refresh'] as const)('shares detail/companion HTTP reads, keeps fresh reads and supports %s during an open read', async (duringRead) => {
    const sourceFixture = createTriageSourceV1Fixture();
    const route = 'octo-org/example-app';
    const entryRef = { source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' },
      kindId: 'issue', collisionScope: `github:${GITHUB_REPOSITORY_RESPONSE.id}`, entryId: '7' };
    const instance = { ...sourceFixture.configuredInstance,
      instance: { ...sourceFixture.configuredInstance.instance, source: entryRef.source },
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, account: GITHUB_TEST_ACCOUNT },
      configuration: { v: 1, token: encodeGithubTriageConfiguration({ v: 1, scope: { kind: 'repository', repositoryKey: route } })! } };
    const selection = { sectionId: null, entryRef, sourceInstanceId: instance.instance.sourceInstanceId };
    let title = 'First open';
    let childNumber = 8;
    let holdIssueRead: Promise<void> | null = null;
    const issue = (number: number) => ({ ...GITHUB_ISSUE_RESPONSE, number, title,
      repository_url: `https://api.github.com/repos/${route}`, html_url: `https://github.com/${route}/issues/${number}` });
    const respond: Parameters<typeof createStubGithubTransport>[0]['respond'] = request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/issues/7')) {
        const body = issue(7);
        return holdIssueRead === null ? { status: 200, body }
          : holdIssueRead.then(() => ({ status: 200, body }));
      }
      if (path.endsWith('/parent')) return { status: 200, body: issue(6) };
      if (path.endsWith('/sub_issues')) return { status: 200, body: [issue(childNumber)] };
      if (path.endsWith('/blocked_by')) return { status: 200, body: [issue(9)] };
      return undefined;
    };
    // Independent detail/companion artifacts have distinct host service facades.
    // Sharing belongs to their Account/plugin scope, above either HTTP client.
    const transports = [createStubGithubTransport({ respond }), createStubGithubTransport({ respond })];
    let entryGets = 0;
    // Host admission supplies opaque handles; all source logic, qualification,
    // folding and the GitHub API client are real beneath the HTTP boundary.
    const admitted = [{ contributor: { pluginId: entryRef.source.pluginId, contributionId: entryRef.source.localId },
      descriptor: { ...sourceFixture.descriptor, kinds: [{ id: 'issue', displayName: 'Issue', pluralDisplayName: 'Issues', workflowSubject: 'issue' }] },
      operations: { get: {} } }] as unknown as readonly TriageAdmittedSourceV1[];
    const scope = createTriageEphemeralSharedScopeFixture();
    const lanes = Object.freeze([]);
    function Reader({ name, open }: { name: string; open: boolean }) {
      const detail = useTriagePostMutationRow(null, lanes, open ? selection : null);
      const snapshot = detail.row?.observations[0]?.outcome;
      return <><Text value={`${name}:${snapshot?.kind === 'present' ? `${snapshot.snapshot.title}:${snapshot.snapshot.relations?.children?.entries?.[0]?.entryId}` : 'reading'}`} />
        <Button title={`Refresh ${name}`} onPress={detail.completePostMutation} /></>;
    }
    const surface = defineUiSurface(() => {
      const [open, setOpen] = React.useState(true);
      const [detailOpen, setDetailOpen] = React.useState(true);
      return <><Button title="Toggle issue" onPress={() => setOpen(value => !value)} />
        <Button title="Close detail" onPress={() => setDetailOpen(false)} />
        <Reader name="detail" open={open && detailOpen} /><Reader name="companion" open={open} /></>;
    });
    const shell = await createPluginUiTestkit({
      identity: { instanceId: 'issue-open', mountNonce: 'issue-open' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' }, surface,
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: scope }),
      handlers: { executeAction: async request => {
        const http = transports[entryGets++ % transports.length]!;
        const input = TriageReobserveEntryInputV1Schema.parse(request.input);
        const result = await reobserveTriageEntry({ ...input, lastKnownLocator: { v: 1, routingToken: route } }, {
          readConfiguredInstance: async () => instance, readAdmittedSources: async () => admitted,
          signal: request.signal,
          executeGet: async (_operation, getInput, options) => getGithubTriageEntry(getInput,
            { ...http.context, signal: options?.signal ?? http.context.signal }), nowMs: () => Date.now(),
        });
        if (result.kind !== 'observed') throw new Error(result.kind);
        const { entryRef, ...observation } = result.observation;
        return { kind: 'observed', entryRef, observation: toTriageWireObservation(observation) };
      } },
    });
    const expectedPaths = [`/repos/${route}`, `/repos/${route}/issues/7`,
      `/repos/${route}/issues/7/parent`, `/repos/${route}/issues/7/sub_issues`, `/repos/${route}/issues/7/dependencies/blocked_by`].sort();
    const paths = () => transports.flatMap(http => http.requests.map(request => new URL(request.url).pathname)).sort();
    try {
      await vi.waitFor(() => expect(paths().length).toBeGreaterThanOrEqual(expectedPaths.length));
      expect(paths()).toEqual(expectedPaths);
      expect(entryGets).toBe(1);
      await vi.waitFor(async () => {
        await expect(shell.getByText('detail:First open:8')).resolves.toBeDefined();
        await expect(shell.getByText('companion:First open:8')).resolves.toBeDefined();
      });
      // One entry get: one issue DTO, one repository identity, three relations.
      await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Toggle issue' })); });
      title = 'Fresh next open'; childNumber = 10;
      await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Toggle issue' })); });
      await shell.getByText('detail:Fresh next open:10');
      await shell.getByText('companion:Fresh next open:10');
      expect(paths()).toEqual([...expectedPaths, ...expectedPaths].sort());
      title = 'Explicitly refreshed'; childNumber = 11;
      await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Refresh detail' })); });
      await shell.getByText('detail:Explicitly refreshed:11');
      expect(paths()).toEqual([...expectedPaths, ...expectedPaths, ...expectedPaths].sort());
      // Leaving one surface must not cancel the other borrower's same read.
      await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Toggle issue' })); });
      const held = Promise.withResolvers<void>();
      holdIssueRead = held.promise;
      await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Toggle issue' })); });
      await vi.waitFor(() => expect(entryGets).toBe(4));
      if (duringRead === 'refresh') {
        title = 'Changed during open';
        holdIssueRead = null;
        let refresh: Promise<void> | undefined;
        try {
          await act(async () => { refresh = shell.press(await shell.getByRole('button', { name: 'Refresh detail' })); });
          await vi.waitFor(() => expect(entryGets).toBe(5));
          await vi.waitFor(async () => { await expect(shell.getByText('detail:Changed during open:11')).resolves.toBeDefined(); });
        } finally {
          await act(async () => { held.resolve(); await refresh; });
        }
        expect(paths()).toEqual(Array.from({ length: 5 }, () => expectedPaths).flat().sort());
        return;
      }
      await act(async () => { await shell.press(await shell.getByRole('button', { name: 'Close detail' })); });
      await act(async () => { held.resolve(); });
      await vi.waitFor(async () => {
        await expect(shell.getByText('companion:Explicitly refreshed:11')).resolves.toBeDefined();
      });
      expect(paths()).toEqual(Array.from({ length: 4 }, () => expectedPaths).flat().sort());
    } finally { await shell.dispose(); }
  });
});
