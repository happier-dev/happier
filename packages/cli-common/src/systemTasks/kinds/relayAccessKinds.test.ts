import { describe, expect, it, vi } from 'vitest';

import type { RelayAccessProvider } from '../../relayAccess/types.js';

import {
  createRelayAccessConfigureTaskKind,
  createRelayAccessDisableTaskKind,
  createRelayAccessStatusTaskKind,
  parseRelayAccessConfigureParams,
  redactRelayAccessParams,
} from './relayAccessKinds.js';

describe('relay access shared system task kinds', () => {
  it('parses cloudflare named-tunnel config and redacts the token field', () => {
    const parsed = parseRelayAccessConfigureParams({
      target: { kind: 'local' },
      providerId: 'cloudflareNamed',
      config: {
        hostname: 'relay.example.test',
        token: 'super-secret',
      },
    });

    expect(parsed.providerId).toBe('cloudflareNamed');
    expect(parsed.config).toEqual({
      providerId: 'cloudflareNamed',
      hostname: 'relay.example.test',
      token: 'super-secret',
    });
    expect(parsed.upstreamUrl).toBeNull();

    expect(redactRelayAccessParams(parsed as unknown as Record<string, unknown>)).toEqual({
      target: { kind: 'local' },
      upstreamUrl: null,
      providerId: 'cloudflareNamed',
      config: {
        providerId: 'cloudflareNamed',
        hostname: 'relay.example.test',
      },
    });
  });

  it('status kind normalizes provider output and redacts sensitive details', async () => {
    const abortController = new AbortController();
    const createExecutionContext = vi.fn((params: { upstreamUrl: string | null; target: unknown }) => ({
      env: process.env,
      upstreamUrl: params.upstreamUrl,
    }));
    const status = vi.fn(async () => ({
      state: 'enabled',
      shareUrl: 'https://relay.example.test',
      details: {
        token: 'super-secret',
        ok: true,
      },
    } as const));
    const provider: RelayAccessProvider = {
      descriptor: {
        id: 'cloudflareNamed',
        title: 'Cloudflare',
        exposure: 'public',
        prerequisites: [],
      },
      status,
    };

    const readConfig = vi.fn(async () => ({
      providerId: 'cloudflareNamed',
      hostname: 'relay.example.test',
      token: 'super-secret',
    } as const));

    const kind = createRelayAccessStatusTaskKind({
      readConfig,
      getProvider: () => provider,
      createExecutionContext,
    });

    const events: unknown[] = [];
    const result = await kind.run({
      params: {
        target: { kind: 'local' },
      },
      signal: abortController.signal,
      emit: (event) => {
        events.push(event);
      },
      prompt: async () => {
        throw new Error('relay access status should not prompt');
      },
    });

    expect(events).toEqual([
      {
        type: 'progress',
        stepId: 'relay.access.status.inspect',
        message: 'Inspecting relay access configuration',
      },
      {
        type: 'progress',
        stepId: 'relay.access.status.check',
        message: 'Checking relay access provider status',
      },
    ]);

    expect(status).toHaveBeenCalledWith(expect.objectContaining({
      signal: abortController.signal,
    }));

    expect(result).toEqual({
      configured: true,
      providerId: 'cloudflareNamed',
      status: {
        state: 'enabled',
        shareUrl: 'https://relay.example.test',
        details: {
          ok: true,
        },
      },
    });
  });

  it('configure kind persists the parsed config and returns a redacted status snapshot', async () => {
    const abortController = new AbortController();
    const createExecutionContext = vi.fn((params: { upstreamUrl: string | null; target: unknown }) => ({
      env: process.env,
      upstreamUrl: params.upstreamUrl,
    }));
    const configure = vi.fn(async () => ({ state: 'enabled', shareUrl: 'https://relay.example.test' } as const));
    const provider: RelayAccessProvider = {
      descriptor: {
        id: 'cloudflareNamed',
        title: 'Cloudflare',
        exposure: 'public',
        prerequisites: [],
      },
      configure,
      status: () => ({
        state: 'enabled',
        shareUrl: 'https://relay.example.test',
        details: {
          token: 'super-secret',
          ok: true,
        },
      }),
    };

    const writeConfig = vi.fn(async () => undefined);

    const kind = createRelayAccessConfigureTaskKind({
      writeConfig,
      getProvider: () => provider,
      createExecutionContext,
    });

    const result = await kind.run({
      params: {
        target: { kind: 'local' },
        upstreamUrl: 'http://127.0.0.1:3005',
        providerId: 'cloudflareNamed',
        config: { hostname: 'relay.example.test', token: 'super-secret' },
      },
      signal: abortController.signal,
      emit: () => {},
      prompt: async () => {
        throw new Error('relay access configure should not prompt');
      },
    });

    expect(writeConfig).toHaveBeenCalledWith({
      target: { kind: 'local' },
      config: {
        providerId: 'cloudflareNamed',
        hostname: 'relay.example.test',
        token: 'super-secret',
      },
    });
    expect(configure).toHaveBeenCalledTimes(1);
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({
      ctx: expect.objectContaining({
        upstreamUrl: 'http://127.0.0.1:3005',
      }),
      signal: abortController.signal,
    }));

    expect(result).toEqual({
      configured: true,
      providerId: 'cloudflareNamed',
      status: {
        state: 'enabled',
        shareUrl: 'https://relay.example.test',
        details: {
          ok: true,
        },
      },
    });
  });

  it('configure kind preserves approval responses from provider.configure without forcing a status refresh', async () => {
    const createExecutionContext = vi.fn((params: { upstreamUrl: string | null; target: unknown }) => ({
      env: process.env,
      upstreamUrl: params.upstreamUrl,
    }));
    const provider: RelayAccessProvider = {
      descriptor: {
        id: 'tailscaleServe',
        title: 'Tailscale Serve',
        exposure: 'private',
        prerequisites: [],
      },
      configure: async () => ({
        state: 'needs_auth',
        details: {
          approvalUrl: 'https://login.tailscale.com/f/serve?node=node-123',
        },
      }),
      status: () => {
        throw new Error('relay access status should not run when configure already returned an approval response');
      },
    };

    const writeConfig = vi.fn(async () => undefined);

    const kind = createRelayAccessConfigureTaskKind({
      writeConfig,
      getProvider: () => provider,
      createExecutionContext,
    });

    const result = await kind.run({
      params: {
        target: { kind: 'local' },
        upstreamUrl: 'http://127.0.0.1:3005',
        providerId: 'tailscaleServe',
        config: { providerId: 'tailscaleServe' },
      },
      emit: () => {},
      prompt: async () => {
        throw new Error('relay access configure should not prompt');
      },
    });

    expect(writeConfig).toHaveBeenCalledWith({
      target: { kind: 'local' },
      config: {
        providerId: 'tailscaleServe',
      },
    });
    expect(result).toEqual({
      configured: true,
      providerId: 'tailscaleServe',
      status: {
        state: 'needs_auth',
        shareUrl: null,
        details: {
          approvalUrl: 'https://login.tailscale.com/f/serve?node=node-123',
        },
      },
    });
  });

  it('disable kind clears persisted config and returns a disabled snapshot', async () => {
    const abortController = new AbortController();
    const createExecutionContext = vi.fn((params: { upstreamUrl: string | null; target: unknown }) => ({
      env: process.env,
      upstreamUrl: params.upstreamUrl,
    }));
    const disable = vi.fn(async () => undefined);
    const provider: RelayAccessProvider = {
      descriptor: {
        id: 'tailscaleServe',
        title: 'Tailscale Serve',
        exposure: 'private',
        prerequisites: [],
      },
      status: () => ({ state: 'enabled', shareUrl: 'https://machine.tailnet.ts.net' }),
      disable,
    };
    const readConfig = vi.fn(async () => ({ providerId: 'tailscaleServe' } as const));
    const writeConfig = vi.fn(async () => undefined);
    const kind = createRelayAccessDisableTaskKind({
      readConfig,
      writeConfig,
      getProvider: () => provider,
      createExecutionContext,
    });

    const result = await kind.run({
      params: {
        target: { kind: 'local' },
      },
      signal: abortController.signal,
      emit: () => {},
      prompt: async () => {
        throw new Error('relay access disable should not prompt');
      },
    });

    expect(writeConfig).toHaveBeenCalledWith({
      target: { kind: 'local' },
      config: null,
    });
    expect(disable).toHaveBeenCalledTimes(1);
    expect(disable).toHaveBeenCalledWith(expect.objectContaining({
      signal: abortController.signal,
    }));
    expect(result).toEqual({
      configured: false,
      providerId: null,
      status: {
        state: 'disabled',
        shareUrl: null,
        details: null,
      },
    });
  });
});
