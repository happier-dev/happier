import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import type { Artifact, ArtifactHeader, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useArtifacts } from '@/sync/domains/state/storage';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { fetchAndApplyArtifactsList } from '@/sync/engine/artifacts/syncArtifacts';
import { isOpenApprovalInboxArtifact } from '@/sync/domains/artifacts/approvalArtifacts';
import { storage } from '@/sync/domains/state/storageStore';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { removeServerProfile, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { installApprovalCommonModuleMocks } from '../../approvals/approvalsTestHelpers';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { createPluginInstallationReviewFixture } from '@happier-dev/protocol/testing/pluginInstallationReviewFixture';
import { preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text/i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const APPROVAL_ARTIFACT_HEADER: ArtifactHeader = {
  title: 'Approve answering the user',
  actionId: 'session.user_action.answer',
  sessionId: 'session-1',
};

function createApprovalArtifact(): Extract<DecryptedArtifact, { isDecrypted: true }> {
  return { id: 'artifact-1', title: 'Approval', headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    isDecrypted: true, header: { ...APPROVAL_ARTIFACT_HEADER } };
}

installApprovalCommonModuleMocks({ text: () => vi.importActual('@/text') });
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

const initialState = storage.getState();
let serverIdB = '';
beforeEach(async () => {
  await upsertServerProfile({ serverUrl: 'https://home-b.example.test', name: 'Home B' });
  const profile = await setServerProfileIdentityForUrl('https://home-b.example.test', 'srv_approval_home_b');
  if (!profile) throw new Error('Expected the approval Home profile');
  serverIdB = profile.id;
  const primary = createSessionFixture({ id: 'session-1', metadata: {
    ...createSessionFixture().metadata!, name: 'Repo session', path: '/Users/leeroy/stale-repo',
    host: 'tester.local', homeDir: '/Users/leeroy', machineId: 'machine-stale',
  } });
  const secondary = createSessionFixture({ id: 'session-1', serverId: serverIdB, metadata: {
    ...createSessionFixture().metadata!, name: 'Secondary Home session', path: '/Users/secondary/repo',
    host: 'secondary.local', homeDir: '/Users/secondary', machineId: 'machine-secondary',
  } });
  // Home B's Session list has been read, so a Session it does not hold is absent rather than still loading.
  storage.setState({ sessions: { [primary.id]: primary }, sessionListRowsByServerId: {
    [serverIdB]: { [secondary.id]: buildSessionListRenderableFromSession(secondary) },
  }, concurrentSessionListCacheByServerId: { [serverIdB]: { serverName: null, listObservation: { phase: 'ready', lastSuccessAt: 1 } } } });
});
afterEach(async () => {
  setPreferredLanguageFromSettings('en');
  standardCleanup();
  storage.setState(initialState, true);
  if (serverIdB) await removeServerProfile(serverIdB);
});

describe('ApprovalInboxCard', () => {
  it('says where a request comes from on its one line under the title, never above it', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const machine = createMachineFixture({ id: 'origin-machine', metadata: { ...createMachineFixture().metadata!, displayName: 'Build Mac', host: 'build.test' } });
    storage.setState({ machineListByServerId: { [serverIdB]: [machine] } });
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'system', pluginId: 'example.observer', contributionLocalId: 'observer' },
      actionId: 'automation.event.sources.list', actionArgs: { transport: { kind: 'checkpointedPull' } }, summary: 'Read sources',
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'plugin', serverId: serverIdB,
        serverIdentityId: 'srv_approval_home_b', machineId: machine.id, actionId: 'automation.event.sources.list', requestId: 'request',
        caller: { kind: 'plugin', pluginId: 'example.observer', contributionLocalId: 'observer',
          sourceCustody: { kind: 'development', registeredRootId: 'observer-root' } } } });
    const artifact = { ...createApprovalArtifact(), header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) };
    const screen = await renderScreen(<ApprovalInboxCard artifact={artifact} onPress={() => {}} />);
    expect(screen.findByTestId(`inbox.approval.${artifact.id}.summary:source`)).toBeNull();
    expect(screen.findByTestId(`inbox.approval.${artifact.id}.summary:facts`)).not.toBeNull();
    expect(screen.getTextContent()).toContain('Build Mac');
  });

  it('names the origin Machine of a sessionless daemon approval from its exact Home', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const machine = createMachineFixture({ id: 'daemon-machine', metadata: {
      ...createMachineFixture().metadata!, displayName: 'Build Mac', host: 'build.test',
    } });
    const otherHomeMachine = { ...machine, metadata: { ...machine.metadata!, displayName: 'Other Home machine' } };
    storage.setState({ machines: { [machine.id]: otherHomeMachine }, machineListByServerId: { [serverIdB]: [machine] } });
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'system', pluginId: 'example.observer', contributionLocalId: 'observer' },
      actionId: 'automation.event.sources.list', actionArgs: { transport: { kind: 'checkpointedPull' } }, summary: 'Read sources',
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'plugin', serverId: serverIdB,
        serverIdentityId: 'srv_approval_home_b', machineId: machine.id, actionId: 'automation.event.sources.list', requestId: 'request',
        caller: { kind: 'plugin', pluginId: 'example.observer', contributionLocalId: 'observer',
          sourceCustody: { kind: 'development', registeredRootId: 'observer-root' } } } });
    const artifact = { ...createApprovalArtifact(), header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) };
    const screen = await renderScreen(<ApprovalInboxCard artifact={artifact} onPress={() => {}} />);
    expect(screen.getTextContent()).toContain('Build Mac');
    expect(screen.getTextContent()).not.toContain('Other Home machine');
    expect(String(screen.findByTestId('inbox.approval.artifact-1')?.props.accessibilityLabel)).toContain('Build Mac');
  });

  it('mounts unclassified and stale-kind approvals while inventory sync repairs only their kind metadata', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const approval = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, actionId: 'session.list', actionArgs: {}, summary: 'List sessions',
      executionOriginV1: { v: 1, authority: 'account_automation', caller: { kind: 'host' }, requestId: 'read-only-approval',
        surface: 'cli', serverId: serverIdB, actionId: 'session.list' } });
    const rows: Artifact[] = [undefined, 'prompt' as const].map((kind, index) => ({
      id: `11111111-1111-4111-8111-11111111111${index}`, ownerAccountId: 'owner', access: 'owner',
      encryptionMode: 'plain', kind, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval)),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }),
      publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: index, createdAt: 1, updatedAt: 1,
    }));
    const requests: Array<{ path: string; method: string; body?: unknown }> = [];
    // Only the Home HTTP boundary is replaced; sync, codecs, store and mounted cards stay real.
    const request = async (path: string, init?: RequestInit) => {
      requests.push({ path, method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}) });
      if (path.startsWith('/v1/artifacts?')) return Response.json(rows.map(({ body: _body, ...head }) => head));
      if (path === '/v1/artifacts/read') return Response.json({ items: rows.map(artifact => ({
        artifactId: artifact.id, ok: true, artifact, recipientCensus: null,
      })) });
      return Response.json({ success: true });
    };
    function ApprovalRead() {
      return <>{useArtifacts().filter(isOpenApprovalInboxArtifact).map(artifact =>
        <ApprovalInboxCard key={artifact.id} artifact={artifact} onPress={() => {}} />)}</>;
    }
    storage.setState({ artifacts: {} });
    const screen = await renderScreen(<ApprovalRead />);
    await act(async () => {
      await fetchAndApplyArtifactsList({ credentials: { token: 'fixture' }, encryption: null,
        artifactDataKeys: new Map(), request, applyArtifacts: artifacts => storage.getState().applyArtifacts(artifacts) });
    });
    for (const row of rows) {
      expect(screen.findByTestId(`inbox.approval.${row.id}`)).not.toBeNull();
      expect(storage.getState().artifacts[row.id]).toMatchObject({ kind: row.kind, body: JSON.stringify(approval), isDecrypted: true });
    }
    const writes = requests.filter(({ path, method }) => method !== 'GET' && path !== '/v1/artifacts/read');
    expect(writes).toEqual(rows.map(row => ({ path: `/v1/artifacts/${row.id}`, method: 'POST',
      body: { kind: 'other', expectedHeaderVersion: 1 } })));
    // Mounting or rerendering a card itself remains observational.
    await act(async () => { screen.tree.update(<ApprovalRead />); });
    expect(requests.filter(({ path, method }) => method !== 'GET' && path !== '/v1/artifacts/read')).toEqual(writes);
  });
  it('localizes the first-party title in French and resolves its document through the shared reference reader', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    await preloadTranslations('fr');
    setPreferredLanguageFromSettings('fr');
    storage.setState({ settingsScope: { serverId: serverIdB, accountId: 'owner' } });
    storage.getState().applyArtifacts([{ id: 'release-notes', title: 'Notes de version',
      isDecrypted: true, header: { title: 'Notes de version' }, headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }]);
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, actionId: 'artifact.public_link.create', summary: 'Create document public link',
      actionArgs: { artifactId: 'release-notes' },
      executionOriginV1: { v: 1, authority: 'account_automation', caller: { kind: 'host' }, requestId: 'public-link-review',
        surface: 'cli', serverId: serverIdB, actionId: 'artifact.public_link.create' },
    });
    const screen = await renderScreen(<ApprovalInboxCard artifact={{ ...createApprovalArtifact(),
      header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) }} onPress={() => {}} />);
    expect(screen.getTextContent()).toContain('Créer un lien public pour « Notes de version » ?');
    expect(screen.getTextContent()).not.toContain('Create document public link');
  });
  it('names an install from its evaluated review rather than its generic summary or plugin id', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, actionId: 'plugins.install', summary: 'Install plugin',
      actionArgs: { path: '/tmp/review-helper', kind: 'path' },
      preview: { pluginInstall: { permissionsDisclosure: 'daemonEvaluated', pendingReview: {
        kind: 'reviewRequired', reviewKind: 'installation', pendingChangeId: 'install-review', reason: 'firstInstall',
        currentVersion: null, authorityExpansion: [],
        review: createPluginInstallationReviewFixture({ displayName: 'Review companion' }),
      } } },
      executionOriginV1: { v: 1, authority: 'account_automation', caller: { kind: 'host' }, requestId: 'install-review',
        surface: 'cli', serverId: serverIdB, actionId: 'plugins.install' },
    });
    const artifact: DecryptedArtifact = { ...createApprovalArtifact(), header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) };
    const screen = await renderScreen(<ApprovalInboxCard artifact={artifact} onPress={() => {}} />);
    expect(screen.getTextContent()).toContain('Review companion');
    expect(screen.getTextContent()).not.toContain('acme.example');
  });
  it('distinguishes an older saved-group approval by the name in its admitted body', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, actionId: 'widgets.fragment.update', summary: 'Update saved group',
      actionArgs: { account: { serverId: serverIdB, accountId: 'owner' }, artifactId: 'opaque-library-id', patch: { name: 'Capacity and PRs' } },
      executionOriginV1: { v: 1, authority: 'account_automation', caller: { kind: 'host' }, requestId: 'rename-group',
        surface: 'cli', serverId: serverIdB, actionId: 'widgets.fragment.update' } });
    const artifact: DecryptedArtifact = { ...createApprovalArtifact(), header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) };
    const screen = await renderScreen(<ApprovalInboxCard artifact={artifact} onPress={() => {}} />);
    expect(screen.getTextContent()).toContain('Capacity and PRs');
    expect(screen.getTextContent()).not.toContain('opaque-library-id');
  });
  it('shows the qualified plugin action without interpreting it as a built-in action', async () => {
    await preloadTranslations('fr');
    setPreferredLanguageFromSettings('fr');
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: {
        title: 'Publish release notes',
        kind: 'target_action_approval.v1',
        qualifiedActionId: 'acme.publisher/actions/releases/publish',
      },
    } satisfies DecryptedArtifact;
    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={artifact}
        onPress={() => {}}
      />,
    );
    // A plugin action is named by its request, never by its raw qualified id.
    expect(screen.getTextContent()).toContain('Publish release notes');
    expect(screen.getTextContent()).not.toContain(
      'acme.publisher/actions/releases/publish',
    );
    expect(screen.getTextContent()).toContain(t('inbox.work.rows.approvalNeeded'));
    expect(
      screen.findByTestId(`inbox.approval.${artifact.id}`)?.props,
    ).toMatchObject({
      accessibilityRole: 'button',
    });
    expect(
      String(
        screen.findByTestId(`inbox.approval.${artifact.id}`)?.props
          .accessibilityLabel,
      ),
    ).not.toContain('acme.publisher');
  });

  it('never repeats its title as the subtitle, and says what it needs instead', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: {
        ...APPROVAL_ARTIFACT_HEADER,
        title: 'Respond to user-action request',
      },
    } satisfies DecryptedArtifact;
    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={artifact}
        onPress={() => {}}
      />,
    );
    const text = screen.getTextContent();
    expect(text.split('Respond to user-action request')).toHaveLength(2);
    // The session that asked tells this row from its siblings; "needs your approval" is not repeated.
    expect(text).toContain('Repo session');
    expect(text).not.toContain(t('inbox.work.rows.approvalNeeded'));
    expect(
      String(
        screen.findByTestId(`inbox.approval.${artifact.id}`)?.props
          .accessibilityLabel,
      ),
    ).toContain(t('inbox.work.rows.approvalNeeded'));
  });

  it('drops the raw session id an older request stored after its title', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: {
        title: 'Set Session lead — cmv06zc2b003itmv4tsr5fin7',
        actionId: 'session.user_action.answer',
        sessionId: 'cmv06zc2b003itmv4tsr5fin7',
      },
    } satisfies DecryptedArtifact;
    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={artifact}
        onPress={() => {}}
      />,
    );
    const text = screen.getTextContent();
    expect(text).toContain('Set Session lead');
    expect(text).not.toContain('cmv06zc2b003itmv4tsr5fin7');
    expect(
      String(
        screen.findByTestId(`inbox.approval.${artifact.id}`)?.props
          .accessibilityLabel,
      ),
    ).not.toContain('cmv06zc2b003itmv4tsr5fin7');
  });

  it('names an approval whose stored title is only its raw Action id by what it is', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: {
        title: 'widgets.definition.update',
        actionId: 'widgets.definition.update',
        sessionId: 'session-1',
      },
    } satisfies DecryptedArtifact;
    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={artifact}
        onPress={() => {}}
      />,
    );
    // Titled by the Action's own name (or the plain fallback); the raw id is never copy.
    expect(screen.getTextContent()).not.toContain('widgets.definition.update');
    expect(
      String(screen.findByTestId(`inbox.approval.${artifact.id}`)?.props.accessibilityLabel ?? ''),
    ).not.toContain('widgets.definition.update');
  });

  it('answers a simple request from its row and leaves anything else behind Review', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli', sessionId: 'session-1' }, actionId: 'account.name.set', actionArgs: { name: 'Captain' },
      summary: 'Change name', executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli',
        caller: { kind: 'host' }, serverId: serverIdB, actionId: 'account.name.set', requestId: 'request-a' } });
    const simple = { ...createApprovalArtifact(), header: { ...buildApprovalRequestArtifactHeaderV1(request), sessionId: 'session-1' },
      body: JSON.stringify(request) } satisfies DecryptedArtifact;
    const screen = await renderScreen(<ApprovalInboxCard artifact={simple} inlineActionLabel="Review" onPress={() => {}} />);
    expect(screen.findHostByTestId(`inbox.approval.${simple.id}.allow_once`)).toBeTruthy();
    expect(screen.findHostByTestId(`inbox.approval.${simple.id}.deny`)).toBeTruthy();
    expect(screen.findHostByTestId(`inbox.approval.${simple.id}.review`)).toBeFalsy();
    // Where it comes from leads the row, above the title.
    expect(screen.getTextContent()).toContain('Secondary Home session');

    const unreviewed = { ...simple, body: JSON.stringify({ ...request, actionArgs: { name: 'Captain', unreviewed: true } }) };
    const other = await renderScreen(<ApprovalInboxCard artifact={unreviewed} inlineActionLabel="Review" onPress={() => {}} />);
    expect(other.findHostByTestId(`inbox.approval.${simple.id}.allow_once`)).toBeFalsy();
    expect(other.findHostByTestId(`inbox.approval.${simple.id}.review`)).toBeTruthy();
  });
  it('keeps an agent\'s request to remember a Project setup behind Review and says so on its row', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const workspace = { serverId: serverIdB, machineId: 'machine-a', workspaceId: 'checkout', rootPath: '/src/happier' };
    const rowFor = (actionArgs: Record<string, unknown>) => {
      const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'cli', sessionId: 'session-1' }, actionId: 'projects.prepare', actionArgs,
        summary: 'Prepare project', executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli',
          caller: { kind: 'host' }, serverId: serverIdB, actionId: 'projects.prepare', requestId: 'request-a' } });
      return { ...createApprovalArtifact(), header: { ...buildApprovalRequestArtifactHeaderV1(request), sessionId: 'session-1' },
        body: JSON.stringify(request) } satisfies DecryptedArtifact;
    };
    const remembered = rowFor({ workspace, phase: 'setup', heldOperationId: 'operation-1', expectedEffectDigest: 'reviewed', consentScope: 'untilChanged' });
    const asked = await renderScreen(<ApprovalInboxCard artifact={remembered} inlineActionLabel="Review" onPress={() => {}} />);
    expect(asked.findHostByTestId(`inbox.approval.${remembered.id}.allow_once`)).toBeFalsy();
    expect(asked.findHostByTestId(`inbox.approval.${remembered.id}.review`)).toBeTruthy();
    expect(asked.getTextContent()).toContain(t('projects.scripts.setup.agentAsksRememberedRow'));

    const ordinary = rowFor({ workspace, phase: 'setup', expectedEffectDigest: 'reviewed', consentScope: 'thisTime' });
    const plain = await renderScreen(<ApprovalInboxCard artifact={ordinary} inlineActionLabel="Review" onPress={() => {}} />);
    expect(plain.getTextContent()).not.toContain(t('projects.scripts.setup.agentAsksRememberedRow'));
  });
  it('sets a simple request\'s Deny and Allow once beneath the row on a phone, outside the row button', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli', sessionId: 'session-1' }, actionId: 'account.name.set', actionArgs: { name: 'Captain' },
      summary: 'Change name', executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli',
        caller: { kind: 'host' }, serverId: serverIdB, actionId: 'account.name.set', requestId: 'request-a' } });
    const simple = { ...createApprovalArtifact(), header: { ...buildApprovalRequestArtifactHeaderV1(request), sessionId: 'session-1' },
      body: JSON.stringify(request) } satisfies DecryptedArtifact;
    const screen = await renderScreen(<ApprovalInboxCard artifact={simple} decideBelow narrow onPress={() => {}} />);
    const below = screen.findHostByTestId(`inbox.approval.${simple.id}:below`);
    expect(below).toBeTruthy();
    expect(below?.findAllByProps({ testID: `inbox.approval.${simple.id}.allow_once` }).length).toBeGreaterThan(0);
    expect(below?.findAllByProps({ testID: `inbox.approval.${simple.id}.deny` }).length).toBeGreaterThan(0);

    // Anything the row cannot decide whole is opened by the row itself: no button beneath it.
    const unreviewed = { ...simple, body: JSON.stringify({ ...request, actionArgs: { name: 'Captain', unreviewed: true } }) };
    const other = await renderScreen(<ApprovalInboxCard artifact={unreviewed} decideBelow narrow onPress={() => {}} />);
    expect(other.findHostByTestId(`inbox.approval.${simple.id}:below`)).toBeFalsy();
    expect(other.findHostByTestId(`inbox.approval.${simple.id}.allow_once`)).toBeFalsy();
  });
  it('says who asked on one line, without the machine, the folder or the Home address', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: { ...APPROVAL_ARTIFACT_HEADER, serverId: serverIdB },
    } satisfies DecryptedArtifact;
    const screen = await renderScreen(
      <ApprovalInboxCard artifact={artifact} onPress={() => {}} />,
    );

    const text = screen.getTextContent();
    expect(text).toContain('Secondary Home session');
    expect(text).not.toContain('Secondary workstation');
    expect(text).not.toContain('repo');
    expect(text).not.toContain('home-b.example.test');
    // One Home: naming it on every row would only repeat it.
    expect(text).not.toContain('Home B');
    expect(
      screen.findHostByTestId(`inbox.approval.${artifact.id}.summary:facts`)?.props.numberOfLines,
    ).toBe(1);
  });

  it('names the Home when the Inbox spans several', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={
          {
            ...createApprovalArtifact(),
            header: { ...APPROVAL_ARTIFACT_HEADER, serverId: serverIdB },
          } satisfies DecryptedArtifact
        }
        onPress={() => {}}
        showHome
      />,
    );

    expect(screen.getTextContent()).toContain('Home B');
  });

  it('says where a session lives when this device does not have it, never its id', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: {
        ...APPROVAL_ARTIFACT_HEADER,
        serverId: serverIdB,
        sessionId: 'cmv06zc2b003itmv4tsr5fin7',
      },
    } satisfies DecryptedArtifact;
    const screen = await renderScreen(
      <ApprovalInboxCard artifact={artifact} onPress={() => {}} />,
    );

    const text = screen.getTextContent();
    expect(text).toContain(t('detailPages.approval.sessionOnHome', { home: 'Home B' }));
    expect(text).not.toContain('cmv06zc2b003itmv4tsr5fin7');
    expect(text).not.toContain('home-b.example.test');
    expect(text).not.toContain(t('inbox.work.rows.approvalNeeded'));
  });

  it('names the person, not a session, when the person made the request themselves from the app', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const cardTextFor = async (surface: 'ui' | 'agent') => {
      const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'agent', sessionId: 'cmv06zc2b003itmv4tsr5fin7' }, actionId: 'session.list', actionArgs: {}, summary: 'List sessions',
        executionOriginV1: { v: 1, authority: surface === 'ui' ? 'present_user' : 'account_automation', caller: { kind: 'host' },
          requestId: `own-${surface}`, surface, serverId: serverIdB, sessionId: 'cmv06zc2b003itmv4tsr5fin7', actionId: 'session.list',
          sessionListAccess: 'current_session' } });
      const screen = await renderScreen(<ApprovalInboxCard onPress={() => {}} artifact={{ ...createApprovalArtifact(),
        header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) }} />);
      return screen.getTextContent();
    };

    const own = await cardTextFor('ui');
    expect(own).toContain(t('detailPages.approval.requesterYou'));
    expect(own).not.toContain(t('detailPages.approval.sessionOnHome', { home: 'Home B' }));
    expect(await cardTextFor('agent')).toContain(t('detailPages.approval.sessionOnHome', { home: 'Home B' }));
  });

  it('names the Home of a session this device cannot list when that Home has no name of its own', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    // A saved Home known only by its address: this device is signed in to it, so the session is on this Home.
    await upsertServerProfile({ serverUrl: 'https://home-c.example.test', name: 'home-c.example.test' });
    const profile = await setServerProfileIdentityForUrl('https://home-c.example.test', 'srv_approval_home_c');
    if (!profile) throw new Error('Expected the unnamed Home profile');
    storage.setState({ concurrentSessionListCacheByServerId: { [profile.id]: { serverName: null,
      listObservation: { phase: 'ready', lastSuccessAt: 1 } } } });
    try {
      const screen = await renderScreen(<ApprovalInboxCard onPress={() => {}} artifact={{ ...createApprovalArtifact(),
        header: { ...APPROVAL_ARTIFACT_HEADER, serverId: profile.id, sessionId: 'cmv06zc2b003itmv4tsr5fin7' },
      } satisfies DecryptedArtifact} />);
      const text = screen.getTextContent();
      expect(text).toContain(t('detailPages.approval.sessionOnHome', { home: t('settingsAccount.thisHome') }));
      expect(text).not.toContain(t('detailPages.approval.sessionElsewhere'));
    } finally {
      await removeServerProfile(profile.id);
    }
  });

  it('claims nothing about where a session lives while its Home list is still being read', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    storage.setState({ concurrentSessionListCacheByServerId: {} });
    const screen = await renderScreen(<ApprovalInboxCard onPress={() => {}} artifact={{ ...createApprovalArtifact(),
      header: { ...APPROVAL_ARTIFACT_HEADER, serverId: serverIdB, sessionId: 'cmv06zc2b003itmv4tsr5fin7' },
    } satisfies DecryptedArtifact} />);
    const text = screen.getTextContent();
    expect(text).not.toContain(t('detailPages.approval.sessionOnHome', { home: 'Home B' }));
    expect(text).not.toContain(t('detailPages.approval.sessionElsewhere'));
  });

  it('says the asking Session once when the title already names it', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, actionId: 'session.manager.set', summary: 'Set Session lead',
      actionArgs: { sessionId: 'session-1', leadSessionId: null, expectedLeadSessionId: null },
      executionOriginV1: { v: 1, authority: 'account_automation', caller: { kind: 'host' }, requestId: 'lead-once',
        surface: 'cli', serverId: serverIdB, actionId: 'session.manager.set', sessionId: 'session-1' } });
    const artifact: DecryptedArtifact = { ...createApprovalArtifact(),
      header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request) };
    const screen = await renderScreen(<ApprovalInboxCard artifact={artifact} onPress={() => {}} />);
    // The session is the request's own subject (its title) and also the one that asked: one mention.
    expect(screen.getTextContent().split('Secondary Home session')).toHaveLength(2);
    expect(String(screen.findByTestId(`inbox.approval.${artifact.id}`)?.props.accessibilityLabel))
      .toContain(t('inbox.work.rows.approvalNeeded'));
  });

  it('uses the approval Home when another Home has the same Session id', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: {
        ...APPROVAL_ARTIFACT_HEADER,
        serverId: serverIdB,
      },
    } satisfies DecryptedArtifact;

    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={artifact}
        onPress={() => {}}
      />,
    );

    expect(screen.getTextContent()).toContain('Secondary Home session');
    expect(screen.getTextContent()).not.toContain('Repo session');
    expect(screen.getTextContent()).not.toContain('/Users/secondary/repo');
  });

  it('finds the asking session through the Home identity when the request recorded another device’s Home id', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const artifact = {
      ...createApprovalArtifact(),
      header: {
        ...APPROVAL_ARTIFACT_HEADER,
        // The asking device's own profile id for the Home, unknown on this device.
        serverId: 'creator-local-home',
        serverIdentityId: 'srv_approval_home_b',
      },
    } satisfies DecryptedArtifact;
    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={artifact}
        onPress={() => {}}
      />,
    );

    expect(screen.getTextContent()).toContain('Secondary Home session');
    expect(screen.getTextContent()).not.toContain(
      'inbox.work.rows.approvalNeeded',
    );
  });

  it('does not synthesize Home-wide freshness in approval context', async () => {
    const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
    const screen = await renderScreen(
      <ApprovalInboxCard
        artifact={
          {
            ...createApprovalArtifact(),
            header: { ...APPROVAL_ARTIFACT_HEADER, serverId: serverIdB },
          } satisfies DecryptedArtifact
        }
        onPress={() => {}}
        nowMs={1_081_000}
      />,
    );

    expect(screen.getTextContent()).not.toContain('Offline');
    expect(screen.getTextContent()).not.toContain('Last updated');
  });

  it('names a locked qualified Session by where it lives without exposing cached private metadata', async () => {
    const previous = storage.getState().sessionListRowsByServerId;
    const locked = createSessionFixture({
      id: 'session-1',
      serverId: serverIdB,
      encryptionMode: 'e2ee',
      encryptedContentAvailability: 'encrypted_access_pending',
      metadata: {
        name: 'Private cached Inbox title',
        path: '/Users/private/inbox-secret',
        host: 'secondary.local',
        homeDir: '/Users/private',
        machineId: 'machine-secondary',
      },
    });
    storage.setState({ sessionListRowsByServerId: { [serverIdB]: {
      [locked.id]: buildSessionListRenderableFromSession(locked),
    } } });
    try {
      const { ApprovalInboxCard } = await import('./ApprovalInboxCard');
      const screen = await renderScreen(
        <ApprovalInboxCard
          artifact={
            {
              ...createApprovalArtifact(),
              header: { ...APPROVAL_ARTIFACT_HEADER, serverId: serverIdB },
            } satisfies DecryptedArtifact
          }
          onPress={() => {}}
        />,
      );

      expect(screen.getTextContent()).not.toContain(
        'Private cached Inbox title',
      );
      expect(screen.getTextContent()).not.toContain('inbox-secret');
      // A locked session reads by where it lives.
      expect(screen.getTextContent()).toContain(t('detailPages.approval.sessionOnHome', { home: 'Home B' }));
    } finally {
      storage.setState({ sessionListRowsByServerId: previous });
    }
  });
});
