import { describe, expect, it } from 'vitest';

import {
  areSessionMcpSelectionsEquivalent,
  parseSessionMcpSelectionV1Json,
  readSessionMcpSelectionRestartRequiredV1FromMetadata,
  readSessionMcpSelectionV1FromMetadata,
  SessionMcpSelectionV1Schema,
} from './sessionSelectionV1.js';

describe('SessionMcpSelectionV1Schema', () => {
  it('retains the explicit built-in Happier tools opt-out', () => {
    expect(SessionMcpSelectionV1Schema.parse({ happierToolsEnabled: false }))
      .toMatchObject({ happierToolsEnabled: false });
    expect(areSessionMcpSelectionsEquivalent(
      SessionMcpSelectionV1Schema.parse({}),
      SessionMcpSelectionV1Schema.parse({ happierToolsEnabled: false }),
    )).toBe(false);
    expect(areSessionMcpSelectionsEquivalent(
      SessionMcpSelectionV1Schema.parse({}),
      SessionMcpSelectionV1Schema.parse({ happierToolsEnabled: true }),
    )).toBe(true);
  });

  it('retains tolerant metadata reading for released V1 selections', () => {
    expect(readSessionMcpSelectionV1FromMetadata({ mcpSelectionV1: {
      v: 1, managedServersEnabled: false, extensionField: 'from-another-reader',
    } })).toEqual({ v: 1, managedServersEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [] });
  });

  it.each(['{"servers":[]}', '[]', 'null', 'false'])('rejects unsupported selection JSON %s', (raw) => {
    expect(parseSessionMcpSelectionV1Json(raw)).toBeNull();
  });

  it('defaults to enabled managed servers with empty include/exclude lists', () => {
    const parsed = SessionMcpSelectionV1Schema.parse({});
    expect(parsed).toEqual({
      v: 1,
      managedServersEnabled: true,
      forceIncludeServerIds: [],
      forceExcludeServerIds: [],
    });
  });

  it('deduplicates include and exclude server ids', () => {
    const parsed = SessionMcpSelectionV1Schema.parse({
      v: 1,
      managedServersEnabled: false,
      forceIncludeServerIds: ['server-a', 'server-a', 'server-b'],
      forceExcludeServerIds: ['server-c', 'server-c'],
    });

    expect(parsed.forceIncludeServerIds).toEqual(['server-a', 'server-b']);
    expect(parsed.forceExcludeServerIds).toEqual(['server-c']);
  });

  it('reads a valid session MCP selection from metadata', () => {
    const selection = readSessionMcpSelectionV1FromMetadata({
      path: '/repo',
      mcpSelectionV1: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['server-a', 'server-a'],
        forceExcludeServerIds: ['server-b'],
      },
    });

    expect(selection).toEqual({
      v: 1,
      managedServersEnabled: false,
      forceIncludeServerIds: ['server-a'],
      forceExcludeServerIds: ['server-b'],
    });
  });

  it('compares selections by effective server behavior instead of array ordering', () => {
    expect(areSessionMcpSelectionsEquivalent({
      v: 1,
      managedServersEnabled: false,
      forceIncludeServerIds: ['server-b', 'server-a', 'excluded'],
      forceExcludeServerIds: ['excluded', 'server-c'],
    }, {
      v: 1,
      managedServersEnabled: false,
      forceIncludeServerIds: ['server-a', 'server-b'],
      forceExcludeServerIds: ['server-c', 'excluded'],
    })).toBe(true);

    expect(areSessionMcpSelectionsEquivalent({
      v: 1,
      managedServersEnabled: true,
      forceIncludeServerIds: [],
      forceExcludeServerIds: [],
    }, {
      v: 1,
      managedServersEnabled: false,
      forceIncludeServerIds: [],
      forceExcludeServerIds: [],
    })).toBe(false);
  });

  it('reads the applied selection baseline from the restart-required marker', () => {
    expect(readSessionMcpSelectionRestartRequiredV1FromMetadata({
      mcpSelectionRestartRequiredV1: {
        v: 1,
        appliedSelection: {
          v: 1,
          managedServersEnabled: true,
          forceIncludeServerIds: ['server-a', 'server-a'],
          forceExcludeServerIds: [],
        },
      },
    })).toEqual({
      v: 1,
      appliedSelection: {
        v: 1,
        managedServersEnabled: true,
        forceIncludeServerIds: ['server-a'],
        forceExcludeServerIds: [],
      },
    });

    expect(readSessionMcpSelectionRestartRequiredV1FromMetadata({
      mcpSelectionRestartRequiredV1: { v: 2 },
    })).toBeNull();
  });
});
