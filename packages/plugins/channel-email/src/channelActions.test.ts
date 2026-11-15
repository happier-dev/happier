import { describe, expect, it } from 'vitest';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { deliverEmailMessage, pollEmailObservations, reconcileEmailDelivery,
  resolveEmailEndpoint, resolveEmailPrincipal, setupEmailChannels, testEmailConnection,
  fetchEmailAttachment } from './channelActions.js';

const config = {
  mailbox: 'wilson@example.com',
  transport: { pluginId: 'acme.email', contributionId: 'mail' },
  transportConfig: {},
  trustStrategy: { kind: 'authenticationResults', authservId: 'mx.example.com' },
  allowedDomains: ['example.com'],
};
const connection = {
  v: 1, connectionId: 'mail-1', providerConnectionKey: 'email:wilson@example.com',
  providerConfigVersion: 1, providerConfig: config, credentialRef: null,
};
const context = {
  surface: 'plugin', caller: { kind: 'plugin', pluginId: 'happier.channels' },
  signal: new AbortController().signal,
} as PluginInvocationContext;

describe('email provider principal admission', () => {
  it('normalizes an owner-entered address and rejects addresses outside configured domains', async () => {
    const resolve = resolveEmailPrincipal;
    const endpoint = { kind: 'direct', audience: 'direct', id: config.mailbox };
    await expect(resolve({ ...connection, providerConfig: { ...config, futureField: true,
      trustStrategy: { ...config.trustStrategy, futureMarker: true } }, endpoint, query: ' Alice@EXAMPLE.COM ' }, context))
      .resolves.toEqual({ kind: 'resolved', candidates: [{ id: 'alice@example.com', kind: 'human', label: 'alice@example.com' }] });
    await expect(resolve({ ...connection, endpoint, query: 'alice@external.com' }, context))
      .resolves.toEqual({ kind: 'resolved', candidates: [] });
  });

  it('does not impose a domain policy when the owner leaves allowedDomains empty', async () => {
    const resolve = resolveEmailPrincipal;
    await expect(resolve({ ...connection, providerConfig: { ...config, allowedDomains: [] },
      endpoint: { kind: 'direct', audience: 'direct', id: config.mailbox }, query: 'partner@external.com' }, context))
      .resolves.toEqual({ kind: 'resolved', candidates: [{ id: 'partner@external.com', kind: 'human', label: 'partner@external.com' }] });
  });

  it('refuses address lists instead of broadening one principal into several recipients', async () => {
    const resolve = resolveEmailPrincipal;
    await expect(resolve({ ...connection, endpoint: { kind: 'direct', audience: 'direct', id: config.mailbox },
      query: 'alice@example.com, bob@example.com' }, context)).resolves.toEqual({ kind: 'resolved', candidates: [] });
  });
});

describe('email provider caller authority', () => {
  it.each([setupEmailChannels, testEmailConnection, resolveEmailEndpoint, resolveEmailPrincipal,
    pollEmailObservations, deliverEmailMessage, reconcileEmailDelivery, fetchEmailAttachment])('refuses callers without a host-stamped plugin surface before parsing or I/O (%s)', async role => {
    await expect(role({}, { ...context, surface: 'cli', caller: undefined }))
      .rejects.toMatchObject({ code: 'channels_core_caller_required' });
    await expect(role({}, { ...context, caller: undefined }))
      .rejects.toMatchObject({ code: 'channels_core_caller_required' });
  });
});

describe('email mailbox resolution', () => {
  it('resolves only the configured mailbox and does not expose a recipient picker', async () => {
    await expect(resolveEmailEndpoint({ ...connection, query: ' WILSON@EXAMPLE.COM ' }, context))
      .resolves.toEqual({ kind: 'resolved', candidates: [{ kind: 'direct', audience: 'direct', id: config.mailbox, label: config.mailbox }] });
    await expect(resolveEmailEndpoint({ ...connection, query: 'alice@example.com' }, context))
      .resolves.toEqual({ kind: 'resolved', candidates: [] });
    await expect(resolveEmailEndpoint({ ...connection, query: config.mailbox, kinds: ['thread'] }, context))
      .resolves.toEqual({ kind: 'resolved', candidates: [] });
  });
});
