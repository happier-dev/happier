import { describe, expect, it } from 'vitest';
import { SavedSecretSchema } from '@/sync/domains/settings/savedSecretTypes';
import { resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import type {
  McpServerCatalogEntryV1,
  McpServersSettingsV1,
} from '@happier-dev/protocol/mcp/servers/settingsV1';

import { buildMcpServerCollection } from '../collection/mcpServerCollectionModel';
import { buildMcpHome, MCP_RING_MORE_KEY } from './mcpHomeModel';
import type { McpSignInView } from '../signIn/mcpSignInGrantView';

/** A test grant: absent (never signed in), signed in, or one whose sign-in ran out. */
type McpHomeGrant = Readonly<{ connected: boolean; identity: string | null }> | null;
function signInView(grant: McpHomeGrant): McpSignInView {
  if (!grant) return { state: 'not_connected' };
  if (!grant.connected) return { state: 'expired', reason: 'expired' };
  return { state: 'connected', identity: grant.identity, scopes: [], lastUsedAt: null };
}

type Kind = 'oauth' | 'key' | 'local' | 'remote';

function entry(
  id: string,
  kind: Kind,
  tools?: number,
): McpServerCatalogEntryV1 {
  const base = {
    id,
    name: id,
    title: id[0]!.toUpperCase() + id.slice(1),
    env: {},
  };
  const snapshot =
    tools === undefined
      ? {}
      : {
          toolsSnapshot: {
            checkedAt: 1,
            machineId: 'm1',
            tools: Array.from({ length: tools }, (_, i) => ({
              name: `t${i}`,
              tokens: 100,
            })),
          },
        };
  if (kind === 'local')
    return {
      ...base,
      transport: 'stdio',
      stdio: { command: 'npx', args: [] },
      ...snapshot,
    } as unknown as McpServerCatalogEntryV1;
  return {
    ...base,
    transport: 'http',
    remote: {
      url: `https://${id}.example/mcp`,
      headers:
        kind === 'key'
          ? { Authorization: { t: 'savedSecret', secretId: `secret-${id}` } }
          : {},
      ...(kind === 'oauth' ? { auth: { kind: 'oauth' } } : {}),
    },
    ...snapshot,
  } as unknown as McpServerCatalogEntryV1;
}

function settings(
  servers: readonly McpServerCatalogEntryV1[],
  off: readonly string[] = [],
): McpServersSettingsV1 {
  return {
    v: 1,
    servers: [...servers],
    bindings: servers
      .filter((server) => !off.includes(server.id))
      .map((server) => ({
        id: `rule-${server.id}`,
        serverId: server.id,
        enabled: true,
        scope: { t: 'everywhere' },
      })),
  } as unknown as McpServersSettingsV1;
}

function home(
  input: Readonly<{
    servers: readonly McpServerCatalogEntryV1[];
    off?: readonly string[];
    grants?: Readonly<Record<string, McpHomeGrant>>;
    secrets?: readonly string[];
    dismissed?: boolean;
    suggestions?: readonly string[];
    machineFactsOf?: Parameters<typeof buildMcpHome>[0]['machineFactsOf'];
  }>,
) {
  return buildMcpHome({
    rows: buildMcpServerCollection(settings(input.servers, input.off), ''),
    signInOf: (id) => signInView(input.grants?.[id] ?? null),
    savedSecretCatalog: { resolveReference: ref => resolveSavedSecretReference(null,
      (input.secrets ?? []).map(id => SavedSecretSchema.parse({ id, name: id, kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, value: 'test-value' }, createdAt: 1, updatedAt: 1 })), ref) },
    firstVisitDismissed: input.dismissed ?? false,
    machineFactsOf: input.machineFactsOf,
    suggestions: (input.suggestions ?? []).map((key) => ({
      key,
      iconUrl: null,
      title: key,
    })),
  });
}

describe('MCP homepage model (P7 U7.11, lab hm-A)', () => {
  it('tethers each server by how it reaches the agents', () => {
    const model = home({
      servers: [
        entry('github', 'oauth', 41),
        entry('sentry', 'oauth'),
        entry('context7', 'key', 2),
        entry('postgres', 'local'),
        entry('playwright', 'local', 21),
        entry('figma', 'oauth'),
      ],
      off: ['figma'],
      grants: {
        github: { connected: true, identity: 'leeroy-brun' },
        sentry: { connected: false, identity: null },
      },
      secrets: ['secret-context7'],
    });
    const tether = Object.fromEntries(
      model.servers.map((server) => [server.id, server.tether]),
    );
    expect(tether).toEqual({
      github: 'account', // signed in once
      sentry: 'attention', // its sign-in ran out
      context7: 'account', // a saved secret, held by the Account
      playwright: 'machine',
      postgres: 'machine',
      figma: 'none', // off: no tether, and no problem asked of the person
    });
    expect(
      model.servers.find((server) => server.id === 'sentry')?.status?.kind,
    ).toBe('expired');
    expect(
      model.servers.find((server) => server.id === 'figma')?.status,
    ).toBeNull();
    expect(
      model.servers.find((server) => server.id === 'github')?.identity,
    ).toBe('leeroy-brun');
    expect(model.needsYou).toBe(1);
    expect(model.attention).toEqual([model.servers.find(server => server.id === 'sentry')]);
    expect(model.present).toEqual({
      servers: 5,
      tools: 64,
      tokens: 6400,
      toolsKnown: true,
    });
  });

  it('projects attention from the same admitted rows in shared blocking order, excluding Off and healthy servers', () => {
    const model = home({
      servers: [entry('alpha-key', 'key'), entry('zulu-runtime', 'local'), entry('healthy', 'remote'), entry('off', 'key')],
      off: ['off'],
      machineFactsOf: row => row.server.transport === 'stdio' ? {
        tests: { m1: { ok: false, errorCode: 'mcp_connect_failed', checkedAt: 1 } },
        machines: [{ machineId: 'm1', name: 'Build', online: true }],
      } : { tests: {}, machines: [] },
    });
    expect(model.attention.map(server => [server.id, server.status?.kind])).toEqual([
      ['zulu-runtime', 'error'], ['alpha-key', 'key'],
    ]);
    expect(model.attention.every(server => model.servers.includes(server))).toBe(true);
    expect(model.needsYou).toBe(model.attention.length);
  });

  it('a missing key and a server never signed in both need the person', () => {
    const model = home({
      servers: [entry('context7', 'key'), entry('linear', 'oauth')],
    });
    expect(
      model.servers.map((server) => [server.id, server.status?.kind, server.tether]),
    ).toEqual([
      ['context7', 'key', 'attention'],
      ['linear', 'signin', 'attention'],
    ]);
  });

  it('groups the legend: signed in once (remote) and runs on your machines (local); off servers stay out', () => {
    const model = home({
      servers: [
        entry('linear', 'oauth'),
        entry('fetch', 'local'),
        entry('context7', 'key'),
        entry('figma', 'oauth'),
      ],
      off: ['figma'],
      grants: { linear: { connected: true, identity: null } },
      secrets: ['secret-context7'],
    });
    expect(model.legend.account.map((server) => server.id)).toEqual([
      'context7',
      'linear',
    ]);
    expect(model.legend.machine.map((server) => server.id)).toEqual(['fetch']);
  });

  it('brand new: suggestions stand on the ring as faded, untethered marks', () => {
    const model = home({
      servers: [],
      suggestions: [
        'linear',
        'github',
        'notion',
        'playwright',
        'sentry',
        'brave',
      ],
    });
    expect(model.ring.marks).toEqual(
      ['linear', 'github', 'notion', 'playwright', 'sentry'].map((key) => ({
        key,
        tether: 'none',
      })),
    );
    expect(model.ring.more).toBe(0);
  });

  it('13 servers draw 11 marks and "+2", needs-you first, then in use by name', () => {
    const names = [
      'alpha',
      'bravo',
      'charlie',
      'delta',
      'echo',
      'foxtrot',
      'golf',
      'hotel',
      'india',
      'juliet',
      'kilo',
      'lima',
      'mike',
    ];
    const servers = names.map((name) =>
      entry(name, name === 'lima' || name === 'mike' ? 'key' : 'local'),
    );
    const model = home({ servers });
    expect(model.ring.marks).toHaveLength(12);
    expect(model.ring.marks.slice(0, 2)).toEqual([
      { key: 'lima', tether: 'attention' },
      { key: 'mike', tether: 'attention' },
    ]);
    expect(model.ring.marks.slice(2, 11).map((mark) => mark.key)).toEqual(
      names.slice(0, 9),
    );
    // The count mark stands at full strength: it is a fact, not an off server.
    expect(model.ring.marks[11]).toEqual({
      key: MCP_RING_MORE_KEY,
      tether: 'none',
      faded: false,
    });
    expect(model.ring.more).toBe(2);
    // Twelve fit whole.
    expect(home({ servers: servers.slice(0, 12) }).ring).toMatchObject({
      more: 0,
    });
    expect(home({ servers: servers.slice(0, 12) }).ring.marks).toHaveLength(12);
  });

  it('the first-visit line shows until dismissed or once a sign-in server exists', () => {
    const local = [entry('playwright', 'local'), entry('context7', 'key')];
    expect(home({ servers: local }).firstVisitLine).toBe(true);
    expect(home({ servers: local, dismissed: true }).firstVisitLine).toBe(
      false,
    );
    expect(
      home({ servers: [...local, entry('linear', 'oauth')] }).firstVisitLine,
    ).toBe(false);
    // A brand-new Account has the empty state instead.
    expect(home({ servers: [] }).firstVisitLine).toBe(false);
  });
});
