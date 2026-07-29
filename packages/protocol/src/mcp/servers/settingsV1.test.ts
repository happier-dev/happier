import { describe, expect, it } from 'vitest';

import { McpServersSettingsV1Schema } from './settingsV1.js';

describe('McpServersSettingsV1Schema', () => {
  it('accepts a valid stdio server entry and binding', () => {
    const res = McpServersSettingsV1Schema.safeParse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 's1',
          name: 'example',
          transport: 'stdio',
          stdio: { command: 'node', args: ['server.js'] },
          env: { FOO: { t: 'literal', v: 'bar' } },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [
        {
          id: 'b1',
          serverId: 's1',
          enabled: true,
          target: { t: 'allMachines' },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    expect(res.success).toBe(true);
  });

  it('rejects reserved server names', () => {
    for (const name of ['happier', '__proto__', 'prototype', 'constructor']) {
      const res = McpServersSettingsV1Schema.safeParse({
        v: 1,
        strictMode: false,
        servers: [
          {
            id: 's1',
            name,
            transport: 'stdio',
            stdio: { command: 'node', args: [] },
            env: {},
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        bindings: [],
      });
      expect(res.success).toBe(false);
    }
  });

  it('rejects invalid env var keys', () => {
    const res = McpServersSettingsV1Schema.safeParse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 's1',
          name: 'example',
          transport: 'stdio',
          stdio: { command: 'node', args: [] },
          env: { 'bad-key': { t: 'literal', v: 'x' } },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [],
    });
    expect(res.success).toBe(false);
  });

  it('rejects invalid header keys', () => {
    const res = McpServersSettingsV1Schema.safeParse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 's1',
          name: 'example',
          transport: 'http',
          remote: {
            url: 'https://mcp.example.com',
            headers: { 'Bad Header': { t: 'literal', v: 'x' } },
          },
          env: {},
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [],
    });
    expect(res.success).toBe(false);
  });

  it('rejects remote MCP URL fragments in catalog entries and binding overrides', () => {
    const base = {
      v: 1 as const,
      strictMode: false,
      servers: [{
        id: 's1',
        name: 'example',
        transport: 'http' as const,
        remote: {
          url: 'https://mcp.example.com',
          headers: {},
        },
        env: {},
        createdAt: 0,
        updatedAt: 0,
      }],
    };

    expect(McpServersSettingsV1Schema.safeParse({
      ...base,
      servers: [{
        ...base.servers[0],
        remote: {
          ...base.servers[0]!.remote,
          url: 'https://mcp.example.com/tools#section',
        },
      }],
      bindings: [],
    }).success).toBe(false);
    expect(McpServersSettingsV1Schema.safeParse({
      ...base,
      bindings: [{
        id: 'b1',
        serverId: 's1',
        enabled: true,
        target: { t: 'allMachines' as const },
        overrides: {
          remote: {
            url: 'https://mcp.example.com/override#section',
          },
        },
        createdAt: 0,
        updatedAt: 0,
      }],
    }).success).toBe(false);
  });

  it('enforces unique server names', () => {
    const res = McpServersSettingsV1Schema.safeParse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 's1',
          name: 'dup',
          transport: 'stdio',
          stdio: { command: 'node', args: [] },
          env: {},
          createdAt: 0,
          updatedAt: 0,
        },
        {
          id: 's2',
          name: 'dup',
          transport: 'stdio',
          stdio: { command: 'node', args: [] },
          env: {},
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [],
    });
    expect(res.success).toBe(false);
  });

  it('enforces unique server ids', () => {
    const res = McpServersSettingsV1Schema.safeParse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 's1',
          name: 'first',
          transport: 'stdio',
          stdio: { command: 'node', args: [] },
          env: {},
          createdAt: 0,
          updatedAt: 0,
        },
        {
          id: 's1',
          name: 'second',
          transport: 'stdio',
          stdio: { command: 'node', args: [] },
          env: {},
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [],
    });
    expect(res.success).toBe(false);
  });

  it('enforces unique binding ids', () => {
    const res = McpServersSettingsV1Schema.safeParse({
      v: 1,
      strictMode: false,
      servers: [
        {
          id: 's1',
          name: 'example',
          transport: 'stdio',
          stdio: { command: 'node', args: [] },
          env: {},
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      bindings: [
        { id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 },
        { id: 'b1', serverId: 's1', enabled: true, target: { t: 'allMachines' }, createdAt: 0, updatedAt: 0 },
      ],
    });
    expect(res.success).toBe(false);
  });
});
