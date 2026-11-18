import { describe, expect, it } from 'vitest';
import type { ConnectedAccountReadContext } from '@happier-dev/plugin-sdk/connected-accounts';
import { connectedAccountRuntime } from './account.js';
import { forbiddenResponse, personalUserResponse, teamId, teamResponse } from './fixtures/accountPlanResponses.js';

const service = { pluginId: 'happier.machine.vercel', localId: 'vercel-account' } as const;

function readContext(response: unknown, status = 200, values: { teamId?: string } = { teamId }, responseSequence?: readonly unknown[]): { context: ConnectedAccountReadContext; requests: string[] } {
  const requests: string[] = [];
  let responseIndex = 0;
  const context = {
    plugin: { id: service.pluginId, version: '0.0.0' },
    contribution: { id: service.localId, qualifiedId: `${service.pluginId}/${service.localId}` },
    surface: 'background' as const,
    invokedAtMs: 1_000,
    signal: new AbortController().signal,
    account: { service, accountId: teamId },
    configuration: { target: { kind: 'account' as const, account: { service, accountId: teamId }, modeId: 'token' },
      revision: 'revision-1', values, async getSecret() { return null; } },
    credentials: { async get() { return 'token'; } },
    services: { http: { async request(request: { url: string }) {
      requests.push(request.url);
      const body = responseSequence?.[responseIndex++] ?? response;
      return { status, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
    } } },
  } as unknown as ConnectedAccountReadContext;
  return { context, requests };
}

describe('Vercel account plan quota', () => {
  it('maps a documented billing plan from the selected team response', async () => {
    const { context, requests } = readContext(teamResponse('pro'));
    const result = await connectedAccountRuntime.quota?.(context);
    expect(result).toMatchObject({ planLabel: 'Pro' });
    expect(requests).toEqual([`https://api.vercel.com/v2/teams/${teamId}`]);
  });

  it('uses a personal account defaultTeamId only after the documented user response supplies it', async () => {
    const { context, requests } = readContext({}, 200, {}, [personalUserResponse, teamResponse('hobby')]);
    await expect(connectedAccountRuntime.quota?.(context)).resolves.toMatchObject({ planLabel: 'Hobby' });
    expect(requests).toEqual(['https://api.vercel.com/v2/user', `https://api.vercel.com/v2/teams/${teamId}`]);
  });

  it.each([
    { name: 'unmapped plan', body: teamResponse('custom'), status: 200 },
    { name: 'denied response', body: forbiddenResponse, status: 403 },
  ])('returns no plan label for $name', async ({ body, status }) => {
    const { context } = readContext(body, status);
    await expect(connectedAccountRuntime.quota?.(context)).resolves.toMatchObject({ observedAtMs: 1_000, planLabel: null });
  });
});
