import { describe, expect, it, vi } from 'vitest';

/**
 * The root barrel is what real consumers import.
 *
 * `apps/ui`, `apps/server` and `apps/cli` all reach this package through
 * `@happier-dev/protocol` rather than through subpaths, so the barrel's own
 * evaluation order is a shipped contract. It is also the order most likely to
 * break: the barrel re-exports the Action id registry and the feature/capability
 * graph, and that graph imports the id registry back. When those two interleave,
 * a module reads `RuntimeActionIdV1Schema` while it is still uninitialized and
 * the whole package fails to load with a bare `undefined` TypeError, far from
 * whichever import actually introduced the edge.
 *
 * Narrowing an individual import to a subpath hides this rather than fixing it,
 * so this check deliberately enters the way consumers do.
 */
describe('protocol root barrel', () => {
  it('loads Artifact sharing before the widget area intent schema', async () => {
    vi.resetModules();
    await import('./artifacts/artifactSharingV1.js');
    const widgets = await import('./widgets/widgetSurfaceArtifactV1.js');
    const intent = { kind: 'remove', instanceId: 'widget-copy' };

    expect(widgets.WidgetAreaLayoutIntentV1Schema.parse(intent)).toEqual(intent);
    expect(widgets.WidgetAreaLayoutIntentV1Schema.safeParse({ ...intent, instanceId: '' }).success).toBe(false);
  }, 60_000);

  it('loads Voice tracked addresses before widget Action inputs', async () => {
    vi.resetModules();
    const voice = await import('./sessions/follow/voiceTrackedTargetsCompatibilityV1.js');
    const widgets = await import('./widgets/actionsV1.js');
    const boundSession = { serverId: 'home', sessionId: 'session' };
    const input = { surface: { serverId: 'home', accountId: 'owner', owner: { kind: 'home' } }, boundSession };

    expect(voice.VoiceTrackedSessionAddressV1Schema.parse(boundSession)).toEqual(boundSession);
    expect(widgets.WidgetInstanceActionInputSchemasV1['widgets.catalog.list'].parse(input)).toEqual(input);
    expect(widgets.readWidgetCatalogBoundSessionV1(input)).toEqual(boundSession);
  }, 60_000);

  it('loads the built-in widget catalog before reading the missing Home preset', async () => {
    vi.resetModules();
    const widgets = await import('./widgets/builtinWidgetDescriptorV1.js');
    const home = await import('./home/homeHubLayoutV1.js');

    const layout = home.normalizeHomeHubLayoutV1(undefined);
    expect(widgets.readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: 'usage_capacity' }))
      .toMatchObject({ definition: { kind: 'builtin', id: 'usage_capacity' } });
    expect(layout.items).toMatchObject([{ kind: 'widget', instance: {
      id: 'default:builtin:usage_capacity', definition: { kind: 'builtin', id: 'usage_capacity' },
    } }, { kind: 'widget', instance: { id: 'default:builtin:machine_fleet', definition: { kind: 'builtin', id: 'machine_fleet' } } },
      { kind: 'widget', instance: { id: 'default:builtin:local_services_app', definition: { kind: 'builtin', id: 'local_services_app' } } }]);
    expect(home.normalizeHomeHubLayoutV1(undefined)).toBe(layout);
  }, 60_000);

  it('initializes the direct Action registry before any root import', async () => {
    vi.resetModules();
    const actions = await import('./actions/actionSpecs.js');

    expect(actions.ActionSpecSchema.safeParse(actions.getActionSpec('workflow.trigger.add')).success)
      .toBe(true);
  }, 60_000);

  it('initializes the Auth entry contracts before any root import', async () => {
    vi.resetModules();
    const auth = await import('./auth/entry.js');

    expect(auth.AuthEntryRequestV1Schema.parse({ v: 1, scope: { kind: 'home' } }))
      .toEqual({ v: 1, scope: { kind: 'home' } });
  }, 60_000);

  it('initializes every eagerly evaluated owner when a consumer imports the package root', async () => {
    vi.resetModules();
    const protocol = await import('./index.js');

    // The registry the feature/browser graph imports back.
    expect(protocol.ACTION_IDS.length).toBeGreaterThan(0);
    expect(protocol.ActionIdSchema.safeParse('home.governance.get').success).toBe(true);

    // The two owners that sit on the far side of that cycle risk: a browser
    // capability schema derived from runtime Action ids, and the assembled
    // Action registry itself.
    expect(protocol.RuntimeActionIdV1Schema.safeParse('browser.navigate').success).toBe(true);
    expect(protocol.getActionSpec('home.governance.get').id).toBe('home.governance.get');
    expect(protocol.AutomationEventFilterV1Schema.parse({
      v: 1,
      all: [{ op: 'eq', field: '/status', value: 'ready' }],
    })).toMatchObject({ v: 1 });

    // Team credential Actions pull resource schemas into this same eager public
    // graph. Their source-binding leaf must not re-enter the Provider broker
    // module while either schema is still initializing.
    expect(protocol.getActionSpec('teams.credentials.list').id).toBe('teams.credentials.list');
    expect(protocol.TeamCredentialSourceBindingV1Schema.parse({
      v: 1,
      kind: 'provider_connection',
      connectionId: 'connection-1',
      connectionSecurityFingerprint: 'connection-security:v1:test',
      credentialSlotId: 'api-key',
    })).toMatchObject({ kind: 'provider_connection' });
    expect(protocol.ProviderBrokerApplicationBindingV1Schema.parse({
      agentTargetKey: 'codex',
      implementationIdentity: {
        pluginId: 'happier.provider.cliproxyapi',
        localId: 'cliproxyapi',
      },
      endpointTemplateId: 'openai-responses',
      protocol: 'openai-responses',
    })).toMatchObject({ endpointTemplateId: 'openai-responses' });
    // The barrel is large; loading it is the point of this check, not a hazard.
  }, 60_000);

  it('exposes the Home family through the root barrel consumers already use', async () => {
    const protocol = await import('./index.js');

    expect(protocol.isHomeDomainActionIdV1('teams.archive')).toBe(true);
    expect(protocol.homeDomainActionTransportV1('teams.archive'))
      .toEqual({ method: 'POST', path: '/v1/teams/archive' });
  }, 60_000);

  it('initializes Team invitation admission before composing key-challenge redemption', async () => {
    const protocol = await import('./index.js');
    const admission = {
      kind: 'team_invitation',
      token: 'A'.repeat(43),
    } as const;

    expect(protocol.TeamInvitationAccountAdmissionV1Schema.parse(admission))
      .toEqual(admission);
    expect(protocol.KeyChallengeAuthRequestSchema.parse({
      challengeId: 'challenge-123',
      publicKey: 'signing-public-key',
      signature: 'signature',
      admission,
    })).toEqual({
      challengeId: 'challenge-123',
      publicKey: 'signing-public-key',
      signature: 'signature',
      admission,
    });
  }, 60_000);
});
