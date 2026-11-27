import { describe, expect, it } from 'vitest';

import {
  DaemonContributionRegistryProjectionAutomationEligibleEventsV1Schema,
  DaemonContributionRegistryProjectionDescribeRequestSchema,
  DaemonContributionRegistryProjectionDescribeResponseSchema,
  DaemonContributionRegistryProjectionDescribeUnchangedResponseSchema,
  DaemonContributionRegistryProjectionSectionsResponseSchema,
  reassembleDaemonProjectionSections, demandedDaemonProjectionSections, daemonProjectionSectionsCover,
  daemonProjectionPluginSectionId, readDaemonProjectionSectionPlugins, DAEMON_PROJECTION_SESSION_PLUGINS,
  readDaemonProjectionSectionPartPlugin, buildDeferredDaemonProjectionSections, DaemonProjectionDeferredSectionsResponseSchema,
  applyDaemonProjectionSectionBindings,
  DaemonProjectionSectionBodyResponseSchema, DAEMON_PROJECTION_SECTION_FRAME_BYTES,
  computeDaemonProjectionSectionDigest, computeDaemonProjectionSectionDigestAsync,
  DaemonPluginUiComposerSurfaceCatalogEntryV1Schema,
  DaemonPluginUiTargetedSurfaceMountV1Schema,
  DaemonPluginUiTargetedContributionsReadRequestSchema,
  DaemonPluginUiTargetedContributionsReadResponseSchema,
  DaemonPluginActionFormConnectedAccountOptionsResolveRequestSchema,
  DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema,
  DaemonPluginActionSchemasReadRequestSchema,
  DaemonPluginActionSchemasReadResponseSchema,
  DaemonPluginStructuredMessageActionExecuteRequestSchema,
  DaemonPluginStructuredMessageActionExecuteResponseSchema,
  DaemonPluginComposerReferenceSearchRequestSchema,
  DaemonPluginComposerReferenceSearchResponseSchema,
  DaemonPluginUiResourceReadRequestSchema,
  DaemonPluginUiResourceReadResponseSchema,
  DaemonPluginUiResourceWatchOpenRequestSchema,
  DaemonPluginUiResourceWatchNextResponseSchema,
  DaemonPluginSettingsWatchRequestSchema,
  DaemonPluginSettingsWatchResponseSchema,
  DaemonPluginUiArtifactBytesReadRequestSchema,
  DaemonPluginUiArtifactBytesReadResponseSchema,
  PluginProjectedActionV2Schema,
  PluginProjectedAgentV2Schema,
  PluginProjectedResourceV2Schema,
  PluginProjectedSettingsFieldV2Schema,
  PluginProjectionInstalledPackageV2Schema,
  PluginProjectionV2Schema,
  PluginDeclaredUiEntryV1Schema,
  PluginUiResourceBindingCapabilityV1Schema,
  projectPluginSettingsContributionV2,
  readDaemonPluginUiTargetedSurfaceMountV1,
} from './contributionRegistryProjection.js';
import * as protocol from '../index.js';
import { PluginActionContributionV2Schema } from '../plugins/actions/v2.js';
import { pluginActionRequiresPresentUserIntent } from '../plugins/actions/invocation.js';
import { RPC_METHODS } from '../rpc/index.js';
import { PluginSettingsContributionV2Schema } from '../plugins/contributions/settings.js';
import { PluginActionPresentUserAuthorizationFactsSchema } from '../plugins/actions/invocation.js';
import type { PluginDeclarativeProjectedModelV1 } from '../plugins/contributions/ui/declarativeProjectedModelV1.js';
import { normalizePluginUiDestinationBindingV1 } from '../plugins/contributions/ui/surfaceRegistry.js';
import { FIRST_PARTY_SKILLS_V1 } from '../prompts/library/skills/firstPartySkillsV1.js';

const TARGET_SOURCE_CUSTODY = {
  kind: 'development',
  registeredRootId: 'target-root',
} as const;
const CONTRIBUTOR_SOURCE_CUSTODY = {
  kind: 'managed',
  immutableGenerationId: 'contributor-generation',
  installSource: 'archive',
} as const;

it('accepts large canonical Resource bytes and rejects malformed encodings for native and plugin reads', () => {
  const base64 = Buffer.alloc(16 * 1024 * 1024, 97).toString('base64');
  const common = { ok: true, contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}` };
  const resources = [
    { ...common, resource: { hostRead: 'machines.services.list', input: { serverId: 'home', machineId: 'machine' } } },
    { ...common, resource: { pluginId: 'happier.machine.services', localId: 'logs' }, kind: 'asset' },
  ];
  for (const resource of resources) {
    expect(DaemonPluginUiResourceReadResponseSchema.safeParse({ ...resource, bytesBase64: base64 }).success).toBe(true);
    for (const bytesBase64 of ['', 'YQ==']) {
      expect(DaemonPluginUiResourceReadResponseSchema.safeParse({ ...resource, bytesBase64 }).success).toBe(true);
    }
    for (const bytesBase64 of ['AB==', 'AAB=', 'YQ==\n', 'Y=Q=', 'YQ=']) {
      expect(DaemonPluginUiResourceReadResponseSchema.safeParse({ ...resource, bytesBase64 }).success).toBe(false);
    }
  }
});

it('preserves cold Bot template descriptors in the canonical daemon family projection', () => {
  const entry = { id: 'acme.bots/garden', pluginId: 'acme.bots', pluginVersion: '1.0.0',
    definition: { id: 'garden', path: 'templates/garden.json' } };
  const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
    familiesById: { botTemplates: { family: 'botTemplates', entriesById: { [entry.id]: entry } } } });
  expect(projection.familiesById.botTemplates?.entriesById[entry.id]).toEqual(entry);
});

describe('private daemon Action read observation wire', () => {
  it('admits a closed Action request and content-free signal while preserving Resource digest requirements', () => {
    const actionRead = { machineId: 'machine', qualifiedActionId: 'acme.source/state',
      expectedContributorOccurrenceId: 'source-occurrence', requiredReadOnly: true, executionSurface: 'cli', input: {},
      invocation: { kind: 'clientPluginAction', clientActionBinding: { pluginId: 'acme.account',
        contributionLocalId: 'aggregate', occurrenceId: 'account-occurrence' } } };
    const open = { machineId: 'machine', callerPluginId: 'acme.source', expectedCallerOccurrenceId: 'source-occurrence',
      subscriptionId: 'read-watch', resource: { actionRead } };
    expect(DaemonPluginUiResourceWatchOpenRequestSchema.safeParse(open).success).toBe(true);
    expect(DaemonPluginUiResourceWatchOpenRequestSchema.safeParse({ ...open,
      resource: { actionRead: { ...actionRead, inventedAuthority: true } } }).success).toBe(false);
    expect(DaemonPluginUiResourceWatchNextResponseSchema.safeParse({ ok: true, status: 'event',
      event: { version: 1, subscriptionId: 'read-watch', kind: 'readInvalidated' } }).success).toBe(true);
    expect(DaemonPluginUiResourceWatchNextResponseSchema.safeParse({ ok: true, status: 'event',
      event: { version: 1, subscriptionId: 'read-watch', kind: 'invalidated' } }).success).toBe(false);
  });
});

/**
 * One complete final projected declarative model exactly as the CLI producer
 * emits it, typed against the Protocol wire contract. Used both as the
 * accepted wire payload and as the base for malformed variants that the
 * strict wire schema must reject.
 */
function createValidDeclarativeProjectedModelV1(): PluginDeclarativeProjectedModelV1 {
  const modeSetting = {
    id: 'mode',
    contributionId: 'preferences',
    qualifiedId: 'acme.review/settings/daemon/preferences/fields/mode',
    descriptor: {
      id: 'mode',
      title: 'Mode',
      target: { kind: 'plugin' },
      scope: 'daemon',
      schema: { type: 'string' },
      default: 'compact',
    },
  } as const;
  return {
    identity: {
      pluginId: 'acme.review',
      localId: 'review-preview',
      qualifiedId: 'acme.review/review-preview',
      occurrenceId: 'occurrenceId-7',
    },
    visible: true,
    requiredHostMethods: [],
    declarativeInventory: {
      actions: [
        {
          identity: { pluginId: 'acme.review', localId: 'approve' },
          qualifiedId: 'acme.review/approve',
          occurrenceId: 'occurrenceId-7',
          enabled: true,
          title: 'Approve',
        },
      ],
      destinations: [
        {
          identity: { pluginId: 'acme.review', localId: 'details' },
          qualifiedId: 'acme.review/details',
          occurrenceId: 'occurrenceId-7',
        },
      ],
      settings: [
        {
          pluginId: 'acme.review',
          id: 'mode',
          qualifiedId: 'acme.review/settings/daemon/preferences/fields/mode',
          schema: { type: 'string' },
          secret: false,
          setting: modeSetting,
        },
      ],
      uiQueries: [],
    },
    root: {
      kind: 'stack',
      path: 'root',
      order: 0,
      children: [
        { kind: 'text', path: 'root.children[0]', order: 1, text: 'Review ready' },
        {
          kind: 'field',
          path: 'root.children[1]',
          order: 2,
          label: 'Mode',
          control: { kind: 'text', settingId: 'mode' },
          setting: modeSetting,
        },
        {
          kind: 'action',
          path: 'root.children[2]',
          order: 3,
          label: 'Approve',
          action: {
            identity: { pluginId: 'acme.review', localId: 'approve' },
            qualifiedId: 'acme.review/approve',
            occurrenceId: 'occurrenceId-7',
          },
          enabled: true,
        },
      ],
    },
  };
}

describe('daemon contribution registry projection (wire)', () => {
  it('shares the opted-in declaration index while preserving the answering Machine binding', () => {
    const response = (machine: string) => DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
      protocolVersion: 1, projectionDigest: (machine === 'one' ? 'a' : 'b').repeat(64),
      projection: { v: 2, generation: 1, installedPackagesById: {
        'acme.one': { id: 'acme.one', displayName: 'One', enabled: true,
          source: { kind: 'bundled', locator: 'acme.one' }, occurrenceId: 'occurrence-' + machine },
      } },
    });
    const legacy = buildDeferredDaemonProjectionSections(response('one'));
    const one = buildDeferredDaemonProjectionSections(response('one'), { bindingOverlay: true });
    const two = buildDeferredDaemonProjectionSections(response('two'), { bindingOverlay: true });
    const section = 'installedPackagesById';
    expect(one.manifest.sections[section]).toBe(two.manifest.sections[section]);
    expect(one.manifest.sections[section]).not.toBe(legacy.manifest.sections[section]);
    expect(one.manifest.bindingSections?.[section]).not.toBe(two.manifest.bindingSections?.[section]);
    for (const [snapshot, machine] of [[one, 'one'], [two, 'two'], [legacy, 'one']] as const) {
      const manifest = DaemonProjectionDeferredSectionsResponseSchema.parse(snapshot.manifest);
      const index = DaemonContributionRegistryProjectionSectionsResponseSchema.parse(
        JSON.parse(snapshot.read(manifest.sections[section]!, 0)!.chunk));
      const bindings = manifest.bindingSections?.[section];
      const values: string[] | undefined = bindings ? JSON.parse(snapshot.read(bindings, 0)!.chunk) : undefined;
      const bodies = new Map(index.parts.flatMap(part => typeof part === 'string'
        ? [] : [[part.digest, JSON.parse(snapshot.read(part.digest, 0)!.chunk)] as const]));
      const framed = values ? applyDaemonProjectionSectionBindings(index, values) : index;
      expect(framed).not.toBeNull();
      const assembled = reassembleDaemonProjectionSections(framed!, bodies);
      expect(assembled?.response).toEqual({ projection: { installedPackagesById: response(machine).projection.installedPackagesById } });
    }
  });

  it('pages oversized and escaped section bodies, with index frames as raw text', () => {
    const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
      projectionDigest: 'a'.repeat(64), projection: { v: 2, generation: 1, installedPackagesById: {
        'acme.one': { id: 'acme.one', displayName: '\"\\\n😀'.repeat(30_000), enabled: true,
          source: { kind: 'bundled', locator: 'acme.one' } },
        'acme.two': { id: 'acme.two', displayName: 'Two', enabled: true,
          source: { kind: 'bundled', locator: 'acme.two' } },
      } } });
    const built = buildDeferredDaemonProjectionSections(response);
    expect(DaemonProjectionDeferredSectionsResponseSchema.parse(built.manifest)).toEqual(built.manifest);
    const indexDigest = built.manifest.sections.installedPackagesById!;
    const fetch = (digest: string, frame = false) => {
      let offset = 0;
      const chunks: string[] = [];
      for (;;) {
        const page = DaemonProjectionSectionBodyResponseSchema.parse(built.read(digest, offset, []));
        expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(DAEMON_PROJECTION_SECTION_FRAME_BYTES);
        chunks.push(page.chunk);
        if (page.nextOffset === null) break;
        expect(page.nextOffset).toBeGreaterThan(offset);
        offset = page.nextOffset;
      }
      const spans: string[] = frame ? [chunks.join('')] : JSON.parse(chunks.join(''));
      expect(computeDaemonProjectionSectionDigest(spans)).toBe(digest);
      return spans;
    };
    const framed = DaemonContributionRegistryProjectionSectionsResponseSchema.parse(JSON.parse(fetch(indexDigest, true)[0]!));
    const packed = DaemonProjectionSectionBodyResponseSchema.parse(built.read(indexDigest, 0,
      framed.parts.flatMap(part => typeof part === 'string' ? [] : [part.digest])));
    expect(new TextEncoder().encode(JSON.stringify(packed)).length).toBeLessThanOrEqual(DAEMON_PROJECTION_SECTION_FRAME_BYTES);
    expect(packed.bodies).toHaveLength(1);
    expect(packed.bodies?.[0]?.body.join('')).toContain('acme.two');
    const held = new Map(framed.parts.flatMap(part => typeof part === 'string' ? [] : [[part.digest, fetch(part.digest)] as const]));
    expect(reassembleDaemonProjectionSections(framed, held)?.response).toEqual({ projection: { installedPackagesById: response.projection.installedPackagesById } });
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({ machineId: 'm', sectionRead: { digest: indexDigest, offset: 0 } }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({ machineId: 'm', selection: 'agents', deferredSections: true }).success).toBe(false);
    expect(DaemonProjectionDeferredSectionsResponseSchema.safeParse({ ...built.manifest, sectionFrameVersion: 3 }).success).toBe(false);
    const { sectionFrameVersion: _version, ...unversioned } = built.manifest;
    expect(DaemonProjectionDeferredSectionsResponseSchema.safeParse(unversioned).success).toBe(false);
    expect(built.read('b'.repeat(64), 0)).toBeNull();
  });
  it('carries each distinct Machine value once per index and reassembles the exact section', () => {
    // Live (P03-FIX-OPEN-SEND): the cold actionsById index repeated 3,140 Machine values,
    // 130 distinct (485 KB of a 566 KB index), and every Machine resends its own.
    const plugins = Array.from({ length: 77 }, (_, index) => `qa.values-${index}`);
    const actionsById = Object.fromEntries(plugins.flatMap(pluginId => Array.from({ length: 8 }, (_, index) => [
      `${pluginId}/action-${index}`, { id: `action-${index}`, pluginId, occurrenceId: `${pluginId}:7`, title: 'Run',
        scopes: ['global'], surfaces: ['ui'], placementBindings: [], execution: { target: 'daemon' },
        dangerLevel: 'safe', available: true }])));
    const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
      projectionDigest: 'a'.repeat(64), projection: { v: 2, generation: 7, actionsById } });
    const built = buildDeferredDaemonProjectionSections(response);
    const text = (digest: string, frame: boolean) => {
      const chunks: string[] = [];
      for (let offset = 0; ;) {
        const page = DaemonProjectionSectionBodyResponseSchema.parse(built.read(digest, offset, []));
        chunks.push(page.chunk);
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      }
      return frame ? [chunks.join('')] : JSON.parse(chunks.join('')) as string[];
    };
    const raw = JSON.parse(text(built.manifest.sections.actionsById!, true)[0]!) as { values?: unknown[];
      parts: (string | { values: unknown[] })[] };
    const carried = [...(raw.values ?? []), ...raw.parts.flatMap(part => typeof part === 'string' ? []
      : part.values.filter(value => typeof value === 'string'))];
    // 616 Actions × (occurrenceId, available): 77 occurrence ids plus one `true`.
    expect({ carried: carried.length, distinct: new Set(carried).size }).toEqual({ carried: 78, distinct: 78 });
    const index = DaemonContributionRegistryProjectionSectionsResponseSchema.parse(raw);
    const held = new Map(index.parts.flatMap(part => typeof part === 'string' ? [] : [[part.digest, text(part.digest, false)] as const]));
    expect(reassembleDaemonProjectionSections(index, held)?.response).toEqual({ projection: { actionsById: response.projection.actionsById } });
    // A reference outside the index's value table never assembles.
    const broken = { ...index, parts: index.parts.map(part => typeof part === 'string' ? part : { ...part, values: part.values.map(() => 9_999) }) };
    expect(reassembleDaemonProjectionSections(DaemonContributionRegistryProjectionSectionsResponseSchema.parse(broken), held)).toBeNull();
  });

  it('reads only the Session-facing plugins of a selectable section and assembles exactly their entries', () => {
    // P03-PLUGIN-UI-SUMMARY: the bundled catalogue has 782 Actions; a Session's
    // placements select 3 of them, yet every Session open read all 1.27 MB.
    const action = (pluginId: string, id: string, extra: Record<string, unknown> = {}) => [`${pluginId}/${id}`, {
      id, pluginId, occurrenceId: `${pluginId}:7`, title: 'Run', scopes: ['global'], surfaces: ['ui'],
      placementBindings: ['commandPalette'], execution: { target: 'daemon' }, dangerLevel: 'safe', available: true, ...extra }] as const;
    const palette = Array.from({ length: 20 }, (_, plugin) => Array.from({ length: 8 },
      (_, index) => action(`qa.palette-${plugin}`, `run-${index}`))).flat();
    const actionsById = Object.fromEntries([...palette,
      action('qa.session', 'continue', { scopes: ['session'] }), action('qa.session', 'other'),
      action('qa.message', 'quote', { scopes: ['message'], placementBindings: ['message.menu'] })]);
    const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
      projectionDigest: 'a'.repeat(64), projection: { v: 2, generation: 7, actionsById } });
    const built = buildDeferredDaemonProjectionSections(response);
    expect(built.manifest.sessionPluginIds).toEqual(['qa.message', 'qa.session']);
    const session = daemonProjectionPluginSectionId('actionsById', DAEMON_PROJECTION_SESSION_PLUGINS);
    expect(demandedDaemonProjectionSections(built.manifest, [session]))
      .toEqual(['base', 'installedPackagesById', 'actionsById#qa.message', 'actionsById#qa.session']);
    const text = (digest: string, frame: boolean) => {
      const chunks: string[] = [];
      for (let offset = 0; ;) {
        const page = DaemonProjectionSectionBodyResponseSchema.parse(built.read(digest, offset, []));
        chunks.push(page.chunk);
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      }
      return frame ? [chunks.join('')] : JSON.parse(chunks.join('')) as string[];
    };
    const index = DaemonContributionRegistryProjectionSectionsResponseSchema.parse(JSON.parse(text(built.manifest.sections.actionsById!, true)[0]!));
    const selected = new Set(['qa.message', 'qa.session']);
    const parts = index.parts.filter(part => typeof part !== 'string');
    const needed = parts.filter(part => typeof part !== 'string' && selected.has(readDaemonProjectionSectionPartPlugin(index, part) ?? ''));
    // Bodies a Session reads: 2 of 22 plugin groups.
    expect({ parts: parts.length, needed: needed.length }).toEqual({ parts: 22, needed: 2 });
    const held = new Map(needed.map(part => [(part as { digest: string }).digest, text((part as { digest: string }).digest, false)] as const));
    const assembled = reassembleDaemonProjectionSections(index, held, selected)?.response as { projection: { actionsById: Record<string, unknown> } };
    expect(Object.keys(assembled.projection.actionsById).sort()).toEqual(['qa.message/quote', 'qa.session/continue', 'qa.session/other']);
    expect(assembled.projection.actionsById['qa.session/continue']).toEqual(actionsById['qa.session/continue']);
    // A missing selected body still refuses assembly.
    expect(reassembleDaemonProjectionSections(index, new Map(), selected)).toBeNull();
    // Coverage: a plugin's slice never claims the whole section; the whole section covers every slice.
    const always = ['base', 'installedPackagesById'];
    expect(daemonProjectionSectionsCover(built.manifest, [...always, 'actionsById#qa.session', 'actionsById#qa.message'], [session])).toBe(true);
    expect(daemonProjectionSectionsCover(built.manifest, [...always, 'actionsById#qa.session'], ['actionsById'])).toBe(false);
    expect(daemonProjectionSectionsCover(built.manifest, [...always, 'actionsById'], [session, 'actionsById#qa.palette-3'])).toBe(true);
    expect(readDaemonProjectionSectionPlugins(['actionsById#qa.session'], 'actionsById')).toEqual(new Set(['qa.session']));
    expect(readDaemonProjectionSectionPlugins(['actionsById', 'actionsById#qa.session'], 'actionsById')).toBe('all');
    // A manifest without a Session summary (older daemon) reads the whole section.
    const { sessionPluginIds: _ids, ...older } = built.manifest;
    expect(demandedDaemonProjectionSections(older, [session])).toEqual(['base', 'installedPackagesById', 'actionsById']);
  });

  it('reads additive fields a newer daemon adds to manifests, indexes and pages', () => {
    const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
      projectionDigest: 'a'.repeat(64), projection: { v: 2, generation: 1, installedPackagesById: {
        'acme.one': { id: 'acme.one', displayName: 'One', enabled: true, source: { kind: 'bundled', locator: 'acme.one' } } } } });
    const built = buildDeferredDaemonProjectionSections(response);
    expect(DaemonProjectionDeferredSectionsResponseSchema.safeParse({ ...built.manifest, futureHint: 1 }).success).toBe(true);
    const page = built.read(built.manifest.sections.installedPackagesById!, 0, [])!;
    expect(DaemonProjectionSectionBodyResponseSchema.safeParse({ ...page, futureHint: 1 }).success).toBe(true);
    const index = JSON.parse(page.chunk) as { parts: unknown[] };
    const future = { ...index, futureHint: 1, parts: index.parts.map(part => typeof part === 'string' ? part : { ...part as object, futureHint: 1 }) };
    const admitted = DaemonContributionRegistryProjectionSectionsResponseSchema.safeParse(future);
    expect(admitted.success).toBe(true);
    // Known discriminators stay closed.
    expect(DaemonProjectionDeferredSectionsResponseSchema.safeParse({ ...built.manifest, sectionFrameVersion: 3 }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionSectionsResponseSchema.safeParse({ ...future, sectioned: false }).success).toBe(false);
  });

  it('addresses section bodies by the same SHA-256 hex on every engine', async () => {
    const { createHash } = await import('node:crypto');
    const vectors: readonly (readonly string[])[] = [[], [''], ['{"a":1}', ',"b":'], ['é', '\u2028', '😀\uD83D'],
      ['\"\\\n😀'.repeat(200_000)]];
    const node = (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest());
    const web = async (bytes: Uint8Array) => new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
    for (const body of vectors) {
      const noble = computeDaemonProjectionSectionDigest(body);
      expect(noble).toMatch(/^[a-f0-9]{64}$/u);
      expect(computeDaemonProjectionSectionDigest(body, node)).toBe(noble);
      await expect(computeDaemonProjectionSectionDigestAsync(body, web)).resolves.toBe(noble);
    }
    // Pinned: the address of the empty body never changes with the engine.
    expect(computeDaemonProjectionSectionDigest([])).toBe(createHash('sha256').update('[]').digest('hex'));
    const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
      projectionDigest: 'a'.repeat(64), projection: { v: 2, generation: 1, installedPackagesById: {} } });
    expect(buildDeferredDaemonProjectionSections(response, { sha256: node }).manifest)
      .toEqual(buildDeferredDaemonProjectionSections(response).manifest);
  });

  it('keeps unchanged replies closed and full replies compatible with older daemons', () => {
    const unchanged = { protocolVersion: 1, unchanged: true, projectionDigest: 'a'.repeat(64) };
    expect(DaemonContributionRegistryProjectionDescribeUnchangedResponseSchema.parse(unchanged)).toEqual(unchanged);
    expect(DaemonContributionRegistryProjectionDescribeUnchangedResponseSchema.safeParse({
      ...unchanged, projection: {},
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse(unchanged).success).toBe(false);
    const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {} });
    expect(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection }).projectionDigest)
      .toBeUndefined();
    expect(DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse({
      protocolVersion: 1, projection, projectionDigest: 42,
    }).success).toBe(false);
  });

  it('validates an optional full-describe content witness without changing legacy requests', () => {
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.parse({ machineId: 'machine' }))
      .toEqual({ machineId: 'machine' });
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
      machineId: 'machine', knownProjectionDigest: 'a'.repeat(64),
    })).toMatchObject({ knownProjectionDigest: 'a'.repeat(64) });
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'machine', knownProjectionDigest: 42,
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'machine', selection: 'agents', knownProjectionDigest: 'a'.repeat(64),
    }).success).toBe(false);
  });

  it('accepts the complete normalized Agent lifecycle declaration', () => {
    const projected = {
      id: 'acme-lifecycle',
      identity: { pluginId: 'acme.lifecycle', localId: 'acme-lifecycle' },
      capabilities: {
        surfaces: ['terminal'],
        sessions: {
          open: ['create', 'resume', 'fork'],
          delivery: ['newTurn', 'steer', 'followUp'],
          cancel: true,
          conversationRollback: true,
          usageLimitRecovery: {
            active: ['checkNow'],
            inactive: ['checkNow', 'consumeResetCredit'],
          },
        },
        executionRuns: {
          open: ['create', 'resume', 'fork'],
          checkpoint: true,
          stop: true,
        },
      },
    } as const;

    expect(PluginProjectedAgentV2Schema.parse(projected)).toEqual({
      ...projected,
      providerOwnedEnvironmentKeys: [],
    });
  });

  it('keeps exact daemon Settings watches content-free and revision-scoped', () => {
    const request = {
      serverIdentityId: 'srv_settings',
      machineId: 'machine-settings',
      pluginId: 'acme.settings',
      scope: { kind: 'daemon' },
    } as const;

    expect(DaemonPluginSettingsWatchRequestSchema.parse(request)).toEqual(request);
    expect(DaemonPluginSettingsWatchRequestSchema.parse({
      ...request,
      knownRevision: 'settings-r1',
    })).toMatchObject({ knownRevision: 'settings-r1' });
    expect(DaemonPluginSettingsWatchRequestSchema.safeParse({
      ...request,
      scope: { kind: 'account' },
    }).success).toBe(false);
    expect(DaemonPluginSettingsWatchRequestSchema.safeParse({
      ...request,
      values: { endpoint: 'must-not-cross-the-watch' },
    }).success).toBe(false);

    expect(DaemonPluginSettingsWatchResponseSchema.parse({
      status: 'ready',
      revision: 'settings-r1',
    })).toEqual({ status: 'ready', revision: 'settings-r1' });
    expect(DaemonPluginSettingsWatchResponseSchema.parse({
      status: 'changed',
      revision: 'settings-r2',
    })).toEqual({ status: 'changed', revision: 'settings-r2' });
    expect(DaemonPluginSettingsWatchResponseSchema.parse({
      status: 'idle',
      revision: 'settings-r2',
    })).toEqual({ status: 'idle', revision: 'settings-r2' });
    expect(DaemonPluginSettingsWatchResponseSchema.safeParse({
      status: 'changed',
      revision: 'settings-r2',
      values: { endpoint: 'must-not-cross-the-watch' },
    }).success).toBe(false);
  });

  it('keeps daemon-selected composer renderer facts occurrenceId-bound without accepting UI-selected candidates', () => {
    const entry = {
      contribution: { pluginId: 'acme.review', localId: 'review' },
      occurrenceId: 'review-occurrence',
      projectionGeneration: 7,
      role: 'attachmentPreview',
      rendererChain: [{ pluginId: 'acme.review', localId: 'review-preview' }],
      selectedRenderer: {
        identity: { pluginId: 'acme.review', localId: 'review-preview' },
        renderer: {
          kind: 'declarative',
          contributionId: 'review-preview',
          model: createValidDeclarativeProjectedModelV1(),
        },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
      },
      executionOrigin: {
        serverIdentityId: 'srv_composer',
        sourceRef: {
          machineId: 'machine-composer',
          sourceCustody: CONTRIBUTOR_SOURCE_CUSTODY,
          pluginId: 'acme.review',
        },
      },
      resourceCapability: { readable: true, dynamic: true },
      contributorTargetedContributions: {
        target: {
          pluginId: 'acme.review',
          occurrenceId: 'review-occurrence',
          sourceCustody: CONTRIBUTOR_SOURCE_CUSTODY,
        },
        points: [],
      },
    } as const;

    expect(DaemonPluginUiComposerSurfaceCatalogEntryV1Schema.parse(entry)).toEqual(entry);
    expect(DaemonPluginUiComposerSurfaceCatalogEntryV1Schema.safeParse({
      ...entry,
      executionOrigin: {
        ...entry.executionOrigin,
        sourceRef: { ...entry.executionOrigin.sourceRef, sourceCustody: TARGET_SOURCE_CUSTODY },
      },
    }).success).toBe(false);
    const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
      protocolVersion: 1,
      projection: { v: 2, generation: 1, familiesById: {} },
      composerSurfaceCatalog: [entry],
    });
    expect(response.composerSurfaceCatalog).toEqual([entry]);
    expect(DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse({
      protocolVersion: 1,
      projection: { v: 2, generation: 1, familiesById: {} },
      composerSurfaceCatalog: [{ ...entry, role: 'not-a-composer-role' }],
    }).success).toBe(false);
    expect(DaemonPluginUiComposerSurfaceCatalogEntryV1Schema.safeParse({
      ...entry,
      selectedRenderer: {
        ...entry.selectedRenderer,
        identity: { pluginId: 'acme.other', localId: 'review-preview' },
      },
    }).success).toBe(false);
    expect(DaemonPluginUiComposerSurfaceCatalogEntryV1Schema.safeParse({
      ...entry,
      contributorTargetedContributions: {
        ...entry.contributorTargetedContributions,
        target: { pluginId: 'acme.review', occurrenceId: 'stale-occurrence' },
      },
    }).success).toBe(false);
  });

  it('types the final CLI-enriched declarative projection at the wire and rejects malformed models', () => {
    const model = createValidDeclarativeProjectedModelV1();
    // The targeted mount correlates the selected renderer identity with its
    // contributionId; the static projected UI entry carries the renderer's
    // own local id.
    const declarativeRenderer = {
      kind: 'declarative',
      contributionId: 'detail-renderer',
      model,
    } as const;

    // The same strict schema carries the model on targeted Surface mounts,
    // Composer surface catalog rows, and static projected UI entries.
    expect(DaemonPluginUiTargetedSurfaceMountV1Schema.safeParse({
      kind: 'targetedSurface',
      target: {
        pluginId: 'acme.target',
        occurrenceId: 'target-occurrence',
        sourceCustody: TARGET_SOURCE_CUSTODY,
      },
      point: { pointId: 'providers', protocol: { id: 'provider', version: 1 } },
      contributor: {
        pluginId: 'acme.contributor',
        contributionId: 'provider-detail',
        occurrenceId: 'contributor-occurrence',
        sourceCustody: CONTRIBUTOR_SOURCE_CUSTODY,
      },
      role: 'detail',
      presentation: 'content',
      inputSchema: { type: 'object' },
      rendererChain: [{ pluginId: 'acme.contributor', localId: 'detail-renderer' }],
      selectedRenderer: {
        identity: { pluginId: 'acme.contributor', localId: 'detail-renderer' },
        renderer: declarativeRenderer,
        availability: { state: 'available', reason: 'available', diagnostics: [] },
      },
      executionOrigin: {
        serverIdentityId: 'srv_targeted',
        materializationRef: {
          machineId: 'machine-targeted',
          materializationId: 'contributor-materialization',
          pluginId: 'acme.contributor',
        },
      },
      resourceCapability: { readable: true, dynamic: true },
      contributorTargetedContributions: {
        target: {
          pluginId: 'acme.contributor',
          occurrenceId: 'contributor-occurrence',
          sourceCustody: CONTRIBUTOR_SOURCE_CUSTODY,
        },
        points: [],
      },
    }).success).toBe(true);
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      familiesById: {
        pluginUi: {
          family: 'pluginUi',
          entriesById: {
            'settingsPage:acme.review:preferences': {
              id: 'settingsPage:acme.review:preferences',
              pluginId: 'acme.review',
              occurrenceId: 'review-occurrence-a',
              renderer: {
                kind: 'declarative',
                contributionId: 'review-preview',
                model: declarativeRenderer.model,
              },
            },
          },
        },
      },
    }).success).toBe(true);

    // Malformed models are typed rejections at the wire owner, not opaque
    // unknown payloads that consumer-side admission must discover.
    const malformedModels: readonly Record<string, unknown>[] = [
      // The historically accepted z.unknown() placeholder.
      { visible: true },
      // Missing required inventory/root.
      {
        ...model,
        declarativeInventory: undefined,
      },
      // Closed object: unknown fields are rejected, not preserved.
      { ...model, unexpected: true },
      // Host-method declarations use the canonical finite Host API vocabulary.
      { ...model, requiredHostMethods: ['inventedHostMethod'] },
      // Unknown node kind in the projected tree.
      { ...model, root: { kind: 'mystery', path: 'root', order: 0 } },
      // An action node naming both an Action and a Composer effect.
      {
        ...model,
        root: {
          kind: 'action',
          path: 'root',
          order: 0,
          label: 'Broken',
          action: model.declarativeInventory.actions[0],
          effect: { kind: 'composerApply', expectedRevision: 'r1', operations: [] },
          enabled: true,
        },
      },
      // A Settings binding whose reattached field descriptor is malformed.
      {
        ...model,
        declarativeInventory: {
          ...model.declarativeInventory,
          settings: [
            {
              ...model.declarativeInventory.settings[0],
              setting: {
                ...model.declarativeInventory.settings[0].setting,
                descriptor: { ...model.declarativeInventory.settings[0].setting.descriptor, scope: 'galaxy' },
              },
            },
          ],
        },
      },
    ];
    for (const malformed of malformedModels) {
      expect(DaemonPluginUiTargetedSurfaceMountV1Schema.safeParse({
        kind: 'targetedSurface',
        target: { pluginId: 'acme.target', occurrenceId: 'target-occurrence' },
        point: { pointId: 'providers', protocol: { id: 'provider', version: 1 } },
        contributor: {
          pluginId: 'acme.contributor',
          contributionId: 'provider-detail',
          occurrenceId: 'contributor-occurrence',
        },
        role: 'detail',
        presentation: 'content',
        inputSchema: { type: 'object' },
        rendererChain: [{ pluginId: 'acme.contributor', localId: 'detail-renderer' }],
        selectedRenderer: {
          identity: { pluginId: 'acme.contributor', localId: 'detail-renderer' },
          renderer: { ...declarativeRenderer, model: malformed },
          availability: { state: 'available', reason: 'available', diagnostics: [] },
        },
        executionOrigin: {
          serverIdentityId: 'srv_targeted',
          materializationRef: {
            machineId: 'machine-targeted',
            materializationId: 'contributor-materialization',
            pluginId: 'acme.contributor',
          },
        },
        resourceCapability: { readable: true, dynamic: true },
        contributorTargetedContributions: {
          target: { pluginId: 'acme.contributor', occurrenceId: 'contributor-occurrence' },
          points: [],
        },
      }).success).toBe(false);
      expect(PluginProjectionV2Schema.safeParse({
        v: 2,
        generation: 7,
        familiesById: {
          pluginUi: {
            family: 'pluginUi',
            entriesById: {
              'settingsPage:acme.review:preferences': {
                id: 'settingsPage:acme.review:preferences',
                pluginId: 'acme.review',
                renderer: {
                  kind: 'declarative',
                  contributionId: 'review-preview',
                  model: malformed,
                },
              },
            },
          },
        },
      }).success).toBe(false);
    }
  });

  it('keeps target-private Surface execution, selected renderer, and child projection correlated to one contributor occurrenceId', () => {
    const mount = {
      kind: 'targetedSurface',
      target: {
        pluginId: 'acme.target',
        occurrenceId: 'target-occurrence',
        sourceCustody: TARGET_SOURCE_CUSTODY,
      },
      point: { pointId: 'providers', protocol: { id: 'provider', version: 1 } },
      contributor: {
        pluginId: 'acme.contributor',
        contributionId: 'provider-detail',
        occurrenceId: 'contributor-occurrence',
        sourceCustody: CONTRIBUTOR_SOURCE_CUSTODY,
      },
      role: 'detail',
      presentation: 'content',
      inputSchema: { type: 'object' },
      rendererChain: [{ pluginId: 'acme.contributor', localId: 'detail-renderer' }],
      selectedRenderer: {
        identity: { pluginId: 'acme.contributor', localId: 'detail-renderer' },
        renderer: {
          kind: 'declarative',
          contributionId: 'detail-renderer',
          model: createValidDeclarativeProjectedModelV1(),
        },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
      },
      executionOrigin: {
        serverIdentityId: 'srv_targeted',
        sourceRef: {
          machineId: 'machine-targeted',
          sourceCustody: CONTRIBUTOR_SOURCE_CUSTODY,
          pluginId: 'acme.contributor',
        },
      },
      resourceCapability: { readable: true, dynamic: true },
      contributorTargetedContributions: {
        target: {
          pluginId: 'acme.contributor',
          occurrenceId: 'contributor-occurrence',
          sourceCustody: CONTRIBUTOR_SOURCE_CUSTODY,
        },
        points: [],
      },
    } as const;

    expect(DaemonPluginUiTargetedSurfaceMountV1Schema.parse(mount)).toEqual(mount);
    expect(DaemonPluginUiTargetedSurfaceMountV1Schema.safeParse({
      ...mount,
      executionOrigin: {
        ...mount.executionOrigin,
        sourceRef: { ...mount.executionOrigin.sourceRef, sourceCustody: TARGET_SOURCE_CUSTODY },
      },
    }).success).toBe(false);
    const surface = {
      point: mount.point,
      contributor: mount.contributor,
      role: mount.role,
      presentation: mount.presentation,
    } as const;
    expect(readDaemonPluginUiTargetedSurfaceMountV1({
      mounts: [mount],
      target: mount.target,
      surface,
    })).toBe(mount);
    expect(readDaemonPluginUiTargetedSurfaceMountV1({
      mounts: [mount],
      target: { ...mount.target, occurrenceId: 'stale-target' },
      surface,
    })).toBeNull();
    expect(readDaemonPluginUiTargetedSurfaceMountV1({
      mounts: [mount],
      target: {
        ...mount.target,
        sourceCustody: { kind: 'development', registeredRootId: 'other-target-root' },
      },
      surface,
    })).toBeNull();
    expect(readDaemonPluginUiTargetedSurfaceMountV1({
      mounts: [mount],
      target: mount.target,
      surface: {
        ...surface,
        contributor: {
          ...surface.contributor,
          sourceCustody: { kind: 'development', registeredRootId: 'other-contributor-root' },
        },
      },
    })).toBeNull();
    expect(readDaemonPluginUiTargetedSurfaceMountV1({
      mounts: [mount, mount],
      target: mount.target,
      surface,
    })).toBeNull();
    expect(DaemonPluginUiTargetedSurfaceMountV1Schema.safeParse({
      ...mount,
      methodCeiling: ['context'],
    }).success).toBe(false);
    expect(DaemonPluginUiTargetedSurfaceMountV1Schema.safeParse({
      ...mount,
      contributorTargetedContributions: {
        ...mount.contributorTargetedContributions,
        target: {
          ...mount.contributorTargetedContributions.target,
          occurrenceId: 'other-occurrence',
        },
      },
    }).success).toBe(false);
    expect(DaemonPluginUiTargetedSurfaceMountV1Schema.safeParse({
      ...mount,
      contributorTargetedContributions: {
        ...mount.contributorTargetedContributions,
        target: {
          ...mount.contributorTargetedContributions.target,
          sourceCustody: { kind: 'development', registeredRootId: 'other-contributor-root' },
        },
      },
    }).success).toBe(false);
    expect(DaemonPluginUiTargetedSurfaceMountV1Schema.safeParse({
      ...mount,
      selectedRenderer: {
        ...mount.selectedRenderer,
        identity: { pluginId: 'acme.other', localId: 'detail-renderer' },
      },
    }).success).toBe(false);
    expect(DaemonPluginUiTargetedSurfaceMountV1Schema.safeParse({
      ...mount,
      rendererChain: [
        ...mount.rendererChain,
        { pluginId: 'acme.other', localId: 'other-renderer' },
      ],
    }).success).toBe(false);
    expect(DaemonPluginUiTargetedSurfaceMountV1Schema.safeParse({
      ...mount,
      selectedRenderer: {
        identity: { pluginId: 'acme.contributor', localId: 'detail-renderer' },
        renderer: { kind: 'reactNative', contributionId: 'detail-renderer' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        artifactProjection: {
          id: 'reactNativeBundle:acme.other:detail-renderer',
          pluginId: 'acme.other',
          contributionKind: 'reactNativeBundle',
          contributionId: 'detail-renderer',
        },
      },
    }).success).toBe(false);
  });

  it('carries only an exact host-stamped Resource context on contextual reads and watches', () => {
    const read = {
      machineId: 'm1',
      expectedCallerOccurrenceId: 'occurrence-1',
      callerPluginId: 'acme.activity',
      resource: { pluginId: 'acme.activity', localId: 'progress' },
      context: { kind: 'session', sessionId: 'session-a' },
    } as const;
    expect(DaemonPluginUiResourceReadRequestSchema.parse(read).context).toEqual(read.context);

    expect(DaemonPluginUiResourceReadRequestSchema.safeParse({
      ...read,
      context: { kind: 'session', sessionId: 'session-a', forged: true },
    }).success).toBe(false);

    expect(DaemonPluginUiResourceWatchOpenRequestSchema.parse({
      ...read,
      subscriptionId: 'sub-1',
    }).context).toEqual(read.context);

    const surface = {
      ...read,
      context: {
        kind: 'surface',
        mountInstanceKey: 'target/acme.target/point/contributor/detail/entry-7',
        launchInput: { revision: 2 },
      },
    } as const;
    expect(DaemonPluginUiResourceReadRequestSchema.parse(surface).context).toEqual(surface.context);
    expect(DaemonPluginUiResourceWatchOpenRequestSchema.parse({
      ...surface,
      subscriptionId: 'sub-2',
    }).context).toEqual(surface.context);
    expect(DaemonPluginUiResourceReadRequestSchema.safeParse({
      ...surface,
      context: { ...surface.context, callerContext: { forged: true } },
    }).success).toBe(false);
  });

  it('preserves typed widget areas only on their declaring app-page placement', () => {
    const entry = {
      id: 'surfacePlacement:acme.widgets:overview',
      pluginId: 'acme.widgets',
      contributionKind: 'surfacePlacement',
      binding: normalizePluginUiDestinationBindingV1({
        pluginId: 'acme.widgets', destinationId: 'overview', rendererId: 'native',
        availableRendererIds: ['native'], container: 'appPage', target: { kind: 'app' },
      }),
      widgetAreas: [{ name: 'pinned', contextSchema: { type: 'object', additionalProperties: false } }],
    } as const;
    expect(PluginDeclaredUiEntryV1Schema.parse(entry).widgetAreas).toEqual(entry.widgetAreas);
    const { widgetAreas: _areas, ...withoutAreas } = entry;
    expect(PluginDeclaredUiEntryV1Schema.safeParse(withoutAreas).success).toBe(true);
    for (const invalid of [
      { ...entry, widgetAreas: [...entry.widgetAreas, ...entry.widgetAreas] },
      { ...entry, widgetAreas: [{ ...entry.widgetAreas[0], unrecognized: true }] },
      { ...entry, contributionKind: 'reactNativeBundle' },
      { ...entry, binding: undefined },
    ]) {
      expect(PluginDeclaredUiEntryV1Schema.safeParse(invalid).success).toBe(false);
    }
  });

  it('carries an exact execution origin envelope on each projected plugin UI entry', () => {
    const entry = {
      id: 'surfacePlacement:acme.preview:overview',
      pluginId: 'acme.preview',
      occurrenceId: 'preview-occurrence-a',
      contributionKind: 'surfacePlacement',
      executionOrigin: {
        serverIdentityId: 'srv_projection_fixture',
        sourceRef: {
          machineId: 'machine_projection_fixture',
          sourceCustody: TARGET_SOURCE_CUSTODY,
          pluginId: 'acme.preview',
        },
      },
    } as const;
    const projection = {
      v: 2,
      generation: 7,
      familiesById: {
        pluginUi: {
          family: 'pluginUi',
          entriesById: {
            [entry.id]: entry,
          },
        },
      },
    } as const;

    expect(PluginProjectionV2Schema.parse(projection).familiesById.pluginUi?.entriesById[entry.id])
      .toMatchObject(entry);

    expect(PluginProjectionV2Schema.safeParse({
      ...projection,
      familiesById: {
        pluginUi: {
          ...projection.familiesById.pluginUi,
          entriesById: {
            [entry.id]: { ...entry, occurrenceId: undefined },
          },
        },
      },
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      ...projection,
      familiesById: {
        pluginUi: {
          ...projection.familiesById.pluginUi,
          entriesById: {
            [entry.id]: { ...entry, executionOrigin: { sourceRef: entry.executionOrigin.sourceRef } },
          },
        },
      },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      ...projection,
      familiesById: {
        pluginUi: {
          ...projection.familiesById.pluginUi,
          entriesById: {
            [entry.id]: {
              ...entry,
              executionOrigin: {
                ...entry.executionOrigin,
                sourceRef: { ...entry.executionOrigin.sourceRef, pluginId: 'acme.other' },
              },
            },
          },
        },
      },
    }).success).toBe(false);
  });

  it('projects static Composer declarations only with their exact qualified identity and runtime occurrence', () => {
    const attachment = {
      id: 'acme.composer/issue',
      pluginId: 'acme.composer',
      identity: { pluginId: 'acme.composer', localId: 'issue' },
      occurrenceId: 'composer-occurrence-7',
      definition: {
        id: 'issue',
        title: 'Issue',
        icon: 'warning',
        cardinality: 'many',
        valueSchema: { type: 'object' },
      },
    } as const;
    const projection = {
      v: 2,
      generation: 7,
      familiesById: {
        composerAttachments: {
          family: 'composerAttachments',
          entriesById: { [attachment.id]: attachment },
        },
      },
    } as const;

    expect(PluginProjectionV2Schema.parse(projection).familiesById.composerAttachments?.entriesById[attachment.id])
      .toMatchObject(attachment);
    expect(PluginProjectionV2Schema.safeParse({
      ...projection,
      familiesById: {
        composerAttachments: {
          ...projection.familiesById.composerAttachments,
          entriesById: {
            [attachment.id]: {
              ...attachment,
              identity: { pluginId: attachment.pluginId, localId: 'other' },
            },
          },
        },
      },
    }).success).toBe(false);
  });

  it('accepts a normalized openable-content viewer only when it targets its own projected details view', () => {
    const entry = {
      id: 'openableContentViewer:acme.viewer:markdown',
      pluginId: 'acme.viewer',
      occurrenceId: 'viewer-occurrence-a',
      contributionKind: 'openableContentViewer',
      descriptorId: 'markdown',
      identity: { pluginId: 'acme.viewer', localId: 'markdown' },
      viewer: {
        contentClasses: ['text'],
        mimeTypes: ['text/markdown'],
        extensions: ['.md'],
      },
      destination: { pluginId: 'acme.viewer', localId: 'file-details' },
    } as const;
    const projection = {
      v: 2,
      generation: 7,
      familiesById: {
        pluginUi: {
          family: 'pluginUi',
          entriesById: { [entry.id]: entry },
        },
      },
    } as const;

    expect(PluginProjectionV2Schema.parse(projection).familiesById.pluginUi?.entriesById[entry.id])
      .toMatchObject(entry);
    expect(PluginProjectionV2Schema.safeParse({
      ...projection,
      familiesById: {
        pluginUi: {
          ...projection.familiesById.pluginUi,
          entriesById: {
            [entry.id]: {
              ...entry,
              destination: { pluginId: 'acme.other', localId: 'file-details' },
            },
          },
        },
      },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      ...projection,
      familiesById: {
        pluginUi: {
          ...projection.familiesById.pluginUi,
          entriesById: {
            [entry.id]: {
              ...entry,
              assetPath: '/Users/alice/private.md',
            },
          },
        },
      },
    }).success).toBe(false);
  });

  it('bounds a selected surface Resource capability to its two admission facts', () => {
    const capability = Object.freeze({ readable: true, dynamic: false });

    expect(PluginUiResourceBindingCapabilityV1Schema.parse(capability)).toEqual(capability);
    expect(PluginUiResourceBindingCapabilityV1Schema.safeParse({
      readable: true,
      dynamic: false,
      resourceIds: ['secret-resource-id'],
    }).success).toBe(false);
    expect(PluginUiResourceBindingCapabilityV1Schema.safeParse({
      readable: true,
    }).success).toBe(false);
    expect(protocol.PluginUiResourceBindingCapabilityV1Schema.parse(capability)).toEqual(capability);
  });

  it('preserves Action confirmation and rejects missing non-safe or unknown metadata', () => {
    const confirmation = {
      title: { key: 'actions.delete.title', fallback: 'Delete workspace?' },
      body: { key: 'actions.delete.body', fallback: 'This cannot be undone.' },
      confirmLabel: { key: 'actions.delete.confirm', fallback: 'Delete' },
    } as const;
    const projectedAction = {
      id: 'delete-workspace',
      pluginId: 'acme.workspace',
      occurrenceId: 'workspace-occurrence-a',
      title: 'Delete workspace',
      scopes: ['workspace'],
      surfaces: ['ui'],
      execution: { target: 'daemon' },
      placementBindings: ['detailsPanel'],
      dangerLevel: 'destructive',
      confirmation,
    } as const;

    expect(PluginProjectedActionV2Schema.parse(projectedAction)).toMatchObject({
      dangerLevel: 'destructive',
      confirmation,
    });
    expect(PluginProjectedActionV2Schema.safeParse({
      ...projectedAction,
      dangerLevel: 'safe',
    }).success).toBe(true);
    expect(PluginProjectedActionV2Schema.safeParse({
      ...projectedAction,
      confirmation: undefined,
    }).success).toBe(false);
    expect(PluginProjectedActionV2Schema.safeParse({
      ...projectedAction,
      confirmation: { ...confirmation, input: { secret: 'must-not-project' } },
    }).success).toBe(false);
  });

  it('preserves confidential safe Action confirmation through projection and present-user policy', () => {
    const declaration = {
      id: 'sensitive/read', title: 'Reveal captured variables',
      execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } },
      scopes: ['global'], surfaces: ['ui', 'agent', 'mcp', 'cli'], placementBindings: [],
      dangerLevel: 'safe',
      confirmation: { title: 'Reveal captured variables?', body: 'Captured values can contain credentials.' },
    } as const;
    const declared = PluginActionContributionV2Schema.parse(declaration);
    const projected = PluginProjectedActionV2Schema.parse({
      ...declaration, pluginId: 'acme.errors', occurrenceId: 'account-occurrence-a',
    });
    expect(projected.dangerLevel).toBe('safe');
    expect(projected.confirmation).toEqual(declared.confirmation);
    for (const surface of declaration.surfaces) {
      expect(pluginActionRequiresPresentUserIntent(projected, surface)).toBe(true);
    }
  });

  it('projects placement-free Actions without inventing fields and retains empty wire bindings', () => {
    const pluginOnly = {
      id: 'refresh-provider-state',
      pluginId: 'acme.provider',
      occurrenceId: 'provider-occurrence-a',
      title: 'Refresh provider state',
      scopes: ['session'],
      surfaces: ['plugin'],
      execution: { target: 'daemon' },
      operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' } },
      dangerLevel: 'writesRemote',
    } as const;

    expect(PluginProjectedActionV2Schema.parse(pluginOnly)).toEqual(pluginOnly);
    // The projection is not a second placement decision-maker: it renders the
    // producer's serialized decision, so the mounted-UI-only declaration is
    // the retained explicit empty binding list.
    const mountedOnly = {
      ...pluginOnly,
      surfaces: ['ui'],
      placementBindings: [],
      dangerLevel: 'safe',
    } as const;
    expect(PluginProjectedActionV2Schema.parse(mountedOnly)).toEqual(mountedOnly);
    expect(PluginProjectedActionV2Schema.safeParse({
      ...pluginOnly,
      execution: {
        target: 'client',
        client: { artifactId: 'bundle', exportName: 'run' },
        platforms: ['web'],
      },
    }).success).toBe(false);
  });

  it('accepts legacy and localized Action presentation without widening other projected contributions', () => {
    const action = {
      id: 'refresh-preview',
      pluginId: 'acme.preview',
      occurrenceId: 'preview-occurrence-a',
      scopes: ['session'],
      surfaces: ['ui', 'voice'],
      placementBindings: ['commandPalette'],
      execution: { target: 'daemon' },
      dangerLevel: 'safe',
    } as const;
    const localizedPresentation = {
      title: { key: 'actions.refresh.title', fallback: 'Refresh preview' },
      description: { key: 'actions.refresh.description', fallback: 'Refresh the active preview.' },
      inputHints: {
        title: { key: 'actions.refresh.form.title', fallback: 'Refresh options' },
        submitLabel: { key: 'actions.refresh.form.submit', fallback: 'Refresh' },
        fields: [{
          path: 'mode',
          widget: 'select',
          title: { key: 'actions.refresh.mode.title', fallback: 'Mode' },
          description: { key: 'actions.refresh.mode.description', fallback: 'Choose a refresh mode.' },
          options: [{
            value: 'quick',
            label: { key: 'actions.refresh.mode.quick', fallback: 'Quick' },
            description: { key: 'actions.refresh.mode.quick.description', fallback: 'Refresh recent data.' },
          }],
        }],
      },
    } as const;

    expect(PluginProjectedActionV2Schema.parse({
      ...action,
      ...localizedPresentation,
    })).toMatchObject(localizedPresentation);
    expect(PluginProjectedActionV2Schema.parse({
      ...action,
      title: 'Refresh preview',
      description: 'Refresh the active preview.',
      inputHints: {
        title: 'Refresh options',
        submitLabel: 'Refresh',
        fields: [{
          path: 'mode',
          widget: 'select',
          title: 'Mode',
          options: [{ value: 'quick', label: 'Quick' }],
        }],
      },
    })).toMatchObject({ title: 'Refresh preview' });
  });

  it('carries the explicit Action execution target with its exact producer origin', () => {
    const projectedAction = {
      id: 'open-client-preview',
      pluginId: 'acme.preview',
      occurrenceId: 'preview-occurrence-a',
      title: 'Open preview',
      scopes: ['session'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      execution: {
        target: 'client',
        client: {
          artifactId: 'preview-client',
          exportName: 'activatePreview',
        },
        platforms: ['web'],
      },
      executionOrigin: {
        serverIdentityId: 'srv_preview',
        sourceRef: {
          machineId: 'machine-preview',
          sourceCustody: TARGET_SOURCE_CUSTODY,
          pluginId: 'acme.preview',
        },
      },
      dangerLevel: 'safe',
    } as const;

    expect(PluginProjectedActionV2Schema.parse(projectedAction)).toMatchObject({
      execution: projectedAction.execution,
      executionOrigin: projectedAction.executionOrigin,
    });
    // Action schemas are read per Action on demand, never projected in bulk.
    expect(PluginProjectedActionV2Schema.safeParse({
      ...projectedAction,
      inputSchema: { type: 'object' },
    }).success).toBe(false);
    expect(PluginProjectedActionV2Schema.safeParse({
      ...projectedAction,
      outputSchema: { type: 'object' },
    }).success).toBe(false);
    expect(DaemonPluginActionSchemasReadResponseSchema.parse({
      ok: true,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
    })).toMatchObject({ ok: true });
    expect(DaemonPluginActionSchemasReadRequestSchema.safeParse({
      machineId: 'machine-preview',
      expectedOccurrenceId: 'preview-occurrence-a',
      qualifiedActionId: 'acme.preview/open-client-preview',
    }).success).toBe(true);
    expect(PluginProjectedActionV2Schema.safeParse({
      ...projectedAction,
      executionOrigin: {
        ...projectedAction.executionOrigin,
        sourceRef: { ...projectedAction.executionOrigin.sourceRef, pluginId: 'acme.other' },
      },
    }).success).toBe(false);
    expect(PluginProjectedActionV2Schema.safeParse({
      ...projectedAction,
      executionOrigin: { sourceRef: projectedAction.executionOrigin.sourceRef },
    }).success).toBe(false);
    expect(PluginProjectedActionV2Schema.safeParse({
      ...projectedAction,
      executionOrigin: undefined,
      serverIdentityId: 'srv_preview',
      materializationRef: { machineId: 'machine-preview', materializationId: 'current', pluginId: 'acme.preview' },
    }).success).toBe(false);
    expect(PluginProjectedActionV2Schema.parse({
      ...projectedAction,
      executionOrigin: {
        serverIdentityId: 'srv_preview',
        materializationRef: { machineId: 'machine-preview', materializationId: 'current', pluginId: 'acme.preview' },
      },
    })).toMatchObject({ executionOrigin: { materializationRef: { materializationId: 'current' } } });
  });

  it('accepts only the normalized present-user authorization projection for an Action', () => {
    const authorization = {
      generation: {
        targetGeneration: 'generation-7',
        desiredGeneration: 'generation-7',
        appliedGeneration: 'generation-7',
        targetGenerationMode: 'current',
      },
      resourceSelections: [{
        id: 'review-account',
        required: true,
        requestedResourceId: 'review-account',
        selectedResourceId: 'review-account',
      }],
      scopedGrants: [{
        id: 'workspace-review',
        required: true,
        status: 'active',
        requiredScope: { workspaceId: 'workspace-1' },
        grantedScope: { workspaceId: 'workspace-1' },
      }],
      serviceAvailability: [{
        id: 'reviews',
        required: true,
        status: 'available',
      }],
      operatingSystemAuthorization: [],
    } as const;
    const projectedAction = {
      id: 'open-client-preview',
      pluginId: 'acme.preview',
      occurrenceId: 'preview-occurrence-a',
      title: 'Open preview',
      scopes: ['session'],
      surfaces: ['ui'],
      placementBindings: ['detailsPanel'],
      execution: { target: 'daemon' },
      dangerLevel: 'safe',
      authorization,
    } as const;

    expect(PluginActionPresentUserAuthorizationFactsSchema.parse(authorization)).toEqual(authorization);
    expect(PluginProjectedActionV2Schema.parse(projectedAction)).toMatchObject({ authorization });
    expect(PluginProjectedActionV2Schema.safeParse({
      ...projectedAction,
      authorization: {
        ...authorization,
        rawAuthorizationRecord: { credential: 'must-not-project' },
      },
    }).success).toBe(false);
  });

  it('requires an explicit plugin action invocation surface on the wire', () => {
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
      machineId: 'm1',
      expectedContributorOccurrenceId: 'action-occurrence-7',
      qualifiedActionId: 'acme.voice/mint-session',
      input: null,
      executionSurface: 'ui',
    }).executionSurface).toBe('ui');
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
      machineId: 'm1',
      expectedContributorOccurrenceId: 'action-occurrence-7',
      qualifiedActionId: 'acme.voice/mint-session',
      input: null,
      executionSurface: 'voice',
    }).executionSurface).toBe('voice');

    // UI-D26: the surface is the target-action authorization input, so an
    // omitted field must be a wire rejection rather than a host-side default.
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      machineId: 'm1',
      expectedContributorOccurrenceId: 'action-occurrence-7',
      qualifiedActionId: 'acme.voice/mint-session',
      input: null,
    }).success).toBe(false);
  });

  it('preserves an omitted action input distinctly from an explicit JSON null', () => {
    const base = {
      machineId: 'm1',
      expectedContributorOccurrenceId: 'action-occurrence-7',
      qualifiedActionId: 'acme.voice/mint-session',
      executionSurface: 'ui' as const,
    };

    const omitted = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(base);
    expect(Object.prototype.hasOwnProperty.call(omitted, 'input')).toBe(false);

    const explicitNull = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
      ...base,
      input: null,
    });
    expect(Object.prototype.hasOwnProperty.call(explicitNull, 'input')).toBe(true);
    expect(explicitNull.input).toBeNull();
  });

  it('admits one exact selected-action settlement carrier without placing its Account ref in outer Action input', () => {
    const base = {
      machineId: 'm1',
      expectedContributorOccurrenceId: 'action-occurrence-7',
      qualifiedActionId: 'acme.channels/prepare-connection',
      input: {
        credentialRef: {
          service: { pluginId: 'acme.github', localId: 'github' },
          accountId: 'account-b',
        },
        providerSetupInput: { repository: 'happier-dev/happier' },
      },
      executionSurface: 'ui' as const,
      invocation: {
        kind: 'mountedPluginSurface' as const,
        mountedBinding: {
          pluginId: 'acme.channels',
          contributionLocalId: 'channels-connection',
          occurrenceId: 'acme.channels:current',
          materializationRef: {
            machineId: 'm1',
            materializationId: 'channels-current',
            pluginId: 'acme.channels',
          },
        },
      },
    };
    const selectedActionInputCarrier = {
      operation: {
        point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
        contributor: {
          pluginId: 'acme.github',
          contributionId: 'github-connection',
          occurrenceId: 'github-occurrence-b',
          sourceCustody: {
            kind: 'development',
            registeredRootId: 'github-root',
          },
        },
        role: 'setup' as const,
        action: { pluginId: 'acme.github', localId: 'setup-connection' },
      },
      result: {
        kind: 'submitted' as const,
        action: { pluginId: 'acme.github', localId: 'setup-connection' },
        input: { repository: 'happier-dev/happier' },
        selection: {
          target: {
            pluginId: 'acme.channels',
            sourceCustody: { kind: 'development', registeredRootId: 'channels-root' },
          },
          point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
          contributor: {
            pluginId: 'acme.github',
            contributionId: 'github-connection',
            sourceCustody: { kind: 'development', registeredRootId: 'github-root' },
          },
        },
        connectedAccount: {
          kind: 'selected' as const,
          fieldPath: 'credentialRef',
          ref: {
            service: { pluginId: 'acme.github', localId: 'github' },
            accountId: 'account-b',
          },
        },
        presentation: {
          connectedAccountLabel: 'Work account',
          machineDisplayName: 'Development Mac',
        },
      },
    };

    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
      ...base,
      selectedActionInputCarrier,
    }).selectedActionInputCarrier).toEqual(selectedActionInputCarrier);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...base,
      selectedActionInputCarrier: {
        ...selectedActionInputCarrier,
        result: {
          ...selectedActionInputCarrier.result,
          action: { pluginId: 'acme.github', localId: 'different-action' },
        },
      },
    }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...base,
      selectedActionInputCarrier,
      invocation: undefined,
    }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...base,
      selectedActionInputCarrier,
      executionSurface: 'cli',
    }).success).toBe(false);
  });

  it('uses only the host-derived target Action and field identity to resolve Connected Account options', () => {
    const nativeOption = { value: { pluginId: 'acme.accounts', localId: 'service' },
      label: 'gh', nativeServicePath: 'nativeService' };
    expect(DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema.safeParse({
      ok: true, options: [nativeOption],
    }).success).toBe(true);
    expect(DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema.safeParse({
      ok: true, options: [{ ...nativeOption, value: { ...nativeOption.value, accountId: 'forged' } }],
    }).success).toBe(false);
    const request = DaemonPluginActionFormConnectedAccountOptionsResolveRequestSchema.parse({
      machineId: 'm1',
      expectedOccurrenceId: 'action-occurrence-7',
      qualifiedActionId: 'acme.accounts/select-account',
      fieldPath: 'credentialRef',
    });
    expect(request).toEqual({
      machineId: 'm1',
      expectedOccurrenceId: 'action-occurrence-7',
      qualifiedActionId: 'acme.accounts/select-account',
      fieldPath: 'credentialRef',
    });
    expect(DaemonPluginActionFormConnectedAccountOptionsResolveRequestSchema.safeParse({
      ...request,
      purpose: 'forged-purpose',
    }).success).toBe(false);
    expect(DaemonPluginActionFormConnectedAccountOptionsResolveRequestSchema.safeParse({
      ...request,
      service: { pluginId: 'acme.accounts', localId: 'service' },
    }).success).toBe(false);

    expect(DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema.parse({
      ok: true,
      options: [{
        value: {
          service: { pluginId: 'acme.accounts', localId: 'service' },
          accountId: 'account-1',
        },
        label: 'Work account',
      }],
    })).toEqual({
      ok: true,
      options: [{
        value: {
          service: { pluginId: 'acme.accounts', localId: 'service' },
          accountId: 'account-1',
        },
        label: 'Work account',
      }],
    });
    expect(DaemonPluginActionFormConnectedAccountOptionsResolveResponseSchema.safeParse({
      ok: true,
      options: [{
        value: {
          service: { pluginId: 'acme.accounts', localId: 'service' },
          accountId: 'account-1',
        },
        label: 'Work account',
        credential: 'must-not-leak',
      }],
    }).success).toBe(false);
  });

  it('carries a mounted binding only in the daemon-validated mounted invocation arm', () => {
    const request = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
      machineId: 'm1',
      qualifiedActionId: 'acme.target/publish',
      input: { title: 'Ready' },
      executionSurface: 'ui',
      expectedContributorOccurrenceId: 'contributor-occurrence-a',
      invocation: {
        kind: 'mountedPluginSurface',
        mountedBinding: {
          pluginId: 'acme.mounted',
          contributionLocalId: 'dashboard',
          occurrenceId: 'acme.mounted:7',
          materializationRef: {
            machineId: 'm1',
            materializationId: 'materialization-current',
            pluginId: 'acme.mounted',
          },
        },
      },
    });

    expect(request).toMatchObject({
      executionSurface: 'ui',
      expectedContributorOccurrenceId: 'contributor-occurrence-a',
      invocation: {
        kind: 'mountedPluginSurface',
        mountedBinding: {
          pluginId: 'acme.mounted',
          contributionLocalId: 'dashboard',
          occurrenceId: 'acme.mounted:7',
          materializationRef: {
            machineId: 'm1',
            materializationId: 'materialization-current',
            pluginId: 'acme.mounted',
          },
        },
      },
    });
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...request,
      invocation: {
        kind: 'mountedPluginSurface',
        mountedBinding: {
          pluginId: 'happier.inspector',
          contributionLocalId: 'inspector-page',
          occurrenceId: 'happier.inspector:22',
        },
      },
    }).success).toBe(true);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...request,
      invocation: {
        ...request.invocation,
        mountedBinding: {
          ...request.invocation.mountedBinding,
          contributionLocalId: 'not valid',
        },
      },
    }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...request,
      mountedBinding: request.invocation.mountedBinding,
    }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...request,
      caller: {
        kind: 'plugin',
        pluginId: 'acme.forged',
        contributionLocalId: 'dashboard',
      },
    }).success).toBe(false);
  });

  it('carries a client Action caller only in its daemon-validated provenance arm', () => {
    const request = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
      machineId: 'm1',
      expectedContributorOccurrenceId: 'action-occurrence-7',
      qualifiedActionId: 'acme.target/read',
      executionSurface: 'ui',
      invocation: {
        kind: 'clientPluginAction',
        clientActionBinding: {
          pluginId: 'acme.search',
          contributionLocalId: 'search',
          occurrenceId: 'acme.search:current',
          materializationRef: {
            machineId: 'm1',
            materializationId: 'materialization-current',
            pluginId: 'acme.search',
          },
        },
      },
    });
    expect(request.invocation).toEqual({
      kind: 'clientPluginAction',
      clientActionBinding: {
        pluginId: 'acme.search',
        contributionLocalId: 'search',
        occurrenceId: 'acme.search:current',
        materializationRef: {
          machineId: 'm1',
          materializationId: 'materialization-current',
          pluginId: 'acme.search',
        },
      },
    });
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...request,
      invocation: {
        ...request.invocation,
        mountedBinding: request.invocation.clientActionBinding,
      },
    }).success).toBe(false);
  });

  it('requires a bounded host-stamped current intent for host-presented Composer and Message Actions', () => {
    const composerRequest = {
      machineId: 'm1',
      expectedContributorOccurrenceId: 'action-occurrence-7',
      qualifiedActionId: 'acme.target/publish',
      executionSurface: 'ui' as const,
      sessionId: 'session-current',
      invocation: {
        kind: 'hostPresentedComposer' as const,
        currentComposerIntent: {
          composer: { kind: 'session' as const, sessionId: 'session-current' },
          revision: 4,
        },
      },
    };

    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(composerRequest))
      .toMatchObject(composerRequest);
    const workflowComposerRequest = {
      ...composerRequest,
      sessionId: undefined,
      invocation: {
        kind: 'hostPresentedComposer' as const,
        currentComposerIntent: {
          composer: {
            kind: 'workflowAuthoring' as const,
            draftId: 'workflow-draft',
            blockId: 'workflow-block',
            instanceId: 'workflow-composer',
          },
          revision: 5,
        },
      },
    };
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(workflowComposerRequest))
      .toMatchObject(workflowComposerRequest);
    // A missing host witness, a stale session witness, and a mounted caller in
    // the host-presented arm must all fail before the daemon sees an Action.
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...composerRequest,
      invocation: { kind: 'hostPresentedComposer' },
    }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...composerRequest,
      sessionId: 'session-replaced',
    }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...composerRequest,
      invocation: {
        ...composerRequest.invocation,
        mountedBinding: {
          contributionLocalId: 'forged',
          materializationRef: {
            machineId: 'm1',
            materializationId: 'current',
            pluginId: 'acme.forged',
          },
        },
      },
    }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...composerRequest,
      caller: { kind: 'plugin', pluginId: 'acme.forged' },
    }).success).toBe(false);

    const messageReference = {
      v: 1 as const,
      sessionId: 'session-current',
      messageId: 'message-current',
      observedRevision: 'revision-current',
    };
    const messageRequest = {
      machineId: 'm1',
      expectedContributorOccurrenceId: 'action-occurrence-7',
      qualifiedActionId: 'acme.target/publish',
      executionSurface: 'ui' as const,
      sessionId: 'session-current',
      messageActionReference: messageReference,
      invocation: {
        kind: 'hostPresentedMessage' as const,
        currentMessageIntent: messageReference,
      },
    };
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(messageRequest))
      .toMatchObject(messageRequest);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...messageRequest,
      invocation: {
        ...messageRequest.invocation,
        currentMessageIntent: {
          ...messageReference,
          observedRevision: 'revision-stale',
        },
      },
    }).success).toBe(false);
  });

  it('carries only an opaque Message Action reference through the existing structured-action transport', () => {
    const request = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
      machineId: 'm1',
      expectedContributorOccurrenceId: 'action-occurrence-7',
      qualifiedActionId: 'acme.voice/mint-session',
      input: null,
      executionSurface: 'ui',
      messageActionReference: {
        v: 1,
        sessionId: 'session-durable',
        messageId: 'message-durable',
        observedRevision: 'message-updated-at:7',
      },
    });

    expect(request.messageActionReference).toEqual({
      v: 1,
      sessionId: 'session-durable',
      messageId: 'message-durable',
      observedRevision: 'message-updated-at:7',
    });
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...request,
      messageActionReference: { ...request.messageActionReference, localId: 'ui-local-id' },
    }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({
      ...request,
      messageActionReference: { ...request.messageActionReference, message: { text: 'caller payload' } },
    }).success).toBe(false);
  });

  it('carries one exact bounded composer-reference search without a retired provider envelope', () => {
    const request = DaemonPluginComposerReferenceSearchRequestSchema.parse({
      machineId: 'm1',
      expectedOccurrenceId: 'composer-occurrence-7',
      reference: { pluginId: 'acme.issues', localId: 'issues' },
      trigger: '$',
      query: 'e\u0301',
    });
    expect(request.query).toBe('é');
    expect(request.trigger).toBe('$');

    // Supported older UI builds did not carry trigger identity. The Protocol
    // seam expands that legacy shape to the only trigger they could emit.
    expect(DaemonPluginComposerReferenceSearchRequestSchema.parse({
      machineId: 'm1',
      expectedOccurrenceId: 'composer-occurrence-7',
      reference: { pluginId: 'acme.issues', localId: 'issues' },
      query: 'issue',
    }).trigger).toBe('@');

    expect(DaemonPluginComposerReferenceSearchRequestSchema.safeParse({
      ...request,
      query: 'x'.repeat(257),
    }).success).toBe(false);
    expect(DaemonPluginComposerReferenceSearchRequestSchema.safeParse({
      ...request,
      candidateId: 'must-not-be-on-search',
    }).success).toBe(false);
    expect(DaemonPluginComposerReferenceSearchRequestSchema.safeParse({
      ...request,
      provider: request.reference,
    }).success).toBe(false);

    expect(DaemonPluginComposerReferenceSearchResponseSchema.parse({
      ok: true,
      reference: request.reference,
      page: [{ id: 'issue:42', label: 'Issue 42', description: 'Open incident' }],
    })).toMatchObject({ ok: true, reference: request.reference });
    expect(DaemonPluginComposerReferenceSearchResponseSchema.safeParse({
      ok: true,
      reference: request.reference,
      page: [{ id: 'issue:42', label: 'Issue 42', context: 'must-not-reach-the-picker' }],
    }).success).toBe(false);
  });

  it('does not publish the retired daemon-owned Composer attachment prepare RPC', async () => {
    const module = await import('./contributionRegistryProjection.js');

    expect(Reflect.has(module, 'DaemonPluginComposerAttachmentPrepareRequestSchema')).toBe(false);
    expect(Reflect.has(module, 'DaemonPluginComposerAttachmentPrepareResponseSchema')).toBe(false);
    expect(Reflect.has(RPC_METHODS, 'DAEMON_PLUGIN_COMPOSER_ATTACHMENT_PREPARE')).toBe(false);
    expect(Object.values(RPC_METHODS)).not.toContain('daemon.plugins.composerAttachments.prepare');
  });

  it('rejects non-JSON structured-message action results at the wire boundary', () => {
    expect(DaemonPluginStructuredMessageActionExecuteResponseSchema.safeParse({
      ok: true,
      result: () => undefined,
    }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteResponseSchema.parse({
      ok: false,
      code: 'channels_connection_required',
      retryable: false,
      remediation: { kind: 'openSettings', path: '/settings/channels' },
    })).toEqual({
      ok: false,
      code: 'channels_connection_required',
      retryable: false,
      remediation: { kind: 'openSettings', path: '/settings/channels' },
    });
    expect(DaemonPluginStructuredMessageActionExecuteResponseSchema.safeParse({
      ok: false,
      code: 'channels_connection_required',
      data: { privateProviderFact: true },
    }).success).toBe(false);
  });

  it('parses a minimal describe request and accepts only the V2 projection', () => {
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.parse({ machineId: 'm1' })).toEqual({
      machineId: 'm1',
    });
    expect(DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse({
      protocolVersion: 1,
      projection: { v: 1, agentsById: {} },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse({
      protocolVersion: 1,
      projection: { v: 2, generation: 1, familiesById: {} },
    }).success).toBe(true);
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 1,
      backendsById: {},
      familiesById: {},
    }).success).toBe(false);
    for (const selection of ['agents', 'settings', 'connectedAccountAdmission', 'machineRecipes'] as const) {
      expect(DaemonContributionRegistryProjectionDescribeRequestSchema.parse({ machineId: 'm1', selection }))
        .toEqual({ machineId: 'm1', selection });
    }
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1', selection: 'settings', skillIds: ['plugin:acme.skills/guide'],
    }).success).toBe(false);
  });

  it('admits addressed skill source reads and validates the real bundle producer at the machine boundary', async () => {
    const { readSkillInLibrary } = await import('../prompts/library/promptLibraryActionOperations.js');
    const skillId = 'plugin:acme.skills/guide';
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.parse({ machineId: 'm1', selection: 'skills', skillIds: [skillId] }))
      .toEqual({ machineId: 'm1', selection: 'skills', skillIds: [skillId] });
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({ machineId: 'm1', selection: 'skills', unexpected: true }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({ machineId: 'm1', skillIds: [skillId] }).success).toBe(false);
    const read = await readSkillInLibrary({ store: { read: async () => null }, request: { skillId, includeFileContents: true },
      pluginSkills: [{ skillId, files: FIRST_PARTY_SKILLS_V1[0]!.files,
        provenance: { kind: 'plugin', pluginId: 'acme.skills', occurrenceId: 'occurrence-1' } }] });
    if ('ok' in read || !read.fileContents || read.provenance.kind !== 'plugin') throw new Error('Skill producer failed');
    const source = { skillId: read.skillId, files: read.fileContents, provenance: read.provenance };
    const response = { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {} }, pluginSkills: [source] };
    expect(DaemonContributionRegistryProjectionDescribeResponseSchema.parse(response).pluginSkills).toEqual([source]);
    for (const invalid of [{ ...source, unexpected: true }, { ...source, provenance: { ...source.provenance, unexpected: true } },
      { ...source, files: [{ ...source.files[0]!, unexpected: true }] }]) {
      expect(DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse({ ...response, pluginSkills: [invalid] }).success).toBe(false);
    }
  });

  it('reads the current contributions to one target without carrying the machine projection', () => {
    const target = {
      pluginId: 'acme.target',
      occurrenceId: 'target-occurrence-a',
      sourceCustody: TARGET_SOURCE_CUSTODY,
    } as const;
    expect(DaemonPluginUiTargetedContributionsReadRequestSchema.parse({
      machineId: 'm1',
      pluginId: 'acme.target',
      locale: 'en',
    })).toEqual({ machineId: 'm1', pluginId: 'acme.target', locale: 'en' });
    // The read names a plugin, not an occurrence: the daemon answers with its
    // current snapshot and tags it; the client remounts on a changed tag.
    expect(DaemonPluginUiTargetedContributionsReadRequestSchema.safeParse({
      machineId: 'm1',
      pluginId: 'acme.target',
      occurrenceId: 'target-occurrence-a',
    }).success).toBe(false);

    const current = DaemonPluginUiTargetedContributionsReadResponseSchema.parse({
      status: 'current',
      targetedContributions: { target, points: [] },
      targetedSurfaceMounts: [],
    });
    expect(current).toEqual({
      status: 'current',
      targetedContributions: { target, points: [] },
      targetedSurfaceMounts: [],
    });
    const resource = { id: 'rows', pluginId: target.pluginId, resourceKind: 'config', scope: 'global' };
    const complete = { ...current, resourceDeclarationsByPluginId: {
      [target.pluginId]: { [`${target.pluginId}/rows`]: resource }, 'acme.empty': {},
    } };
    expect(DaemonPluginUiTargetedContributionsReadResponseSchema.parse(complete)).toEqual(complete);
    for (const declarations of [
      { [target.pluginId]: { 'acme.other/rows': resource } },
      { 'acme.other': { [`${target.pluginId}/rows`]: resource } },
      { [target.pluginId]: { [`${target.pluginId}/different`]: resource } },
      { [target.pluginId]: { [`${target.pluginId}/rows`]: { ...resource, unexpected: true } } },
    ]) {
      expect(DaemonPluginUiTargetedContributionsReadResponseSchema.safeParse({
        ...current, resourceDeclarationsByPluginId: declarations,
      }).success).toBe(false);
    }
    expect(DaemonPluginUiTargetedContributionsReadResponseSchema.safeParse({
      status: 'current',
      projection: { v: 2, generation: 1, familiesById: {} },
      targetedContributions: { target, points: [] },
      targetedSurfaceMounts: [],
    }).success).toBe(false);
    expect(DaemonPluginUiTargetedContributionsReadResponseSchema.safeParse({
      status: 'current',
      targetedContributions: { target, points: [{ pointId: 'providers', protocols: [] }] },
      targetedSurfaceMounts: [],
    }).success).toBe(false);
    expect(DaemonPluginUiTargetedContributionsReadResponseSchema.parse({
      status: 'unavailable',
      code: 'plugin_targeted_contributions_unavailable',
    })).toEqual({ status: 'unavailable', code: 'plugin_targeted_contributions_unavailable' });
  });

  it('parses current Machine source declarations independently of the handler import graph', () => {
    const empty = { status: 'sourceDeclarations', pluginId: 'acme.target', sourceDeclarations: [] };
    expect(DaemonPluginUiTargetedContributionsReadResponseSchema.parse(empty)).toEqual(empty);
    const withSource = { ...empty, sourceDeclarations: [{
      manifest: { id: 'acme.source', contributes: {
        actions: [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['plugin'],
          execution: { target: 'daemon' }, dangerLevel: 'safe' }],
        pluginContributionPoints: [],
        targetedPluginContributions: [{ id: 'source', target: { pluginId: 'acme.target', pointId: 'providers' },
          protocol: { id: 'detail', version: 1 }, operations: { read: 'read' } }],
        ui: { renderers: [] },
      } },
      occurrenceId: 'source-occurrence', sourceCustody: CONTRIBUTOR_SOURCE_CUSTODY,
    }] };
    expect(DaemonPluginUiTargetedContributionsReadResponseSchema.parse(withSource)).toMatchObject(withSource);
    const targetCustody = {
      manifest: { id: 'acme.target', contributes: {
        actions: [], pluginContributionPoints: [], targetedPluginContributions: [], ui: { renderers: [] },
      } },
      occurrenceId: 'target-occurrence', sourceCustody: CONTRIBUTOR_SOURCE_CUSTODY,
    };
    // The producer includes the physical target's custody even when only
    // external plugins contribute operations to it.
    const withTarget = { ...withSource, sourceDeclarations: [targetCustody, ...withSource.sourceDeclarations] };
    expect(DaemonPluginUiTargetedContributionsReadResponseSchema.parse(withTarget)).toMatchObject(withTarget);
    expect(DaemonPluginUiTargetedContributionsReadResponseSchema.safeParse({ ...withSource,
      sourceDeclarations: [{ ...targetCustody, manifest: { ...targetCustody.manifest, id: 'acme.unrelated' } }],
    }).success).toBe(false);
    expect(DaemonPluginUiTargetedContributionsReadResponseSchema.safeParse({ ...withTarget,
      sourceDeclarations: [targetCustody, targetCustody],
    }).success).toBe(false);
  });

  it('carries current Event Automation composer siblings without changing PluginProjectionV2', () => {
    // Full describe is additive on the older daemon: the explicit offer must
    // not require a fallback request or retire ordinary portable discovery.
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'machine-events', supportedEventObservationBindingVersions: [1],
    }).success).toBe(true);
    const automationEligibleEvents = [{
      event: {
        id: 'acme.events/repository/updated',
        identity: { pluginId: 'acme.events', localId: 'repository/updated' },
        occurrenceId: 'event-occurrence-a',
        sourceCustody: { kind: 'development', registeredRootId: 'events-root' },
        title: 'Repository updated',
        description: null,
        localizedPresentation: {
          title: { key: 'events.repository.title', fallback: 'Repository updated ({count})', params: { count: 2 } },
          description: { key: 'events.repository.description', fallback: 'A repository changed.' },
        },
        payloadSchema: { type: 'object', additionalProperties: false },
        automation: {
          v: 1,
          eligible: true,
          source: {
            sourceContractVersion: 1,
            supportedObservationTransports: ['checkpointedPull'],
            sourceConfigSchema: { type: 'object', additionalProperties: false },
            setupActionRef: { pluginId: 'acme.events', localId: 'configure-source' },
            historyGapResetActionRef: { pluginId: 'acme.events', localId: 'baseline-history-gap' },
          },
        },
      },
      setupAction: {
        id: 'acme.events/configure-source',
        identity: { pluginId: 'acme.events', localId: 'configure-source' },
        occurrenceId: 'event-occurrence-a',
        title: 'Configure source',
        description: 'Choose a repository',
        inputSchema: { type: 'object', additionalProperties: false },
        inputHints: null,
      },
      historyGapResetAction: {
        id: 'acme.events/baseline-history-gap',
        identity: { pluginId: 'acme.events', localId: 'baseline-history-gap' },
        occurrenceId: 'event-occurrence-a',
        title: 'Resume source',
        description: 'Baseline the current source head',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { automationId: { type: 'string' } },
          required: ['automationId'],
        },
        inputHints: null,
      },
    }] as const;

    const parsed = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
      protocolVersion: 1,
      projection: { v: 2, generation: 1, familiesById: {} },
      automationEligibleEvents,
    });

    expect(parsed.automationEligibleEvents).toEqual(automationEligibleEvents);
    const executionOrigin = { serverIdentityId: 'srv_events', sourceRef: {
      machineId: 'machine-events', pluginId: 'acme.events', sourceCustody: automationEligibleEvents[0].event.sourceCustody,
    } };
    const binding = { executionOrigin, materializationRef: {
      machineId: 'machine-events', pluginId: 'acme.events', materializationId: 'admitted-observer',
    } };
    const withBinding = { protocolVersion: 1, projection: { v: 2, generation: 1 },
      automationEligibleEvents: [{ ...automationEligibleEvents[0], observationBinding: binding }] };
    expect(DaemonContributionRegistryProjectionDescribeResponseSchema.parse(withBinding)
      .automationEligibleEvents?.[0]).toMatchObject({ observationBinding: binding });
    for (const invalidBinding of [
      { ...binding, materializationRef: { ...binding.materializationRef, machineId: 'other-machine' } },
      { ...binding, materializationRef: { ...binding.materializationRef, pluginId: 'other.plugin' } },
      { ...binding, executionOrigin: { ...executionOrigin, sourceRef: { ...executionOrigin.sourceRef,
        sourceCustody: { kind: 'development', registeredRootId: 'retired-source' } } } },
      { ...binding, trusted: true },
    ]) {
      expect(DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse({ ...withBinding,
        automationEligibleEvents: [{ ...automationEligibleEvents[0], observationBinding: invalidBinding }],
      }).success).toBe(false);
    }
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 1,
      installedPackagesById: {},
      agentsById: {},
      actionsById: {},
      resourcesById: {},
      settingsById: {},
      familiesById: {},
      diagnostics: [],
      automationEligibleEvents,
    }).success).toBe(false);
  });

  it('does not inherit the retired manifest array-entry ceiling for Automation siblings', () => {
    const eligibleEvent = {
      event: {
        id: 'acme.events/repository/updated',
        identity: { pluginId: 'acme.events', localId: 'repository/updated' },
        occurrenceId: 'event-occurrence-a',
        sourceCustody: { kind: 'development', registeredRootId: 'events-root' },
        title: 'Repository updated',
        description: null,
        automation: {
          v: 1,
          eligible: true,
          source: {
            sourceContractVersion: 1,
            supportedObservationTransports: ['checkpointedPull'],
            sourceConfigSchema: { type: 'object', additionalProperties: false },
            setupActionRef: { pluginId: 'acme.events', localId: 'configure-source' },
          },
        },
      },
      setupAction: {
        id: 'acme.events/configure-source',
        identity: { pluginId: 'acme.events', localId: 'configure-source' },
        occurrenceId: 'event-occurrence-a',
        title: 'Configure source',
        description: null,
        inputSchema: { type: 'object', additionalProperties: false },
        inputHints: null,
      },
    } as const;

    expect(DaemonContributionRegistryProjectionAutomationEligibleEventsV1Schema.safeParse(
      Array.from({ length: 8_193 }, () => eligibleEvent),
    ).success).toBe(true);
  });

  it('accepts a deployed legacy managed-dependency title while current writers omit it', () => {
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 1,
      familiesById: {
        managedDependencies: {
          family: 'managedDependencies',
          entriesById: {
            'acme.runtime/runtime': {
              id: 'runtime',
              pluginId: 'acme.runtime',
              title: 'Runtime',
              executable: 'runtime',
            },
          },
        },
      },
    }).success).toBe(true);
  });

  it('accepts canonical Agent projections and rejects retired Provider aliases', () => {
    const canonicalV2 = PluginProjectionV2Schema.parse({
      v: 2,
      generation: 1,
      agentsById: {
        custom: {
          id: 'custom',
          title: 'Custom',
          catalogAgentId: 'claude',
        },
      },
    });
    expect(canonicalV2).toMatchObject({
      agentsById: {
        custom: { id: 'custom', catalogAgentId: 'claude' },
      },
    });

    const retiredV2Projections = [
      {
        v: 2,
        generation: 1,
        providersById: { custom: { providerId: 'custom' } },
      },
      {
        v: 2,
        generation: 1,
        agentsById: { custom: { id: 'custom', providerId: 'custom' } },
      },
      {
        v: 2,
        generation: 1,
        agentsById: { custom: { id: 'custom', providerAgentId: 'claude' } },
      },
      {
        v: 2,
        generation: 1,
        backendsById: { b1: { id: 'b1', agentId: 'custom', providerId: 'custom' } },
      },
      {
        v: 2,
        generation: 1,
        backendsById: { b1: { id: 'b1', agentId: 'custom', providerAgentId: 'claude' } },
      },
    ];
    for (const projection of retiredV2Projections) {
      expect(PluginProjectionV2Schema.safeParse(projection).success).toBe(false);
    }

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 1,
      familiesById: {
        providers: {
          family: 'providers',
          entriesById: {
            'acme.provider/openai': {
              id: 'openai',
              pluginId: 'acme.provider',
              definition: {},
            },
          },
        },
      },
    }).success).toBe(false);
  });

  it('accepts platform selection without exact framework or engine compatibility facts', () => {
    const parsed = DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: {
        platform: 'ios',
        channel: 'internal',
        appVersion: '0.2.1',
        nativeApplicationVersion: '0.2.0',
        nativeBuildVersion: '101',
        applicationId: 'dev.happier.app',
        rawUpdateChannel: 'internalpreview',
      },
    });

    expect(parsed.reactNativeHostRuntimeIdentity).toEqual({
      platform: 'ios',
      channel: 'internal',
      appVersion: '0.2.1',
      nativeApplicationVersion: '0.2.0',
      nativeBuildVersion: '101',
      applicationId: 'dev.happier.app',
      rawUpdateChannel: 'internalpreview',
    });

    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: { platform: 'web', channel: 'internal' },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: { platform: 'ios', channel: 'preview' },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: {
        platform: 'ios',
        channel: 'internal',
        reactVersion: '19.2.0',
      },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: {
        platform: 'ios',
        channel: 'internal',
        reactNativeVersion: '0.83.4',
      },
    }).success).toBe(false);
  });

  it('normalizes the predecessor browser fact and accepts only exact factual hosted frame adapters', () => {
    const parsed = DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
      machineId: 'm1',
      hostedWebFrameCapability: {
        platform: 'web',
        adapter: 'domIframe',
      },
    });
    expect(parsed.hostedWebFrameCapability).toEqual({
      platform: 'web',
      adapter: 'domIframe',
    });

    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: { platform: 'ios', channel: 'internal' },
      hostedWebFrameCapability: { platform: 'ios', adapter: 'WKWebView' },
    }).hostedWebFrameCapability).toEqual({ platform: 'ios', adapter: 'WKWebView' });
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      reactNativeHostRuntimeIdentity: { platform: 'ios', channel: 'internal' },
      hostedWebFrameCapability: { platform: 'android', adapter: 'WebViewAssetLoader' },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
      machineId: 'm1',
      hostedWebFrameCapability: { platform: 'android', adapter: 'WebViewAssetLoader' },
    }).hostedWebFrameCapability).toEqual({ platform: 'android', adapter: 'WebViewAssetLoader' });
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
      machineId: 'm1',
      hostedWebFrameCapability: { platform: 'desktop', adapter: 'wry' },
    }).hostedWebFrameCapability).toEqual({ platform: 'desktop', adapter: 'wry' });

    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      hostedWebFrameCapability: { platform: 'desktop', adapter: 'domIframe' },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      hostedWebFrameCapability: { platform: 'web', adapter: 'domIframe', available: true },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      hostedWebFrameCapability: { platform: 'web', adapter: 'sourcePresence' },
    }).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeRequestSchema.safeParse({
      machineId: 'm1',
      hostedWebFrameCapability: { platform: 'ios', adapter: 'WebViewAssetLoader' },
    }).success).toBe(false);
  });

  it('parses a v2 describe response payload that carries the authoritative plugin projection', () => {
    const parsed = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
      protocolVersion: 1,
      projection: {
        v: 2,
        generation: 7,
        installedPackagesById: {
          'acme.plugin': {
            id: 'acme.plugin',
            displayName: 'Acme Plugin',
            version: '1.2.3',
            enabled: true,
            source: {
              kind: 'path',
              locator: '/tmp/acme',
            },
          },
        },
        agentsById: {
          'acme-agent': {
            id: 'acme-agent',
            connectedServiceIds: ['openai-codex'],
          },
        },
        actionsById: {},
        resourcesById: {},
        diagnostics: [],
      },
    });

    expect(parsed.protocolVersion).toBe(1);
    expect(parsed.projection.v).toBe(2);
    expect(parsed.projection.installedPackagesById['acme.plugin']?.displayName).toBe('Acme Plugin');
    expect(parsed.projection.agentsById['acme-agent']?.connectedServiceIds)
      .toEqual(['openai-codex']);
  });

  it('rejects superseded daemon projection fields with no released or active predecessor producer', () => {
    const predecessorResponse = {
      protocolVersion: 1 as const,
      projection: {
        v: 2 as const,
        generation: 17,
        agentsById: {
          'acme-agent': {
            id: 'acme-agent',
            externalSessions: {
              agent: { pluginId: 'acme.external-sessions', localId: 'acme-agent' },
              occurrenceId: 17,
              operations: {
                listCandidates: true,
                resolveLinkIdentity: true,
                pageTranscript: true,
                readAfterTranscript: true,
              },
              sources: [{
                sourceKind: 'acmeArchive',
                schema: {
                  fields: [{ name: 'kind', kind: 'literal' as const, value: 'acmeArchive' }],
                  passthrough: true,
                },
                key: { segments: [{ kind: 'literal' as const, value: 'acmeArchive' }] },
              }],
            },
          },
        },
        actionsById: {
          'acme.external-sessions.open': {
            id: 'acme.external-sessions.open',
            pluginId: 'acme.external-sessions',
            title: 'Open archive',
            scopes: ['settings' as const],
            surfaces: ['ui' as const],
            execution: { target: 'daemon' as const },
            placement: 'primary',
            dangerLevel: 'safe' as const,
          },
        },
        familiesById: {
          pluginUi: {
            family: 'pluginUi' as const,
            entriesById: {
              'surfacePlacement:acme.ui:activity': {
                id: 'surfacePlacement:acme.ui:activity',
                pluginId: 'acme.ui',
                contributionKind: 'surfacePlacement',
                descriptorId: 'activity',
                generatedV2: true,
                container: 'appPage',
                target: { kind: 'app' as const },
                binding: {
                  destination: { pluginId: 'acme.ui', localId: 'activity' },
                  rendererChain: [{ pluginId: 'acme.ui', localId: 'activity-renderer' }],
                  renderer: { pluginId: 'acme.ui', localId: 'activity-renderer' },
                  container: 'appPage',
                  target: { kind: 'app' as const },
                  targetKind: 'app',
                  surfaceContextPlacement: 'appSurface',
                  instancePolicy: 'singleton',
                  platforms: ['android', 'desktop', 'ios', 'web'],
                  collisionDomain: { container: 'appPage', targetKind: 'app' },
                  collisionKey: 'appPage\u0000app\u0000acme.ui/activity',
                  methodCeiling: [
                    'context',
                    'watchContext',
                    'executeAction',
                    'readResource',
                    'statOpenableContent',
                    'readOpenableContent',
                    'watchResource',
                    'openSurface',
                    'notify',
                    'confirm',
                    'diagnostic',
                    'readClipboard',
                    'writeClipboard',
                    'openExternalLink',
                  ],
                },
                renderer: { kind: 'declarative' as const },
                display: { titleKey: 'activity', developerFallback: 'Activity' },
                actions: [],
                availability: { state: 'available' as const, reason: 'available', diagnostics: [] },
              },
            },
          },
        },
      },
    };

    // Neither the supported immutable releases nor the active prospective
    // predecessor emits this abandoned tuple. The daemon response stays on
    // the same closed canonical projection schema instead of guessing it.
    expect(PluginProjectionV2Schema.safeParse(predecessorResponse.projection).success).toBe(false);
    expect(DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse(predecessorResponse).success)
      .toBe(false);
  });

  it('rejects raw manifest digests in installed-package projections', () => {
    expect(PluginProjectionInstalledPackageV2Schema.safeParse({
      id: 'acme.plugin',
      displayName: 'Acme Plugin',
      version: '1.2.3',
      enabled: true,
      source: {
        kind: 'path',
        locator: '/tmp/acme',
      },
      digest: 'sha256:manifest',
    }).success).toBe(false);
  });

  it('binds installed package and Resource origins to their actual producer identity', () => {
    const executionOrigin = {
      serverIdentityId: 'srv_projection_fixture',
      sourceRef: {
        machineId: 'machine_projection_fixture',
        pluginId: 'acme.plugin',
        sourceCustody: TARGET_SOURCE_CUSTODY,
      },
    } as const;
    const installedPackage = {
      id: 'acme.plugin', displayName: 'Acme Plugin', enabled: true,
      source: { kind: 'path', locator: '/tmp/acme' },
      sourceCustody: TARGET_SOURCE_CUSTODY,
      executionOrigin,
    } as const;
    expect(PluginProjectionInstalledPackageV2Schema.parse(installedPackage)).toMatchObject({ executionOrigin });
    expect(PluginProjectionInstalledPackageV2Schema.safeParse({
      ...installedPackage, sourceCustody: CONTRIBUTOR_SOURCE_CUSTODY,
    }).success).toBe(false);
    const resource = {
      id: 'acme.plugin/entries', pluginId: 'acme.plugin', occurrenceId: 'plugin-occurrence',
      resourceKind: 'config', scope: 'global', executionOrigin,
    } as const;
    expect(PluginProjectedResourceV2Schema.parse(resource)).toMatchObject({ executionOrigin });
    expect(PluginProjectedResourceV2Schema.safeParse({ ...resource, occurrenceId: undefined }).success).toBe(false);
    const portable = { ...resource, executionOrigin: undefined,
      execution: { target: 'account', account: { artifactId: 'portable', exportName: 'activate' } } };
    expect(PluginProjectedResourceV2Schema.parse(portable)).toMatchObject({ execution: portable.execution });
    expect(PluginProjectedResourceV2Schema.safeParse({ ...portable, execution: {
      ...portable.execution, account: { ...portable.execution.account, machineId: 'untrusted' },
    } }).success).toBe(false);
    for (const schemaAndRow of [
      { schema: PluginProjectionInstalledPackageV2Schema, row: installedPackage },
      { schema: PluginProjectedResourceV2Schema, row: resource },
    ]) {
      expect(schemaAndRow.schema.safeParse({
        ...schemaAndRow.row,
        executionOrigin: { ...executionOrigin, sourceRef: { ...executionOrigin.sourceRef, pluginId: 'acme.other' } },
      }).success).toBe(false);
    }
  });

  it.each([
    ['registrySources', {
      id: 'catalog', title: 'Catalog', format: 'happier-catalog', kinds: ['plugin'], url: 'https://catalog.example.org',
    }],
    ['inputTypes', { id: 'catalog', title: 'Catalog', semantic: 'catalog', valueSchema: { type: 'string' } }],
    ['atmospherePictures', {
      id: 'catalog', title: 'Catalog', kind: 'photo',
      credit: { author: 'Acme', source: 'Acme', url: 'https://catalog.example.org', licence: 'CC0' },
      src: { full: 'https://catalog.example.org/full.jpg', thumb: 'https://catalog.example.org/thumb.jpg' },
      horizon: {}, focus: {}, hour: 12, grades: { light: 1, dusk: 1, night: 1 }, dark: 'night', look: {},
    }],
    ['machineProvisioners', {
      id: 'catalog', title: 'Catalog', icon: 'server', resourceKind: 'machine',
      launchSchema: { type: 'object', additionalProperties: false },
      resourceSchema: { type: 'object', additionalProperties: false },
      schemaVersion: 1, platforms: ['linux'], prerequisites: [],
      billing: { location: 'cloud', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['delete'] },
      actions: { check: 'check', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' },
    }],
  ] as const)('keeps %s origin envelopes closed and bound to their serving occurrence', (family, definition) => {
    const executionOrigin = {
      serverIdentityId: 'srv_projection_fixture',
      sourceRef: { machineId: 'machine_projection_fixture', pluginId: 'acme.plugin', sourceCustody: TARGET_SOURCE_CUSTODY },
    } as const;
    const entry = { id: 'acme.plugin/catalog', pluginId: 'acme.plugin', pluginVersion: '1', occurrenceId: 'plugin-occurrence', definition, executionOrigin };
    const projectionFor = (row: unknown) => ({
      v: 2, generation: 1, familiesById: { [family]: { family, entriesById: { [entry.id]: row } } },
    });
    expect(PluginProjectionV2Schema.parse(projectionFor(entry))).toMatchObject({
      familiesById: { [family]: { entriesById: { [entry.id]: { executionOrigin } } } },
    });
    expect(PluginProjectionV2Schema.safeParse(projectionFor({ ...entry, occurrenceId: undefined })).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse(projectionFor({
      ...entry, executionOrigin: { ...executionOrigin, sourceRef: { ...executionOrigin.sourceRef, pluginId: 'acme.other' } },
    })).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse(projectionFor({
      ...entry, executionOrigin: { sourceRef: executionOrigin.sourceRef },
    })).success).toBe(false);
  });

  it('carries only a committed immutable generation on installed-package projections', () => {
    const installedPackage = {
      id: 'acme.plugin',
      displayName: 'Acme Plugin',
      version: '1.2.3',
      enabled: true,
      source: {
        kind: 'path',
        locator: '/tmp/acme',
      },
      immutableGenerationId: 'committed-generation-a',
    } as const;

    expect(PluginProjectionInstalledPackageV2Schema.parse(installedPackage)).toMatchObject({
      id: 'acme.plugin',
      immutableGenerationId: 'committed-generation-a',
    });
    expect(PluginProjectionInstalledPackageV2Schema.safeParse({
      ...installedPackage,
      immutableGenerationId: ' ',
    }).success).toBe(false);
  });

  it('parses v2 plugin projection descriptors without executable handler internals', () => {
    expect(typeof PluginProjectionV2Schema?.parse).toBe('function');
    expect((protocol as { PluginProjectedHookV2Schema?: unknown }).PluginProjectedHookV2Schema).toBeUndefined();
    expect((protocol as { ExtensionProjectionV2Schema?: unknown }).ExtensionProjectionV2Schema).toBeUndefined();
    expect((protocol as { ExtensionProjectedHookV2Schema?: unknown }).ExtensionProjectedHookV2Schema).toBeUndefined();

    const parsed = PluginProjectionV2Schema.parse({
      v: 2,
      generation: 7,
      installedPackagesById: {
        'acme.plugin': {
          id: 'acme.plugin',
          displayName: 'Acme Plugin',
          version: '1.2.3',
          enabled: true,
          source: {
            kind: 'path',
            locator: '/tmp/acme',
          },
        },
      },
      actionsById: {
        'acme.plugin.refresh': {
          id: 'acme.plugin.refresh',
          pluginId: 'acme.plugin',
          occurrenceId: 'plugin-occurrence-a',
          title: 'Refresh Acme',
          scopes: ['settings'],
          surfaces: ['agent'],
          execution: { target: 'daemon' },
          placementBindings: ['primary'],
          dangerLevel: 'safe',
          available: true,
        },
      },
      resourcesById: {
        'acme.plugin.prompt': {
          id: 'acme.plugin.prompt',
          pluginId: 'acme.plugin',
          resourceKind: 'prompt',
          path: 'resources/prompt.md',
          digest: 'sha256:abc123',
        },
      },
      diagnostics: [
        {
          version: 1,
          id: 'acme.plugin:normalization:plugin:0',
          data: {
            severity: 'warning',
            code: 'plugin.futureCapability',
            message: 'Unsupported future capability',
          },
          plugin: { id: 'acme.plugin', version: '1.2.3', source: 'localPath' },
          stage: 'normalization',
          host: 'daemon',
          platform: 'darwin',
          occurredAtMs: 1,
          resolution: { state: 'current' },
        },
      ],
    });

    expect(parsed.generation).toBe(7);
    expect(parsed.actionsById['acme.plugin.refresh']?.available).toBe(true);
    expect(parsed).not.toHaveProperty('toolsById');
    expect(parsed).not.toHaveProperty('commandsById');
    expect(parsed).not.toHaveProperty('hooksById');
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      hooksById: {
        'acme.plugin.spawn-env': {
          id: 'acme.plugin.spawn-env',
          pluginId: 'acme.plugin',
          eventId: 'agent.spawnEnv.augment',
        },
      },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      actionsById: {
        'acme.plugin.refresh': {
          id: 'acme.plugin.refresh',
          pluginId: 'acme.plugin',
          title: 'Refresh Acme',
          scopes: ['settings'],
          surfaces: ['settings'],
          placementBindings: ['primary'],
          dangerLevel: 'safe',
          handler: {
            target: 'daemon',
            exportName: 'refreshAcme',
          },
        },
      },
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      executableRegistryPath: '/tmp/acme/registry.json',
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      agentsById: {
        acme: {
          id: 'acme',
          title: 'Acme',
          handler: {
            target: 'daemon',
            exportName: 'loadAcme',
          },
        },
      },
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      backendsById: {
        'acme.backend': {
          id: 'acme.backend',
          agentId: 'acme',
          handler: {
            target: 'daemon',
            exportName: 'launchAcme',
          },
        },
      },
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      uiDescriptorsById: {
        'acme.plugin.settings': {
          id: 'acme.plugin.settings',
          pluginId: 'acme.plugin',
          surface: 'settings',
          title: 'Acme Settings',
          fields: [
            {
              id: 'enabled',
              type: 'boolean',
              title: 'Enabled',
              componentModule: './SettingsPanel.js',
            },
          ],
        },
      },
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      hooksById: {
        'acme.plugin.spawn-env': {
          id: 'acme.plugin.spawn-env',
          pluginId: 'acme.plugin',
          eventId: 'spawn.augmentEnv',
        },
      },
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      hooksById: {
        'acme.plugin.spawn-env': {
          id: 'acme.plugin.spawn-env',
          pluginId: 'acme.plugin',
          eventId: 'agent.spawnEnv.augment',
          handler: {
            target: 'daemon',
            exportName: 'augmentSpawnEnv',
          },
        },
      },
    }).success).toBe(false);
  });

  it('rejects the retired uiDescriptors projection family', () => {
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 1,
      uiDescriptorsById: {},
    }).success).toBe(false);
  });

  it('bounds projected agent-owned provider environment keys without projecting provider credentials', () => {
    const base = {
      v: 2 as const,
      generation: 1,
      agentsById: {
        codex: {
          id: 'codex',
          providerOwnedEnvironmentKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
        },
      },
    };
    expect(PluginProjectionV2Schema.parse(base).agentsById.codex?.providerOwnedEnvironmentKeys)
      .toEqual(['OPENAI_API_KEY', 'CODEX_API_KEY']);
    expect(PluginProjectionV2Schema.safeParse({
      ...base,
      agentsById: { codex: { id: 'codex', providerOwnedEnvironmentKeys: ['OPENAI_API_KEY', 'OPENAI_API_KEY'] } },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      ...base,
      agentsById: { codex: { id: 'codex', providerOwnedEnvironmentKeys: Array.from({ length: 65 }, (_, index) => `PROVIDER_KEY_${index}`) } },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      ...base,
      agentsById: { codex: { id: 'codex', providerOwnedEnvironmentKeys: ['not-an-env-key'] } },
    }).success).toBe(false);
  });

  it('projects a bounded generation-pinned external-session browse descriptor for an Agent', () => {
    const externalSessions = {
      agent: {
        pluginId: 'acme.external-sessions',
        localId: 'acme-agent',
      },
      generation: 17,
      operations: {
        listCandidates: true,
        resolveLinkIdentity: true,
        pageTranscript: true,
        readAfterTranscript: true,
      },
      sources: [{
        sourceKind: 'acmeArchive',
        schema: {
          fields: [{ name: 'kind', kind: 'literal', value: 'acmeArchive' }],
        },
        key: { segments: [{ kind: 'literal', value: 'acmeArchive' }] },
        instances: [{ kind: 'default', constants: {} }],
      }],
    } as const;
    const base = {
      v: 2 as const,
      generation: 17,
      agentsById: {
        'acme-agent': {
          id: 'acme-agent',
          externalSessions,
        },
      },
    };

    expect(PluginProjectionV2Schema.parse(base).agentsById['acme-agent']?.externalSessions)
      .toEqual(externalSessions);
    expect(PluginProjectionV2Schema.safeParse({
      ...base,
      agentsById: {
        'acme-agent': {
          id: 'acme-agent',
          externalSessions: {
            ...externalSessions,
            operations: { ...externalSessions.operations, takeover: true },
          },
        },
      },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      ...base,
      agentsById: {
        'acme-agent': {
          id: 'acme-agent',
          externalSessions: { ...externalSessions, generation: -1 },
        },
      },
    }).success).toBe(false);
  });

  it('projects secret custody independently from the Settings record scope', () => {
    const accountSettingsWithDaemonSecret = PluginSettingsContributionV2Schema.parse({
      id: 'account-settings',
      version: 1,
      title: 'Account settings',
      target: { kind: 'plugin' },
      scope: 'account',
      fields: [{
        id: 'daemon-secret',
        title: 'Daemon secret',
        schema: { type: 'string' },
        secret: { custody: 'daemon' },
      }],
    });
    const daemonSettingsWithAccountSecret = PluginSettingsContributionV2Schema.parse({
      id: 'daemon-settings',
      version: 1,
      title: 'Daemon settings',
      target: { kind: 'plugin' },
      scope: 'daemon',
      fields: [{
        id: 'account-secret',
        title: 'Account secret',
        schema: { type: 'string' },
        secret: { custody: 'account' },
      }],
    });

    const accountProjection = projectPluginSettingsContributionV2({
      pluginId: 'acme.settings',
      definition: accountSettingsWithDaemonSecret,
    });
    const daemonProjection = projectPluginSettingsContributionV2({
      pluginId: 'acme.settings',
      definition: daemonSettingsWithAccountSecret,
    });

    expect(accountProjection).toMatchObject({
      scope: { kind: 'account' },
      fields: [{
        id: 'daemon-secret',
        control: 'password',
        secretCustody: 'daemon',
        redaction: 'secret',
      }],
    });
    expect(daemonProjection).toMatchObject({
      scope: { kind: 'daemon' },
      fields: [{
        id: 'account-secret',
        control: 'password',
        secretCustody: 'account',
        redaction: 'secret',
      }],
    });
    expect(accountProjection.fields[0]).not.toHaveProperty('defaultValue');
    expect(daemonProjection.fields[0]).not.toHaveProperty('defaultValue');
  });

  it('parses explicit Account settings metadata without exposing setting values', () => {
    const parsed = PluginProjectionV2Schema.parse({
      v: 2,
      generation: 7,
      settingsById: {
        'acme.hooks.settings': {
          id: 'acme.hooks.settings',
          pluginId: 'acme.hooks',
          version: 1,
          title: 'Acme hook settings',
          scope: { kind: 'account' },
          presentation: { sections: [], subagentSections: [] },
          target: { kind: 'plugin' },
          fields: [
            {
              id: 'apiToken',
              kind: 'settings.field',
              version: '1.0.0',
              valueSchema: { type: 'string' },
              valueType: 'string',
              control: 'password',
              secretCustody: 'account',
              displayKey: 'plugins.acme.apiToken.label',
              descriptionKey: 'plugins.acme.apiToken.description',
              redaction: 'secret',
              clearWhenEmpty: 'omit',
              capabilityGates: [],
              permissionGates: [],
            },
            {
              id: 'enabled',
              kind: 'settings.field',
              version: '1.0.0',
              valueSchema: { type: 'boolean' },
              valueType: 'boolean',
              control: 'switch',
              secretCustody: null,
              displayKey: 'plugins.acme.enabled.label',
              redaction: 'none',
              clearWhenEmpty: 'persist',
              defaultBooleanValue: true,
              capabilityGates: [],
              permissionGates: [],
            },
          ],
        },
      },
    });

    expect(parsed.settingsById['acme.hooks.settings']?.scope).toEqual({ kind: 'account' });
    expect(parsed.settingsById['acme.hooks.settings']?.fields.map((field) => field.id)).toEqual([
      'apiToken',
      'enabled',
    ]);
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      settingsById: {
        'acme.hooks.settings': {
          id: 'acme.hooks.settings',
          pluginId: 'acme.hooks',
          version: 1,
          title: 'Acme hook settings',
          scope: { kind: 'account' },
          presentation: { sections: [], subagentSections: [] },
          target: { kind: 'plugin' },
          fields: [
            {
              id: 'apiToken',
              kind: 'settings.field',
              version: '1.0.0',
              valueSchema: { type: 'string' },
              valueType: 'string',
              control: 'password',
              secretCustody: 'account',
              displayKey: 'plugins.acme.apiToken.label',
              redaction: 'secret',
              clearWhenEmpty: 'omit',
              capabilityGates: [],
              permissionGates: [],
              value: 'super-secret-token',
            },
          ],
        },
      },
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 7,
      settingsById: {
        'acme.hooks.settings': {
          id: 'acme.hooks.settings',
          pluginId: 'acme.hooks',
          version: 1,
          title: 'Acme hook settings',
          scope: { kind: 'account' },
          presentation: { sections: [], subagentSections: [] },
          target: { kind: 'plugin' },
          fields: [
            {
              id: 'apiToken',
              kind: 'settings.field',
              version: '1.0.0',
              valueSchema: {
                type: 'string',
                default: 'schema-secret-default',
                enum: ['schema-secret-option'],
              },
              valueType: 'string',
              control: 'password',
              secretCustody: 'account',
              displayKey: 'plugins.acme.apiToken.label',
              redaction: 'secret',
              clearWhenEmpty: 'omit',
              capabilityGates: [],
              permissionGates: [],
            },
          ],
        },
      },
    }).success).toBe(false);

    expect(PluginProjectedSettingsFieldV2Schema.safeParse({
      id: 'legacy-secret',
      kind: 'settings.field',
      version: '1.0.0',
      valueSchema: { type: 'string' },
      valueType: 'string',
      control: 'password',
      displayKey: 'Legacy secret',
      redaction: 'secret',
      clearWhenEmpty: 'omit',
      capabilityGates: [],
      permissionGates: [],
    }).success).toBe(false);
  });

  it('rejects unknown projection families and unknown family entry fields', () => {
    const parsed = PluginProjectionV2Schema.parse({
      v: 2,
      generation: 12,
      familiesById: {
        scmHostingProviders: {
          family: 'scmHostingProviders',
          entriesById: {
            github: {
              id: 'github',
              pluginId: 'acme.scm',
              localId: 'github',
              kind: 'github',
              displayName: 'GitHub',
              description: 'GitHub hosting',
              baseUrl: 'https://github.com',
              urlSafety: {},
              capabilities: {},
              operations: {},
              authService: 'github',
            },
          },
        },
      },
    });

    expect(parsed.familiesById.scmHostingProviders?.entriesById.github).toEqual({
      id: 'github',
      pluginId: 'acme.scm',
      localId: 'github',
      kind: 'github',
      displayName: 'GitHub',
      description: 'GitHub hosting',
      baseUrl: 'https://github.com',
      urlSafety: {},
      capabilities: {},
      operations: {},
      authService: 'github',
    });
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 12,
      familiesById: {
        unknownFamily: {
          family: 'unknownFamily',
          entriesById: {},
        },
      },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 12,
      familiesById: {
        scmHostingProviders: {
          family: 'scmHostingProviders',
          entriesById: {
            github: {
              ...parsed.familiesById.scmHostingProviders?.entriesById.github,
              hostPattern: 'github.com',
            },
          },
        },
      },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      v: 2,
      generation: 12,
      familiesById: {
        scmHostingProviders: {
          family: 'scmBackends',
          entriesById: {},
        },
      },
    }).success).toBe(false);
    expect(parsed.agentsById).toEqual({});
  });

  it('admits only compiled semantic commands in current plugin-UI projection entries', () => {
    const headerSemanticAction = {
      kind: 'executeAction' as const,
      action: { pluginId: 'acme.ui', localId: 'refresh' },
    };
    const pageSemanticAction = {
      kind: 'openSurface' as const,
      destination: { pluginId: 'acme.ui', localId: 'activity' },
    };
    const binding = {
      kind: 'destination' as const,
      destination: { pluginId: 'acme.ui', localId: 'activity' },
      rendererChain: [{ pluginId: 'acme.ui', localId: 'activity-renderer' }],
      renderer: { pluginId: 'acme.ui', localId: 'activity-renderer' },
      container: 'appPage',
      target: { kind: 'app' },
      targetKind: 'app',
      surfaceContextPlacement: 'appSurface',
      instancePolicy: 'singleton',
      platforms: ['android', 'desktop', 'ios', 'web'],
    };
    const projection = {
      v: 2 as const,
      generation: 13,
      familiesById: {
        pluginUi: {
          family: 'pluginUi' as const,
          entriesById: {
            'sessionHeaderAction:acme.ui:refresh': {
              id: 'sessionHeaderAction:acme.ui:refresh',
              pluginId: 'acme.ui',
              occurrenceId: 'ui-occurrence-a',
              contributionKind: 'sessionHeaderAction',
              descriptorId: 'refresh',
              title: 'Refresh',
              icon: 'refresh',
              command: headerSemanticAction,
            },
            'surfacePlacement:acme.ui:activity': {
              id: 'surfacePlacement:acme.ui:activity',
              pluginId: 'acme.ui',
              occurrenceId: 'ui-occurrence-a',
              contributionKind: 'surfacePlacement',
              descriptorId: 'activity',
              generatedV2: true,
              container: 'appPage',
              target: { kind: 'app' },
              binding,
              renderer: { kind: 'declarative', contributionId: 'activity-renderer' },
              display: { titleKey: 'activity', developerFallback: 'Activity' },
              actions: [],
              headerActions: [{
                id: 'open-activity',
                title: 'Open activity',
                icon: 'action',
                command: pageSemanticAction,
              }],
              availability: { state: 'available', reason: 'available', diagnostics: [] },
            },
            'settingsGroup:acme.ui:tools': {
              id: 'settingsGroup:acme.ui:tools',
              pluginId: 'acme.ui',
              occurrenceId: 'ui-occurrence-a',
              contributionKind: 'settingsGroup',
              group: { id: { pluginId: 'acme.ui', localId: 'tools' }, title: 'Tools' },
            },
            'settingsPage:acme.ui:tools': {
              id: 'settingsPage:acme.ui:tools',
              pluginId: 'acme.ui',
              occurrenceId: 'ui-occurrence-a',
              contributionKind: 'settingsPage',
              descriptorId: 'tools',
              page: { id: { pluginId: 'acme.ui', localId: 'tools' }, title: 'Tools' },
              binding: {
                ...binding,
                destination: { pluginId: 'acme.ui', localId: 'tools' },
                container: 'settingsPage',
              },
              renderer: { kind: 'declarative', contributionId: 'tools-renderer' },
              availability: { state: 'available', reason: 'available', diagnostics: [] },
            },
          },
        },
      },
    };

    expect(PluginProjectionV2Schema.parse(projection).familiesById.pluginUi?.entriesById)
      .toMatchObject(projection.familiesById.pluginUi.entriesById);

    expect(PluginProjectionV2Schema.safeParse({
      ...projection,
      familiesById: {
        ...projection.familiesById,
        pluginUi: {
          ...projection.familiesById.pluginUi,
          entriesById: {
            ...projection.familiesById.pluginUi.entriesById,
            'surfacePlacement:acme.ui:activity': {
              ...projection.familiesById.pluginUi.entriesById['surfacePlacement:acme.ui:activity'],
              binding: {
                ...binding,
                collisionDomain: { container: 'appPage', targetKind: 'app' },
              },
            },
          },
        },
      },
    }).success).toBe(false);

    expect(PluginProjectionV2Schema.safeParse({
      ...projection,
      familiesById: {
        pluginUi: {
          ...projection.familiesById.pluginUi,
          entriesById: {
            ...projection.familiesById.pluginUi.entriesById,
            'sessionHeaderAction:acme.ui:refresh': {
              ...projection.familiesById.pluginUi.entriesById['sessionHeaderAction:acme.ui:refresh'],
              command: { kind: 'executeAction', action: 'refresh' },
            },
          },
        },
      },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      ...projection,
      familiesById: {
        pluginUi: {
          ...projection.familiesById.pluginUi,
          entriesById: {
            ...projection.familiesById.pluginUi.entriesById,
            'surfacePlacement:acme.ui:activity': {
              ...projection.familiesById.pluginUi.entriesById['surfacePlacement:acme.ui:activity'],
              headerActions: [{
                id: 'open-activity',
                title: 'Open activity',
                command: { kind: 'openSurface', destination: 'activity' },
              }],
            },
          },
        },
      },
    }).success).toBe(false);
    expect(PluginProjectionV2Schema.safeParse({
      ...projection,
      familiesById: {
        pluginUi: {
          ...projection.familiesById.pluginUi,
          entriesById: {
            ...projection.familiesById.pluginUi.entriesById,
            'surfacePlacement:acme.ui:activity': {
              ...projection.familiesById.pluginUi.entriesById['surfacePlacement:acme.ui:activity'],
              binding: { ...binding, container: 'detailsTab' },
            },
          },
        },
      },
    }).success).toBe(false);
  });

  it('admits search providers only through their closed same-plugin identity and Action arm', () => {
    const entry = {
      id: 'searchProvider:acme.search:entries',
      pluginId: 'acme.search',
      occurrenceId: 'search-occurrence-a',
      contributionKind: 'searchProvider',
      descriptorId: 'entries',
      identity: { pluginId: 'acme.search', localId: 'entries' },
      action: { pluginId: 'acme.search', localId: 'entries/search-v1' },
    } as const;
    const projection = {
      v: 2,
      generation: 1,
      familiesById: {
        pluginUi: {
          family: 'pluginUi',
          entriesById: { [entry.id]: entry },
        },
      },
    } as const;

    expect(PluginProjectionV2Schema.safeParse(projection).success).toBe(true);

    const { occurrenceId: _occurrence, ...declaration } = entry;
    expect(PluginDeclaredUiEntryV1Schema.safeParse(declaration).success).toBe(true);

    for (const invalidEntry of [
      { ...entry, occurrenceId: undefined },
      { ...entry, action: 'entries/search-v1' },
      { ...entry, action: { pluginId: 'other.plugin', localId: 'entries/search-v1' } },
      { ...entry, identity: { pluginId: 'acme.search', localId: 'other' } },
      { ...entry, title: 'Unrelated duplicate Action presentation' },
    ]) {
      expect(PluginProjectionV2Schema.safeParse({
        ...projection,
        familiesById: {
          pluginUi: {
            ...projection.familiesById.pluginUi,
            entriesById: { [entry.id]: invalidEntry },
          },
        },
      }).success).toBe(false);
    }
  });

  it('dereferences React Native bytes by digest alone', () => {
    const cacheIdentity = {
      artifactDigest: `sha256:${'a'.repeat(64)}`,
    } as const;
    const request = DaemonPluginUiArtifactBytesReadRequestSchema.parse({
      artifactFamily: 'reactNative',
      machineId: 'm1',
      cacheIdentity,
    });

    expect(request).toEqual({ artifactFamily: 'reactNative', machineId: 'm1', cacheIdentity });
    for (const unrelatedMetadata of [
      { artifactOwnerKind: 'renderer' },
      { artifactOwnerKind: 'voiceProvider' },
      {
        artifactOwnerKind: 'clientContribution',
        clientContribution: {
          family: 'actions',
          action: { pluginId: 'acme.preview', localId: 'open-preview' },
        },
      },
      { reactNativeHostRuntimeIdentity: { platform: 'ios', channel: 'internal' } },
    ]) {
      expect(DaemonPluginUiArtifactBytesReadRequestSchema.safeParse({
        ...request,
        ...unrelatedMetadata,
      }).success).toBe(false);
    }

    expect(DaemonPluginUiArtifactBytesReadResponseSchema.parse({
      ok: true,
      artifactFamily: 'reactNative',
      cacheIdentity,
      artifact: {
        artifactKind: 'reactNativeBundle',
        digest: cacheIdentity.artifactDigest,
        format: 'plainJs',
        byteSize: 9,
      },
      files: [{
        relativePath: 'native/entry.cjs',
        digest: `sha256:${'b'.repeat(64)}`,
        byteSize: 9,
        bytesBase64: 'Ly8gYnVuZGxl',
      }],
    })).toMatchObject({ ok: true, cacheIdentity });
  });

  it('keeps packaged hosted-web artifact reads in their own closed renderer family', () => {
    const request = DaemonPluginUiArtifactBytesReadRequestSchema.parse({
      artifactFamily: 'hostedWeb',
      machineId: 'm1',
      cacheIdentity: {
        artifactDigest: `sha256:${'c'.repeat(64)}`,
      },
    });

    expect(request).toMatchObject({
      artifactFamily: 'hostedWeb',
      cacheIdentity: {
        artifactDigest: `sha256:${'c'.repeat(64)}`,
      },
    });
    expect(DaemonPluginUiArtifactBytesReadRequestSchema.safeParse({
      ...request,
      reactNativeHostRuntimeIdentity: { platform: 'ios', channel: 'internal' },
    }).success).toBe(false);
    const response = {
      ok: true,
      artifactFamily: 'hostedWeb',
      cacheIdentity: request.cacheIdentity,
      artifact: {
        artifactKind: 'hostedWebAsset',
        digest: `sha256:${'c'.repeat(64)}`,
        byteSize: 13,
      },
      files: [{
        relativePath: 'hosted/index.html',
        digest: `sha256:${'d'.repeat(64)}`,
        byteSize: 13,
        bytesBase64: 'PCFkb2N0eXBlIGh0bWw+',
      }],
    } as const;
    expect(DaemonPluginUiArtifactBytesReadResponseSchema.parse(response)).toMatchObject({
      ok: true,
      artifactFamily: 'hostedWeb',
      artifact: {
        artifactKind: 'hostedWebAsset',
      },
    });
    expect(DaemonPluginUiArtifactBytesReadResponseSchema.safeParse({
      ...response,
      artifact: {
        ...response.artifact,
        pluginId: 'acme.preview',
        contributionId: 'hosted-preview',
      },
    }).success).toBe(false);
  });

});
