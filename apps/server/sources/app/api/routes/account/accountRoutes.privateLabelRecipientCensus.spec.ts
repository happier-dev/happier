import { describe, expect, it, vi } from 'vitest';

import { createFakeRouteApp, getRouteEntry } from '../../testkit/routeHarness';
import { isRestrictedAuthTokenDeniedForRoute } from '@/app/api/utils/apiTokenRouteAdmission';
import { accountRoutes } from './accountRoutes';

describe('account private-label recipient census route', () => {
  it('admits normal Home credentials only on the normal path and Directory credentials only on the account-only path', () => {
    const app = createFakeRouteApp();
    accountRoutes(app as any);

    const normal = getRouteEntry(app, 'POST', '/v1/account/private-labels/recipient-census');
    const directory = getRouteEntry(app, 'POST', '/v1/account-directory/private-labels/recipient-census');

    expect(normal.opts.preHandler).toBe(app.authenticate);
    expect(normal.opts.config?.allowAccountDirectoryToken).toBeUndefined();
    expect(directory.opts.preHandler).toEqual([app.authenticate]);
    expect(directory.opts.config).toEqual({ allowAccountDirectoryToken: true });
    expect(normal.opts.schema).toEqual(expect.objectContaining({
      body: expect.anything(),
      response: expect.objectContaining({ 200: expect.anything(), 403: expect.anything(), 409: expect.anything() }),
    }));
    expect(isRestrictedAuthTokenDeniedForRoute({
      authTokenKind: 'account', routeOptions: { config: normal.opts.config },
    })).toBe(false);
    expect(isRestrictedAuthTokenDeniedForRoute({
      authTokenKind: 'terminal', routeOptions: { config: normal.opts.config },
    })).toBe(false);
    expect(isRestrictedAuthTokenDeniedForRoute({
      authTokenKind: 'account_directory', routeOptions: { config: normal.opts.config },
    })).toBe(true);
    expect(isRestrictedAuthTokenDeniedForRoute({
      authTokenKind: 'account_directory', routeOptions: { config: directory.opts.config },
    })).toBe(false);
    expect(isRestrictedAuthTokenDeniedForRoute({
      authTokenKind: 'account', routeOptions: { config: directory.opts.config },
    })).toBe(true);
  });

  it('refuses a Team census before a Directory credential can reach Team admission', async () => {
    const app = createFakeRouteApp();
    accountRoutes(app as any);
    const route = getRouteEntry(app, 'POST', '/v1/account-directory/private-labels/recipient-census');
    const reply = {
      code: vi.fn(() => reply),
      send: vi.fn((payload) => payload),
    };

    await expect(route.handler({
      userId: 'account-ada',
      body: { owner: { kind: 'team', teamId: 'team-1' } },
    }, reply)).resolves.toEqual({ error: 'forbidden' });
    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: 'forbidden' });
  });
});
