import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginInstallReviewPrincipalDigestSchema } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';

const boundary = vi.hoisted(() => ({
  settingsVersion: 1 as number | null,
}));

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: object) => React.createElement('Item', props),
}));

vi.mock('@/components/plugins/permissions/PluginPermissionGrantSheet', () => ({
  PluginPermissionGrantSheet: (props: object) => React.createElement('PluginPermissionGrantSheet', props),
}));

vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({
    translate: (key, params) => params ? `${key} ${JSON.stringify(params)}` : key,
  });
});

vi.mock('@/sync/store/hooks', () => ({
  useSettingsVersion: () => boundary.settingsVersion,
}));

const contribution = Object.freeze({ pluginId: 'acme.voice', localId: 'browser' });
const rawGrant = Object.freeze({
  realm: 'web' as const,
  phase: 'connection' as const,
  request: Object.freeze({
    kind: 'httpHeaders' as const,
    origin: 'https://voice.example.test',
    headerNames: Object.freeze(['authorization']),
  }),
});
const subject = Object.freeze({
  kind: 'credential_access_disclosure' as const,
  contribution,
  credentialSlotId: 'api_key' as never,
  purpose: 'voice.browser' as never,
  accessDeclarationDigest: 'b'.repeat(64) as never,
  selectedAuthorityDigest: 'c'.repeat(64) as never,
  selectedRawAccessDigest: 'd'.repeat(64) as never,
  installedGenerationId: 'generation-1' as never,
  installReviewPrincipalDigest: PluginInstallReviewPrincipalDigestSchema.parse('a'.repeat(64)),
});
// The daemon only ever authorizes as an exact machine installation; a grant
// approved by another machine, or by an installation this one replaced, is a
// different person's approval on a different device.
const thisInstallation = Object.freeze({
  kind: 'machine_installation' as const,
  machineId: 'machine-a',
  installationId: 'installation-1',
});
const otherMachine = Object.freeze({
  kind: 'machine_installation' as const,
  machineId: 'machine-b',
  installationId: 'installation-1',
});
const replacedInstallation = Object.freeze({
  kind: 'machine_installation' as const,
  machineId: 'machine-a',
  installationId: 'installation-2',
});
const authorization = Object.freeze({
  pluginId: contribution.pluginId,
  capability: 'credentials.materialize.raw' as const,
  targetScope: Object.freeze({ kind: 'account' as const }),
  subject,
  authoritySource: thisInstallation,
  // Mutable to match the protocol's `z.array(...)` output; freezing the array
  // is what previously forced the fixture behind an `as never` cast.
  disclosures: [{
    sourceClass: Object.freeze({ kind: 'savedSecret' as const, secretKinds: ['apiKey' as const] }),
    realm: 'web' as const,
    phase: 'connection' as const,
    materialization: 'httpHeaders' as const,
    origin: 'https://voice.example.test',
    destination: 'authorization',
  }],
});
const review = Object.freeze({
  plugin: Object.freeze({ id: contribution.pluginId, name: 'Acme Voice', version: '2.0.0' }),
  package: Object.freeze({ identity: '@acme/voice' }),
  distribution: Object.freeze({
    kind: 'npm' as const,
    packageName: '@acme/voice',
    registryOrigin: 'https://registry.npmjs.org',
  }),
  publisher: Object.freeze({
    status: 'unverified' as const,
    id: 'acme',
    displayName: 'Acme',
  }),
  packageSignature: Object.freeze({ status: 'verified' as const, keyId: 'registry-signing-key' }),
  contribution: Object.freeze({ identity: contribution, name: 'Browser Voice' }),
  credentialSlot: Object.freeze({ id: 'api_key', name: 'API key', purpose: 'voice.browser' }),
});

const pendingRequest = Object.freeze({
  v: 1 as const,
  id: 'request-1',
  accountId: 'account-1',
  pluginId: contribution.pluginId,
  capability: authorization.capability,
  targetScope: authorization.targetScope,
  subject,
  authoritySource: thisInstallation,
  requester: Object.freeze({ kind: 'plugin' as const, pluginId: contribution.pluginId }),
  reason: 'Voice provider raw credential access review',
  status: 'pending' as const,
  createdAt: 1,
  updatedAt: 1,
});

const subjectB = Object.freeze({
  ...subject,
  selectedAuthorityDigest: 'e'.repeat(64) as never,
});
const authorizationB = Object.freeze({
  ...authorization,
  subject: subjectB,
});
const reviewB = Object.freeze({
  ...review,
  credentialSlot: Object.freeze({
    ...review.credentialSlot,
    name: 'Account B API key',
  }),
});
const pendingRequestB = Object.freeze({
  ...pendingRequest,
  id: 'request-2',
  subject: subjectB,
});

const grant = Object.freeze({
  v: 1 as const,
  id: 'grant-1',
  accountId: 'account-1',
  pluginId: contribution.pluginId,
  capability: authorization.capability,
  targetScope: authorization.targetScope,
  subject,
  authoritySource: thisInstallation,
  status: 'active' as const,
  requestId: pendingRequest.id,
  grantedByUserId: 'user-1',
  grantedAt: 2,
  createdAt: 2,
  updatedAt: 2,
});

describe('VoiceRawCredentialAccessReview', () => {
  beforeEach(() => {
    boundary.settingsVersion = 1;
  });

  it('lists, requests, approves, and revokes the exact host-derived raw credential subject', async () => {
    const client = {
      inspect: vi.fn(async () => ({ ok: true as const, authorization, review })),
      request: vi.fn(async () => ({ ok: true as const, authorization, review, pendingRequest })),
    };
    const actions = {
      list: vi.fn(async () => ({ grants: [], pendingRequests: [] })),
      request: vi.fn(),
      grant: vi.fn(async () => ({
        grant,
        pendingRequest: { ...pendingRequest, status: 'granted' as const, grantId: grant.id, decidedAt: 2 },
      })),
      revoke: vi.fn(async () => ({ grant: { ...grant, status: 'revoked' as const, revokedAt: 3 } })),
      dismissRequest: vi.fn(async () => ({
        pendingRequest: { ...pendingRequest, status: 'dismissed' as const, decidedAt: 3 },
      })),
    };
    const { VoiceRawCredentialAccessReview } = await import('./VoiceRawCredentialAccessReview');
    const screen = await renderScreen(
      <VoiceRawCredentialAccessReview
        contribution={contribution}
        rawGrant={rawGrant}
        client={client}
        actions={actions}
        testID="raw-access"
      />,
    );

    await vi.waitFor(() => expect(actions.list).toHaveBeenCalledWith({
      pluginId: contribution.pluginId,
      capability: 'credentials.materialize.raw',
      targetScope: { kind: 'account' },
      subject,
      includeRevoked: false,
      includeResolvedRequests: false,
      limit: 200,
    }));

    await act(async () => {
      screen.tree.findByTestId('raw-access')?.props.onPress();
    });
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith(contribution, rawGrant));
    const sheet = screen.tree.findByTestId('raw-access-sheet');
    expect(sheet).not.toBeNull();
    expect(JSON.stringify(sheet?.props.detailRows)).toContain('@acme/voice');
    expect(JSON.stringify(sheet?.props.detailRows)).toContain('https://registry.npmjs.org');
    expect(JSON.stringify(sheet?.props.detailRows)).toContain('Acme');
    expect(JSON.stringify(sheet?.props.detailRows)).toContain('unverified');
    expect(JSON.stringify(sheet?.props.detailRows)).toContain('registry-signing-key');
    expect(JSON.stringify(sheet?.props.detailRows)).toContain('recipientApprovalPackageSignature');
    expect(JSON.stringify(sheet?.props.detailRows)).not.toContain('verified publisher');
    expect(JSON.stringify(sheet?.props.detailRows)).toContain('authorization');
    expect(JSON.stringify(sheet?.props.detailRows)).not.toContain('secret-value');
    const decisionBody = sheet?.props.labels.body({ pluginName: 'Acme Voice' });
    expect(decisionBody).toContain('settingsVoice.externalCredentials.rawCredentialAccessReviewBody');
    expect(decisionBody).toContain(contribution.pluginId);
    expect(decisionBody).toContain(contribution.localId);
    expect(decisionBody).toContain('api_key');
    expect(decisionBody).toContain('savedSecret(apiKey)');
    expect(decisionBody).toContain('web');
    expect(decisionBody).toContain('connection');
    expect(decisionBody).not.toContain('credentials.materialize.raw');

    await act(async () => {
      sheet?.props.onGrant({ requestId: pendingRequest.id });
    });
    await vi.waitFor(() => expect(screen.tree.findByTestId('raw-access')?.props.destructive).toBe(true));

    await act(async () => {
      screen.tree.findByTestId('raw-access')?.props.onPress();
    });
    await vi.waitFor(() => expect(actions.revoke).toHaveBeenCalledWith({ grantId: grant.id }));
    expect(actions.request).not.toHaveBeenCalled();
  });

  it('never reads another machine installation approval as this machine being granted', async () => {
    const client = {
      inspect: vi.fn(async () => ({ ok: true as const, authorization, review })),
      request: vi.fn(async () => ({ ok: true as const, authorization, review, pendingRequest })),
    };
    const actions = {
      list: vi.fn(async () => ({
        grants: [
          { ...grant, id: 'grant-other-machine', authoritySource: otherMachine },
          { ...grant, id: 'grant-replaced-installation', authoritySource: replacedInstallation },
        ],
        pendingRequests: [
          { ...pendingRequest, id: 'request-other-machine', authoritySource: otherMachine },
        ],
      })),
      request: vi.fn(),
      grant: vi.fn(),
      revoke: vi.fn(),
      dismissRequest: vi.fn(),
    };
    const { VoiceRawCredentialAccessReview } = await import('./VoiceRawCredentialAccessReview');
    const screen = await renderScreen(
      <VoiceRawCredentialAccessReview
        contribution={contribution}
        rawGrant={rawGrant}
        client={client}
        actions={actions as never}
        testID="raw-access"
      />,
    );

    await vi.waitFor(() => expect(actions.list).toHaveBeenCalled());
    await vi.waitFor(() => expect(screen.tree.findByTestId('raw-access')?.props.loading).toBe(false));
    expect(screen.tree.findByTestId('raw-access')?.props.destructive).toBe(false);
    expect(screen.tree.findByTestId('raw-access')?.props.detail)
      .toBe('settingsVoice.externalCredentials.reviewRequired');
    // Another installation's pending request must never be presented here as
    // this installation's decision.
    expect(screen.tree.findByTestId('raw-access-sheet')).toBeNull();

    await act(async () => {
      screen.tree.findByTestId('raw-access')?.props.onPress();
    });
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith(contribution, rawGrant));
    expect(actions.revoke).not.toHaveBeenCalled();
  });

  it('revokes this installation grant rather than the first account-wide match', async () => {
    const client = {
      inspect: vi.fn(async () => ({ ok: true as const, authorization, review })),
      request: vi.fn(async () => ({ ok: true as const, authorization, review, pendingRequest })),
    };
    const actions = {
      // The other machine's grant is listed first on purpose: taking the first
      // account-wide match would revoke a different device's approval.
      list: vi.fn(async () => ({
        grants: [
          { ...grant, id: 'grant-other-machine', authoritySource: otherMachine },
          grant,
        ],
        pendingRequests: [],
      })),
      request: vi.fn(),
      grant: vi.fn(),
      revoke: vi.fn(async () => ({ grant: { ...grant, status: 'revoked' as const, revokedAt: 3 } })),
      dismissRequest: vi.fn(),
    };
    const { VoiceRawCredentialAccessReview } = await import('./VoiceRawCredentialAccessReview');
    const screen = await renderScreen(
      <VoiceRawCredentialAccessReview
        contribution={contribution}
        rawGrant={rawGrant}
        client={client}
        actions={actions as never}
        testID="raw-access"
      />,
    );

    await vi.waitFor(() => expect(screen.tree.findByTestId('raw-access')?.props.destructive).toBe(true));
    await act(async () => {
      screen.tree.findByTestId('raw-access')?.props.onPress();
    });
    await vi.waitFor(() => expect(actions.revoke).toHaveBeenCalledWith({ grantId: grant.id }));
    expect(actions.revoke).not.toHaveBeenCalledWith({ grantId: 'grant-other-machine' });
  });

  it('re-inspects before deciding a captured request when account settings switch', async () => {
    let selectedAccount: 'A' | 'B' = 'A';
    const inspectionForSelectedAccount = () => selectedAccount === 'A'
      ? { ok: true as const, authorization, review }
      : { ok: true as const, authorization: authorizationB, review: reviewB };
    const client = {
      inspect: vi.fn(async () => inspectionForSelectedAccount()),
      request: vi.fn(async () => ({ ok: true as const, authorization, review, pendingRequest })),
    };
    const actions = {
      list: vi.fn(async (input: Readonly<{ subject: unknown }>) => ({
        grants: [],
        pendingRequests: JSON.stringify(input.subject) === JSON.stringify(subjectB)
          ? [pendingRequestB]
          : [],
      })),
      request: vi.fn(),
      grant: vi.fn(),
      revoke: vi.fn(),
      dismissRequest: vi.fn(),
    };
    const { VoiceRawCredentialAccessReview } = await import('./VoiceRawCredentialAccessReview');
    const renderReview = () => (
      <VoiceRawCredentialAccessReview
        contribution={contribution}
        rawGrant={rawGrant}
        client={client}
        actions={actions as never}
        testID="raw-access"
      />
    );
    const screen = await renderScreen(renderReview());

    await act(async () => {
      screen.tree.findByTestId('raw-access')?.props.onPress();
    });
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith(contribution, rawGrant));
    const staleSheet = screen.tree.findByTestId('raw-access-sheet');
    expect(staleSheet).not.toBeNull();
    const staleGrant = staleSheet?.props.onGrant;
    const staleDismiss = staleSheet?.props.onDismiss;

    selectedAccount = 'B';
    boundary.settingsVersion = 2;

    // A user decision can race the subscription render. The action itself
    // must therefore re-inspect rather than decide the captured request.
    await act(async () => {
      staleGrant?.({ requestId: pendingRequest.id });
    });
    await vi.waitFor(() => {
      expect(screen.tree.findByTestId('raw-access-sheet')?.props.pendingRequest.id).toBe(pendingRequestB.id);
    });
    expect(actions.grant).not.toHaveBeenCalled();

    await act(async () => {
      staleDismiss?.({ requestId: pendingRequest.id });
    });
    // Five inspections so far: mount, the explicit request, the settings-version
    // refresh committed with account B, and one per captured decision.
    await vi.waitFor(() => expect(client.inspect).toHaveBeenCalledTimes(5));
    expect(actions.dismissRequest).not.toHaveBeenCalled();

    // A further settings switch must re-derive the authorization on its own,
    // without any decision driving it.
    const inspectionsBeforeSettingsRefresh = client.inspect.mock.calls.length;
    boundary.settingsVersion = 3;
    await act(async () => {
      screen.tree.update(renderReview());
    });
    await vi.waitFor(() => expect(client.inspect).toHaveBeenCalledTimes(inspectionsBeforeSettingsRefresh + 1));
    const freshSheet = screen.tree.findByTestId('raw-access-sheet');
    expect(freshSheet?.props.pendingRequest.id).toBe(pendingRequestB.id);
    expect(JSON.stringify(freshSheet?.props.detailRows)).toContain('Account B API key');
  });
});
